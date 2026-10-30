import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auditEvents, freightConsignments, freightLoadScans, type FreightLoad } from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { normalizeCourierInput, type NormalizedCourier } from '../../shared/primitives/courier';
import { normalizePhone, PHONE_RE } from '../../shared/primitives/phone';
import { normalizeVehicleNo, VEHICLE_NO_RE } from '../../shared/primitives/vehicle';
import {
  DRIVER_LICENCE_RE,
  FREIGHT_LIMITS,
  FREIGHT_MODES,
  FREIGHT_TERMS,
  lrProblem,
  normalizeDriverLicence,
  normalizeLr,
  normalizeSeal,
  SEAL_RE,
  VEHICLE_TYPES,
  type FreightMode,
  type FreightTerms,
  type VehicleType,
} from '../../shared/primitives/freight';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { validation } from './shipping-support';

/**
 * Story 4-9a — the freight commands' shared shape rules (400s above the
 * transaction), their problem constructors and the small writes several
 * commands share (removing a consignment and unloading its scans).
 */

export const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The gate-in's container rule (`CONTAINER_NO_RE`, gate-in.command.ts). */
export const CONTAINER_NO_RE = /^[A-Z0-9]{1,11}$/;
export const DOCK_DOOR_RE = /^[A-Z0-9-]{1,20}$/;

/** A9 / A14 — the business-time windows: `[now − 7 days, now + 2 minutes]`. */
export const FREIGHT_PAST_MS = 7 * 86_400_000;
export const FREIGHT_FUTURE_MS = 2 * 60_000;

export interface NormalizedLoadHeader {
  readonly mode: FreightMode;
  readonly transporter: NormalizedCourier;
  readonly vehicleType: VehicleType | null;
  readonly vehicleNumber: string | null;
  readonly containerNumber: string | null;
  readonly vehicleCapacityKg: number | null;
  readonly driverName: string | null;
  readonly driverPhone: string | null;
  readonly driverLicenceNumber: string | null;
  readonly dockDoor: string | null;
  readonly vehicleReportedAt: string | null;
  readonly note: string | null;
}

export interface LoadHeaderInput {
  readonly mode?: unknown;
  readonly transporter?: { readonly transporterId?: string | null; readonly name?: string | null } | null;
  readonly vehicleType?: string | null;
  readonly vehicleNumber?: string | null;
  readonly containerNumber?: string | null;
  readonly vehicleCapacityKg?: number | null;
  readonly driverName?: string | null;
  readonly driverPhone?: string | null;
  readonly driverLicenceNumber?: string | null;
  readonly dockDoor?: string | null;
  readonly vehicleReportedAt?: string | null;
  readonly note?: string | null;
}

export function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validation(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > max) throw validation(`${field} must be at most ${max} characters.`);
  return trimmed;
}

export function optionalInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !INSTANT_RE.test(value) || Number.isNaN(Date.parse(value))) throw validation(`${field} must be an ISO-8601 instant.`);
  return new Date(Date.parse(value)).toISOString();
}

export function normalizeVehicle(raw: unknown, field = 'vehicleNumber'): string | null {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw validation(`${field} must be text.`);
  const vehicle = normalizeVehicleNo((raw as string | null | undefined) ?? null);
  if (vehicle !== null && !VEHICLE_NO_RE.test(vehicle)) throw validation(`${field} must be 4–15 letters or digits (e.g. KA01AB1234).`);
  return vehicle;
}

export function normalizeContainer(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw validation('containerNumber must be text.');
  const value = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (value === '') return null;
  if (!CONTAINER_NO_RE.test(value)) throw validation('containerNumber must be 1–11 letters or digits (e.g. MSCU1234567).');
  return value;
}

export function normalizeVehicleType(raw: unknown): VehicleType | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !(VEHICLE_TYPES as readonly string[]).includes(raw)) {
    throw validation(`vehicleType must be one of ${VEHICLE_TYPES.join(', ')}.`);
  }
  return raw as VehicleType;
}

export function normalizeDriverPhone(raw: unknown): string | null {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw validation('driverPhone must be text.');
  const phone = normalizePhone((raw as string | null | undefined) ?? null);
  if (phone !== null && !PHONE_RE.test(phone)) throw validation('driverPhone must be 7–15 digits, optionally with a leading +.');
  return phone;
}

