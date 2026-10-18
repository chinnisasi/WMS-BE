import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, devices, idempotencyKeys, users } from '../../shared/db/schema';
import type { UserRole, UserStatus } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission } from './permissions';
import { getMemberRoleIn } from './tenancy.service';
import { DUMMY_HASH, hashPassword } from './passwords';
import { shareLockClientInTx } from '../clients/clients.facade';
import { emailDigest, signInLockedUntil } from './auth-attempts';
import { revokeSessionsInTx } from './sessions';
import { clearOpenChallengesInTx, clearSecondFactorLockInTx } from './second-factor';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';

export const DEFAULT_USER_PAGE_SIZE = 50;
export const MAX_USER_PAGE_SIZE = 200;
/** One-time invite links are valid for 7 days (spec 1.5). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const USERS_EMAIL = 'users_email_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

export type UserAction =
  | 'user.invited'
  | 'user.role_changed'
  | 'user.accepted'
  | 'user.deactivated'
  | 'user.reactivated'
  | 'user.unlocked';

/** The user shape every users response carries — never password material. */
export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  /**
   * Story 21-7 — the client brand of a client-portal user (role `client`);
   * null for the tenant's own staff. Written only by the invite insert.
   */
  readonly clientId: string | null;
  readonly createdAt: string;
  /**
   * Story 6-1a — sign-in is locked for this email (from some address) until
   * this instant; list reads only. Optional so stored invite / role-change
   * snapshots replay unchanged.
   */
  readonly lockedUntil?: string | null;
  /** Story 6-1b — list reads only; optional for the same reason as `lockedUntil`. */
  readonly secondFactorEnabled?: boolean;
}

export interface UserStatusInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
}

/** Story 6-1a — deactivate / reactivate. A reactivated never-accepted invitee gets a fresh invite token. */
export interface UserStatusSnapshot {
  readonly user: UserView;
  readonly inviteToken?: string;
  readonly inviteExpiresAt?: string;
}

export interface InviteUserInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly email: string;
  readonly role: UserRole;
  /** Story 21-7 — required exactly when `role` is `client`. */
  readonly clientId?: string;
}

/**
 * The invite response. The raw token's only durable store is this snapshot,
 * persisted in the idempotency row's `response_snapshot` so a same-key
 * replay can re-serve the exact link — only its sha256 hash lives on the
 * users row.
 */
export interface InviteUserSnapshot {
  readonly user: UserView;
  readonly inviteToken: string;
  readonly inviteExpiresAt: string;
}

export interface SetUserRoleInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly role: UserRole;
}

export interface AcceptInviteInput {
  /** The inviting tenant from the URL — must match the invite row. */
  readonly tenantId: string;
  readonly token: string;
  readonly password: string;
}

export interface AcceptInviteSnapshot {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: UserRole;
    readonly status: UserStatus;
    /** Story 21-7 — absent from a pre-21-7 snapshot; normalised on replay. */
    readonly clientId?: string | null;
    readonly createdAt: string;
  };
}

/**
 * Story 21-7 — a stored snapshot's user, normalised: a pre-21-7 invite,
 * role-change or accept snapshot carries no `clientId`, which reads as
 * `null` (every pre-21-7 user was staff). Applied on every replay so the
 * response shape is the current one.
 */
export function normaliseUserView<T extends { clientId?: string | null }>(
  user: T,
): Omit<T, 'clientId'> & { clientId: string | null } {
  return { ...user, clientId: user.clientId ?? null };
}

function clientRoleShapeRefused(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid invitation', detail);
}

export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Cryptographically strong one-time invite token (raw — only the hash is stored). */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

function emailExists(email: string): ProblemException {
  return new ProblemException(
    'email-exists',
    409,
    'Email already has an account',
    `An account for ${email} already exists — emails are globally unique.`,
  );
}

function inviteInvalid(): ProblemException {
  return new ProblemException(
    'invite-invalid',
    400,
    'Invitation is unknown, used, or expired',
    'This invite link is not valid — ask the owner for a fresh invitation.',
  );
}

