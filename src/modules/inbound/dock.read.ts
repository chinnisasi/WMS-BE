import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  advanceShipmentNotices,
  dockAppointmentDocuments,
  dockAppointments,
  dockDoors,
  dockSchedules,
  gateIns,
  purchaseOrders,
  type DockAppointmentRow,
  type DockDoorRow,
} from '../../shared/db/schema';
import type { TenantTx } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { IST_OFFSET_MS, addIsoDays, canonicalInstant, istDateOf, istMidnightOf, istWeekdayOf } from '../../shared/primitives/time';

/**
 * Story 2-3b — dock appointments, the read side: the vocabularies, the
 * schedule (row or defaults), the door, appointment and window views, the
 * derived punctuality and no-show (decision 9 — never stored), the summary
 * (A8, SQL aggregates over the whole window — A9), the gate-in fold and the
 * device snapshot's two reads. Pure reads on the caller's transaction; it
 * imports only the schema and `shared/`, so every command and the gate-in
 * read import it without a cycle.
 */

// ── the vocabularies (IMPLEMENTATION-GUIDE §4 — mirrored by 0110's CHECKs) ────

/** Decision 7 — `booked → arrived | cancelled`. */
export const DOCK_APPOINTMENT_STATUSES = ['booked', 'arrived', 'cancelled'] as const;
export type DockAppointmentStatus = (typeof DOCK_APPOINTMENT_STATUSES)[number];

/** Decision 3 — the slot lengths a schedule may take. */
export const DOCK_SLOT_MINUTES = [15, 30, 60] as const;

/** Decision 9 — how an arrival compares to its slot, derived at read. */
export const DOCK_PUNCTUALITIES = ['early', 'on_time', 'late'] as const;
export type DockPunctuality = (typeof DOCK_PUNCTUALITIES)[number];

/** The bounds the commands answer as named 400s / 409s (the CHECKs are the backstop). */
export const DOCK_LIMITS = {
  doorsPerWarehouse: 100,
  doorCode: 20,
  doorName: 60,
  slotsPerAppointment: 8,
  documents: 10,
  transporterName: 80,
  note: 500,
  cancelReason: 200,
  graceMinutes: 120,
  /** Decision 4 — no later than this many IST days ahead. */
  daysAhead: 90,
  /** The window read — at most this many IST days, at most this many appointments. */
  windowDays: 7,
  windowAppointments: 1000,
  /** Decision 12 — the device's "Expected today". */
  deviceAppointments: 100,
} as const;

export const DOOR_CODE_RE = /^[A-Z0-9-]{1,20}$/;

/** Decision 3 — what a warehouse with no schedule row reads (`configured: false`). */
export const DEFAULT_DOCK_SCHEDULE = {
  slotMinutes: 30,
  opensMinute: 9 * 60,
  closesMinute: 18 * 60,
  /** Mon–Sat: bits 0–5. */
  openDays: 0b0111111,
  graceMinutes: 15,
} as const;

/**
 * The dock's clock (IMPLEMENTATION-GUIDE §7c): every "now" of the dock
 * commands and reads — the bounds of decision 4, the no-show, the summary's
 * `asOf`, the device's "today" — reads it, so a test can move it. Tests
 * ASSIGN `dockClock.now` and restore it.
 */
export const dockClock = { now: (): number => Date.now() };

const MINUTE_MS = 60_000;

// ── the schedule ──────────────────────────────────────────────────────────────

/** The schedule as the commands and reads use it (minutes of the IST day, the day bitmask). */
export interface DockScheduleRules {
  readonly slotMinutes: number;
  readonly opensMinute: number;
  readonly closesMinute: number;
  /** Bit 0 = Monday … bit 6 = Sunday. */
  readonly openDays: number;
  readonly graceMinutes: number;
  readonly configured: boolean;
  readonly updatedAt: string | null;
}

/** The schedule on the wire (decision 3). */
export interface DockScheduleView {
  readonly warehouseId: string;
  readonly slotMinutes: number;
  /** IST wall clock `HH:MM`, on the slot grid. */
  readonly opensAt: string;
  /** IST wall clock `HH:MM`; `24:00` closes at midnight. */
  readonly closesAt: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday, ascending. */
  readonly openDays: readonly number[];
  readonly graceMinutes: number;
  /** False while the warehouse has no stored schedule (the defaults are read). */
  readonly configured: boolean;
  readonly updatedAt: string | null;
}