export function normalizeLicence(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw validation('driverLicenceNumber must be text.');
  const value = normalizeDriverLicence(raw);
  if (value === '') return null;
  if (!DRIVER_LICENCE_RE.test(value)) throw validation('driverLicenceNumber must be 6–20 letters or digits.');
  return value;
}

export function normalizeLoadHeader(input: LoadHeaderInput): NormalizedLoadHeader {
  if (typeof input.mode !== 'string' || !(FREIGHT_MODES as readonly string[]).includes(input.mode)) {
    throw validation(`mode must be one of ${FREIGHT_MODES.join(', ')}.`);
  }
  const rawTransporter = input.transporter ?? {};
  if (typeof rawTransporter !== 'object') throw validation('transporter must be an object {transporterId} or {name}.');
  let transporter: NormalizedCourier;
  try {
    transporter = normalizeCourierInput({ transporterId: rawTransporter.transporterId, courierName: rawTransporter.name });
  } catch {
    throw validation('Name the transporter: choose a transporter partner (transporter.transporterId) or type its name (transporter.name, 1–100 characters) — exactly one.');
  }
  const capacity = input.vehicleCapacityKg ?? null;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > FREIGHT_LIMITS.capacityKgMax)) {
    throw validation(`vehicleCapacityKg must be a whole number of kilograms, 1–${FREIGHT_LIMITS.capacityKgMax}.`);
  }
  const dockRaw = input.dockDoor;
  let dockDoor: string | null = null;
  if (dockRaw !== undefined && dockRaw !== null) {
    if (typeof dockRaw !== 'string') throw validation('dockDoor must be text.');
    const value = dockRaw.trim().toUpperCase();
    if (value !== '') {
      if (!DOCK_DOOR_RE.test(value)) throw validation('dockDoor must be 1–20 letters, digits or hyphens (e.g. D-3).');
      dockDoor = value;
    }
  }
  return {
    mode: input.mode as FreightMode,
    transporter,
    vehicleType: normalizeVehicleType(input.vehicleType),
    vehicleNumber: normalizeVehicle(input.vehicleNumber),
    containerNumber: normalizeContainer(input.containerNumber),
    vehicleCapacityKg: capacity,
    driverName: optionalText(input.driverName, 'driverName', FREIGHT_LIMITS.driverName),
    driverPhone: normalizeDriverPhone(input.driverPhone),
    driverLicenceNumber: normalizeLicence(input.driverLicenceNumber),
    dockDoor,
    vehicleReportedAt: optionalInstant(input.vehicleReportedAt, 'vehicleReportedAt'),
    note: optionalText(input.note, 'note', FREIGHT_LIMITS.note),
  };
}

/** The header's hash fields, in a fixed order (A9). */
export function loadHeaderHash(header: NormalizedLoadHeader): Record<string, unknown> {
  return {
    mode: header.mode,
    transporterId: header.transporter.transporterId,
    transporterName: header.transporter.courierName,
    vehicleType: header.vehicleType,
    vehicleNumber: header.vehicleNumber,
    containerNumber: header.containerNumber,
    vehicleCapacityKg: header.vehicleCapacityKg,
    driverName: header.driverName,
    driverPhone: header.driverPhone,
    driverLicenceNumber: header.driverLicenceNumber,
    dockDoor: header.dockDoor,
    vehicleReportedAt: header.vehicleReportedAt,
    note: header.note,
  };
}

export function requiredReason(raw: unknown, field = 'reason'): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < 1 || [...reason].length > FREIGHT_LIMITS.reason) throw validation(`${field} must be 1–${FREIGHT_LIMITS.reason} characters.`);
  return reason;
}

export function normalizeOrderIds(raw: unknown, field: string, min: number, max: number): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) throw validation(`${field} must list ${min}–${max} order ids.`);
  const seen = new Set<string>();
  return raw.map((value: unknown, index) => {
    const id = typeof value === 'string' ? value.toLowerCase() : '';
    if (!UUID_RE.test(id)) throw validation(`${field}[${index}] must be a uuid.`);
    if (seen.has(id)) throw validation(`${field}[${index}]: order ${id} is listed twice.`);
    seen.add(id);
    return id;
  });
}

export function normalizeSeals(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > FREIGHT_LIMITS.seals) throw validation(`seals must list at most ${FREIGHT_LIMITS.seals} seal numbers.`);
  const seen = new Set<string>();
  return raw.map((value: unknown, index) => {
    if (typeof value !== 'string') throw validation(`seals[${index}] must be text.`);
    const seal = normalizeSeal(value);
    if (!SEAL_RE.test(seal)) throw validation(`seals[${index}] must be 1–${FREIGHT_LIMITS.sealLength} letters, digits, "/" or "-".`);
    if (seen.has(seal)) throw validation(`seals[${index}]: seal ${seal} is listed twice.`);
    seen.add(seal);
    return seal;
  });
}

