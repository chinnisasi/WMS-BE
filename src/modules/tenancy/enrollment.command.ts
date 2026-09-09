import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AUTH_DATABASE, DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { auditEvents, devices, idempotencyKeys, users } from '../../shared/db/schema';
import type { UserRole } from '../../shared/db/schema';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { nowIso } from '../../shared/primitives/time';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { generateSecret, seal } from '../../shared/crypto/envelope';
import { hashCommandPayload } from './idempotency-guard';
import { idempotencyKeyReuse } from './registration.command';
import { assertPermission } from './permissions';
import { getMemberRoleIn } from './tenancy.service';
import { DUMMY_HASH, hashPassword, verifyPassword } from './passwords';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import {
  DEVICE_SESSION_TTL_SECONDS,
  signBadgeInSession,
  signDeviceToken,
  tenantSessionSecret,
} from './jwt-session';

export const DEFAULT_DEVICE_PAGE_SIZE = 50;
export const MAX_DEVICE_PAGE_SIZE = 200;
/** One-time enrollment codes are valid for 15 minutes (single redemption). */
export const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const DEVICES_ENROLLMENT_CODE_HASH_UNIQUE = 'devices_enrollment_code_hash_unique';

export type DeviceAction = 'device.enrollment_code_minted' | 'device.enrolled' | 'device.revoked';

/** The device shape the web Settings device list (and revoke) carries. */
export interface DeviceView {
  readonly id: string;
  readonly label: string | null;
  readonly operatorUserId: string | null;
  readonly operatorEmail: string | null;
  readonly status: 'active' | 'revoked';
  readonly wipeFlag: boolean;
  readonly enrolledAt: string | null;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface MintEnrollmentCodeInput {
  readonly tenantId: string;
  readonly actorUserId: string;
}

export interface MintEnrollmentCodeSnapshot {
  readonly code: string;
  readonly expiresAt: string;
}

export interface EnrollDeviceInput {
  /** The tenant whose path the code was offered on (must own the code). */
  readonly tenantId: string;
  /** The one-time enrollment code minted by an authorized user. */
  readonly code: string;
  readonly label: string;
  /** The 4-6 digit badge-in PIN (human decision 2026-09-09) — set at enrollment. */
  readonly pin: string;
}

export interface EnrollDeviceSnapshot {
  readonly device: { readonly id: string; readonly tenantId: string; readonly label: string };
  /** The device-bound credential (device_id claim, 30-day TTL, server-checked). */
  readonly deviceToken: string;
  readonly expiresInSeconds: number;
  /**
   * The offline-store key, generated server-side and sealed under
   * DEVICE_ENCRYPTION_KEY (AES-256-GCM envelope, AD-15 stand-in). Delivered
   * exactly once — the device unwraps it into the device keychain and the
   * server never needs it again (swap-to-KMS documented in envelope.ts).
   */
  readonly offlineStoreKeySealed: string;
}

export interface BadgeInInput {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The badge-in operator (email) — the device's PIN is their credential. */
  readonly operatorEmail: string;
  readonly pin: string;
}

export interface BadgeInSnapshot {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresInSeconds: number;
  readonly operator: { readonly id: string; readonly email: string; readonly role: UserRole };
  readonly device: { readonly id: string; readonly label: string };
}

export interface RevokeDeviceInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly deviceId: string;
}

export interface SelfTestEchoInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly operatorUserId: string;
  /** The queued op payload the device replayed (arbitrary JSON). */
  readonly payload: Record<string, unknown>;
}

export interface SelfTestEchoSnapshot {
  readonly deviceId: string;
  readonly operatorUserId: string;
  readonly echoed: Record<string, unknown>;
  readonly receivedAt: string;
}

export function hashEnrollmentCode(rawCode: string): string {
  return createHash('sha256').update(rawCode, 'utf8').digest('hex');
}

/** Cryptographically strong one-time enrollment code (raw — only the hash is stored). */
export function generateEnrollmentCode(): string {
  return randomBytes(32).toString('base64url');
}

