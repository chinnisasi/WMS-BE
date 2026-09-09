import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, idempotencyKeys, users } from '../../shared/db/schema';
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
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';

export const DEFAULT_USER_PAGE_SIZE = 50;
export const MAX_USER_PAGE_SIZE = 200;
/** One-time invite links are valid for 7 days (spec 1.5). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const USERS_EMAIL = 'users_email_unique';
const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

export type UserAction = 'user.invited' | 'user.role_changed' | 'user.accepted';

/** The user shape every users response carries — never password material. */
export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: string;
}

export interface InviteUserInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly email: string;
  readonly role: UserRole;
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
    readonly createdAt: string;
  };
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
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      email,
      role: command.role,
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
        return existing[0].responseSnapshot as InviteUserSnapshot;
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
        return (existing[0].responseSnapshot as { user: UserView }).user;
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

      // Atomic last-Owner guard (review): the role UPDATE itself refuses to
      // demote a tenant's last Owner — the owner count is a subquery inside
      // the UPDATE's where clause, evaluated in the same statement, and a
      // demotion that matches no rows answers 409 `last-owner` with nothing
      // persisted. The owner rows are locked FOR UPDATE first because under
      // READ COMMITTED two concurrent demotions of *different* owners would
      // each count 2 from their own snapshot; the row locks make the second
      // transaction re-read the freshly demoted row before its count runs.
      const demotingLastOwner = target.role === 'owner' && command.role !== 'owner';
      if (demotingLastOwner) {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.tenantId, command.tenantId), eq(users.role, 'owner')))
          .for('update');
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
                  where owner_rows.tenant_id = ${users.tenantId} and owner_rows.role = 'owner')`
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

    // Auth-time replay lookup (no tenant context yet) — BYPASSRLS connection.
    const existing = await this.authDb
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idempotencyKey))
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadHash !== payloadHash) {
        throw idempotencyKeyReuse();
      }
      return existing[0].responseSnapshot as AcceptInviteSnapshot;
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
    const page = buildPage(rows.map(toUserView), pageSize);
    return { items: page.items, nextCursor: page.nextCursor };
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

function toUserView(row: typeof users.$inferSelect): UserView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status as UserStatus,
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