/**
 * User/team commands (Story 1.5): invite (Owner only, one-time 7-day invite
 * token returned in the response — no email delivery), cursor list (open to
 * any tenant member — reads are never gated), role change (Owner only, with
 * the last-Owner guard), and the unauthenticated accept-invite (AUTH_DATABASE
 * path like sign-in, tenant-scoped write inside). Every invitation and role
 * change, and accept-invite writes an audit_events row (actor, action,
 * target, time, idempotency reference) in the same transaction as the
 * mutation.
 *
 * Authority is `assertPermission` at command-service entry against the role
 * read from the DB **in the same tenant transaction** (`getMemberRoleIn`) —
 * never a JWT claim, so a role change applies to the user's next command.
 */
@Injectable()
export class UsersCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async invite(command: InviteUserInput, idempotencyKey: string): Promise<InviteUserSnapshot> {
    const email = command.email.trim().toLowerCase();
    const clientId = command.clientId ?? null;
    // Story 21-7 — request SHAPE (no DB row needed, so above the
    // transaction, the guide's tier 1): a `client` invite names its client,
    // and no other role may.
    if (command.role === 'client' && clientId === null) {
      throw clientRoleShapeRefused('A client-portal user (role "client") must name its client — clientId is required.');
    }
    if (command.role !== 'client' && clientId !== null) {
      throw clientRoleShapeRefused(
        `Only a client-portal user (role "client") belongs to a client — clientId is refused for role "${command.role}".`,
      );
    }
    // The fingerprint gains `clientId` ONLY when present (the 8-1d
    // conditional-key exception, at a fixed position after `role`): every
    // staff invite hashes byte-for-byte as before 21-7 (pinned by the golden
    // in test/portal.spec.ts).
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      email,
      role: command.role,
      ...(clientId === null ? {} : { clientId }),
    });

    const snapshot = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority first: role re-read from the DB in this transaction.
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'users.invite');

      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.tenantId, command.tenantId),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        const stored = existing[0].responseSnapshot as InviteUserSnapshot;
        return { ...stored, user: normaliseUserView(stored.user) };
      }

      // Story 21-7 — the client checks, BEHIND the replay lookup (a committed
      // invite re-serves its snapshot even if the client was suspended since):
      // the client must be this tenant's (read by tenant AND id → 404), a
      // client brand rather than the tenant's own `self` (400), and active
      // (409 `client-not-active`, the 21-3 type).
      if (clientId !== null) {
        // Story 21-10 — FOR SHARE, so a suspend cannot commit between this
        // read and the invite insert.
        const client = await shareLockClientInTx(tx, command.tenantId, clientId);
        if (client.systemOwned) {
          throw clientRoleShapeRefused(
            "A client-portal user belongs to a client brand — the tenant's own company is not one.",
          );
        }
        if (client.status !== 'active') {
          throw new ProblemException(
            'client-not-active',
            409,
            'Client is not active',
            `Client ${client.code} is ${client.status} — portal users are invited only for an active client.`,
          );
        }
      }

      // Emails are globally unique (one account per email, any tenant). The
      // pre-check reads the AUTH connection (BYPASSRLS) because the scoped
      // transaction cannot see foreign tenants' users; the DB unique
      // constraint is the race backstop.
      const collision = await this.authDb
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (collision[0]) {
        throw emailExists(email);
      }

      const rawToken = generateInviteToken();
      const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

      let user: UserView;
      try {
        const rows = await tx
          .insert(users)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            email,
            // No password yet: an unusable sentinel scrypt hash that no
            // credential verifies — the invitee sets their own password on
            // accept (sign-in is blocked with 403 invite-pending before that).
            passwordHash: DUMMY_HASH,
            role: command.role,
            status: 'invited',
            // Story 21-7 — the ONLY write of users.client_id anywhere (the
            // architecture test pins it); paired with role by the 0065 CHECK.
            clientId,
            inviteTokenHash: hashInviteToken(rawToken),
            inviteExpiresAt,
          })
          .returning();
        const row = rows[0]!;
        user = toUserView(row);
      } catch (err) {
        if (isUniqueViolationOn(err, USERS_EMAIL)) {
          throw emailExists(email);
        }
        throw err;
      }

      await insertAuditRow(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'user.invited',
        targetType: 'user',
        targetId: user.id,
        reference: idempotencyKey,
      });

      const body: InviteUserSnapshot = {
        user,
        inviteToken: rawToken,
        inviteExpiresAt,
      };
      // In-transaction outbox append (AD-7, story outbox-relay) — replaces
      // the old post-commit publish, and closes retro item 3: an idempotent
      // replay returns above (and a concurrent duplicate's transaction rolls
      // back whole), so a replayed invite writes NO second outbox row.
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'user.invited',
        occurredAt: nowIso(),
        payload: {
          userId: user.id,
          email: user.email,
          role: command.role,
          ...(clientId === null ? {} : { clientId }),
        },
      });
      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          key: idempotencyKey,
          payloadHash,
          responseSnapshot: body,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
          throw concurrentIdempotency();
        }
        throw err;
      }
      return body;
    });

    return snapshot;
  }

  async setUserRole(command: SetUserRoleInput, idempotencyKey: string): Promise<UserView> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      targetUserId: command.targetUserId,
      role: command.role,
    });

    const snapshot = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'users.role_change',
      );

      const existing = await tx
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.tenantId, command.tenantId),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].payloadHash !== payloadHash) {
          throw idempotencyKeyReuse();
        }
        return normaliseUserView((existing[0].responseSnapshot as { user: UserView }).user);
      }

      const targetRows = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, command.targetUserId), eq(users.tenantId, command.tenantId)))
        .limit(1);
      const target = targetRows[0];
      if (!target) {
        throw new ProblemException(
          'not-found',
          404,
          'User not found',
          'No user with this id exists in this tenant.',
        );
      }
      // Story 21-7 — a client-portal user's role never changes (its client
      // would go stale, or a staff role would carry a client the CHECK
      // refuses). Invite a new user instead. (`client` is never ASSIGNED
      // either: the DTO's ASSIGNABLE_ROLES; this is the command's backstop.)
      if (target.role === 'client' || command.role === 'client') {
        throw new ProblemException(
          'validation-failed',
          400,
          'Client-portal roles cannot change',
          'A client-portal user’s role is fixed at invite, and no user can be made one — invite a new user instead.',
        );
      }

      // Atomic last-Owner guard (review): the role UPDATE itself refuses to
      // demote a tenant's last Owner — the owner count is a subquery inside
      // the UPDATE's where clause, evaluated in the same statement, and a
      // demotion that matches no rows answers 409 `last-owner` with nothing
      // persisted. The owner rows are locked FOR UPDATE first because under
      // READ COMMITTED two concurrent demotions of *different* owners would
      // each count 2 from their own snapshot; the row locks make the second
      // transaction re-read the freshly demoted row before its count runs.
      // Story 6-1a — only ACTIVE owners count: demoting the last active owner
      // is refused; a deactivated owner can be demoted freely.
      const demotingLastOwner =
        target.role === 'owner' && target.status === 'active' && command.role !== 'owner';
      if (demotingLastOwner) {
        await lockActiveOwners(tx, command.tenantId);
      }

      const updatedRows = await tx
        .update(users)
        .set({ role: command.role, updatedAt: nowIso() })
        .where(
          and(
            eq(users.id, command.targetUserId),
            eq(users.tenantId, command.tenantId),
            demotingLastOwner
              ? sql`1 < (select count(*) from ${users} owner_rows
                  where owner_rows.tenant_id = ${users.tenantId} and owner_rows.role = 'owner'
                    and owner_rows.status = 'active')`
              : undefined,
          ),
        )
        .returning();
      if (updatedRows.length === 0) {
        if (demotingLastOwner) {
          throw new ProblemException(
            'last-owner',
            409,
            'Cannot change the last Owner',
            'The last Owner of a tenant cannot be demoted — invite another Owner first.',
          );
        }
        // Unreachable in this story (no user delete), but fail closed.
        throw new ProblemException(
          'not-found',
          404,
          'User not found',
          'No user with this id exists in this tenant.',
        );
      }
      const updated = toUserView(updatedRows[0]!);
      // Story 6-1a — a changed role ends the user's web sessions: their next
      // request signs in again under the new role.
      if (target.role !== command.role) {
        await revokeSessionsInTx(tx, command.tenantId, { userId: target.id, kinds: ['web'] }, 'role-changed');
        // Story 6-1b — a role change ends any sign-in in progress (a promotion
        // to owner must meet the enrolment step on the next one).
        await clearOpenChallengesInTx(tx, command.tenantId, target.id);
      }

      await insertAuditRow(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'user.role_changed',
        targetType: 'user',
        targetId: command.targetUserId,
        reference: idempotencyKey,
      });

      // In-transaction outbox append (AD-7) — suppression parity: the
      // idempotent replay returned above, so a replayed role change writes
      // no second outbox row.
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'user.role_changed',
        occurredAt: nowIso(),
        payload: {
          userId: updated.id,
          role: updated.role,
        },
      });

      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          key: idempotencyKey,
          payloadHash,
          responseSnapshot: { user: updated },
        });
      } catch (err) {
        if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
          throw concurrentIdempotency();
        }
        throw err;
      }
      return updated;
    });

    return snapshot;
  }

  /**
   * Accept-invite (unauthenticated, cross-tenant by nature): the raw token
   * hashes to the stored sha256 digest; the lookup runs on the AUTH_DATABASE
   * connection (BYPASSRLS — same reasoning as sign-in), and the credential +
   * status flip happens in the invited user's own tenant transaction.
   * Unknown / used / expired tokens (and tokens offered on the wrong
   * tenant's URL) are one indistinguishable 400 `invite-invalid`. The
   * idempotency fingerprint covers the tenant + token — never password
   * material (same discipline as registration).
   */
  async acceptInvite(command: AcceptInviteInput, idempotencyKey: string): Promise<AcceptInviteSnapshot> {
    const tokenHash = hashInviteToken(command.token);
    const payloadHash = hashCommandPayload({ tenantId: command.tenantId, token: command.token });

    // Auth-time replay lookup — BYPASSRLS connection (the invitee has no
    // session yet), but scoped to the TENANT the path names. Idempotency keys
    // are unique per `(tenant_id, key)`, not per key, so a lookup on `key`
    // alone reads another tenant's row: with a matching payload hash it would
    // return that tenant's snapshot as a 200 while flipping nobody — leaving
    // this invitee `invited`, so their next sign-in answers 403
    // `invite-pending` — and with a differing hash it 422s on a key this
    // tenant never used, which also leaks that the key exists elsewhere.
    // Registration's twin lookup stays key-only because it genuinely has no
    // tenant yet; accept-invite always does.
    const existing = await this.authDb
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, command.tenantId),
          eq(idempotencyKeys.key, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadHash !== payloadHash) {
        throw idempotencyKeyReuse();
      }
      const stored = existing[0].responseSnapshot as AcceptInviteSnapshot;
      return { user: normaliseUserView(stored.user) };
    }

    const inviteRows = await this.authDb
      .select()
      .from(users)
      .where(eq(users.inviteTokenHash, tokenHash))
      .limit(1);
    const invite = inviteRows[0];
    if (
      !invite ||
      // The token is only valid on the inviting tenant's URL — accepting it
      // through any other tenant's path is one indistinguishable 400.
      invite.tenantId !== command.tenantId ||
      invite.status !== 'invited' ||
      invite.inviteExpiresAt === null ||
      Date.parse(invite.inviteExpiresAt) <= Date.now()
    ) {
      throw inviteInvalid();
    }

    const passwordHash = await hashPassword(command.password);

    const snapshot = await withTenantTransaction(this.db, invite.tenantId, async (tx) => {
      // The UPDATE itself carries every validity condition (review): still
      // `invited`, same token hash, unexpired — so two concurrent accepts of
      // the same token cannot both succeed (the loser's UPDATE matches no
      // rows and answers the same invite-invalid), and an invite that expired
      // between the AUTH read and this transaction is caught here too.
      const updatedRows = await tx
        .update(users)
        .set({
          passwordHash,
          status: 'active',
          inviteTokenHash: null,
          inviteExpiresAt: null,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(users.id, invite.id),
            eq(users.tenantId, invite.tenantId),
            eq(users.status, 'invited'),
            eq(users.inviteTokenHash, tokenHash),
            sql`${users.inviteExpiresAt} is not null and ${users.inviteExpiresAt} > now()`,
          ),
        )
        .returning();
      if (updatedRows.length === 0) {
        // The invite was accepted (or expired/cleared) between the AUTH read
        // and this transaction — one indistinguishable 400.
        throw inviteInvalid();
      }
      const updated = updatedRows[0]!;

      await insertAuditRow(tx, {
        tenantId: invite.tenantId,
        actorUserId: updated.id,
        action: 'user.accepted',
        targetType: 'user',
        targetId: updated.id,
        reference: idempotencyKey,
      });

      const body: AcceptInviteSnapshot = {
        user: {
          id: updated.id,
          email: updated.email,
          role: updated.role,
          status: 'active',
          clientId: updated.clientId,
          createdAt: updated.createdAt,
        },
      };
      // In-transaction outbox append (AD-7) — suppression parity: the
      // auth-time replay lookup returned before this transaction, and a
      // concurrent duplicate accept rolls back whole, so a replayed accept
      // writes no second outbox row.
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: invite.tenantId,
        type: 'user.accepted',
        occurredAt: nowIso(),
        payload: {
          userId: updated.id,
          email: updated.email,
        },
      });
      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: invite.tenantId,
          key: idempotencyKey,
          payloadHash,
          responseSnapshot: body,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
          throw concurrentIdempotency();
        }
        throw err;
      }
      return body;
    });

    return snapshot;
  }

  /**
   * Story 6-1a — offboarding (`users.role_change`, owner). Deactivate: the
   * user can no longer sign in or badge in; EVERY session ends now (web,
   * portal, badge); their device bindings and push registrations clear; a
   * pending invite is cancelled. History, attribution and the audit trail
   * are untouched. The last ACTIVE owner cannot be deactivated (409
   * `last-owner` — self-deactivation included). Reactivate restores the
   * status the deactivation replaced; a never-accepted invitee gets a fresh
   * invite token in the response. A no-op (already in that state) writes
   * nothing but stores the key. `arm` is in the hash, so the two arms never
   * replay each other.
   */
  async setUserStatus(
    command: UserStatusInput & { readonly arm: 'deactivate' | 'reactivate' },
    idempotencyKey: string,
  ): Promise<UserStatusSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: command.arm,
      tenantId: command.tenantId,
      targetUserId: command.targetUserId,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'users.role_change');
      const replayed = await replayUserKey(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed as UserStatusSnapshot;

      // Owner rows first (the demotion's lock order), then the target.
      await lockActiveOwners(tx, command.tenantId);
      const targetRows = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, command.targetUserId), eq(users.tenantId, command.tenantId)))
        .for('update')
        .limit(1);
      const target = targetRows[0];
      if (!target) throw userNotFound();
      const again = await replayUserKey(tx, command.tenantId, idempotencyKey, payloadHash);
      if (again !== null) return again as UserStatusSnapshot;

      let body: UserStatusSnapshot;
      if (command.arm === 'deactivate') {
        if (target.status === 'deactivated') {
          body = { user: toUserView(target) };
        } else {
          if (target.role === 'owner' && target.status === 'active') {
            const others = await tx
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.tenantId, command.tenantId),
                  eq(users.role, 'owner'),
                  eq(users.status, 'active'),
                  sql`${users.id} <> ${target.id}`,
                ),
              )
              .limit(1);
            if (others.length === 0) {
              throw new ProblemException(
                'last-owner',
                409,
                'Cannot deactivate the last Owner',
                'The last active Owner of a tenant cannot be deactivated — make another user an Owner first.',
              );
            }
          }
          const updated = await tx
            .update(users)
            .set({
              status: 'deactivated',
              statusBeforeDeactivation: target.status,
              inviteTokenHash: null,
              inviteExpiresAt: null,
              updatedAt: nowIso(),
            })
            .where(eq(users.id, target.id))
            .returning();
          await revokeSessionsInTx(tx, command.tenantId, { userId: target.id }, 'deactivated');
          // Story 6-1b — and any sign-in in progress.
          await clearOpenChallengesInTx(tx, command.tenantId, target.id);
          await tx
            .update(devices)
            .set({
              operatorUserId: null,
              pushToken: null,
              pushWarehouseId: null,
              pushRegisteredAt: null,
              updatedAt: nowIso(),
            })
            .where(and(eq(devices.tenantId, command.tenantId), eq(devices.operatorUserId, target.id)));
          await insertAuditRow(tx, {
            tenantId: command.tenantId,
            actorUserId: command.actorUserId,
            action: 'user.deactivated',
            targetType: 'user',
            targetId: target.id,
            reference: idempotencyKey,
          });
          body = { user: toUserView(updated[0]!) };
        }
      } else if (target.status !== 'deactivated') {
        body = { user: toUserView(target) };
      } else {
        const restore = target.statusBeforeDeactivation === 'invited' ? 'invited' : 'active';
        const rawToken = restore === 'invited' ? generateInviteToken() : null;
        const expiresAt = rawToken === null ? null : new Date(Date.now() + INVITE_TTL_MS).toISOString();
        const updated = await tx
          .update(users)
          .set({
            status: restore,
            statusBeforeDeactivation: null,
            ...(rawToken === null ? {} : { inviteTokenHash: hashInviteToken(rawToken), inviteExpiresAt: expiresAt }),
            updatedAt: nowIso(),
          })
          .where(eq(users.id, target.id))
          .returning();
        await insertAuditRow(tx, {
          tenantId: command.tenantId,
          actorUserId: command.actorUserId,
          action: 'user.reactivated',
          targetType: 'user',
          targetId: target.id,
          reference: idempotencyKey,
        });
        body =
          rawToken === null
            ? { user: toUserView(updated[0]!) }
            : { user: toUserView(updated[0]!), inviteToken: rawToken, inviteExpiresAt: expiresAt! };
      }
      await storeUserKey(tx, command.tenantId, idempotencyKey, payloadHash, body);
      return body;
    });
  }

  /**
   * Story 6-1a — Unlock (`users.role_change`): clears the sign-in lock on
   * this user's email from every address. Keyed and audited; unlocking an
   * unlocked user is a quiet success (still audited — the owner acted).
   */
  async unlockUser(command: UserStatusInput, idempotencyKey: string): Promise<UserView> {
    const payloadHash = hashCommandPayload({
      arm: 'unlock',
      tenantId: command.tenantId,
      targetUserId: command.targetUserId,
    });
    const body = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'users.role_change');
      const replayed = await replayUserKey(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const targetRows = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, command.targetUserId), eq(users.tenantId, command.tenantId)))
        .limit(1);
      const target = targetRows[0];
      if (!target) throw userNotFound();
      await tx.execute(sql`delete from signin_attempts where email_hash = ${emailDigest(target.email)}`);
      // Story 6-1b — and the two-factor lock (inside this tenant transaction:
      // on a bare connection RLS would match nothing).
      await clearSecondFactorLockInTx(tx, command.tenantId, target.id);
      await insertAuditRow(tx, {
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'user.unlocked',
        targetType: 'user',
        targetId: target.id,
        reference: idempotencyKey,
      });
      const snapshot = { user: { ...toUserView(target), lockedUntil: null } };
      await storeUserKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
      return snapshot;
    });
    return normaliseUserView(body.user);
  }

  /** Cursor list of the tenant's users — a read, open to any tenant member. */
  async list(
    tenantId: string,
    cursor?: string,
    limit: number = DEFAULT_USER_PAGE_SIZE,
  ): Promise<Page<UserView>> {
    const pageSize = Math.min(
      Math.max(Math.trunc(limit) || DEFAULT_USER_PAGE_SIZE, 1),
      MAX_USER_PAGE_SIZE,
    );
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    const rows = await withTenantTransaction(this.db, tenantId, (tx) => {
      const scope = eq(users.tenantId, tenantId);
      return tx
        .select()
        .from(users)
        .where(
          before
            ? and(
                scope,
                sql`(${users.createdAt}, ${users.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
              )
            : scope,
        )
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(pageSize + 1);
    });
    const page = buildPage(rows, pageSize);
    // Story 6-1a — the Team card's Unlock reads `lockedUntil`; story 6-1b —
    // the later of the sign-in lock and the two-factor lock.
    const locks = await signInLockedUntil(this.db, page.items.map((user) => user.email));
    const now = Date.now();
    return {
      items: page.items.map((row) => ({
        ...toUserView(row),
        lockedUntil: laterLock(locks.get(row.email) ?? null, secondFactorLockOf(row.mfaLockedUntil, now)),
        secondFactorEnabled: row.mfaEnabledAt !== null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** The signed-in caller's own user row (`GET …/me`) — a read. */
  async me(tenantId: string, userId: string): Promise<UserView> {
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(users)
        .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
        .limit(1),
    );
    const user = rows[0];
    if (!user) {
      throw new ProblemException(
        'not-found',
        404,
        'User not found',
        'No user with this id exists in this tenant.',
      );
    }
    return toUserView(user);
  }
}

/** Story 6-1b — a permanent two-factor lock (`'infinity'`) reads as the far future: "until an owner unlocks". */
export const PERMANENT_LOCK_INSTANT = '9999-12-31T23:59:59.999Z';

function secondFactorLockOf(lockedUntil: string | null, now: number): string | null {
  if (lockedUntil === null) return null;
  if (lockedUntil === 'infinity') return PERMANENT_LOCK_INSTANT;
  const at = Date.parse(lockedUntil);
  return Number.isNaN(at) || at <= now ? null : new Date(at).toISOString();
}

function laterLock(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function toUserView(row: typeof users.$inferSelect): UserView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status as UserStatus,
    clientId: row.clientId,
    createdAt: row.createdAt,
  };
}

function insertAuditRow(
  tx: TenantTx,
  row: {
    tenantId: string;
    actorUserId: string;
    action: UserAction;
    targetType: string;
    targetId: string;
    reference: string;
  },
): Promise<unknown> {
  return tx.insert(auditEvents).values({
    id: uuidv7(),
    tenantId: row.tenantId,
    actorUserId: row.actorUserId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    reference: row.reference,
    occurredAt: nowIso(),
  });
}

function concurrentIdempotency(): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Concurrent idempotent request',
    'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
  );
}

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  let decoded: { createdAt: string; id: string };
  try {
    decoded = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  if (!UUID_RE.test(decoded.id) || Number.isNaN(Date.parse(decoded.createdAt))) {
    throw invalidCursor();
  }
  return decoded;
}

function invalidCursor(): ProblemException {
  return new ProblemException(
    'invalid-cursor',
    400,
    'Malformed pagination cursor',
    'The cursor parameter is not a valid opaque page cursor.',
  );
}

/** Story 6-1a — lock the tenant's active owner rows (the last-owner guards' serialisation point). */
async function lockActiveOwners(tx: TenantTx, tenantId: string): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, 'owner'), eq(users.status, 'active')))
    .for('update');
}

function userNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'User not found', 'No user with this id exists in this tenant.');
}

async function replayUserKey(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<{ user: UserView } | null> {
  const existing = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, idempotencyKey)))
    .limit(1);
  if (!existing[0]) return null;
  if (existing[0].payloadHash !== payloadHash) throw idempotencyKeyReuse();
  const stored = existing[0].responseSnapshot as { user: UserView };
  return { ...stored, user: normaliseUserView(stored.user) };
}

async function storeUserKey(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
  payloadHash: string,
  body: unknown,
): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({
      id: uuidv7(),
      tenantId,
      key: idempotencyKey,
      payloadHash,
      responseSnapshot: body as Record<string, unknown>,
    });
  } catch (err) {
    if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
      throw concurrentIdempotency();
    }
    throw err;
  }
}