/** The badge-in PIN is exactly 4-6 digits (human decision 2026-09-09). */
export function isValidBadgePin(pin: string): boolean {
  return /^[0-9]{4,6}$/.test(pin);
}

function deviceNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Device not found',
    'No device with this id exists in this tenant.',
  );
}

/** Unknown and revoked devices fail closed identically (the matrix's `device-revoked`). */
export function deviceRevoked(): ProblemException {
  return new ProblemException(
    'device-revoked',
    403,
    'Device is not active',
    'This device is unknown, revoked, or not yet enrolled — enrollment must be redone.',
  );
}

function enrollmentCodeInvalid(): ProblemException {
  return new ProblemException(
    'enrollment-code-invalid',
    400,
    'Enrollment code is unknown, used, or expired',
    'This enrollment code is not valid — mint a fresh one in web Settings.',
  );
}

function badgeInvalid(): ProblemException {
  return new ProblemException(
    'badge-invalid',
    401,
    'Badge-in failed',
    'Unknown operator or wrong PIN.',
  );
}

function concurrentIdempotency(): ProblemException {
  return new ProblemException(
    'conflict',
    409,
    'Concurrent idempotent request',
    'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
  );
}

/**
 * Device lifecycle commands (Story 3.2), tenancy-owned: mint one-time
 * enrollment codes (`device.manage`), the device's unauthenticated enroll
 * (one-time code + label + badge-in PIN → device-bound credential + sealed
 * offline-store key), badge-in (PIN → revocable operator-bound device
 * session), revocation (wipe-flagged, audited, outboxed, idempotent
 * re-revoke), the Settings device-list read, and the device self-test echo
 * the substrate's replay proves against.
 *
 * Invariant order per command (`withTenantTransaction`): assertPermission →
 * idempotency replay → asserts → write → in-tx outbox → idempotency-key
 * snapshot. Authority is re-read from the DB in-transaction — the device
 * token is transport, never authority (fail-closed: every device
 * command re-resolves the device row).
 */