export function minuteToHhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** `HH:MM` → minutes of the day; `24:00` only when `allowMidnight`. Null when malformed. */
export function hhmmToMinute(value: unknown, allowMidnight: boolean): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours === 24 && minutes === 0 && allowMidnight) return 1440;
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

export function openDaysOfMask(mask: number): number[] {
  return [1, 2, 3, 4, 5, 6, 7].filter((day) => (mask & (1 << (day - 1))) !== 0);
}

export function maskOfOpenDays(days: readonly number[]): number {
  return days.reduce((mask, day) => mask | (1 << (day - 1)), 0);
}

export function isOpenDay(rules: Pick<DockScheduleRules, 'openDays'>, date: string): boolean {
  return (rules.openDays & (1 << (istWeekdayOf(date) - 1))) !== 0;
}

export async function dockScheduleOfInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<DockScheduleRules> {
  const rows = await tx
    .select()
    .from(dockSchedules)
    .where(and(eq(dockSchedules.tenantId, tenantId), eq(dockSchedules.warehouseId, warehouseId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { ...DEFAULT_DOCK_SCHEDULE, configured: false, updatedAt: null };
  return {
    slotMinutes: row.slotMinutes,
    opensMinute: row.opensMinute,
    closesMinute: row.closesMinute,
    openDays: row.openDays,
    graceMinutes: row.graceMinutes,
    configured: true,
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

export function dockScheduleView(warehouseId: string, rules: DockScheduleRules): DockScheduleView {
  return {
    warehouseId,
    slotMinutes: rules.slotMinutes,
    opensAt: minuteToHhmm(rules.opensMinute),
    closesAt: minuteToHhmm(rules.closesMinute),
    openDays: openDaysOfMask(rules.openDays),
    graceMinutes: rules.graceMinutes,
    configured: rules.configured,
    updatedAt: rules.updatedAt,
  };
}

// ── doors ─────────────────────────────────────────────────────────────────────

export interface DockDoorView {
  readonly id: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string | null;
  readonly active: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function dockDoorView(row: DockDoorRow): DockDoorView {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    code: row.code,
    name: row.name,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: canonicalInstant(row.createdAt),
    updatedAt: canonicalInstant(row.updatedAt),
  };
}

/** A warehouse's doors — active first, then by code (decision 1). */
export async function listDockDoorsInTx(tx: TenantTx, tenantId: string, warehouseId: string): Promise<DockDoorView[]> {
  const rows = await tx
    .select()
    .from(dockDoors)
    .where(and(eq(dockDoors.tenantId, tenantId), eq(dockDoors.warehouseId, warehouseId)))
    .orderBy(desc(dockDoors.active), asc(dockDoors.code));
  return rows.map(dockDoorView);
}

// ── punctuality (decision 9, A12) ────────────────────────────────────────────

/**
 * The arrival against the slot: `punctualityMinutes` is the RAW delta —
 * arrival − start in whole minutes, truncated toward zero (A12) — and the
 * word compares it with the frozen grace: early below −grace, late above
 * +grace, else on time (the edges are on time). The summary's SQL computes
 * the same delta (`trunc(epoch / 60)`).
 */
export function punctualityOf(
  startsAt: string,
  graceMinutes: number,
  arrivalAt: string,
): { readonly punctuality: DockPunctuality; readonly punctualityMinutes: number } {
  const delta = Math.trunc((Date.parse(arrivalAt) - Date.parse(startsAt)) / MINUTE_MS);
  const punctuality: DockPunctuality = delta < -graceMinutes ? 'early' : delta > graceMinutes ? 'late' : 'on_time';
  return { punctuality, punctualityMinutes: delta === 0 ? 0 : delta };
}

/** Decision 9 — still booked once the window and its grace have passed. */
export function isNoShow(status: string, endsAt: string, graceMinutes: number, asOfMs: number): boolean {
  return status === 'booked' && asOfMs >= Date.parse(endsAt) + graceMinutes * MINUTE_MS;
}

// ── the appointment view ─────────────────────────────────────────────────────

export interface DockAppointmentDocumentView {
  readonly kind: 'po' | 'asn';
  readonly id: string;
  readonly code: string | null;
  readonly clientId: string | null;
  /** The PO's frozen `vendor_snapshot` name (A26); null on an ASN or a null snapshot. */
  readonly vendorName: string | null;
}

export interface DockAppointmentView {
  readonly id: string;
  readonly tenantId: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly status: DockAppointmentStatus;
  readonly dockDoorId: string;
  readonly doorCode: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly graceMinutes: number;
  readonly clientId: string | null;
  readonly vehicleNo: string | null;
  readonly transporterName: string | null;
  readonly note: string | null;
  readonly documents: readonly DockAppointmentDocumentView[];
  readonly gateInId: string | null;
  readonly gateInCode: string | null;
  readonly gatedInAt: string | null;
  readonly linkedAt: string | null;
  readonly linkedBy: string | null;
  readonly bookedBy: string;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
  readonly cancelReason: string | null;
  readonly punctuality: DockPunctuality | null;
  readonly punctualityMinutes: number | null;
  readonly noShow: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const instantOrNull = (value: string | null): string | null => (value === null ? null : canonicalInstant(value));

/**
 * The views of `rows`, in their order: the door codes, the documents (each
 * with its PO / ASN code, client and vendor name) and the linked gate-ins
 * folded over the rows' ids — four reads whatever the count.
 */
export async function dockAppointmentViewsInTx(
  tx: TenantTx,
  tenantId: string,
  rows: readonly DockAppointmentRow[],
  asOfMs: number,
): Promise<DockAppointmentView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const doorIds = [...new Set(rows.map((row) => row.dockDoorId))];
  const gateInIds = [...new Set(rows.map((row) => row.gateInId).filter((id): id is string => id !== null))];
  const doors = await tx
    .select({ id: dockDoors.id, code: dockDoors.code })
    .from(dockDoors)
    .where(and(eq(dockDoors.tenantId, tenantId), inArray(dockDoors.id, doorIds)));
  const doorCode = new Map(doors.map((door) => [door.id, door.code]));
  const documents = await tx
    .select({
      appointmentId: dockAppointmentDocuments.appointmentId,
      poId: dockAppointmentDocuments.poId,
      asnId: dockAppointmentDocuments.asnId,
      poCode: purchaseOrders.code,
      poClientId: purchaseOrders.clientId,
      // Literal qualifier: a select-list fragment renders its column unqualified (Gotcha 16).
      vendorName: sql<string | null>`"purchase_orders"."vendor_snapshot" ->> 'name'`,
      asnCode: advanceShipmentNotices.asnCode,
      asnClientId: advanceShipmentNotices.clientId,
    })
    .from(dockAppointmentDocuments)
    .leftJoin(
      purchaseOrders,
      and(eq(purchaseOrders.tenantId, dockAppointmentDocuments.tenantId), eq(purchaseOrders.id, dockAppointmentDocuments.poId)),
    )
    .leftJoin(
      advanceShipmentNotices,
      and(
        eq(advanceShipmentNotices.tenantId, dockAppointmentDocuments.tenantId),
        eq(advanceShipmentNotices.id, dockAppointmentDocuments.asnId),
      ),
    )
    .where(and(eq(dockAppointmentDocuments.tenantId, tenantId), inArray(dockAppointmentDocuments.appointmentId, ids)))
    .orderBy(asc(dockAppointmentDocuments.appointmentId), asc(dockAppointmentDocuments.position));
  const documentsOf = new Map<string, DockAppointmentDocumentView[]>();
  for (const doc of documents) {
    const list = documentsOf.get(doc.appointmentId) ?? [];
    list.push(
      doc.poId !== null
        ? { kind: 'po', id: doc.poId, code: doc.poCode, clientId: doc.poClientId, vendorName: doc.vendorName ?? null }
        : { kind: 'asn', id: doc.asnId!, code: doc.asnCode, clientId: doc.asnClientId, vendorName: null },
    );
    documentsOf.set(doc.appointmentId, list);
  }
  const gateInRows =
    gateInIds.length === 0
      ? []
      : await tx
          .select({ id: gateIns.id, code: gateIns.code, gatedInAt: gateIns.gatedInAt })
          .from(gateIns)
          .where(and(eq(gateIns.tenantId, tenantId), inArray(gateIns.id, gateInIds)));
  const gateInOf = new Map(gateInRows.map((row) => [row.id, { code: row.code, gatedInAt: canonicalInstant(row.gatedInAt) }]));
  return rows.map((row) => {
    const startsAt = canonicalInstant(row.startsAt);
    const endsAt = canonicalInstant(row.endsAt);
    const gateIn = row.gateInId === null ? undefined : gateInOf.get(row.gateInId);
    const timing = gateIn === undefined ? null : punctualityOf(startsAt, row.graceMinutes, gateIn.gatedInAt);
    return {
      id: row.id,
      tenantId: row.tenantId,
      warehouseId: row.warehouseId,
      code: row.code,
      status: row.status as DockAppointmentStatus,
      dockDoorId: row.dockDoorId,
      doorCode: doorCode.get(row.dockDoorId) ?? '',
      startsAt,
      endsAt,
      graceMinutes: row.graceMinutes,
      clientId: row.clientId,
      vehicleNo: row.vehicleNo,
      transporterName: row.transporterName,
      note: row.note,
      documents: documentsOf.get(row.id) ?? [],
      gateInId: row.gateInId,
      gateInCode: gateIn?.code ?? null,
      gatedInAt: gateIn?.gatedInAt ?? null,
      linkedAt: instantOrNull(row.linkedAt),
      linkedBy: row.linkedBy,
      bookedBy: row.bookedBy,
      cancelledAt: instantOrNull(row.cancelledAt),
      cancelledBy: row.cancelledBy,
      cancelReason: row.cancelReason,
      punctuality: timing?.punctuality ?? null,
      punctualityMinutes: timing?.punctualityMinutes ?? null,
      noShow: isNoShow(row.status, endsAt, row.graceMinutes, asOfMs),
      createdAt: canonicalInstant(row.createdAt),
      updatedAt: canonicalInstant(row.updatedAt),
    };
  });
}

export async function dockAppointmentRowInTx(tx: TenantTx, tenantId: string, appointmentId: string): Promise<DockAppointmentRow | null> {
  if (!UUID_RE.test(appointmentId)) return null;
  const rows = await tx
    .select()
    .from(dockAppointments)
    .where(and(eq(dockAppointments.tenantId, tenantId), eq(dockAppointments.id, appointmentId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function dockAppointmentViewInTx(tx: TenantTx, row: DockAppointmentRow, asOfMs: number): Promise<DockAppointmentView> {
  const [view] = await dockAppointmentViewsInTx(tx, row.tenantId, [row], asOfMs);
  return view!;
}

/**
 * The outbox payload's appointment: the view WITHOUT the note and the cancel
 * reason (A15 — both are desk free text a phone number can be typed into;
 * personal data is never copied into an event).
 */
export function outboxAppointment(view: DockAppointmentView): Omit<DockAppointmentView, 'note' | 'cancelReason'> {
  const { note, cancelReason, ...rest } = view;
  void note;
  void cancelReason;
  return rest;
}

// ── the window read (decision 10, A8, A9) ────────────────────────────────────

export interface DockWindowQuery {
  readonly warehouseId: string;
  /** Inclusive IST dates. */
  readonly from: string;
  readonly to: string;
  readonly includeCancelled: boolean;
}

export interface DockSummaryView {
  /** Non-cancelled appointments starting in the window (A8). */
  readonly scheduled: number;
  /** Booked and not yet a no-show. */
  readonly pending: number;
  readonly arrived: number;
  readonly early: number;
  readonly onTime: number;
  readonly late: number;
  readonly noShow: number;
  /** Counted whether or not the list includes them. */
  readonly cancelled: number;
  /** onTime ÷ (arrived + noShow) as a percentage, one decimal; null at 0. */
  readonly onTimeRate: number | null;
  readonly bookedMinutes: number;
  readonly openMinutes: number;
  /** bookedMinutes ÷ openMinutes as a percentage, one decimal, clamped to 100; null at 0. */
  readonly utilisationRate: number | null;
  readonly byDoor: readonly { readonly doorId: string; readonly bookedMinutes: number; readonly openMinutes: number }[];
}

export interface DockWindowView {
  readonly asOf: string;
  readonly from: string;
  readonly to: string;
  readonly schedule: DockScheduleView;
  readonly doors: readonly DockDoorView[];
  readonly appointments: readonly DockAppointmentView[];
  readonly summary: DockSummaryView;
  readonly truncated: boolean;
}

const percent = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : Math.min(100, Math.round((numerator / denominator) * 1000) / 10);

/**
 * The window `[istMidnightOf(from), istMidnightOf(to + 1))` on `starts_at`:
 * the appointments (≤ 1000 by `(starts_at, id)`, `truncated` past it), the
 * doors (active, plus any door an appointment of the window names), and the
 * summary — SQL aggregates over the WHOLE window, independent of the cap
 * (A9), with the numerator of the utilisation each scheduled appointment's
 * minutes clipped to its day's opening hours (a closed day contributes
 * nothing) and the denominator the door set × the open minutes of each open
 * day (A8).
 */
export async function dockWindowInTx(tx: TenantTx, tenantId: string, query: DockWindowQuery, asOfMs: number): Promise<DockWindowView> {
  const rules = await dockScheduleOfInTx(tx, tenantId, query.warehouseId);
  const fromInstant = istMidnightOf(query.from);
  const toInstant = istMidnightOf(addIsoDays(query.to, 1));
  const asOf = new Date(asOfMs).toISOString();
  const inWindow = and(
    eq(dockAppointments.tenantId, tenantId),
    eq(dockAppointments.warehouseId, query.warehouseId),
    sql`${dockAppointments.startsAt} >= ${fromInstant}::timestamptz`,
    sql`${dockAppointments.startsAt} < ${toInstant}::timestamptz`,
  );
  const rows = await tx
    .select()
    .from(dockAppointments)
    .where(and(inWindow, query.includeCancelled ? undefined : ne(dockAppointments.status, 'cancelled')))
    .orderBy(asc(dockAppointments.startsAt), asc(dockAppointments.id))
    .limit(DOCK_LIMITS.windowAppointments + 1);
  const truncated = rows.length > DOCK_LIMITS.windowAppointments;
  const page = truncated ? rows.slice(0, DOCK_LIMITS.windowAppointments) : rows;
  const appointments = await dockAppointmentViewsInTx(tx, tenantId, page, asOfMs);

  // The summary — one aggregate statement, grouped by door. Written as raw
  // SQL with literal qualifiers: `status` is a column of both joined tables,
  // and a column interpolated into a select-list fragment renders
  // unqualified (guide §1, outbound Gotcha 16).
  const grouped = (
    (await tx.execute(sql`
      select a.dock_door_id as "doorId",
             count(*) filter (where a.status <> 'cancelled')::int as "scheduled",
             count(*) filter (where a.status = 'cancelled')::int as "cancelled",
             count(*) filter (where a.status = 'arrived')::int as "arrived",
             count(*) filter (where a.status = 'arrived' and p.delta < -a.grace_minutes)::int as "early",
             count(*) filter (where a.status = 'arrived' and p.delta > a.grace_minutes)::int as "late",
             count(*) filter (where a.status = 'booked'
                                and a.ends_at + make_interval(mins => a.grace_minutes) <= ${asOf}::timestamptz)::int as "noShow",
             coalesce(sum(case
               when a.status <> 'cancelled' and (${rules.openDays}::int & (1 << (p.dow - 1))) <> 0
               then greatest(0, least(p.start_min + p.duration_min, ${rules.closesMinute}::int) - greatest(p.start_min, ${rules.opensMinute}::int))
               else 0 end), 0)::int as "bookedMinutes"
        from dock_appointments a
        left join gate_ins g on g.tenant_id = a.tenant_id and g.id = a.gate_in_id
        cross join lateral (
          select trunc(extract(epoch from (g.gated_in_at - a.starts_at)) / 60) as delta,
                 extract(isodow from ((a.starts_at at time zone 'UTC') + interval '330 minutes'))::int as dow,
                 (extract(hour from ((a.starts_at at time zone 'UTC') + interval '330 minutes')) * 60
                  + extract(minute from ((a.starts_at at time zone 'UTC') + interval '330 minutes')))::int as start_min,
                 (extract(epoch from (a.ends_at - a.starts_at)) / 60)::int as duration_min
        ) p
       where a.tenant_id = ${tenantId}::uuid
         and a.warehouse_id = ${query.warehouseId}::uuid
         and a.starts_at >= ${fromInstant}::timestamptz
         and a.starts_at < ${toInstant}::timestamptz
       group by a.dock_door_id`)) as unknown as {
      doorId: string;
      scheduled: number;
      cancelled: number;
      arrived: number;
      early: number;
      late: number;
      noShow: number;
      bookedMinutes: number;
    }[]
  ).map((row) => ({
    doorId: row.doorId,
    scheduled: Number(row.scheduled),
    cancelled: Number(row.cancelled),
    arrived: Number(row.arrived),
    early: Number(row.early),
    late: Number(row.late),
    noShow: Number(row.noShow),
    bookedMinutes: Number(row.bookedMinutes),
  }));

  // The door set: active now, plus every door an appointment of the window names.
  // Cancelled-only doors join only when their appointments are listed (the page rows).
  const doorIdsInWindow = new Set([...grouped.filter((row) => row.scheduled > 0).map((row) => row.doorId), ...page.map((row) => row.dockDoorId)]);
  const doorRows = await tx
    .select()
    .from(dockDoors)
    .where(
      and(
        eq(dockDoors.tenantId, tenantId),
        eq(dockDoors.warehouseId, query.warehouseId),
        doorIdsInWindow.size === 0 ? eq(dockDoors.active, true) : sql`(${dockDoors.active} = true or ${inArray(dockDoors.id, [...doorIdsInWindow])})`,
      ),
    )
    .orderBy(desc(dockDoors.active), asc(dockDoors.code));
  const doors = doorRows.map(dockDoorView);

  // Open minutes per door: the open days of the window × the opening hours.
  let openDayCount = 0;
  for (let date = query.from; date <= query.to; date = addIsoDays(date, 1)) {
    if (isOpenDay(rules, date)) openDayCount += 1;
  }
  const openMinutesPerDoor = openDayCount * (rules.closesMinute - rules.opensMinute);
  const scheduledDoorIds = new Set(grouped.filter((row) => row.scheduled > 0).map((row) => row.doorId));
  const utilisationDoors = doorRows.filter((door) => door.active || scheduledDoorIds.has(door.id));
  const byDoorMinutes = new Map(grouped.map((row) => [row.doorId, row.bookedMinutes]));
  const byDoor = utilisationDoors.map((door) => ({
    doorId: door.id,
    bookedMinutes: byDoorMinutes.get(door.id) ?? 0,
    openMinutes: openMinutesPerDoor,
  }));
  const sum = (pick: (row: (typeof grouped)[number]) => number): number => grouped.reduce((total, row) => total + pick(row), 0);
  const arrived = sum((row) => row.arrived);
  const early = sum((row) => row.early);
  const late = sum((row) => row.late);
  const onTime = arrived - early - late;
  const noShow = sum((row) => row.noShow);
  const scheduled = sum((row) => row.scheduled);
  const bookedMinutes = byDoor.reduce((total, door) => total + door.bookedMinutes, 0);
  const openMinutes = openMinutesPerDoor * utilisationDoors.length;
  return {
    asOf,
    from: query.from,
    to: query.to,
    schedule: dockScheduleView(query.warehouseId, rules),
    doors,
    appointments,
    summary: {
      scheduled,
      pending: scheduled - arrived - noShow,
      arrived,
      early,
      onTime,
      late,
      noShow,
      cancelled: sum((row) => row.cancelled),
      onTimeRate: percent(onTime, arrived + noShow),
      bookedMinutes,
      openMinutes,
      utilisationRate: percent(bookedMinutes, openMinutes),
      byDoor,
    },
    truncated,
  };
}

// ── the gate-in fold (decision 8's views) ────────────────────────────────────

/** A gate-in's appointment, as the gate-in list, detail and the device snapshot carry it. */
export interface GateInAppointmentView {
  readonly id: string;
  readonly code: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly doorCode: string;
  readonly punctuality: DockPunctuality;
  readonly punctualityMinutes: number;
}

/**
 * The appointment linked to each of `gateInIds` (one read, joined to the
 * door and the gate-in's own `gated_in_at`, so a corrected gate-in time
 * reclassifies on the next read — decision 9).
 */
export async function appointmentsOfGateInsInTx(
  tx: TenantTx,
  tenantId: string,
  gateInIds: readonly string[],
): Promise<Map<string, GateInAppointmentView>> {
  const distinct = [...new Set(gateInIds)];
  if (distinct.length === 0) return new Map();
  const rows = await tx
    .select({
      gateInId: dockAppointments.gateInId,
      id: dockAppointments.id,
      code: dockAppointments.code,
      startsAt: dockAppointments.startsAt,
      endsAt: dockAppointments.endsAt,
      graceMinutes: dockAppointments.graceMinutes,
      doorCode: dockDoors.code,
      gatedInAt: gateIns.gatedInAt,
    })
    .from(dockAppointments)
    .innerJoin(gateIns, and(eq(gateIns.tenantId, dockAppointments.tenantId), eq(gateIns.id, dockAppointments.gateInId)))
    .leftJoin(dockDoors, and(eq(dockDoors.tenantId, dockAppointments.tenantId), eq(dockDoors.id, dockAppointments.dockDoorId)))
    .where(and(eq(dockAppointments.tenantId, tenantId), inArray(dockAppointments.gateInId, distinct)));
  const map = new Map<string, GateInAppointmentView>();
  for (const row of rows) {
    const startsAt = canonicalInstant(row.startsAt);
    map.set(row.gateInId!, {
      id: row.id,
      code: row.code,
      startsAt,
      endsAt: canonicalInstant(row.endsAt),
      doorCode: row.doorCode ?? '',
      ...punctualityOf(startsAt, row.graceMinutes, canonicalInstant(row.gatedInAt)),
    });
  }
  return map;
}

// ── the device snapshot (decision 12, A13) ───────────────────────────────────

export interface DeviceDockAppointmentView {
  readonly id: string;
  readonly code: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** A13 — the device derives "Not arrived" from `endsAt + grace` against its own clock. */
  readonly graceMinutes: number;
  readonly doorCode: string;
  readonly vehicleNo: string | null;
  readonly transporterName: string | null;
  /** A26 — `clientId` lets the device prefix the client's code when two documents' codes collide (an ASN code is unique per client only). */
  readonly documents: readonly { readonly kind: 'po' | 'asn'; readonly code: string | null; readonly clientId: string | null }[];
}

/**
 * The warehouse's BOOKED appointments starting today (IST, the dock clock),
 * at most `DOCK_LIMITS.deviceAppointments`, by start — an `…InTx` read on the
 * snapshot's own transaction (inbound Gotcha 2). No note (it never reaches
 * the device).
 */
export async function todaysDockAppointmentsInTx(
  tx: TenantTx,
  tenantId: string,
  warehouseId: string,
  nowMs: number,
): Promise<DeviceDockAppointmentView[]> {
  const today = istDateOf(new Date(nowMs).toISOString());
  const rows = await tx
    .select()
    .from(dockAppointments)
    .where(
      and(
        eq(dockAppointments.tenantId, tenantId),
        eq(dockAppointments.warehouseId, warehouseId),
        eq(dockAppointments.status, 'booked'),
        sql`${dockAppointments.startsAt} >= ${istMidnightOf(today)}::timestamptz`,
        sql`${dockAppointments.startsAt} < ${istMidnightOf(addIsoDays(today, 1))}::timestamptz`,
      ),
    )
    .orderBy(asc(dockAppointments.startsAt), asc(dockAppointments.id))
    .limit(DOCK_LIMITS.deviceAppointments);
  const views = await dockAppointmentViewsInTx(tx, tenantId, rows, nowMs);
  return views.map((view) => ({
    id: view.id,
    code: view.code,
    startsAt: view.startsAt,
    endsAt: view.endsAt,
    graceMinutes: view.graceMinutes,
    doorCode: view.doorCode,
    vehicleNo: view.vehicleNo,
    transporterName: view.transporterName,
    documents: view.documents.map((doc) => ({ kind: doc.kind, code: doc.code, clientId: doc.clientId })),
  }));
}

// ── the slot grid (decision 4, A7) ───────────────────────────────────────────

/** The start of the IST slot `nowMs` falls in, as epoch ms (IST midnight is on every slot grid). */
export function currentSlotStartMs(nowMs: number, slotMinutes: number): number {
  const slotMs = slotMinutes * MINUTE_MS;
  return Math.floor((nowMs + IST_OFFSET_MS) / slotMs) * slotMs - IST_OFFSET_MS;
}