export interface NormalizedLr {
  readonly lrNumber: string | null;
  readonly lrDate: string | null;
  readonly freightTerms: FreightTerms | null;
}

export function normalizeLrInput(raw: { lrNumber?: unknown; lrDate?: unknown; freightTerms?: unknown }, field: string): NormalizedLr {
  let lrNumber: string | null = null;
  if (raw.lrNumber !== undefined && raw.lrNumber !== null && String(raw.lrNumber).trim() !== '') {
    if (typeof raw.lrNumber !== 'string') throw validation(`${field}.lrNumber must be text.`);
    lrNumber = normalizeLr(raw.lrNumber);
    const problem = lrProblem(lrNumber);
    if (problem !== null) throw validation(`${field}.lrNumber: ${problem}`);
  }
  let lrDate: string | null = null;
  if (raw.lrDate !== undefined && raw.lrDate !== null && raw.lrDate !== '') {
    // A real calendar date: `2026-02-30` parses (Date rolls it to March 2) but is no date — the round trip refuses it.
    if (typeof raw.lrDate !== 'string' || !ISO_DATE_RE.test(raw.lrDate) || Number.isNaN(Date.parse(`${raw.lrDate}T00:00:00Z`)) || new Date(`${raw.lrDate}T00:00:00Z`).toISOString().slice(0, 10) !== raw.lrDate) {
      throw validation(`${field}.lrDate must be an ISO date (YYYY-MM-DD).`);
    }
    lrDate = raw.lrDate;
  }
  let freightTerms: FreightTerms | null = null;
  if (raw.freightTerms !== undefined && raw.freightTerms !== null && raw.freightTerms !== '') {
    if (typeof raw.freightTerms !== 'string' || !(FREIGHT_TERMS as readonly string[]).includes(raw.freightTerms)) {
      throw validation(`${field}.freightTerms must be one of ${FREIGHT_TERMS.join(', ')}.`);
    }
    freightTerms = raw.freightTerms as FreightTerms;
  }
  return { lrNumber, lrDate, freightTerms };
}

export function normalizePhotoRefs(raw: unknown, surface: 'web' | 'device'): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw validation('photoRefs must be an array of photo ULIDs.');
  if (raw.length === 0) return [];
  if (surface === 'web') throw validation('photoRefs are the handheld’s — upload the signed loading sheet on the load instead.');
  if (raw.length > 10) throw validation('photoRefs: at most 10 photos.');
  for (const ref of raw) if (typeof ref !== 'string' || !ULID_RE.test(ref)) throw validation('photoRefs must be photo ULIDs.');
  if (new Set(raw).size !== raw.length) throw validation('photoRefs lists a photo twice.');
  return [...(raw as string[])];
}

// ── problems ─────────────────────────────────────────────────────────────

export function loadNotFound(loadId: string): ProblemException {
  return new ProblemException('not-found', 404, 'Freight load not found', `No freight load with id "${loadId}" exists in this tenant.`);
}

export function loadNotOpen(load: FreightLoad): ProblemException {
  return new ProblemException(
    'load-not-open',
    409,
    'The load is not open',
    `${load.code} is ${load.status} — only an open load is changed.`,
    { loadCode: load.code, loadStatus: load.status },
  );
}

export function loadStateRefusal(load: FreightLoad): ProblemException | null {
  if (load.status === 'dispatched') {
    return new ProblemException('load-dispatched', 409, 'The truck has left', `${load.code} was already dispatched${load.dispatchedAt === null ? '' : ` at ${load.dispatchedAt}`}.`, {
      loadCode: load.code,
      dispatchedAt: load.dispatchedAt,
      dispatchedBy: load.dispatchedBy,
    });
  }
  if (load.status === 'cancelled') {
    return new ProblemException('load-cancelled', 409, 'The load was cancelled', `${load.code} was cancelled — ${load.cancelReason ?? 'no reason recorded'}.`, { loadCode: load.code });
  }
  return null;
}

export function warehouseMismatch(load: FreightLoad): ProblemException {
  return new ProblemException('warehouse-mismatch', 409, 'Another warehouse’s load', `${load.code} is another warehouse’s truck — refresh the device.`, { loadCode: load.code });
}

