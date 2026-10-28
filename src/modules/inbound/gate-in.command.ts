import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import {
  advanceShipmentNotices,
  auditEvents,
  dockAppointments,
  gateInDocuments,
  gateIns,
  idempotencyKeys,
  purchaseOrders,
  type DockAppointmentRow,
  type GateInRow,
} from '../../shared/db/schema';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { OUTBOX_SINK } from '../../shared/events/outbox.seam';
import type { OutboxSink } from '../../shared/events/outbox.seam';
import { UUID_RE, uuidv7 } from '../../shared/primitives/ids';
import { isInstant } from '../../shared/primitives/instant-range';
import { PHONE_RE, normalizePhone } from '../../shared/primitives/phone';
import { addIsoDays, canonicalInstant, isIsoDate, istDateOf, istMidnightOf, nowIso } from '../../shared/primitives/time';
import { EWB_NO_RE, VEHICLE_NO_RE, normalizeVehicleNo } from '../../shared/primitives/vehicle';
import { ProblemException, isUniqueViolationOn } from '../../shared/problem-details/problem.exception';
import { assertTransporterInTx, type TransporterSnapshotV1 } from '../partners/partners.facade';
import { assertDeviceOperatorInTx, touchDeviceInTx } from '../tenancy/device-operator';
import { hashCommandPayload } from '../tenancy/idempotency-guard';
import { assertPermission } from '../tenancy/permissions';
import { idempotencyKeyReuse } from '../tenancy/registration.command';
import { assertWarehouseInTenant, getMemberRoleIn } from '../tenancy/tenancy.service';
import { documentWarehouseMismatch } from './receiving.command';
import { gateInViewInTx, outboxGateIn, type GateInView } from './gate-in.read';
import { appointmentClosed, appointmentNotFound, windowLabel } from './dock-appointment.command';
import { dockAppointmentViewInTx, outboxAppointment, type DockAppointmentView } from './dock.read';

// ── the vocabularies (IMPLEMENTATION-GUIDE §4 — mirrored by 0086's CHECKs) ────

/** Decision 7 — the visit's lifecycle; gate-out closes it. */
export const GATE_IN_STATUSES = ['gated_in', 'unloading', 'unloaded', 'gated_out'] as const;
export type GateInStatus = (typeof GATE_IN_STATUSES)[number];

/** Decision 8 — a broken seal is shown, never blocked; `none` = no seal on the vehicle. */
export const SEAL_STATUSES = ['intact', 'broken', 'none'] as const;
export type SealStatus = (typeof SEAL_STATUSES)[number];

/** Decision 3 — the supplier documents a truck carries. */
export const GATE_IN_DOCUMENT_KINDS = ['invoice', 'challan', 'bill_of_entry'] as const;
export type GateInDocumentKind = (typeof GATE_IN_DOCUMENT_KINDS)[number];

/** The two unload records — one command behind two controller entries. */
export const UNLOAD_PHASES = ['start', 'end'] as const;
export type UnloadPhase = (typeof UNLOAD_PHASES)[number];

/** The bounds the command answers as named 400s (the CHECKs are the backstop). */
export const GATE_IN_LIMITS = {
  documents: 20,
  documentNumber: 40,
  transporterName: 80,
  lrNumber: 30,
  driverName: 80,
  sealNumber: 120,
  dockDoor: 20,
  packages: 1_000_000,
} as const;

const CONTAINER_NO_RE = /^[A-Z0-9]{1,11}$/;

/** Decision 16 — the fields an amend may no longer change once the unload ended. */
export const LOCKED_AFTER_UNLOAD = ['sealStatus', 'sealNumber', 'packagesDeclared'] as const;

/** A web-supplied time more than this far ahead of the server clock is refused 400 `time-in-future`. */
export const GATE_IN_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The command's clock (IMPLEMENTATION-GUIDE §7c): every "now" — the default
 * times, the future bound, a document date's "today in IST" — reads it, so a
 * test can move it. Tests ASSIGN `gateInClock.now` and restore it.
 */
export const gateInClock = { now: (): number => Date.now() };

const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';
const GATE_IN_CODE_UNIQUE = 'gate_ins_tenant_code_unique';

// ── command inputs ────────────────────────────────────────────────────────────

export interface GateInDocumentInput {
  readonly kind: string;
  readonly number: string;
  /** `YYYY-MM-DD` as typed (never an instant — D7). */
  readonly documentDate: string;
  readonly ewayBillNo?: string | null | undefined;
  readonly poId?: string | null | undefined;
  readonly asnId?: string | null | undefined;
}

/** The header a create sends, and an amend replaces in full (absent = null). */
export interface GateInHeaderInput {
  readonly handDelivery?: boolean | null | undefined;
  readonly vehicleNo?: string | null | undefined;
  readonly containerNo?: string | null | undefined;
  readonly transporterPartnerId?: string | null | undefined;
  readonly transporterName?: string | null | undefined;
  readonly lrNumber?: string | null | undefined;
  readonly driverName?: string | null | undefined;
  readonly driverPhone?: string | null | undefined;
  readonly sealStatus: string;
  readonly sealNumber?: string | null | undefined;
  readonly packagesDeclared?: number | null | undefined;
  readonly dockDoor?: string | null | undefined;
  /** Create: absent = now (after the replay lookup). Amend: absent = unchanged. */
  readonly gatedInAt?: string | null | undefined;
  readonly documents?: readonly GateInDocumentInput[] | null | undefined;
  /**
   * Story 2-3b (decision 8, A2) — the dock appointment this visit keeps. The
   * ONE header field where absent ≠ null on an amend: `undefined` (an older
   * client that never saw the field) leaves the link unchanged, `null`
   * clears it (the appointment returns to `booked`), an id moves it. Hashed
   * as received and LAST, so `JSON.stringify` drops an absent one and every
   * pre-2-3b hash keeps its bytes.
   */
  readonly appointmentId?: string | null | undefined;
}

export interface CreateGateInCommand extends GateInHeaderInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly warehouseId: string;
}

export interface AmendGateInCommand extends GateInHeaderInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly gateInId: string;
}

export interface UnloadGateInCommand {
  readonly tenantId: string;
  /** The web session's user, or the device's badged operator. */
  readonly actorUserId: string;
  /** Set on the device entry (the handheld's `gate-in.unload`), null on the web. */
  readonly deviceId: string | null;
  readonly gateInId: string;
  readonly phase: string;
  /** Device: required, taken as sent. Web: absent = now; bounded and ordered. */
  readonly occurredAt?: string | null | undefined;
  /** Required with `end`, refused with `start`. */
  readonly packagesCounted?: number | null | undefined;
}