@Injectable()
export class EnrollmentCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_DATABASE) private readonly authDb: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  /**
   * Mints a one-time enrollment code (web Settings, `device.manage`). The
   * mint creates the **pending-redemption device row** (label/operator still
   * null, `enrollment_code_hash` set): redemption is a single conditional
   * UPDATE against that row, so a code cannot be redeemed twice. The raw
   * code's only durable store is this response / its idempotency snapshot —
   * only the sha256 hash lives on the row (the users.invite precedent).
   */
  async mintEnrollmentCode(
    command: MintEnrollmentCodeInput,
    idempotencyKey: string,
  ): Promise<MintEnrollmentCodeSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
    });

    const snapshot = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'device.manage',
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
        return existing[0].responseSnapshot as MintEnrollmentCodeSnapshot;
      }

      const rawCode = generateEnrollmentCode();
      const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MS).toISOString();

      let deviceId: string;
      try {
        const rows = await tx
          .insert(devices)
          .values({
            id: uuidv7(),
            tenantId: command.tenantId,
            enrollmentCodeHash: hashEnrollmentCode(rawCode),
            enrollmentCodeExpiresAt: expiresAt,
          })
          .returning({ id: devices.id });
        deviceId = rows[0]!.id;
      } catch (err) {
        if (isUniqueViolationOn(err, DEVICES_ENROLLMENT_CODE_HASH_UNIQUE)) {
          // Practically unreachable (128-bit random); fail closed, not silent.
          throw concurrentIdempotency();
        }
        throw err;
      }

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'device.enrollment_code_minted',
        targetType: 'device',
        targetId: deviceId,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'device.enrollment_code_minted',
        occurredAt: nowIso(),
        payload: { deviceId, expiresAt },
      });

      const body: MintEnrollmentCodeSnapshot = { code: rawCode, expiresAt };
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

  /**
   * Enroll (unauthenticated, the device app): redeems the one-time code,
   * binds label + operator's badge-in PIN, and delivers the device credential
   * plus the sealed offline-store key. The redemption is a conditional UPDATE
   * carrying every validity condition (hash match, unexpired, unredeemed) —
   * two concurrent redemptions of the same code cannot both succeed, and
   * unknown / expired / already-redeemed codes are one indistinguishable
   * 400 `enrollment-code-invalid`. PIN hashes with the repo's scrypt
   * primitive; account passwords never appear here.
   */
  async enroll(command: EnrollDeviceInput, idempotencyKey: string): Promise<EnrollDeviceSnapshot> {
    const codeHash = hashEnrollmentCode(command.code);
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      code: command.code,
      label: command.label,
      pin: command.pin,
    });

    // Auth-time replay lookup (no tenant context yet) — BYPASSRLS connection,
    // the accept-invite pattern. Replays re-serve the original credential
    // even though the code is now burned.
    const existing = await this.authDb
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, idempotencyKey))
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadHash !== payloadHash) {
        throw idempotencyKeyReuse();
      }
      return existing[0].responseSnapshot as EnrollDeviceSnapshot;
    }

    if (!isValidBadgePin(command.pin)) {
      throw new ProblemException(
        'validation-failed',
        400,
        'PIN must be 4-6 digits',
        'The badge-in PIN must be 4 to 6 digits.',
      );
    }
    const label = command.label.trim();
    if (label.length === 0 || label.length > 100) {
      throw new ProblemException(
        'validation-failed',
        400,
        'Device label required',
        'The device label must be 1-100 characters.',
      );
    }

    const deviceRows = await this.authDb
      .select()
      .from(devices)
      .where(eq(devices.enrollmentCodeHash, codeHash))
      .limit(1);
    const pending = deviceRows[0];
    if (
      !pending ||
      // A code offered on the wrong tenant's path is one indistinguishable
      // 400 — checked BEFORE the burn, so the code survives for its tenant.
      pending.tenantId !== command.tenantId ||
      pending.enrollmentCodeExpiresAt === null ||
      Date.parse(pending.enrollmentCodeExpiresAt) <= Date.now()
    ) {
      throw enrollmentCodeInvalid();
    }

    const pinHash = await hashPassword(command.pin);
    const offlineStoreKey = generateSecret();

    const snapshot = await withTenantTransaction(this.db, pending.tenantId, async (tx) => {
      // The UPDATE itself carries every validity condition — no double-redeem.
      const updatedRows = await tx
        .update(devices)
        .set({
          label,
          pinHash,
          enrolledAt: nowIso(),
          enrollmentCodeHash: null,
          enrollmentCodeExpiresAt: null,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(devices.id, pending.id),
            eq(devices.tenantId, pending.tenantId),
            eq(devices.enrollmentCodeHash, codeHash),
          ),
        )
        .returning();
      if (updatedRows.length === 0) {
        // Redeemed (or expired) between the AUTH read and this transaction —
        // one indistinguishable 400.
        throw enrollmentCodeInvalid();
      }

      const deviceToken = signDeviceToken(pending.tenantId, pending.id, tenantSessionSecret());

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: pending.tenantId,
        type: 'device.enrolled',
        occurredAt: nowIso(),
        payload: { deviceId: pending.id, label },
      });

      const body: EnrollDeviceSnapshot = {
        device: { id: pending.id, tenantId: pending.tenantId, label },
        deviceToken,
        expiresInSeconds: DEVICE_SESSION_TTL_SECONDS,
        offlineStoreKeySealed: seal(offlineStoreKey),
      };
      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: pending.tenantId,
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
   * Badge-in (device credential + operator email + PIN): mints the revocable,
   * operator-bound device session. Wrong operator/PIN is one 401
   * `badge-invalid`; unknown / revoked / not-yet-enrolled devices fail closed
   * with 403 `device-revoked`. The PIN is always paid one scrypt round
   * (DUMMY_HASH fallback) so the rejection is time-indistinguishable. The
   * first badge-in binds the device's operator (`operator_user_id`); later
   * badge-ins must be the same operator (a device is single-operator until
   * re-enrollment). Not a state change beyond the binding + last-seen, so no
   * idempotency key applies (the sign-in pattern).
   */
  async badgeIn(command: BadgeInInput): Promise<BadgeInSnapshot> {
    const snapshot = await withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const deviceRows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.id, command.deviceId), eq(devices.tenantId, command.tenantId)))
        .for('update')
        .limit(1);
      const device = deviceRows[0];
      if (!device || device.status !== 'active' || device.pinHash === null) {
        throw deviceRevoked();
      }

      const email = command.operatorEmail.trim().toLowerCase();
      const operatorRows = await tx
        .select({ id: users.id, email: users.email, role: users.role, status: users.status })
        .from(users)
        .where(and(eq(users.email, email), eq(users.tenantId, command.tenantId)))
        .limit(1);
      const operator = operatorRows[0];

      const pinOk = await verifyPassword(command.pin, device.pinHash ?? DUMMY_HASH);
      const bound =
        operator !== undefined &&
        operator.status === 'active' &&
        (device.operatorUserId === null || device.operatorUserId === operator.id);
      if (!pinOk || !bound) {
        throw badgeInvalid();
      }

      await tx
        .update(devices)
        .set({
          operatorUserId: operator.id,
          lastSeenAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(devices.id, device.id));

      return {
        accessToken: signBadgeInSession(
          command.tenantId,
          device.id,
          operator.id,
          tenantSessionSecret(),
        ),
        tokenType: 'Bearer' as const,
        expiresInSeconds: DEVICE_SESSION_TTL_SECONDS,
        operator: { id: operator.id, email: operator.email, role: operator.role },
        device: { id: device.id, label: device.label ?? '' },
      };
    });
    return snapshot;
  }

  /**
   * Revocation (web Settings, `device.manage`): status flip + revokedAt/
   * revokedBy + wipe flag + audit row + `device.revoked` outbox event, in the
   * one transaction. Effective on the device's next request (every device
   * command re-resolves the row). Re-revoke is idempotent — a second revoke
   * of an already-revoked device re-serves the revoked state without a second
   * audit row or outbox event.
   */
  async revokeDevice(command: RevokeDeviceInput, idempotencyKey: string): Promise<DeviceView> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      deviceId: command.deviceId,
      actorUserId: command.actorUserId,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(
        await getMemberRoleIn(tx, command.tenantId, command.actorUserId),
        'device.manage',
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
        return (existing[0].responseSnapshot as { device: DeviceView }).device;
      }

      const deviceRows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.id, command.deviceId), eq(devices.tenantId, command.tenantId)))
        .for('update')
        .limit(1);
      const device = deviceRows[0];
      if (!device) {
        throw deviceNotFound();
      }

      if (device.status === 'revoked') {
        // Idempotent re-revoke: no second audit row, no second outbox event.
        const body = toDeviceView(device, null);
        try {
          await tx.insert(idempotencyKeys).values({
            id: uuidv7(),
            tenantId: command.tenantId,
            key: idempotencyKey,
            payloadHash,
            responseSnapshot: { device: body },
          });
        } catch (err) {
          if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
            throw concurrentIdempotency();
          }
          throw err;
        }
        return body;
      }

      const updatedRows = await tx
        .update(devices)
        .set({
          status: 'revoked',
          revokedAt: nowIso(),
          revokedBy: command.actorUserId,
          wipeFlag: true,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(devices.id, command.deviceId),
            eq(devices.tenantId, command.tenantId),
            eq(devices.status, 'active'),
          ),
        )
        .returning();
      const updated = updatedRows[0]!;

      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId: command.tenantId,
        actorUserId: command.actorUserId,
        action: 'device.revoked',
        targetType: 'device',
        targetId: command.deviceId,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });

      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId: command.tenantId,
        type: 'device.revoked',
        occurredAt: nowIso(),
        payload: { deviceId: command.deviceId, wipeFlag: true },
      });

      const body = toDeviceView(updated, null);
      try {
        await tx.insert(idempotencyKeys).values({
          id: uuidv7(),
          tenantId: command.tenantId,
          key: idempotencyKey,
          payloadHash,
          responseSnapshot: { device: body },
        });
      } catch (err) {
        if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
          throw concurrentIdempotency();
        }
        throw err;
      }
      return body;
    });
  }

  /** The tenant's enrolled devices — a read, open to any tenant member. */
  async list(
    tenantId: string,
    cursor?: string,
    limit: number = DEFAULT_DEVICE_PAGE_SIZE,
  ): Promise<Page<DeviceView>> {
    const pageSize = Math.min(
      Math.max(Math.trunc(limit) || DEFAULT_DEVICE_PAGE_SIZE, 1),
      MAX_DEVICE_PAGE_SIZE,
    );
    const before = cursor === undefined ? undefined : decodeCursorSafe(cursor);
    const rows = await withTenantTransaction(this.db, tenantId, (tx) => {
      const scope = and(
        eq(devices.tenantId, tenantId),
        // The Settings list shows enrolled devices; pending-redemption rows
        // (still carrying an unredeemed code hash) are not devices yet.
        isNull(devices.enrollmentCodeHash),
      );
      return tx
        .select({ device: devices, operatorEmail: users.email })
        .from(devices)
        .leftJoin(users, eq(users.id, devices.operatorUserId))
        .where(
          before
            ? and(
                scope,
                sql`(${devices.createdAt}, ${devices.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
              )
            : scope,
        )
        .orderBy(desc(devices.createdAt), desc(devices.id))
        .limit(pageSize + 1);
    });
    const page = buildPage(rows.map((row) => toDeviceView(row.device, row.operatorEmail)), pageSize);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  /**
   * Device self-test echo (Story 3.2): the substrate's replay target — the
   * device replays a queued self-test op here, the server echoes it back.
   * Every call re-resolves the device row (fail-closed 403
   * `device-revoked`) and re-reads the badge-in operator's role from the DB
   * (a demoted operator is 403 `role-denied` — the token is transport,
   * never authority, AD-4). Idempotent per client ULID key through the same
   * `(tenant_id, key)` de-dupe as every mutating command, so replayed ops
   * settle exactly once; a replayed op under a revoked device never reaches
   * here (the client quarantines it with session attribution).
   */
  async selfTestEcho(
    command: SelfTestEchoInput,
    idempotencyKey: string,
  ): Promise<SelfTestEchoSnapshot> {
    const payloadHash = hashCommandPayload({
      tenantId: command.tenantId,
      deviceId: command.deviceId,
      operatorUserId: command.operatorUserId,
      payload: command.payload,
    });

    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      const deviceRows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.id, command.deviceId), eq(devices.tenantId, command.tenantId)))
        .for('update')
        .limit(1);
      const device = deviceRows[0];
      if (!device || device.status !== 'active' || device.pinHash === null) {
        throw deviceRevoked();
      }

      // Role re-read from the DB per command — floor devices are operator
      // surfaces; a demoted-to-accountant operator is denied per command.
      const roleRows = await tx
        .select({ role: users.role })
        .from(users)
        .where(and(eq(users.id, command.operatorUserId), eq(users.tenantId, command.tenantId)))
        .limit(1);
      const role = roleRows[0]?.role;
      if (role === undefined || role === 'accountant') {
        throw new ProblemException(
          'role-denied',
          403,
          'Role lacks the required capability',
          `Role "${role ?? 'none'}" cannot operate a floor device.`,
        );
      }

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
        return existing[0].responseSnapshot as SelfTestEchoSnapshot;
      }

      await tx
        .update(devices)
        .set({ lastSeenAt: nowIso(), updatedAt: nowIso() })
        .where(eq(devices.id, command.deviceId));

      const body: SelfTestEchoSnapshot = {
        deviceId: command.deviceId,
        operatorUserId: command.operatorUserId,
        echoed: command.payload,
        receivedAt: nowIso(),
      };
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
  }
}

function toDeviceView(row: typeof devices.$inferSelect, operatorEmail: string | null): DeviceView {
  return {
    id: row.id,
    label: row.label,
    operatorUserId: row.operatorUserId,
    operatorEmail,
    status: row.status as 'active' | 'revoked',
    wipeFlag: row.wipeFlag,
    enrolledAt: row.enrolledAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
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