/** §7g — a review row's op id: derived from the key, never the key. */
export function derivedOpId(idempotencyKey: string, salt: string): string {
  const digest = createHash('sha256').update(`${idempotencyKey}:${salt}`).digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = idempotencyKey.slice(0, 10).toUpperCase().padEnd(10, '0') + tail;
  if (derived !== idempotencyKey) return derived;
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}

/** The LD- code sequence's advisory-lock key text (the RTV allocator shape). */
export function freightLoadSequenceLockKey(tenantId: string): string {
  return `${tenantId}:freight-load-seq`;
}

// ── shared writes ───────────────────────────────────────────────────────

/**
 * Remove planned consignments (conditional on `planned`) and unload their
 * `loaded` scans with the same reason. Returns the ids actually removed.
 * A64 — the caller writes unstamped (the scans are staff-only).
 */
export async function removeConsignmentsInTx(
  tx: TenantTx,
  input: { readonly tenantId: string; readonly consignmentIds: readonly string[]; readonly actorUserId: string; readonly reason: string; readonly at: string },
): Promise<{ removed: string[]; unloaded: number }> {
  if (input.consignmentIds.length === 0) return { removed: [], unloaded: 0 };
  const reason = [...input.reason].slice(0, FREIGHT_LIMITS.reason).join('');
  const removed = await tx
    .update(freightConsignments)
    .set({ status: 'removed', removedAt: input.at, removedBy: input.actorUserId, removeReason: reason, updatedAt: input.at })
    .where(and(eq(freightConsignments.tenantId, input.tenantId), inArray(freightConsignments.id, [...input.consignmentIds]), eq(freightConsignments.status, 'planned')))
    .returning({ id: freightConsignments.id });
  const ids = removed.map((row) => row.id);
  if (ids.length === 0) return { removed: [], unloaded: 0 };
  const unloaded = await tx
    .update(freightLoadScans)
    .set({ status: 'unloaded', unloadedAt: input.at, unloadedBy: input.actorUserId, unloadReason: reason })
    .where(and(eq(freightLoadScans.tenantId, input.tenantId), inArray(freightLoadScans.consignmentId, ids), eq(freightLoadScans.status, 'loaded')))
    .returning({ id: freightLoadScans.id });
  return { removed: ids, unloaded: unloaded.length };
}

/**
 * A19, A45, A64 — the cancels' freight arm: the order's planned consignment
 * `FOR UPDATE` (after the order lock — the global order) → `removed` ("Order
 * cancelled"), its loaded scans unloaded, one `freight_load.order_removed`
 * audit row under the cancel's key. Asserts the transaction is unstamped (the
 * scans are staff-only — a client stamp would silently skip them).
 */
export async function removeFromFreightOnCancelInTx(
  tx: TenantTx,
  input: { readonly tenantId: string; readonly orderId: string; readonly actorUserId: string; readonly at: string; readonly idempotencyKey: string },
): Promise<void> {
  const rows = await tx
    .select()
    .from(freightConsignments)
    .where(and(eq(freightConsignments.tenantId, input.tenantId), eq(freightConsignments.orderId, input.orderId), eq(freightConsignments.status, 'planned')))
    .limit(1)
    .for('update');
  const consignment = rows[0];
  if (consignment === undefined) return;
  await assertUnstampedInTx(tx);
  const { unloaded } = await removeConsignmentsInTx(tx, {
    tenantId: input.tenantId,
    consignmentIds: [consignment.id],
    actorUserId: input.actorUserId,
    reason: 'Order cancelled',
    at: input.at,
  });
  await tx.insert(auditEvents).values({
    id: uuidv7(),
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: 'freight_load.order_removed',
    targetType: 'freight_load',
    targetId: consignment.loadId,
    reference: input.idempotencyKey,
    changes: { orderId: input.orderId, reason: 'Order cancelled', stopSeq: consignment.stopSeq, unloadedScans: unloaded },
    occurredAt: input.at,
  });
}

/** A64 — a freight write must run unstamped (the load and its scans are staff-only). */
export async function assertUnstampedInTx(tx: TenantTx): Promise<void> {
  const rows = (await tx.execute(sql`select coalesce(current_setting('app.client_id', true), '') as client`)) as unknown as { client: string }[];
  if ((rows[0]?.client ?? '') !== '') {
    throw new Error('A freight write ran inside a client-stamped transaction — the load and its scans are staff-only (A64).');
  }
}