export interface GateOutCommand {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly gateInId: string;
  readonly gatedOutAt?: string | null | undefined;
}

// ── snapshots ─────────────────────────────────────────────────────────────────

export interface GateInSnapshot {
  readonly gateIn: GateInView;
}

/** The unload's answer: `applied: false` when every column it would fill was already recorded. */
export interface GateInUnloadSnapshot {
  readonly applied: boolean;
  readonly gateIn: GateInView;
}

// ── the shape (behind the replay lookup — spec step 3) ────────────────────────

interface NormalizedDocument {
  readonly kind: GateInDocumentKind;
  readonly number: string;
  readonly documentDate: string;
  readonly ewayBillNo: string | null;
  readonly poId: string | null;
  readonly asnId: string | null;
}

interface NormalizedHeader {
  readonly handDelivery: boolean;
  readonly vehicleNo: string | null;
  readonly containerNo: string | null;
  readonly transporterPartnerId: string | null;
  readonly transporterName: string | null;
  readonly lrNumber: string | null;
  readonly driverName: string | null;
  readonly driverPhone: string | null;
  readonly sealStatus: SealStatus;
  readonly sealNumber: string | null;
  readonly packagesDeclared: number | null;
  readonly dockDoor: string | null;
  /** Canonical UTC, or null when the request carried none. */
  readonly gatedInAt: string | null;
  readonly documents: readonly NormalizedDocument[];
}

function invalid(detail: string): ProblemException {
  return new ProblemException('validation-failed', 400, 'Invalid gate-in', detail);
}

/** Trimmed; blank = null; longer than `max` code points = 400 naming the field. */
function optionalText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > max) throw invalid(`${field} is at most ${max} characters (got ${[...trimmed].length}).`);
  return trimmed;
}

/**
 * A web-supplied instant: real, with a zone, not more than five minutes
 * ahead of the server clock (400 `time-in-future`). Returns canonical UTC.
 */
export function webInstant(value: string, field: string): string {
  if (!isInstant(value)) {
    throw invalid(`${field} must be an ISO-8601 instant with a zone designator (got "${String(value).slice(0, 64)}").`);
  }
  const canonical = canonicalInstant(value);
  if (Date.parse(canonical) > gateInClock.now() + GATE_IN_FUTURE_TOLERANCE_MS) {
    throw new ProblemException(
      'time-in-future',
      400,
      'Time is in the future',
      `${field} (${canonical}) is more than 5 minutes ahead of the server clock — check the time entered.`,
    );
  }
  return canonical;
}

function timeOutOfOrder(detail: string): ProblemException {
  return new ProblemException('time-out-of-order', 400, 'Time out of order', detail);
}

export function gateInNotFound(): ProblemException {
  return new ProblemException('not-found', 404, 'Gate-in not found', 'No gate-in with this id exists in this tenant.');
}

function gateInClosed(code: string): ProblemException {
  return new ProblemException(
    'gate-in-closed',
    409,
    'Gate-in is closed',
    `Gate-in "${code}" is gated out — the visit is closed and takes no further edits.`,
  );
}

function normalizeHeader(input: GateInHeaderInput): NormalizedHeader {
  const handDelivery = input.handDelivery === true;
  if (input.handDelivery !== undefined && input.handDelivery !== null && typeof input.handDelivery !== 'boolean') {
    throw invalid('handDelivery must be true or false.');
  }
  // Decision 13 — the plate as the desk types it, normalised.
  const vehicleNo = normalizeVehicleNo(input.vehicleNo);
  if (vehicleNo === null && !handDelivery) {
    throw invalid('vehicleNo is required — or mark the gate-in a hand delivery (no vehicle).');
  }
  if (vehicleNo !== null && !VEHICLE_NO_RE.test(vehicleNo)) {
    throw invalid(`vehicleNo must be 4–15 letters and digits; spaces, dots and hyphens are ignored (got "${String(input.vehicleNo).slice(0, 40)}").`);
  }
  // Decision 12 — an ISO 6346-style container number, typed.
  const containerRaw = input.containerNo === null || input.containerNo === undefined ? null : String(input.containerNo).replace(/[\s-]+/g, '').toUpperCase();
  const containerNo = containerRaw === '' ? null : containerRaw;
  if (containerNo !== null && !CONTAINER_NO_RE.test(containerNo)) {
    throw invalid(`containerNo must be at most 11 letters and digits (got "${String(input.containerNo).slice(0, 40)}").`);
  }
  // Decision 4 — a transporter partner OR a typed name, exactly one.
  const partnerRaw = input.transporterPartnerId === null || input.transporterPartnerId === undefined ? '' : String(input.transporterPartnerId).trim();
  const transporterPartnerId = partnerRaw === '' ? null : partnerRaw;
  const transporterName = optionalText(input.transporterName, 'transporterName', GATE_IN_LIMITS.transporterName);
  if (transporterPartnerId !== null && transporterName !== null) {
    throw invalid('Name the transporter once — a transporter partner or a typed name, not both.');
  }
  if (transporterPartnerId === null && transporterName === null) {
    throw invalid('A gate-in needs its transporter — pick a transporter partner, or type the name.');
  }
  if (transporterPartnerId !== null && !UUID_RE.test(transporterPartnerId)) {
    throw invalid('transporterPartnerId must be a uuid.');
  }
  const lrNumber = optionalText(input.lrNumber, 'lrNumber', GATE_IN_LIMITS.lrNumber);
  const driverName = optionalText(input.driverName, 'driverName', GATE_IN_LIMITS.driverName);
  const driverPhone = normalizePhone(input.driverPhone);
  if (driverPhone !== null && !PHONE_RE.test(driverPhone)) {
    throw invalid('driverPhone must be 7–15 digits, optionally led by + (spaces, hyphens, dots and brackets are ignored).');
  }
  if (!(SEAL_STATUSES as readonly string[]).includes(input.sealStatus)) {
    throw invalid(`sealStatus must be one of ${JSON.stringify(SEAL_STATUSES)} (got "${String(input.sealStatus)}").`);
  }
  const sealStatus = input.sealStatus as SealStatus;
  const sealNumber = optionalText(input.sealNumber, 'sealNumber', GATE_IN_LIMITS.sealNumber);
  if (sealStatus === 'none' && sealNumber !== null) {
    throw invalid('sealNumber is recorded only with a seal — the seal status is "none".');
  }
  if (sealStatus !== 'none' && sealNumber === null) {
    throw invalid(`sealNumber is required when the seal is ${sealStatus} (several seals: type them comma-separated).`);
  }
  const packagesDeclared = input.packagesDeclared ?? null;
  if (packagesDeclared !== null && (!Number.isInteger(packagesDeclared) || packagesDeclared < 0 || packagesDeclared > GATE_IN_LIMITS.packages)) {
    throw invalid(`packagesDeclared must be a whole number from 0 to ${GATE_IN_LIMITS.packages.toLocaleString('en-IN')} (got ${String(packagesDeclared)}).`);
  }
  const dockDoor = optionalText(input.dockDoor, 'dockDoor', GATE_IN_LIMITS.dockDoor);
  const gatedInAt = input.gatedInAt === null || input.gatedInAt === undefined ? null : webInstant(input.gatedInAt, 'gatedInAt');

  const documentsInput = input.documents ?? [];
  if (!Array.isArray(documentsInput)) throw invalid('documents must be a list.');
  if (documentsInput.length > GATE_IN_LIMITS.documents) {
    throw invalid(`A gate-in carries at most ${GATE_IN_LIMITS.documents} documents (got ${documentsInput.length}).`);
  }
  const todayIst = istDateOf(new Date(gateInClock.now()).toISOString());
  const seen = new Map<string, number>();
  const documents = documentsInput.map((doc, index): NormalizedDocument => {
    const row = `Document ${index + 1}`;
    if (!(GATE_IN_DOCUMENT_KINDS as readonly string[]).includes(doc.kind)) {
      throw invalid(`${row}: kind must be one of ${JSON.stringify(GATE_IN_DOCUMENT_KINDS)} (got "${String(doc.kind)}").`);
    }
    const number = optionalText(doc.number, `${row}: number`, GATE_IN_LIMITS.documentNumber);
    if (number === null) throw invalid(`${row}: the document number is required.`);
    const named = `${row} (${doc.kind} ${number})`;
    if (typeof doc.documentDate !== 'string' || !isIsoDate(doc.documentDate) || !/^2[01]\d\d-/.test(doc.documentDate)) {
      throw invalid(`${named}: documentDate must be a calendar date YYYY-MM-DD (got "${String(doc.documentDate).slice(0, 32)}").`);
    }
    if (doc.documentDate > todayIst) {
      throw invalid(`${named}: the document is dated ${doc.documentDate}, after today (${todayIst}, IST).`);
    }
    const ewbRaw = doc.ewayBillNo === null || doc.ewayBillNo === undefined ? '' : String(doc.ewayBillNo).replace(/\s+/g, '');
    const ewayBillNo = ewbRaw === '' ? null : ewbRaw;
    if (ewayBillNo !== null && !EWB_NO_RE.test(ewayBillNo)) {
      throw invalid(`${named}: the e-way bill number must be 12 digits (got ${ewayBillNo.length} characters).`);
    }
    const poId = doc.poId === null || doc.poId === undefined || doc.poId === '' ? null : String(doc.poId);
    const asnId = doc.asnId === null || doc.asnId === undefined || doc.asnId === '' ? null : String(doc.asnId);
    if (poId !== null && asnId !== null) throw invalid(`${named}: a document covers one purchase order or one ASN, not both.`);
    if (poId !== null && !UUID_RE.test(poId)) throw invalid(`${named}: poId must be a uuid.`);
    if (asnId !== null && !UUID_RE.test(asnId)) throw invalid(`${named}: asnId must be a uuid.`);
    // A duplicate (kind, number) within one gate-in — the same paper twice.
    const key = `${doc.kind}|${number.toUpperCase()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw invalid(`${named} repeats document ${first + 1} — each ${doc.kind} number appears once on a gate-in.`);
    }
    seen.set(key, index);
    return { kind: doc.kind as GateInDocumentKind, number, documentDate: doc.documentDate, ewayBillNo, poId, asnId };
  });
  return {
    handDelivery,
    vehicleNo,
    containerNo,
    transporterPartnerId,
    transporterName,
    lrNumber,
    driverName,
    driverPhone,
    sealStatus,
    sealNumber,
    packagesDeclared,
    dockDoor,
    gatedInAt,
    documents,
  };
}

/**
 * Decision 16 — an amend's field-level diff, `{field: {before, after}}`, for
 * its audit row: every header field that changes, the transporter as its
 * partner id and typed name, the documents as their `kind number` list, and
 * the driver phone as `{changed: true}` only (personal data, decision 10).
 */
function amendChanges(
  current: GateInRow,
  currentDocuments: readonly (typeof gateInDocuments.$inferSelect)[],
  header: NormalizedHeader,
  gatedInAt: string,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const compare = (field: string, before: unknown, after: unknown): void => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes[field] = { before, after };
  };
  compare('handDelivery', current.handDelivery, header.handDelivery);
  compare('vehicleNo', current.vehicleNo, header.vehicleNo);
  compare('containerNo', current.containerNo, header.containerNo);
  compare('transporterPartnerId', current.transporterPartnerId, header.transporterPartnerId);
  compare('transporterName', current.transporterName, header.transporterName);
  compare('lrNumber', current.lrNumber, header.lrNumber);
  compare('driverName', current.driverName, header.driverName);
  if (current.driverPhone !== header.driverPhone) changes.driverPhone = { changed: true };
  compare('sealStatus', current.sealStatus, header.sealStatus);
  compare('sealNumber', current.sealNumber, header.sealNumber);
  compare('packagesDeclared', current.packagesDeclared, header.packagesDeclared);
  compare('dockDoor', current.dockDoor, header.dockDoor);
  compare('gatedInAt', canonicalInstant(current.gatedInAt), gatedInAt);
  const documentLabel = (doc: { kind: string; number: string; documentDate: string; ewayBillNo: string | null; poId: string | null; asnId: string | null }) =>
    [doc.kind, doc.number, doc.documentDate, doc.ewayBillNo, doc.poId, doc.asnId];
  compare('documents', currentDocuments.map(documentLabel), header.documents.map(documentLabel));
  return changes;
}

/** The hashed header — every field as RECEIVED (absent and null hash alike; times never defaulted). */
function hashedHeader(input: GateInHeaderInput): Record<string, unknown> {
  return {
    handDelivery: input.handDelivery ?? undefined,
    vehicleNo: input.vehicleNo ?? undefined,
    containerNo: input.containerNo ?? undefined,
    transporterPartnerId: input.transporterPartnerId ?? undefined,
    transporterName: input.transporterName ?? undefined,
    lrNumber: input.lrNumber ?? undefined,
    driverName: input.driverName ?? undefined,
    driverPhone: input.driverPhone ?? undefined,
    sealStatus: input.sealStatus,
    sealNumber: input.sealNumber ?? undefined,
    packagesDeclared: input.packagesDeclared ?? undefined,
    dockDoor: input.dockDoor ?? undefined,
    // D8 — hashed as received: a retry without a time hashes exactly as the
    // first attempt did, whatever "now" was then.
    gatedInAt: input.gatedInAt ?? undefined,
    documents: (input.documents ?? []).map((doc) => ({
      kind: doc.kind,
      number: doc.number,
      documentDate: doc.documentDate,
      ewayBillNo: doc.ewayBillNo ?? undefined,
      poId: doc.poId ?? undefined,
      asnId: doc.asnId ?? undefined,
    })),
    // Story 2-3b (A2) — LAST, as received: absent drops out of the JSON (the
    // pre-2-3b bytes, pinned by the goldens in test/gate-ins.spec.ts); `null`
    // (a clear) hashes as null, so a clear and an untouched amend never collide.
    appointmentId: input.appointmentId,
  };
}

/** Story 2-3b — the link and release rows a gate-in writes beside its own (A24). */
interface AppointmentEffect {
  readonly action: 'dock_appointment.arrived' | 'dock_appointment.released';
  readonly appointment: DockAppointmentView;
}

/**
 * Story 2-3a — the gate-in: one inbound vehicle visit (decision 1). Four
 * keyed commands, each on the guide §1 skeleton:
 * - **create** (web, the gate desk) — `gate_in.recorded`;
 * - **amend** (web) — a full replacement of the header and the document set;
 * - **unload** (the dock handheld, offline-queued, or the web) — the unload
 *   start, or its end with the packages counted; column-level
 *   first-writer-wins in any status, so a late device replay never loses a
 *   count and never answers a state 409 (Design Notes);
 * - **gate-out** (web) — closes the visit.
 *
 * Lock order: the device row (the device entry's operator guard), then the
 * gate-in `FOR UPDATE`. Create's and amend's document checks are plain reads;
 * the GRN reads the gate-in unlocked before its PO/ASN lock, so no cycle.
 * The driver's phone is never copied into an outbox payload, and every
 * stored snapshot carries it masked (decision 10).
 */
@Injectable()
export class GateInCommand {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_SINK) private readonly outbox: OutboxSink,
  ) {}

  async create(command: CreateGateInCommand, idempotencyKey: string): Promise<GateInSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'gate-in-create',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      warehouseId: command.warehouseId,
      ...hashedHeader(command),
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // 1. Authority first, re-read from the DB.
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'gate.manage');
      // 2. Replay — a committed create re-serves its snapshot whatever today's rules say.
      const replayed = await this.replay<GateInSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      // 3. Shape: normalise, the regexes, the seal rules, the duplicate document.
      const header = normalizeHeader(command);
      const gatedInAt = header.gatedInAt ?? new Date(gateInClock.now()).toISOString();
      // 4. The warehouse.
      await assertWarehouseInTenant(tx, command.tenantId, command.warehouseId);
      // 5. The transporter partner, frozen (FOR KEY SHARE).
      const transporterSnapshot =
        header.transporterPartnerId === null
          ? null
          : await assertTransporterInTx(tx, command.tenantId, header.transporterPartnerId);
      // 6. Each document's PO or ASN in this warehouse (any status, any client — a plain read).
      await this.assertDocumentTargetsInTx(tx, command.tenantId, command.warehouseId, header.documents);
      // 6b. Story 2-3b (decision 8, A1) — the appointment: lock it (404 only),
      // replay again UNDER the lock (a same-key duplicate parked here wakes to
      // the winner's snapshot), then the guards.
      let claimed: DockAppointmentRow | null = null;
      if (command.appointmentId !== undefined && command.appointmentId !== null) {
        const locked = await this.lockAppointments(tx, command.tenantId, [command.appointmentId]);
        const row = locked.get(String(command.appointmentId).toLowerCase());
        if (row === undefined) throw appointmentNotFound();
        const replayedUnderAppointment = await this.replay<GateInSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
        if (replayedUnderAppointment !== null) return replayedUnderAppointment;
        await this.assertLinkable(tx, row, command.warehouseId, null);
        claimed = row;
      }
      // 7. The write.
      const id = uuidv7();
      const code = await this.allocateGateInCode(tx, command.tenantId);
      try {
        await tx.insert(gateIns).values({
          id,
          tenantId: command.tenantId,
          warehouseId: command.warehouseId,
          code,
          status: 'gated_in',
          ...this.headerColumns(header, transporterSnapshot),
          gatedInAt,
          recordedBy: command.actorUserId,
        });
      } catch (err) {
        if (isUniqueViolationOn(err, GATE_IN_CODE_UNIQUE)) {
          // The advisory lock serialises the tenant's allocations; this is the backstop.
          throw new ProblemException('conflict', 409, 'Gate-in code taken', `Gate-in code "${code}" was taken concurrently — retry.`);
        }
        throw err;
      }
      await this.insertDocumentsInTx(tx, command.tenantId, id, header.documents);
      const appointments: AppointmentEffect[] = [];
      if (claimed !== null) {
        appointments.push({ action: 'dock_appointment.arrived', appointment: await this.claimInTx(tx, claimed, id, command.actorUserId) });
      }
      const row = await this.lockedRow(tx, command.tenantId, id);
      const snapshot: GateInSnapshot = { gateIn: await gateInViewInTx(tx, row) };
      await this.finish(tx, command.tenantId, command.actorUserId, idempotencyKey, payloadHash, snapshot, {
        event: 'gate_in.recorded',
        audit: ['gate_in.recorded'],
        gateIn: snapshot.gateIn,
        appointments,
      });
      return snapshot;
    });
  }

  async amend(command: AmendGateInCommand, idempotencyKey: string): Promise<GateInSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'gate-in-amend',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      gateInId: command.gateInId,
      ...hashedHeader(command),
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'gate.manage');
      const replayed = await this.replay<GateInSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      // Lock, then replay again UNDER the lock (guide §1 step 6), then the state guards.
      const current = await this.lockRow(tx, command.tenantId, command.gateInId);
      const replayedUnderLock = await this.replay<GateInSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      if (current.status === 'gated_out') throw gateInClosed(current.code);
      const header = normalizeHeader(command);
      // Decision 14 — the time is editable while the truck waits at the gate;
      // once the unload began it is locked (the unload and gate-out times
      // stay as recorded). The same time resent is not a change.
      let gatedInAt = canonicalInstant(current.gatedInAt);
      if (header.gatedInAt !== null && header.gatedInAt !== gatedInAt) {
        if (current.status !== 'gated_in') {
          throw new ProblemException(
            'gate-in-time-locked',
            409,
            'Gate-in time is locked',
            `Gate-in "${current.code}" is ${current.status} — its gated-in time can be corrected only before the unload starts.`,
          );
        }
        gatedInAt = header.gatedInAt;
      }
      // Re-assert and re-freeze the transporter only when it CHANGES (D33 —
      // an amend of other fields never sticks on a since-deactivated partner).
      let transporterSnapshot: TransporterSnapshotV1 | null;
      if (header.transporterPartnerId === null) {
        transporterSnapshot = null;
      } else if (header.transporterPartnerId === current.transporterPartnerId) {
        transporterSnapshot = current.transporterSnapshot as TransporterSnapshotV1;
      } else {
        transporterSnapshot = await assertTransporterInTx(tx, command.tenantId, header.transporterPartnerId);
      }
      // Decision 16 — once the unload ended, the security fields are locked:
      // the seal and the declared count are what the counted packages were
      // checked against. Every other field stays editable until the gate-out.
      const currentDocuments = await tx
        .select()
        .from(gateInDocuments)
        .where(and(eq(gateInDocuments.tenantId, command.tenantId), eq(gateInDocuments.gateInId, current.id)))
        .orderBy(gateInDocuments.position);
      const changes = amendChanges(current, currentDocuments, header, gatedInAt);
      if (current.unloadEndedAt !== null) {
        const locked = LOCKED_AFTER_UNLOAD.filter((field) => field in changes);
        if (locked.length > 0) {
          throw new ProblemException(
            'gate-in-field-locked',
            409,
            'Gate-in field locked',
            `Gate-in "${current.code}" has finished unloading — ${locked.join(', ')} can no longer change (the counted packages were checked against them). Other fields can still be corrected.`,
          );
        }
      }
      await this.assertDocumentTargetsInTx(tx, command.tenantId, current.warehouseId, header.documents);
      // Story 2-3b (decision 8, A1, A2) — the appointment link: absent =
      // unchanged; null = clear; another id = move. A change locks the old and
      // the new appointment by id (the gate-in is already locked: gate-in →
      // appointment(s) is the lock order), replays again under them, then
      // guards the new one.
      let link: { readonly released: DockAppointmentRow | null; readonly claimed: DockAppointmentRow | null } | null = null;
      if (command.appointmentId !== undefined) {
        const linked = await this.linkedAppointmentOf(tx, command.tenantId, current.id);
        const wanted = command.appointmentId === null ? null : String(command.appointmentId).toLowerCase();
        if (wanted !== (linked?.id ?? null)) {
          const locked = await this.lockAppointments(
            tx,
            command.tenantId,
            [linked?.id, wanted].filter((value): value is string => value !== null && value !== undefined),
          );
          const replayedUnderAppointments = await this.replay<GateInSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
          if (replayedUnderAppointments !== null) return replayedUnderAppointments;
          const claimedRow = wanted === null ? null : (locked.get(wanted) ?? null);
          if (wanted !== null && claimedRow === null) throw appointmentNotFound();
          if (claimedRow !== null) await this.assertLinkable(tx, claimedRow, current.warehouseId, current.id);
          link = { released: linked === null ? null : (locked.get(linked.id) ?? linked), claimed: claimedRow };
          changes.appointment = { before: linked?.code ?? null, after: claimedRow?.code ?? null };
        }
      }
      // Full replacement (D9) — and two desks editing at once is last write wins.
      await tx
        .update(gateIns)
        .set({ ...this.headerColumns(header, transporterSnapshot), gatedInAt, updatedAt: nowIso() })
        .where(eq(gateIns.id, current.id));
      await tx
        .delete(gateInDocuments)
        .where(and(eq(gateInDocuments.tenantId, command.tenantId), eq(gateInDocuments.gateInId, current.id)));
      await this.insertDocumentsInTx(tx, command.tenantId, current.id, header.documents);
      const appointments: AppointmentEffect[] = [];
      if (link !== null) {
        if (link.released !== null) {
          appointments.push({ action: 'dock_appointment.released', appointment: await this.releaseInTx(tx, link.released, current.id) });
        }
        if (link.claimed !== null) {
          appointments.push({ action: 'dock_appointment.arrived', appointment: await this.claimInTx(tx, link.claimed, current.id, command.actorUserId) });
        }
      }
      const row = await this.lockedRow(tx, command.tenantId, current.id);
      const snapshot: GateInSnapshot = { gateIn: await gateInViewInTx(tx, row) };
      await this.finish(tx, command.tenantId, command.actorUserId, idempotencyKey, payloadHash, snapshot, {
        event: 'gate_in.amended',
        audit: ['gate_in.amended'],
        gateIn: snapshot.gateIn,
        // Decision 16 — the audit row records each changed field's before and after.
        changes,
        appointments,
      });
      return snapshot;
    });
  }

  /**
   * The unload — one command behind the web and the device entries. Every
   * column fills only when it is still null (first writer wins), in ANY
   * status: a device that syncs after the web recorded the end, or after the
   * gate-out, keeps the first truth and loses no count (Design Notes). The
   * status moves only forward (`gated_in → unloading → unloaded`) and never
   * out of `gated_out`. Nothing to fill → 200 `applied: false` with the
   * current gate-in: the key and snapshot are stored, nothing is audited or
   * emitted (`AUDIT_NO_OP_ARMS` — `gateIns.unload:already-recorded`). The
   * route never answers `gate-in-closed`.
   */
  async unload(command: UnloadGateInCommand, idempotencyKey: string): Promise<GateInUnloadSnapshot> {
    // ── request shape, above the transaction (no row needed) ──────────────
    if (!(UNLOAD_PHASES as readonly string[]).includes(command.phase)) {
      throw invalid(`phase must be one of ${JSON.stringify(UNLOAD_PHASES)} (got "${String(command.phase)}").`);
    }
    const phase = command.phase as UnloadPhase;
    const counted = command.packagesCounted ?? null;
    if (phase === 'end' && counted === null) {
      throw invalid('packagesCounted is required to end the unload — the packages counted off the vehicle.');
    }
    if (phase === 'start' && counted !== null) {
      throw invalid('packagesCounted is recorded when the unload ends, not when it starts.');
    }
    if (counted !== null && (!Number.isInteger(counted) || counted < 0 || counted > GATE_IN_LIMITS.packages)) {
      throw invalid(`packagesCounted must be a whole number from 0 to ${GATE_IN_LIMITS.packages.toLocaleString('en-IN')} (got ${String(counted)}).`);
    }
    const surface = command.deviceId === null ? 'web' : 'device';
    const occurredRaw = command.occurredAt ?? null;
    if (surface === 'device' && occurredRaw === null) {
      throw invalid('occurredAt is required on a handheld unload — the time the dock pressed the button.');
    }
    if (occurredRaw !== null && !isInstant(occurredRaw)) {
      throw invalid(`occurredAt must be an ISO-8601 instant with a zone designator (got "${String(occurredRaw).slice(0, 64)}").`);
    }
    // D11 — the surface, the actor and the device are in the fingerprint: the
    // two entries could send byte-identical bodies under one key.
    const payloadHash = hashCommandPayload({
      surface,
      actor: command.actorUserId,
      deviceId: command.deviceId ?? undefined,
      tenantId: command.tenantId,
      gateInId: command.gateInId,
      phase,
      occurredAt: occurredRaw ?? undefined,
      packagesCounted: counted ?? undefined,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      // Authority — the device arm: the device row (locked) and the operator's
      // floor role first, then the capability (the excursion shape).
      if (command.deviceId !== null) {
        await assertDeviceOperatorInTx(tx, command.tenantId, command.deviceId, command.actorUserId);
      }
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'gate.manage');
      const replayed = await this.replay<GateInUnloadSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      // Web times are bounded (D31); device times are taken as sent.
      const occurredAt =
        surface === 'web'
          ? occurredRaw === null
            ? new Date(gateInClock.now()).toISOString()
            : webInstant(occurredRaw, 'occurredAt')
          : canonicalInstant(occurredRaw!);
      const current = await this.lockRow(tx, command.tenantId, command.gateInId);
      const replayedUnderLock = await this.replay<GateInUnloadSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;

      const fills = phase === 'start' ? current.unloadStartedAt === null : current.unloadEndedAt === null;
      if (!fills) {
        // The no-op arm: the first writer's truth stands. Key stored, no audit, no outbox.
        const snapshot: GateInUnloadSnapshot = { applied: false, gateIn: await gateInViewInTx(tx, current) };
        if (command.deviceId !== null) await touchDeviceInTx(tx, command.deviceId);
        await this.writeKey(tx, command.tenantId, idempotencyKey, payloadHash, snapshot);
        return snapshot;
      }
      if (surface === 'web') {
        const floor = phase === 'end' && current.unloadStartedAt !== null ? current.unloadStartedAt : current.gatedInAt;
        const floorLabel = phase === 'end' && current.unloadStartedAt !== null ? 'the unload start' : 'the gated-in time';
        if (Date.parse(occurredAt) < Date.parse(canonicalInstant(floor))) {
          throw timeOutOfOrder(
            `The unload ${phase} (${occurredAt}) is before ${floorLabel} (${canonicalInstant(floor)}) of gate-in "${current.code}".`,
          );
        }
        // A web unload recorded on a gated-out visit happened before the vehicle left.
        if (current.gatedOutAt !== null && Date.parse(occurredAt) > Date.parse(canonicalInstant(current.gatedOutAt))) {
          throw timeOutOfOrder(
            `The unload ${phase} (${occurredAt}) is after the gate-out (${canonicalInstant(current.gatedOutAt)}) of gate-in "${current.code}".`,
          );
        }
      }
      const forward = (next: GateInStatus): GateInStatus => (current.status === 'gated_out' ? 'gated_out' : next);
      const update: Partial<typeof gateIns.$inferInsert> =
        phase === 'start'
          ? {
              unloadStartedAt: occurredAt,
              unloadStartedBy: command.actorUserId,
              status: current.status === 'gated_in' ? 'unloading' : current.status,
            }
          : {
              unloadEndedAt: occurredAt,
              unloadEndedBy: command.actorUserId,
              packagesCounted: counted!,
              // D32 — an end with no start stamps the start with the same time and actor.
              ...(current.unloadStartedAt === null ? { unloadStartedAt: occurredAt, unloadStartedBy: command.actorUserId } : {}),
              status: forward('unloaded'),
            };
      await tx
        .update(gateIns)
        .set({ ...update, updatedAt: nowIso() })
        .where(eq(gateIns.id, current.id));
      const row = await this.lockedRow(tx, command.tenantId, current.id);
      const snapshot: GateInUnloadSnapshot = { applied: true, gateIn: await gateInViewInTx(tx, row) };
      if (command.deviceId !== null) await touchDeviceInTx(tx, command.deviceId);
      await this.finish(tx, command.tenantId, command.actorUserId, idempotencyKey, payloadHash, snapshot, {
        event: 'gate_in.unloaded',
        // D32 — an end that also stamped the start audits only the end.
        audit: [phase === 'start' ? 'gate_in.unload_started' : 'gate_in.unload_ended'],
        gateIn: snapshot.gateIn,
        extra: { phase },
      });
      return snapshot;
    });
  }

  async gateOut(command: GateOutCommand, idempotencyKey: string): Promise<GateInSnapshot> {
    const payloadHash = hashCommandPayload({
      arm: 'gate-in-gate-out',
      tenantId: command.tenantId,
      actorUserId: command.actorUserId,
      gateInId: command.gateInId,
      gatedOutAt: command.gatedOutAt ?? undefined,
    });
    return withTenantTransaction(this.db, command.tenantId, async (tx) => {
      assertPermission(await getMemberRoleIn(tx, command.tenantId, command.actorUserId), 'gate.manage');
      const replayed = await this.replay<GateInSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayed !== null) return replayed;
      const gatedOutAt =
        command.gatedOutAt === null || command.gatedOutAt === undefined
          ? new Date(gateInClock.now()).toISOString()
          : webInstant(command.gatedOutAt, 'gatedOutAt');
      const current = await this.lockRow(tx, command.tenantId, command.gateInId);
      const replayedUnderLock = await this.replay<GateInSnapshot>(tx, command.tenantId, idempotencyKey, payloadHash);
      if (replayedUnderLock !== null) return replayedUnderLock;
      // From any state but gated out — a truck turned away gates out unloaded.
      if (current.status === 'gated_out') throw gateInClosed(current.code);
      // The floor is the latest instant recorded: the unload end, else its start, else the gate-in.
      const floors: [string | null, string][] = [
        [current.unloadEndedAt, 'the unload end'],
        [current.unloadStartedAt, 'the unload start'],
        [current.gatedInAt, 'the gated-in time'],
      ];
      for (const [instant, label] of floors) {
        if (instant !== null && Date.parse(gatedOutAt) < Date.parse(canonicalInstant(instant))) {
          throw timeOutOfOrder(
            `The gate-out (${gatedOutAt}) is before ${label} (${canonicalInstant(instant)}) of gate-in "${current.code}".`,
          );
        }
      }
      await tx
        .update(gateIns)
        .set({ status: 'gated_out', gatedOutAt, gatedOutBy: command.actorUserId, updatedAt: nowIso() })
        .where(eq(gateIns.id, current.id));
      const row = await this.lockedRow(tx, command.tenantId, current.id);
      const snapshot: GateInSnapshot = { gateIn: await gateInViewInTx(tx, row) };
      await this.finish(tx, command.tenantId, command.actorUserId, idempotencyKey, payloadHash, snapshot, {
        event: 'gate_in.gated_out',
        audit: ['gate_in.gated_out'],
        gateIn: snapshot.gateIn,
      });
      return snapshot;
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private headerColumns(header: NormalizedHeader, transporterSnapshot: TransporterSnapshotV1 | null) {
    return {
      handDelivery: header.handDelivery,
      vehicleNo: header.vehicleNo,
      containerNo: header.containerNo,
      transporterPartnerId: header.transporterPartnerId,
      transporterSnapshot,
      transporterName: header.transporterName,
      lrNumber: header.lrNumber,
      driverName: header.driverName,
      driverPhone: header.driverPhone,
      sealStatus: header.sealStatus,
      sealNumber: header.sealNumber,
      packagesDeclared: header.packagesDeclared,
      dockDoor: header.dockDoor,
    };
  }

  /**
   * Every document's PO or ASN exists in the tenant (404) and in this
   * warehouse (409 `document-warehouse-mismatch`) — in ANY status and of ANY
   * client (D33: paperwork names a closed PO as often as an open one, and a
   * truck carries several clients' goods). A plain read: nothing here locks a
   * document, so the gate-in never orders against a receipt's PO/ASN lock.
   */
  private async assertDocumentTargetsInTx(
    tx: TenantTx,
    tenantId: string,
    warehouseId: string,
    documents: readonly NormalizedDocument[],
  ): Promise<void> {
    const poIds = [...new Set(documents.map((doc) => doc.poId).filter((id): id is string => id !== null))];
    const asnIds = [...new Set(documents.map((doc) => doc.asnId).filter((id): id is string => id !== null))];
    if (poIds.length > 0) {
      const rows = await tx
        .select({ id: purchaseOrders.id, code: purchaseOrders.code, warehouseId: purchaseOrders.warehouseId })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.tenantId, tenantId), inArray(purchaseOrders.id, poIds)));
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const poId of poIds) {
        const po = byId.get(poId);
        if (po === undefined) {
          throw new ProblemException('not-found', 404, 'Purchase order not found', `No purchase order with id "${poId}" exists in this tenant.`);
        }
        if (po.warehouseId !== warehouseId) throw documentWarehouseMismatch(`Purchase order "${po.code}"`);
      }
    }
    if (asnIds.length > 0) {
      const rows = await tx
        .select({ id: advanceShipmentNotices.id, code: advanceShipmentNotices.asnCode, warehouseId: advanceShipmentNotices.warehouseId })
        .from(advanceShipmentNotices)
        .where(and(eq(advanceShipmentNotices.tenantId, tenantId), inArray(advanceShipmentNotices.id, asnIds)));
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const asnId of asnIds) {
        const asn = byId.get(asnId);
        if (asn === undefined) {
          throw new ProblemException('not-found', 404, 'Advance shipment notice not found', `No advance shipment notice with id "${asnId}" exists in this tenant.`);
        }
        if (asn.warehouseId !== warehouseId) throw documentWarehouseMismatch(`Advance shipment notice "${asn.code}"`);
      }
    }
  }

  private async insertDocumentsInTx(
    tx: TenantTx,
    tenantId: string,
    gateInId: string,
    documents: readonly NormalizedDocument[],
  ): Promise<void> {
    if (documents.length === 0) return;
    await tx.insert(gateInDocuments).values(
      documents.map((doc, position) => ({
        id: uuidv7(),
        tenantId,
        gateInId,
        position,
        kind: doc.kind,
        number: doc.number,
        documentDate: doc.documentDate,
        ewayBillNo: doc.ewayBillNo,
        poId: doc.poId,
        asnId: doc.asnId,
      })),
    );
  }

  /** Lock the gate-in `FOR UPDATE` — "lock, 404 when absent", nothing else (guide §1: a lock helper never checks status). */
  private async lockRow(tx: TenantTx, tenantId: string, gateInId: string): Promise<GateInRow> {
    if (!UUID_RE.test(gateInId)) throw gateInNotFound();
    const rows = await tx
      .select()
      .from(gateIns)
      .where(and(eq(gateIns.tenantId, tenantId), eq(gateIns.id, gateInId)))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw gateInNotFound();
    return row;
  }

  /** The row this transaction already holds (read back after a write). */
  private async lockedRow(tx: TenantTx, tenantId: string, gateInId: string): Promise<GateInRow> {
    const rows = await tx
      .select()
      .from(gateIns)
      .where(and(eq(gateIns.tenantId, tenantId), eq(gateIns.id, gateInId)))
      .limit(1);
    return rows[0]!;
  }

  // ── story 2-3b: the appointment link ─────────────────────────────────────

  /** Lock the named appointments `FOR UPDATE` in id order — absent ones are simply missing (the caller answers 404). */
  private async lockAppointments(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<Map<string, DockAppointmentRow>> {
    const sorted = [...new Set(ids.map((id) => String(id).toLowerCase()).filter((id) => UUID_RE.test(id)))].sort();
    if (sorted.length === 0) return new Map();
    const rows = await tx
      .select()
      .from(dockAppointments)
      .where(and(eq(dockAppointments.tenantId, tenantId), inArray(dockAppointments.id, sorted)))
      .orderBy(dockAppointments.id)
      .for('update');
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The appointment this gate-in keeps (one at most — the partial unique index), unlocked. */
  private async linkedAppointmentOf(tx: TenantTx, tenantId: string, gateInId: string): Promise<DockAppointmentRow | null> {
    const rows = await tx
      .select()
      .from(dockAppointments)
      .where(and(eq(dockAppointments.tenantId, tenantId), eq(dockAppointments.gateInId, gateInId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Decision 8 + A14 — another warehouse's appointment is 409
   * `appointment-warehouse-mismatch`; a cancelled one, or one another gate-in
   * keeps, 409 `appointment-closed`; one starting outside IST yesterday …
   * tomorrow 409 `appointment-not-due`. A no-show links (the visit reads late).
   */
  private async assertLinkable(tx: TenantTx, row: DockAppointmentRow, warehouseId: string, gateInId: string | null): Promise<void> {
    if (row.warehouseId !== warehouseId) {
      throw new ProblemException(
        'appointment-warehouse-mismatch',
        409,
        'Appointment is another warehouse’s',
        `Dock appointment "${row.code}" is booked at another warehouse — pick an appointment of this gate.`,
      );
    }
    if (row.status === 'cancelled') {
      throw appointmentClosed(row, `Dock appointment "${row.code}" is cancelled — it cannot be linked to a gate-in.`);
    }
    if (row.status === 'arrived' && row.gateInId !== gateInId) {
      const other = await tx
        .select({ code: gateIns.code })
        .from(gateIns)
        .where(and(eq(gateIns.tenantId, row.tenantId), eq(gateIns.id, row.gateInId!)))
        .limit(1);
      throw appointmentClosed(
        row,
        `Dock appointment "${row.code}" is already linked to gate-in ${other[0]?.code ?? row.gateInId} — one appointment per visit.`,
      );
    }
    const today = istDateOf(new Date(gateInClock.now()).toISOString());
    const startsAt = canonicalInstant(row.startsAt);
    if (startsAt < istMidnightOf(addIsoDays(today, -1)) || startsAt >= istMidnightOf(addIsoDays(today, 2))) {
      throw new ProblemException(
        'appointment-not-due',
        409,
        'Appointment not due',
        `Dock appointment "${row.code}" (${windowLabel(startsAt, canonicalInstant(row.endsAt))}) is not due — only an appointment starting yesterday, today or tomorrow (IST) can be linked at the gate.`,
      );
    }
  }

  /** Link: the appointment `arrived`, with the gate-in, when and by whom. Returns its view. */
  private async claimInTx(tx: TenantTx, row: DockAppointmentRow, gateInId: string, actorUserId: string): Promise<DockAppointmentView> {
    const now = new Date(gateInClock.now()).toISOString();
    await tx
      .update(dockAppointments)
      .set({ status: 'arrived', gateInId, linkedAt: now, linkedBy: actorUserId, updatedAt: nowIso() })
      .where(and(eq(dockAppointments.tenantId, row.tenantId), eq(dockAppointments.id, row.id)));
    return this.appointmentViewInTx(tx, row.tenantId, row.id);
  }

  /** Release: back to `booked`, the link columns cleared (only while this gate-in still holds it). */
  private async releaseInTx(tx: TenantTx, row: DockAppointmentRow, gateInId: string): Promise<DockAppointmentView> {
    await tx
      .update(dockAppointments)
      .set({ status: 'booked', gateInId: null, linkedAt: null, linkedBy: null, updatedAt: nowIso() })
      .where(and(eq(dockAppointments.tenantId, row.tenantId), eq(dockAppointments.id, row.id), eq(dockAppointments.gateInId, gateInId)));
    return this.appointmentViewInTx(tx, row.tenantId, row.id);
  }

  private async appointmentViewInTx(tx: TenantTx, tenantId: string, appointmentId: string): Promise<DockAppointmentView> {
    const rows = await tx
      .select()
      .from(dockAppointments)
      .where(and(eq(dockAppointments.tenantId, tenantId), eq(dockAppointments.id, appointmentId)))
      .limit(1);
    return dockAppointmentViewInTx(tx, rows[0]!, gateInClock.now());
  }

  /**
   * The next `GI-<n>` under the tenant's sequence advisory lock (the
   * `allocateGrnCode` copy): only codes of the `GI-<digits>` shape take the
   * max, the digits bounded at 9 so a forged tail overflows nothing; the
   * unique `(tenant, code)` index is the race backstop.
   */
  private async allocateGateInCode(tx: TenantTx, tenantId: string): Promise<string> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':gate-in-seq', 0))`);
    const headRows = await tx
      .select({ n: sql<number>`coalesce(max(substring(code from '^GI-([0-9]{1,9})$')::int), 0)` })
      .from(gateIns)
      .where(eq(gateIns.tenantId, tenantId));
    const next = (headRows[0]?.n ?? 0) + 1;
    return `GI-${String(next).padStart(4, '0')}`;
  }

  private async replay<T>(tx: TenantTx, tenantId: string, key: string, payloadHash: string): Promise<T | null> {
    const rows = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    const existing = rows[0];
    if (existing === undefined) return null;
    if (existing.payloadHash !== payloadHash) throw idempotencyKeyReuse();
    return existing.responseSnapshot as T;
  }

  /** Steps 9–11: the outbox event (no phone), the audit row(s), the key LAST. */
  private async finish(
    tx: TenantTx,
    tenantId: string,
    actorUserId: string,
    idempotencyKey: string,
    payloadHash: string,
    snapshot: unknown,
    effect: {
      readonly event: 'gate_in.recorded' | 'gate_in.amended' | 'gate_in.unloaded' | 'gate_in.gated_out';
      readonly audit: readonly string[];
      readonly gateIn: GateInView;
      readonly extra?: Record<string, unknown>;
      /** Decision 16 — the amend's field-level diff, on its audit row. */
      readonly changes?: Record<string, unknown>;
      /**
       * Story 2-3b (A24) — the appointment link and release: each its own
       * outbox event (the note dropped — A15) and audit row (target
       * `dock_appointment`), beside the gate-in's, under the same key.
       */
      readonly appointments?: readonly AppointmentEffect[];
    },
  ): Promise<void> {
    const events: { readonly type: string; readonly payload: Record<string, unknown> }[] = [
      { type: effect.event, payload: { ...(effect.extra ?? {}), gateIn: outboxGateIn(effect.gateIn) } },
      ...(effect.appointments ?? []).map((linked) => ({
        type: linked.action,
        payload: { appointment: outboxAppointment(linked.appointment) },
      })),
    ];
    for (const event of events) {
      await this.outbox.append(tx, {
        messageId: uuidv7(),
        tenantId,
        type: event.type,
        occurredAt: nowIso(),
        payload: event.payload,
      });
    }
    for (const action of effect.audit) {
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId,
        action,
        targetType: 'gate_in',
        targetId: effect.gateIn.id,
        reference: idempotencyKey,
        ...(effect.changes === undefined ? {} : { changes: effect.changes }),
        occurredAt: nowIso(),
      });
    }
    for (const linked of effect.appointments ?? []) {
      await tx.insert(auditEvents).values({
        id: uuidv7(),
        tenantId,
        actorUserId,
        action: linked.action,
        targetType: 'dock_appointment',
        targetId: linked.appointment.id,
        reference: idempotencyKey,
        occurredAt: nowIso(),
      });
    }
    await this.writeKey(tx, tenantId, idempotencyKey, payloadHash, snapshot);
  }

  private async writeKey(tx: TenantTx, tenantId: string, key: string, payloadHash: string, snapshot: unknown): Promise<void> {
    try {
      await tx.insert(idempotencyKeys).values({ id: uuidv7(), tenantId, key, payloadHash, responseSnapshot: snapshot });
    } catch (err) {
      if (isUniqueViolationOn(err, IDEMPOTENCY_TENANT_KEY)) {
        throw new ProblemException(
          'conflict',
          409,
          'Concurrent idempotent request',
          'The same Idempotency-Key is being processed concurrently; retry to read the settled result.',
        );
      }
      throw err;
    }
  }
}
