import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request, { type Test as SupertestTest } from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { IST_OFFSET_MS, addIsoDays, istMidnightOf } from '../src/shared/primitives/time';
import { gateInClock } from '../src/modules/inbound/gate-in.command';
import { DOCK_APPOINTMENT_STATUSES, dockClock, punctualityOf } from '../src/modules/inbound/dock.read';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow, noOpIdempotencyKey } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';
import { createLinkedVendor } from './support/linked-vendor';

process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.DEVICE_ENCRYPTION_KEY ??= 'e2e-only-device-encryption-key-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;

jest.setTimeout(300_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';
const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/** Tuesday 3 Nov 2026, 10:10 IST — the suite's "now" (both command clocks). */
const TODAY = '2026-11-03';
const TOMORROW = '2026-11-04';
const SUNDAY = '2026-11-08';
const NOW_MS = Date.parse('2026-11-03T04:40:00.000Z');

/** The instant an IST wall clock `HH:MM` on `date` is. */
function at(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(istMidnightOf(date)) + (h! * 60 + m!) * MINUTE).toISOString();
}

interface Appointment {
  id: string;
  code: string;
  status: string;
  dockDoorId: string;
  doorCode: string;
  startsAt: string;
  endsAt: string;
  graceMinutes: number;
  clientId: string | null;
  vehicleNo: string | null;
  transporterName: string | null;
  note: string | null;
  documents: { kind: string; id: string; code: string | null; clientId: string | null; vendorName: string | null }[];
  gateInId: string | null;
  gateInCode: string | null;
  punctuality: string | null;
  punctualityMinutes: number | null;
  noShow: boolean;
  cancelReason: string | null;
}

interface WindowBody {
  asOf: string;
  doors: { id: string; code: string; active: boolean }[];
  appointments: Appointment[];
  summary: Record<string, unknown> & { byDoor: { doorId: string; bookedMinutes: number; openMinutes: number }[] };
  truncated: boolean;
  schedule: Record<string, unknown>;
}

/**
 * Story 2-3b — dock appointments: one case per backend row of the spec's
 * I/O matrix and its amendments (book, the bounds, overlap and the same-door
 * race, documents, reschedule and its A3/A4/A5/A10 rows, cancel, the closed
 * and no-show arms, the busy-door deactivation, the window read and its
 * summary — A8/A9 —, the device snapshot), the audit and no-op pins, the
 * overlap EXPLAIN (A16), RLS (the AD-24 arm) and the portal fence. The
 * gate-in link rows are in test/gate-ins.spec.ts.
 */
describe('story 2-3b: dock appointments', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let suiteDb: SuiteDatabase;
  const realDock = dockClock.now;
  const realGate = gateInClock.now;

  let tenantId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let operatorToken: string;
  let operatorUserId: string;
  let accountantToken: string;
  let portalToken: string;
  let deviceToken: string;
  let wh1: string;
  let wh2: string;
  let glowCo: string;
  let brewCo: string;
  let po1001: string;
  let po1002: string;
  let poClosed: string;
  let poWh2: string;
  let asn77: string;
  let asnReceived: string;
  const door: Record<string, string> = {};
  let doorWh2: string;
  let doorInactive: string;

  const http = () => request(app.getHttpServer());

  function expectProblem(res: request.Response, status: number, code: string): void {
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  }

  async function member(role: 'ops_manager' | 'operator' | 'accountant' | 'client', clientId?: string): Promise<{ token: string; userId: string; email: string }> {
    const email = `${role}-${ulid().toLowerCase()}@example.com`;
    const invited = await http()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({ email, role, ...(clientId === undefined ? {} : { clientId }) })
      .expect(201);
    await http()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    const signed = (await mintSignIn(app, { email, password: PASSWORD })).body;
    return { token: signed.accessToken as string, userId: signed.user?.id as string, email };
  }

  async function site(code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ origin: testAddress(), code, name: `${code} site` })
        .expect(201)
    ).body.id as string;
  }

  async function newDoor(warehouseId: string, code: string): Promise<string> {
    return (
      await http()
        .post(`${API}/${tenantId}/warehouses/${warehouseId}/dock-doors`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set(KEY_HEADER, ulid())
        .send({ code })
        .expect(201)
    ).body.dockDoor.id as string;
  }

  function setDoor(warehouseId: string, doorId: string, body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .patch(`${API}/${tenantId}/warehouses/${warehouseId}/dock-doors/${doorId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send(body);
  }

  function putSchedule(warehouseId: string, body: Record<string, unknown>): SupertestTest {
    return http()
      .put(`${API}/${tenantId}/warehouses/${warehouseId}/dock-schedule`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send(body);
  }

  function book(body: Record<string, unknown>, key = ulid(), token = operatorToken): SupertestTest {
    return http().post(`${API}/${tenantId}/receiving/dock-appointments`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(body);
  }

  /** A full replacement — `slot()`'s warehouseId dropped (the route takes the appointment's). */
  function reschedule(id: string, body: Record<string, unknown>, key = ulid(), token = operatorToken): SupertestTest {
    const { warehouseId, ...fields } = body;
    void warehouseId;
    return http().patch(`${API}/${tenantId}/receiving/dock-appointments/${id}`).set('Authorization', `Bearer ${token}`).set(KEY_HEADER, key).send(fields);
  }

  function cancel(id: string, reason: string, key = ulid(), token = operatorToken): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/dock-appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .set(KEY_HEADER, key)
      .send({ reason });
  }

  async function windowOf(warehouseId: string, from: string, to = from, extra: Record<string, unknown> = {}): Promise<WindowBody> {
    return (
      await http()
        .get(`${API}/${tenantId}/receiving/dock-schedule`)
        .query({ warehouseId, from, to, ...extra })
        .set('Authorization', `Bearer ${accountantToken}`)
        .expect(200)
    ).body as WindowBody;
  }

  async function getAppointment(id: string): Promise<Appointment> {
    return (await http().get(`${API}/${tenantId}/receiving/dock-appointments/${id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body
      .appointment as Appointment;
  }

  /** A booking body on D<n> of BLR-1 (the default schedule: 30 min, 09:00–18:00 Mon–Sat, grace 15). */
  function slot(doorCode: string, date: string, from: string, to: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { warehouseId: wh1, dockDoorId: door[doorCode], startsAt: at(date, from), endsAt: at(date, to), ...extra };
  }

  function gateIn(body: Record<string, unknown>, key = ulid()): SupertestTest {
    return http()
      .post(`${API}/${tenantId}/receiving/gate-ins`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, key)
      .send({ warehouseId: wh1, vehicleNo: 'KA01AB1234', transporterName: 'Typed Roadways', sealStatus: 'none', ...body });
  }

  const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

  /** Polls until `min` requests are parked behind `holderPid` on a `FOR UPDATE` of `table` (the waiter chain counted). */
  async function waitParked(table: string, holderPid: number, min: number): Promise<void> {
    const probe = handle();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = (await probe`
          select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
          where a.wait_event_type = 'Lock' and a.state = 'active'
            and a.query ilike ${`%"${table}"%`} and a.query ilike '%for update%'
        `) as unknown as { pid: number; blockers: number[] }[];
        const chain = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of waiting) {
            if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
              chain.add(row.pid);
              grew = true;
            }
          }
        }
        if (chain.size - 1 >= min) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${min} request(s) parked on ${table}`);
    } finally {
      await probe.end();
    }
  }

  async function auditCount(key: string): Promise<number> {
    return (await sql<{ n: number }[]>`select count(*)::int as n from audit_events where tenant_id = ${tenantId} and reference = ${key}`)[0]!.n;
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('dock_appointments');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => undefined });
    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await http()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Dock Appointments ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    ownerUserId = registered.body.owner.id as string;
    ownerToken = (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
    const operator = await member('operator');
    operatorToken = operator.token;
    operatorUserId = (await sql<{ id: string }[]>`select id from users where email = ${operator.email}`)[0]!.id;
    accountantToken = (await member('accountant')).token;
    const client = async (code: string, name: string): Promise<string> =>
      (
        await http()
          .post(`${API}/${tenantId}/clients`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, name })
          .expect(201)
      ).body.client.id as string;
    glowCo = await client('GLOW', 'GlowCo');
    brewCo = await client('BREW', 'BrewCo');
    portalToken = (await member('client', glowCo)).token;
    const minted = await http()
      .post(`${API}/${tenantId}/devices/enrollment-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set(KEY_HEADER, ulid())
      .send({})
      .expect(201);
    const enrolled = await http()
      .post(`${API}/${tenantId}/devices/enroll`)
      .set(KEY_HEADER, ulid())
      .send({ code: minted.body.code, label: 'Dock handheld', pin: '2468' })
      .expect(201);
    deviceToken = (
      await http()
        .post(`${API}/${tenantId}/devices/badge-in`)
        .set('Authorization', `Bearer ${enrolled.body.deviceToken as string}`)
        .send({ operatorEmail: operator.email, pin: '2468' })
        .expect(200)
    ).body.accessToken as string;
    wh1 = await site('BLR-1');
    wh2 = await site('PNQ-1');
    const sku = async (code: string, clientId: string): Promise<string> =>
      (
        await http()
          .post(`${API}/${tenantId}/catalog/skus`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ code, name: `${code} item`, uom: 'each', gstRate: 1800, batchTracked: false, serialTracked: false, catchWeightTracked: false, clientId })
          .expect(201)
      ).body.sku.id as string;
    const glowSku = await sku('GLOW-CREAM', glowCo);
    const brewSku = await sku('BREW-ALE', brewCo);
    const vendor = await createLinkedVendor(app, tenantId, ownerToken, { code: 'V-GLOW', name: 'Glow Supplier', clientIds: [glowCo] });
    const po = async (warehouseId: string, code: string): Promise<string> =>
      (
        await http()
          .post(`${API}/${tenantId}/inbound/purchase-orders`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ warehouseId, vendorId: vendor, code, lines: [{ skuId: glowSku, orderedQty: 100, unitCostPaise: 1000 }] })
          .expect(201)
      ).body.purchaseOrder.id as string;
    po1001 = await po(wh1, 'PO-1001');
    po1002 = await po(wh1, 'PO-1002');
    poClosed = await po(wh1, 'PO-1003');
    poWh2 = await po(wh2, 'PO-2001');
    await sql`update purchase_orders set status = 'closed' where id = ${poClosed}`;
    const asn = async (code: string): Promise<string> =>
      (
        await http()
          .post(`${API}/${tenantId}/inbound/asns`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .set(KEY_HEADER, ulid())
          .send({ clientId: brewCo, warehouseId: wh1, asnCode: code, lines: [{ skuId: brewSku, announcedQty: 10 }] })
          .expect(201)
      ).body.asn.id as string;
    asn77 = await asn('ASN-77');
    asnReceived = await asn('ASN-78');
    await sql`update advance_shipment_notices set status = 'received' where id = ${asnReceived}`;
    for (const code of ['D1', 'D2', 'D3', 'D4', 'D9']) door[code] = await newDoor(wh1, code);
    doorInactive = door.D9!;
    await setDoor(wh1, doorInactive, { code: 'D9', active: false }).expect(200);
    doorWh2 = await newDoor(wh2, 'W1');
  });

  beforeEach(() => {
    dockClock.now = () => NOW_MS;
    gateInClock.now = () => NOW_MS;
  });

  afterAll(async () => {
    dockClock.now = realDock;
    gateInClock.now = realGate;
    await sql?.end();
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── book ──────────────────────────────────────────────────────────────────

  describe('book', () => {
    it('Book (AC1): D3 tomorrow 10:30–11:30 against PO-1001 → 201 DA-0001, booked, GlowCo stamped, grace 15 frozen; audited; replayed; the note never rides the outbox', async () => {
      const key = ulid();
      const body = slot('D3', TOMORROW, '10:30', '11:30', {
        documents: [{ poId: po1001 }],
        vehicleNo: 'ka-01 ab 1234',
        transporterName: ' VRL ',
        note: 'Call 98765 43210 at the gate',
      });
      const res = await book(body, key).expect(201);
      const appointment = res.body.appointment as Appointment;
      expect(appointment).toMatchObject({
        code: 'DA-0001',
        status: 'booked',
        doorCode: 'D3',
        startsAt: at(TOMORROW, '10:30'),
        endsAt: at(TOMORROW, '11:30'),
        graceMinutes: 15,
        clientId: glowCo,
        vehicleNo: 'KA01AB1234',
        transporterName: 'VRL',
        note: 'Call 98765 43210 at the gate',
        gateInId: null,
        punctuality: null,
        noShow: false,
      });
      expect(appointment.documents).toEqual([{ kind: 'po', id: po1001, code: 'PO-1001', clientId: glowCo, vendorName: 'Glow Supplier' }]);
      await expectAuditRow({ tenantId, key, action: 'dock_appointment.booked', targetType: 'dock_appointment', targetId: appointment.id, actorUserId: operatorUserId });
      expect((await book(body, key).expect(201)).body.appointment).toEqual(appointment);
      await expectAuditRow({ tenantId, key, action: 'dock_appointment.booked', targetType: 'dock_appointment', targetId: appointment.id, actorUserId: operatorUserId });
      expectProblem(await book({ ...body, note: 'other' }, key), 422, 'idempotency-key-reuse');
      const events = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'dock_appointment.booked'`) as unknown as {
        payload: { appointment: Record<string, unknown> };
      }[];
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.appointment.code).toBe('DA-0001');
      expect('note' in events[0]!.payload.appointment).toBe(false);
      expect(JSON.stringify(events[0]!.payload)).not.toContain('98765');
      // The drawer read and the Week view's data.
      expect(await getAppointment(appointment.id)).toEqual(appointment);
    });

    it('Mixed clients: PO-1002 (GlowCo) + ASN-77 (BrewCo) → client null; both documents shown', async () => {
      const res = await book(slot('D1', TOMORROW, '09:00', '09:30', { documents: [{ poId: po1002 }, { asnId: asn77 }] })).expect(201);
      const appointment = res.body.appointment as Appointment;
      expect(appointment.clientId).toBeNull();
      expect(appointment.documents).toEqual([
        { kind: 'po', id: po1002, code: 'PO-1002', clientId: glowCo, vendorName: 'Glow Supplier' },
        { kind: 'asn', id: asn77, code: 'ASN-77', clientId: brewCo, vendorName: null },
      ]);
      // No documents: no client.
      expect((await book(slot('D1', TOMORROW, '09:30', '10:00')).expect(201)).body.appointment.clientId).toBeNull();
    });

    it('C1: the documents hash both keys as received — a same-key resend differing only in asnId is 422, never a replay', async () => {
      const key = ulid();
      const body = slot('D1', TOMORROW, '10:00', '10:30', { documents: [{ poId: '', asnId: asn77 }] });
      const booked = (await book(body, key).expect(201)).body.appointment as Appointment;
      expect(booked.documents.map((doc) => doc.id)).toEqual([asn77]);
      expectProblem(await book(slot('D1', TOMORROW, '10:00', '10:30', { documents: [{ poId: '', asnId: asnReceived }] }), key), 422, 'idempotency-key-reuse');
      expect((await book(body, key).expect(201)).body.appointment).toEqual(booked);
    });

    it('Overlap: D3 11:00–11:30 over DA-0001 → 409 dock-slot-taken naming DA-0001 10:30–11:30; Adjacent: 11:30–12:00 → 201', async () => {
      const res = await book(slot('D3', TOMORROW, '11:00', '11:30'));
      expectProblem(res, 409, 'dock-slot-taken');
      expect(res.body.detail).toContain('DA-0001');
      expect(res.body.detail).toContain('10:30–11:30 IST');
      expect(res.body.clash).toMatchObject({ code: 'DA-0001', startsAt: at(TOMORROW, '10:30'), endsAt: at(TOMORROW, '11:30') });
      expectProblem(await book(slot('D3', TOMORROW, '10:00', '11:00')), 409, 'dock-slot-taken');
      expectProblem(await book(slot('D3', TOMORROW, '10:00', '12:00')), 409, 'dock-slot-taken');
      await book(slot('D3', TOMORROW, '11:30', '12:00')).expect(201);
      await book(slot('D3', TOMORROW, '10:00', '10:30')).expect(201);
    });

    it('A16: the overlap read plans on the (tenant_id, dock_door_id, starts_at) index', async () => {
      await sql`analyze dock_appointments`;
      await sql.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        const plan = (await tx.unsafe(
          `explain select id from dock_appointments where tenant_id = $1 and dock_door_id = $2 and status <> 'cancelled'
             and starts_at > $3::timestamptz - interval '8 hours' and starts_at < $4::timestamptz and ends_at > $3::timestamptz limit 1`,
          [tenantId, door.D3!, at(TOMORROW, '10:00'), at(TOMORROW, '11:00')],
        )) as unknown as { 'QUERY PLAN': string }[];
        expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('dock_appointments_tenant_door_starts_idx');
      });
    });

    it('Same-door race: two books of D2 tomorrow 13:00 parked on the door lock → one 201, one 409 dock-slot-taken', async () => {
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from dock_doors where id = ${door.D2!} for update`) as unknown as { pid: number }[];
          first = (async () => book(slot('D2', TOMORROW, '13:00', '13:30')))();
          second = (async () => book(slot('D2', TOMORROW, '13:00', '14:00')))();
          await waitParked('dock_doors', locked[0]!.pid, 2);
        });
        const results = await Promise.all([first!, second!]);
        expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
        expect(results.find((res) => res.status === 409)!.body.code).toBe('dock-slot-taken');
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      const rows = await sql`select count(*)::int as n from dock_appointments where dock_door_id = ${door.D2!} and starts_at = ${at(TOMORROW, '13:00')}`;
      expect(rows[0]!.n).toBe(1);
    });

    it('Misaligned / long: a 10:40 start → 400 slot-misaligned; 45 minutes → slot-misaligned; 9 slots → 400 validation-failed', async () => {
      expectProblem(await book(slot('D4', TOMORROW, '10:40', '11:10')), 400, 'slot-misaligned');
      expectProblem(await book(slot('D4', TOMORROW, '10:00', '10:45')), 400, 'slot-misaligned');
      const res = await book(slot('D4', TOMORROW, '09:00', '13:30'));
      expectProblem(res, 400, 'validation-failed');
      expect(res.body.detail).toMatch(/1 to 8 slots/);
      // Over 8 hours is refused as shape, before the schedule.
      expectProblem(await book(slot('D4', TOMORROW, '09:00', '17:30')), 400, 'validation-failed');
      expectProblem(await book(slot('D4', TOMORROW, '10:00', '10:00')), 400, 'validation-failed');
    });

    it('Closed: Sunday; 08:30; ending 18:30 → 409 dock-closed', async () => {
      const sunday = await book(slot('D4', SUNDAY, '10:00', '10:30'));
      expectProblem(sunday, 409, 'dock-closed');
      expect(sunday.body.detail).toMatch(/closed on Sunday/);
      expectProblem(await book(slot('D4', TOMORROW, '08:30', '09:30')), 409, 'dock-closed');
      expectProblem(await book(slot('D4', TOMORROW, '17:30', '18:30')), 409, 'dock-closed');
      await book(slot('D4', TOMORROW, '17:30', '18:00')).expect(201);
    });

    it('Past / far / current: the previous slot today → 400 slot-in-past; today + 91 → slot-too-far; now 10:40, 10:30 today → 201', async () => {
      // Now 10:10 IST: the current slot is 10:00.
      expectProblem(await book(slot('D4', TODAY, '09:30', '10:00')), 400, 'slot-in-past');
      expectProblem(await book(slot('D4', addIsoDays(TODAY, 91), '10:00', '10:30')), 400, 'slot-too-far');
      await book(slot('D4', addIsoDays(TODAY, 90), '10:00', '10:30')).expect(201);
      dockClock.now = () => Date.parse(at(TODAY, '10:40'));
      await book(slot('D4', TODAY, '10:30', '11:00')).expect(201);
    });

    it('Documents (A17): unknown → 404; closed PO → po-not-open; received ASN → asn-not-open; a WH2 PO → document-warehouse-mismatch; a repeat → 400', async () => {
      expectProblem(await book(slot('D4', TOMORROW, '12:00', '12:30', { documents: [{ poId: uuidv7() }] })), 404, 'not-found');
      expectProblem(await book(slot('D4', TOMORROW, '12:00', '12:30', { documents: [{ poId: poClosed }] })), 409, 'po-not-open');
      expectProblem(await book(slot('D4', TOMORROW, '12:00', '12:30', { documents: [{ asnId: asnReceived }] })), 409, 'asn-not-open');
      expectProblem(await book(slot('D4', TOMORROW, '12:00', '12:30', { documents: [{ poId: poWh2 }] })), 409, 'document-warehouse-mismatch');
      expectProblem(await book(slot('D4', TOMORROW, '12:00', '12:30', { documents: [{ poId: po1001 }, { poId: po1001 }] })), 400, 'validation-failed');
      expectProblem(await book(slot('D4', TOMORROW, '12:00', '12:30', { documents: [{ poId: po1001, asnId: asn77 }] })), 400, 'validation-failed');
      const eleven = Array.from({ length: 11 }, () => ({ poId: uuidv7() }));
      expectProblem(await book(slot('D4', TOMORROW, '12:00', '12:30', { documents: eleven })), 400, 'validation-failed');
    });

    it('Doors: a WH2 door → 409 dock-door-warehouse-mismatch; an inactive door → 409 dock-door-inactive; unknown → 404', async () => {
      expectProblem(await book({ ...slot('D4', TOMORROW, '12:00', '12:30'), dockDoorId: doorWh2 }), 409, 'dock-door-warehouse-mismatch');
      expectProblem(await book({ ...slot('D4', TOMORROW, '12:00', '12:30'), dockDoorId: doorInactive }), 409, 'dock-door-inactive');
      expectProblem(await book({ ...slot('D4', TOMORROW, '12:00', '12:30'), dockDoorId: uuidv7() }), 404, 'not-found');
    });

    it('capabilities: dock.schedule — an accountant is refused before validation; a portal session is refused on every appointment route', async () => {
      expectProblem(await book({ ...slot('D4', TOMORROW, '12:10', '12:30') }, ulid(), accountantToken), 403, 'role-denied');
      const anId = (await sql<{ id: string }[]>`select id from dock_appointments where tenant_id = ${tenantId} limit 1`)[0]!.id;
      for (const res of [
        await book(slot('D4', TOMORROW, '12:00', '12:30'), ulid(), portalToken),
        await reschedule(anId, slot('D4', TOMORROW, '12:00', '12:30'), ulid(), portalToken),
        await cancel(anId, 'x', ulid(), portalToken),
        await http().get(`${API}/${tenantId}/receiving/dock-appointments/${anId}`).set('Authorization', `Bearer ${portalToken}`),
        await http().get(`${API}/${tenantId}/receiving/dock-schedule`).query({ warehouseId: wh1, from: TOMORROW, to: TOMORROW }).set('Authorization', `Bearer ${portalToken}`),
      ]) {
        expectProblem(res, 403, 'role-denied');
        expect(res.body.detail).toBe('This is an operator surface.');
      }
    });
  });

  // ── reschedule and cancel ──────────────────────────────────────────────────

  describe('reschedule and cancel', () => {
    it('Reschedule: to D4 14:00 → 200, door and window replaced, the audit row carries the changes; unchanged → the no-op arm', async () => {
      const created = (await book(slot('D1', TOMORROW, '15:00', '15:30', { documents: [{ poId: po1001 }], note: 'first' })).expect(201)).body
        .appointment as Appointment;
      const key = ulid();
      const body = slot('D4', TOMORROW, '14:00', '15:00', { documents: [{ poId: po1001 }], note: 'second' });
      const moved = (await reschedule(created.id, body, key).expect(200)).body.appointment as Appointment;
      expect(moved).toMatchObject({ id: created.id, code: created.code, doorCode: 'D4', startsAt: at(TOMORROW, '14:00'), endsAt: at(TOMORROW, '15:00'), note: 'second' });
      await expectAuditRow({ tenantId, key, action: 'dock_appointment.rescheduled', targetType: 'dock_appointment', targetId: created.id, actorUserId: operatorUserId });
      const changes = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`)[0]!.changes as Record<string, unknown>;
      expect(changes).toEqual({
        door: { before: 'D1', after: 'D4' },
        startsAt: { before: at(TOMORROW, '15:00'), after: at(TOMORROW, '14:00') },
        endsAt: { before: at(TOMORROW, '15:30'), after: at(TOMORROW, '15:00') },
        note: { changed: true },
      });
      expect((await reschedule(created.id, body, key).expect(200)).body.appointment).toEqual(moved);
      // The old slot freed, the new one taken.
      await book(slot('D1', TOMORROW, '15:00', '15:30')).expect(201);
      expectProblem(await book(slot('D4', TOMORROW, '14:30', '15:00')), 409, 'dock-slot-taken');
      // Unchanged (a new key): no audit, no outbox.
      const noOp = noOpIdempotencyKey(tenantId, ulid(), 'dockAppointments.reschedule:unchanged');
      const before = Number((await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'dock_appointment.rescheduled'`)[0]!.n);
      await reschedule(created.id, body, noOp).expect(200);
      expect(await auditCount(noOp)).toBe(0);
      expect(Number((await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'dock_appointment.rescheduled'`)[0]!.n)).toBe(before);
    });

    it('Reschedule, PO closed since: same documents, a new time → 200; a kept closed PO + an added open ASN → 200; an ADDED closed PO → 409 po-not-open', async () => {
      const created = (await book(slot('D2', TOMORROW, '16:00', '16:30', { documents: [{ poId: po1002 }] })).expect(201)).body.appointment as Appointment;
      await sql`update purchase_orders set status = 'closed' where id = ${po1002}`;
      try {
        await reschedule(created.id, slot('D2', TOMORROW, '16:30', '17:00', { documents: [{ poId: po1002 }] })).expect(200);
        // Only the added documents are checked; the client re-derives from the full set (mixed → null).
        const added = (await reschedule(created.id, slot('D2', TOMORROW, '16:30', '17:00', { documents: [{ poId: po1002 }, { asnId: asn77 }] })).expect(200)).body
          .appointment as Appointment;
        expect(added.documents.map((doc) => doc.code)).toEqual(['PO-1002', 'ASN-77']);
        expect(added.clientId).toBeNull();
        // Dropping the ASN again re-stamps GlowCo from the kept (closed) PO.
        expect((await reschedule(created.id, slot('D2', TOMORROW, '16:30', '17:00', { documents: [{ poId: po1002 }] })).expect(200)).body.appointment.clientId).toBe(glowCo);
        expectProblem(
          await reschedule(created.id, slot('D2', TOMORROW, '16:30', '17:00', { documents: [{ poId: po1002 }, { poId: poClosed }] })),
          409,
          'po-not-open',
        );
      } finally {
        await sql`update purchase_orders set status = 'open' where id = ${po1002}`;
      }
    });

    it('A3: a move to a WH2 door → 409 dock-door-warehouse-mismatch; to an inactive door → 409 dock-door-inactive', async () => {
      const created = (await book(slot('D2', TOMORROW, '09:00', '09:30')).expect(201)).body.appointment as Appointment;
      expectProblem(await reschedule(created.id, { ...slot('D2', TOMORROW, '09:00', '09:30'), dockDoorId: doorWh2 }), 409, 'dock-door-warehouse-mismatch');
      expectProblem(await reschedule(created.id, { ...slot('D2', TOMORROW, '09:00', '09:30'), dockDoorId: doorInactive }), 409, 'dock-door-inactive');
      expectProblem(await reschedule(created.id, { ...slot('D2', TOMORROW, '09:00', '09:30'), dockDoorId: uuidv7() }), 404, 'not-found');
      expectProblem(await reschedule(uuidv7(), slot('D2', TOMORROW, '09:00', '09:30')), 404, 'not-found');
    });

    it('A5: a note edit at 10:40 on a 10:00–11:00 booking → 200, grace unchanged (a move then would be slot-in-past)', async () => {
      const created = (await book(slot('D1', TODAY, '11:00', '12:00')).expect(201)).body.appointment as Appointment;
      await sql`update dock_appointments set starts_at = ${at(TODAY, '10:00')}, ends_at = ${at(TODAY, '11:00')}, grace_minutes = 20 where id = ${created.id}`;
      dockClock.now = () => Date.parse(at(TODAY, '10:40'));
      const edited = (await reschedule(created.id, slot('D1', TODAY, '10:00', '11:00', { note: 'Gate 2' })).expect(200)).body.appointment as Appointment;
      expect(edited).toMatchObject({ note: 'Gate 2', graceMinutes: 20 });
      expectProblem(await reschedule(created.id, slot('D1', TODAY, '10:00', '10:30', { note: 'Gate 2' })), 400, 'slot-in-past');
    });

    it('A10: dropping ASN-77 from PO-1001 + ASN-77 stamps GlowCo (audit changes.client); adding it back clears it', async () => {
      const created = (await book(slot('D3', TOMORROW, '14:00', '14:30', { documents: [{ poId: po1001 }, { asnId: asn77 }] })).expect(201)).body
        .appointment as Appointment;
      expect(created.clientId).toBeNull();
      const key = ulid();
      const stamped = (await reschedule(created.id, slot('D3', TOMORROW, '14:00', '14:30', { documents: [{ poId: po1001 }] }), key).expect(200)).body
        .appointment as Appointment;
      expect(stamped.clientId).toBe(glowCo);
      const changes = (await sql`select changes from audit_events where tenant_id = ${tenantId} and reference = ${key}`)[0]!.changes as Record<string, unknown>;
      expect(changes.client).toEqual({ before: null, after: glowCo });
      expect(changes.documents).toEqual({ before: ['po PO-1001', 'asn ASN-77'], after: ['po PO-1001'] });
      const cleared = (await reschedule(created.id, slot('D3', TOMORROW, '14:00', '14:30', { documents: [{ asnId: asn77 }, { poId: po1001 }] })).expect(200))
        .body.appointment as Appointment;
      expect(cleared.clientId).toBeNull();
    });

    it('A4: two reschedules of one appointment to different doors — one 200, the other 409 conflict ("moved concurrently")', async () => {
      const created = (await book(slot('D1', TOMORROW, '16:00', '16:30')).expect(201)).body.appointment as Appointment;
      const holder = handle();
      let first: Promise<request.Response> | undefined;
      let second: Promise<request.Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          const locked = (await tx`select pg_backend_pid() as pid from dock_appointments where id = ${created.id} for update`) as unknown as { pid: number }[];
          // R1 locks {D1, D2} and parks on the appointment …
          first = (async () => reschedule(created.id, slot('D2', TOMORROW, '17:00', '17:30')))();
          await waitParked('dock_appointments', locked[0]!.pid, 1);
          // … R2 parks on D1 behind R1.
          second = (async () => reschedule(created.id, slot('D3', TOMORROW, '17:00', '17:30')))();
          const r1 = (await tx`select pid from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%"dock_appointments"%' and query ilike '%for update%'`) as unknown as { pid: number }[];
          await waitParked('dock_doors', r1[0]!.pid, 1);
        });
        const [r1, r2] = await Promise.all([first!, second!]);
        expect(r1.status).toBe(200);
        expectProblem(r2, 409, 'conflict');
        expect(r2.body.detail).toContain('moved concurrently');
      } finally {
        await Promise.allSettled([first, second]);
        await holder.end();
      }
      expect((await getAppointment(created.id)).doorCode).toBe('D2');
    });

    it('Cancel: "Vendor postponed" → cancelled, the slot frees; audited; a second cancel → 409 appointment-closed', async () => {
      const created = (await book(slot('D4', TOMORROW, '15:00', '15:30')).expect(201)).body.appointment as Appointment;
      const key = ulid();
      const cancelled = (await cancel(created.id, '  Vendor postponed ', key).expect(200)).body.appointment as Appointment;
      expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Vendor postponed' });
      await expectAuditRow({ tenantId, key, action: 'dock_appointment.cancelled', targetType: 'dock_appointment', targetId: created.id, actorUserId: operatorUserId });
      expect((await cancel(created.id, '  Vendor postponed ', key).expect(200)).body.appointment).toEqual(cancelled);
      await book(slot('D4', TOMORROW, '15:00', '15:30')).expect(201);
      expectProblem(await cancel(created.id, 'again'), 409, 'appointment-closed');
      expectProblem(await reschedule(created.id, slot('D4', TOMORROW, '16:00', '16:30')), 409, 'appointment-closed');
      expectProblem(await cancel(created.id, '   '), 400, 'validation-failed');
      expectProblem(await cancel(created.id, 'r'.repeat(201)), 400, 'validation-failed');
      // C4 — the reason is desk free text: it rides no event.
      const events = (await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'dock_appointment.cancelled'
        and payload->'appointment'->>'id' = ${created.id}`) as unknown as { payload: { appointment: Record<string, unknown> } }[];
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.appointment.status).toBe('cancelled');
      expect('cancelReason' in events[0]!.payload.appointment).toBe(false);
      expect(JSON.stringify(events[0]!.payload)).not.toContain('Vendor postponed');
    });

    it('V5: a same-door reschedule over its own old window (12:00–12:30 → 12:00–13:00) → 200; into another appointment → 409 dock-slot-taken with the clash', async () => {
      const mine = (await book(slot('D4', TOMORROW, '12:00', '12:30')).expect(201)).body.appointment as Appointment;
      await reschedule(mine.id, slot('D4', TOMORROW, '12:00', '13:00')).expect(200);
      const other = (await book(slot('D4', TOMORROW, '13:00', '13:30')).expect(201)).body.appointment as Appointment;
      const res = await reschedule(mine.id, slot('D4', TOMORROW, '12:30', '13:30'));
      expectProblem(res, 409, 'dock-slot-taken');
      expect(res.body.clash).toMatchObject({ id: other.id, code: other.code, startsAt: at(TOMORROW, '13:00'), endsAt: at(TOMORROW, '13:30') });
    });

    it('Closed / no-show: cancel an arrived one → appointment-closed; reschedule at endsAt + grace + 1 min → appointment-no-show', async () => {
      const arrived = (await book(slot('D1', TOMORROW, '17:00', '17:30')).expect(201)).body.appointment as Appointment;
      gateInClock.now = () => Date.parse(at(TOMORROW, '17:05'));
      await gateIn({ gatedInAt: at(TOMORROW, '17:05'), appointmentId: arrived.id }).expect(201);
      expectProblem(await cancel(arrived.id, 'late'), 409, 'appointment-closed');
      const created = (await book(slot('D2', TOMORROW, '10:00', '10:30')).expect(201)).body.appointment as Appointment;
      dockClock.now = () => Date.parse(at(TOMORROW, '10:45'));
      // Exactly endsAt + grace is already a no-show (decision 9: asOf ≥ endsAt + grace).
      expectProblem(await cancel(created.id, 'x'), 409, 'appointment-no-show');
      dockClock.now = () => Date.parse(at(TOMORROW, '10:46'));
      expectProblem(await reschedule(created.id, slot('D2', TOMORROW, '11:00', '11:30')), 409, 'appointment-no-show');
      expect((await getAppointment(created.id)).noShow).toBe(true);
      dockClock.now = () => Date.parse(at(TOMORROW, '10:44'));
      expect((await getAppointment(created.id)).noShow).toBe(false);
    });

    it('Deactivate busy door: D3 with bookings tomorrow → 409 dock-door-has-appointments naming the count and the first code', async () => {
      const count = Number(
        (await sql`select count(*)::int as n from dock_appointments where dock_door_id = ${door.D3!} and status = 'booked'
          and ends_at + grace_minutes * interval '1 minute' > ${new Date(NOW_MS).toISOString()}`)[0]!.n,
      );
      const res = await setDoor(wh1, door.D3!, { code: 'D3', active: false });
      expectProblem(res, 409, 'dock-door-has-appointments');
      expect(res.body.appointmentCount).toBe(count);
      expect(res.body.firstAppointmentCode).toMatch(/^DA-\d{4}$/);
      expect(res.body.detail).toContain(res.body.firstAppointmentCode as string);
    });

    it('C2 / V2: a booked appointment past its end but inside its grace keeps the door busy; cancelled, arrived or no-show ones do not', async () => {
      const wh = await site('BSY-1');
      const graced = await newDoor(wh, 'B1');
      const free = await newDoor(wh, 'B2');
      const seedRow = async (doorId: string, startMs: number, status: string, grace = 15): Promise<void> => {
        const id = uuidv7();
        const gateInId = status === 'arrived' ? uuidv7() : null;
        await sql`insert into dock_appointments (id, tenant_id, warehouse_id, code, status, dock_door_id, starts_at, ends_at, grace_minutes, booked_by,
                    gate_in_id, linked_at, linked_by, cancelled_at, cancelled_by, cancel_reason)
                  values (${id}, ${tenantId}, ${wh}, ${`DA-${String(7_000_000 + Math.floor(Math.random() * 900_000))}`}, ${status}, ${doorId},
                    ${new Date(startMs).toISOString()}, ${new Date(startMs + 30 * MINUTE).toISOString()}, ${grace}, ${ownerUserId},
                    ${gateInId}, ${gateInId === null ? null : new Date(startMs).toISOString()}, ${gateInId === null ? null : ownerUserId},
                    ${status === 'cancelled' ? new Date(startMs).toISOString() : null}, ${status === 'cancelled' ? ownerUserId : null}, ${status === 'cancelled' ? 'seed' : null})`;
      };
      // Ended 5 minutes ago, grace 15: still expected.
      await seedRow(graced, NOW_MS - 35 * MINUTE, 'booked');
      const busy = await setDoor(wh, graced, { code: 'B1', active: false });
      expectProblem(busy, 409, 'dock-door-has-appointments');
      expect(busy.body.appointmentCount).toBe(1);
      // A future cancelled one, a future arrived one, and a long-past (no-show) booked one.
      await seedRow(free, NOW_MS + DAY_MS, 'cancelled');
      await seedRow(free, NOW_MS + 2 * DAY_MS, 'arrived');
      await seedRow(free, NOW_MS - 3 * DAY_MS, 'booked');
      expect((await setDoor(wh, free, { code: 'B2', active: false }).expect(200)).body.dockDoor.active).toBe(false);
    });

    it('Schedule change: slot 30 → 60 with a 10:30–11:00 booking → 200; untouched; a move must fit the new grid; a note edit still works', async () => {
      const wh = await site('SCH-1');
      const d = await newDoor(wh, 'S1');
      const created = (await book({ warehouseId: wh, dockDoorId: d, startsAt: at(TOMORROW, '10:30'), endsAt: at(TOMORROW, '11:00') }).expect(201)).body
        .appointment as Appointment;
      await putSchedule(wh, { slotMinutes: 60, opensAt: '09:00', closesAt: '18:00', openDays: [1, 2, 3, 4, 5, 6], graceMinutes: 30 }).expect(200);
      expect(await getAppointment(created.id)).toMatchObject({ startsAt: at(TOMORROW, '10:30'), endsAt: at(TOMORROW, '11:00'), graceMinutes: 15 });
      expectProblem(await reschedule(created.id, { dockDoorId: d, startsAt: at(TOMORROW, '10:30'), endsAt: at(TOMORROW, '11:30') }), 400, 'slot-misaligned');
      const noted = (await reschedule(created.id, { dockDoorId: d, startsAt: at(TOMORROW, '10:30'), endsAt: at(TOMORROW, '11:00'), note: 'n' }).expect(200))
        .body.appointment as Appointment;
      expect(noted.graceMinutes).toBe(15);
      // A move re-freezes the grace from the current schedule.
      const movedAppt = (await reschedule(created.id, { dockDoorId: d, startsAt: at(TOMORROW, '11:00'), endsAt: at(TOMORROW, '12:00') }).expect(200)).body
        .appointment as Appointment;
      expect(movedAppt.graceMinutes).toBe(30);
    });

    it('A7 midnight close: 23:30–24:00 → 201 when closes 24:00; 409 dock-closed when it closes 23:00', async () => {
      const wh = await site('MID-1');
      const d = await newDoor(wh, 'M1');
      await putSchedule(wh, { slotMinutes: 30, opensAt: '00:00', closesAt: '24:00', openDays: [1, 2, 3, 4, 5, 6, 7], graceMinutes: 15 }).expect(200);
      await book({ warehouseId: wh, dockDoorId: d, startsAt: at(TOMORROW, '23:30'), endsAt: at(addIsoDays(TOMORROW, 1), '00:00') }).expect(201);
      await putSchedule(wh, { slotMinutes: 30, opensAt: '00:00', closesAt: '23:00', openDays: [1, 2, 3, 4, 5, 6, 7], graceMinutes: 15 }).expect(200);
      expectProblem(await book({ warehouseId: wh, dockDoorId: d, startsAt: at(SUNDAY, '23:30'), endsAt: at(addIsoDays(SUNDAY, 1), '00:00') }), 409, 'dock-closed');
      // Crossing midnight is never inside one day's hours.
      expectProblem(await book({ warehouseId: wh, dockDoorId: d, startsAt: at(SUNDAY, '22:30'), endsAt: at(addIsoDays(SUNDAY, 1), '00:30') }), 409, 'dock-closed');
    });
  });

  // ── the window read and the summary ────────────────────────────────────────

  describe('the window read', () => {
    it('Window read: from = to = tomorrow lists the day by (startsAt, id) with doors and schedule; 8 days or to < from → 400', async () => {
      const view = await windowOf(wh1, TOMORROW);
      expect(view.appointments.length).toBeGreaterThan(5);
      // V3 — only the queried warehouse's appointments (WH2's are not listed).
      expect(view.appointments.every((a) => (a as unknown as { warehouseId: string }).warehouseId === wh1)).toBe(true);
      const starts = view.appointments.map((a) => a.startsAt);
      expect([...starts].sort()).toEqual(starts);
      expect(view.appointments.every((a) => a.status !== 'cancelled')).toBe(true);
      expect(view.summary.cancelled).toBeGreaterThan(0);
      expect((await windowOf(wh1, TOMORROW, TOMORROW, { includeCancelled: true })).appointments.some((a) => a.status === 'cancelled')).toBe(true);
      expect(view.doors.map((d) => d.code)).toEqual(['D1', 'D2', 'D3', 'D4']);
      expect(view.schedule).toMatchObject({ slotMinutes: 30, configured: false });
      expect(view.asOf).toBe(new Date(NOW_MS).toISOString());
      const bad = (from: string, to: string) =>
        http().get(`${API}/${tenantId}/receiving/dock-schedule`).query({ warehouseId: wh1, from, to }).set('Authorization', `Bearer ${ownerToken}`);
      expectProblem(await bad(TODAY, addIsoDays(TODAY, 7)), 400, 'validation-failed');
      await bad(TODAY, addIsoDays(TODAY, 6)).expect(200);
      expectProblem(await bad(TOMORROW, TODAY), 400, 'validation-failed');
      expectProblem(await bad('2026-02-31', '2026-03-01'), 400, 'validation-failed');
    });

    async function seed(
      warehouseId: string,
      doorId: string,
      rows: { start: string; minutes: number; status?: string; gatedInAt?: string; grace?: number }[],
    ): Promise<void> {
      for (const row of rows) {
        const id = uuidv7();
        const code = `DA-${String(5000 + Math.floor(Math.random() * 4_000_000)).padStart(7, '0')}`;
        const ends = new Date(Date.parse(row.start) + row.minutes * MINUTE).toISOString();
        let gateInId: string | null = null;
        if (row.gatedInAt !== undefined) {
          gateInId = uuidv7();
          await sql`insert into gate_ins (id, tenant_id, warehouse_id, code, vehicle_no, transporter_name, seal_status, gated_in_at, recorded_by)
                    values (${gateInId}, ${tenantId}, ${warehouseId}, ${`SEED-${gateInId.slice(-8)}`}, 'KA01AB0000', 'Seed', 'none', ${row.gatedInAt}, ${ownerUserId})`;
        }
        const status = row.status ?? (gateInId === null ? 'booked' : 'arrived');
        await sql`insert into dock_appointments (id, tenant_id, warehouse_id, code, status, dock_door_id, starts_at, ends_at, grace_minutes, booked_by,
                    gate_in_id, linked_at, linked_by, cancelled_at, cancelled_by, cancel_reason)
                  values (${id}, ${tenantId}, ${warehouseId}, ${code}, ${status}, ${doorId}, ${row.start}, ${ends}, ${row.grace ?? 15}, ${ownerUserId},
                    ${gateInId}, ${gateInId === null ? null : row.gatedInAt!}, ${gateInId === null ? null : ownerUserId},
                    ${status === 'cancelled' ? row.start : null}, ${status === 'cancelled' ? ownerUserId : null}, ${status === 'cancelled' ? 'seed' : null})`;
      }
    }

    it('Summary: 10 booked — 6 on time, 1 early, 1 late, 1 no-show, 1 pending — and 1 cancelled → onTimeRate 66.7, cancelled 1', async () => {
      const wh = await site('SUM-1');
      const d = await newDoor(wh, 'X1');
      const day = TODAY;
      const start = (hhmm: string) => at(day, hhmm);
      const plus = (hhmm: string, minutes: number) => new Date(Date.parse(start(hhmm)) + minutes * MINUTE).toISOString();
      await seed(wh, d, [
        { start: start('09:00'), minutes: 30, gatedInAt: plus('09:00', 0) },
        { start: start('09:30'), minutes: 30, gatedInAt: plus('09:30', 15) },
        { start: start('10:00'), minutes: 30, gatedInAt: plus('10:00', -15) },
        { start: start('10:30'), minutes: 30, gatedInAt: plus('10:30', 11) },
        { start: start('11:00'), minutes: 30, gatedInAt: plus('11:00', 5) },
        { start: start('11:30'), minutes: 30, gatedInAt: plus('11:30', -3) },
        { start: start('12:00'), minutes: 30, gatedInAt: plus('12:00', -20) },
        { start: start('12:30'), minutes: 30, gatedInAt: plus('12:30', 20) },
        { start: start('08:00'), minutes: 30 },
        { start: start('15:00'), minutes: 30 },
        { start: start('13:00'), minutes: 30, status: 'cancelled' },
      ]);
      const view = await windowOf(wh, day);
      expect(view.summary).toMatchObject({ scheduled: 10, pending: 1, arrived: 8, early: 1, onTime: 6, late: 1, noShow: 1, cancelled: 1, onTimeRate: 66.7 });
      const byStart = new Map(view.appointments.map((a) => [a.startsAt, a]));
      expect(byStart.get(start('09:30'))).toMatchObject({ punctuality: 'on_time', punctualityMinutes: 15 });
      expect(byStart.get(start('12:00'))).toMatchObject({ punctuality: 'early', punctualityMinutes: -20 });
      expect(byStart.get(start('12:30'))).toMatchObject({ punctuality: 'late', punctualityMinutes: 20 });
      expect(byStart.get(start('08:00'))).toMatchObject({ status: 'booked', noShow: true });
      expect(byStart.get(start('15:00'))).toMatchObject({ status: 'booked', noShow: false });
      // Utilisation: one active door, 540 open minutes; 9 × 30 booked inside the hours + the 08:00 booking clipped to 0.
      expect(view.summary).toMatchObject({ bookedMinutes: 270, openMinutes: 540, utilisationRate: 50 });
      expect(view.summary.byDoor).toEqual([{ doorId: d, bookedMinutes: 270, openMinutes: 540 }]);
    });

    it('A8 utilisation: an inactive door with an appointment joins the door set; a closed day adds nothing; an off-schedule booking is still counted (A6)', async () => {
      const wh = await site('UTL-1');
      const a = await newDoor(wh, 'U1');
      const b = await newDoor(wh, 'U2');
      const c = await newDoor(wh, 'U3');
      await seed(wh, c, [{ start: at(TOMORROW, '09:00'), minutes: 60 }]);
      await setDoor(wh, c, { code: 'U3', active: false }).expect(409);
      await sql`update dock_doors set active = false where id = ${c}`;
      // A Saturday booking (open by default), then Saturday closed: counted, contributes no minutes.
      const saturday = addIsoDays(TODAY, 4);
      await seed(wh, a, [{ start: at(saturday, '10:00'), minutes: 60 }, { start: at(TOMORROW, '17:30'), minutes: 60 }]);
      await putSchedule(wh, { slotMinutes: 30, opensAt: '09:00', closesAt: '18:00', openDays: [1, 2, 3, 4, 5], graceMinutes: 15 }).expect(200);
      const view = await windowOf(wh, TOMORROW, saturday);
      // Wed–Fri open (3 days × 540) × 3 doors (U1, U2 active, U3 by its appointment).
      expect(view.summary.openMinutes).toBe(3 * 540 * 3);
      expect(view.summary.scheduled).toBe(3);
      // U3's 60 + U1's 17:30–18:30 clipped to 30; Saturday's 60 adds nothing.
      expect(view.summary.bookedMinutes).toBe(90);
      expect(view.summary.utilisationRate).toBe(Math.round((90 / (3 * 540 * 3)) * 1000) / 10);
      expect(view.doors.map((d) => [d.code, d.active])).toEqual([
        ['U1', true],
        ['U2', true],
        ['U3', false],
      ]);
      expect(view.summary.byDoor.map((row) => row.doorId).sort()).toEqual([a, b, c].sort());
      expect(view.appointments.some((x) => x.startsAt === at(saturday, '10:00'))).toBe(true);
      // C8 — an inactive door whose only appointment in the window is cancelled is no column unless cancelled ones are listed.
      const gone = await newDoor(wh, 'U4');
      await seed(wh, gone, [{ start: at(TOMORROW, '11:00'), minutes: 30, status: 'cancelled' }]);
      await sql`update dock_doors set active = false where id = ${gone}`;
      expect((await windowOf(wh, TOMORROW, saturday)).doors.map((d) => d.code)).toEqual(['U1', 'U2', 'U3']);
      expect((await windowOf(wh, TOMORROW, saturday, { includeCancelled: true })).doors.map((d) => d.code)).toEqual(['U1', 'U2', 'U3', 'U4']);
      expect((await windowOf(wh, TOMORROW, saturday)).summary.openMinutes).toBe(3 * 540 * 3);
    });

    it('A9 truncated summary: 1001 appointments in the window → truncated, 1000 listed, the summary exact', async () => {
      const wh = await site('TRN-1');
      const d = await newDoor(wh, 'T1');
      await sql`insert into dock_appointments (id, tenant_id, warehouse_id, code, status, dock_door_id, starts_at, ends_at, grace_minutes, booked_by)
        select gen_random_uuid(), ${tenantId}, ${wh}, 'DA-' || (8000000 + g)::text, 'booked', ${d},
               ${at(TOMORROW, '09:00')}::timestamptz + (g % 18) * interval '30 minutes',
               ${at(TOMORROW, '09:00')}::timestamptz + (g % 18) * interval '30 minutes' + interval '30 minutes', 15, ${ownerUserId}
          from generate_series(1, 1001) g`;
      const view = await windowOf(wh, TOMORROW);
      expect(view.truncated).toBe(true);
      expect(view.appointments).toHaveLength(1000);
      expect(view.summary).toMatchObject({ scheduled: 1001, pending: 1001, bookedMinutes: 1001 * 30, openMinutes: 540, utilisationRate: 100 });
    });
  });

  // ── the device, RLS and the vocabularies ──────────────────────────────────

  describe('the device snapshot, RLS and the vocabularies', () => {
    it('Handheld: dockAppointments lists today’s BOOKED appointments by start, with graceMinutes and no note or noShow', async () => {
      const today = (await book(slot('D2', TODAY, '14:00', '15:00', { documents: [{ poId: po1002 }], note: 'secret note' })).expect(201)).body
        .appointment as Appointment;
      const cancelledToday = (await book(slot('D3', TODAY, '15:00', '15:30')).expect(201)).body.appointment as Appointment;
      await cancel(cancelledToday.id, 'gone').expect(200);
      // V1 — an appointment that arrived today, and another warehouse's booked one today, are not listed.
      const arrivedToday = (await book(slot('D4', TODAY, '12:00', '12:30')).expect(201)).body.appointment as Appointment;
      await gateIn({ gatedInAt: new Date(NOW_MS).toISOString(), appointmentId: arrivedToday.id }).expect(201);
      const elsewhere = (await book({ warehouseId: wh2, dockDoorId: doorWh2, startsAt: at(TODAY, '13:00'), endsAt: at(TODAY, '13:30') }).expect(201)).body
        .appointment as Appointment;
      dockClock.now = () => Date.parse(at(TODAY, '12:00'));
      const snapshot = (
        await http().get(`${API}/${tenantId}/devices/catalog-snapshot`).query({ warehouseId: wh1 }).set('Authorization', `Bearer ${deviceToken}`).expect(200)
      ).body as { dockAppointments: Record<string, unknown>[] };
      const codes = snapshot.dockAppointments.map((a) => a.code);
      expect(codes).toContain(today.code);
      expect(codes).not.toContain(cancelledToday.code);
      expect(codes).not.toContain(arrivedToday.code);
      expect(codes).not.toContain(elsewhere.code);
      const entry = snapshot.dockAppointments.find((a) => a.code === today.code)!;
      expect(entry).toEqual({
        id: today.id,
        code: today.code,
        startsAt: at(TODAY, '14:00'),
        endsAt: at(TODAY, '15:00'),
        graceMinutes: 15,
        doorCode: 'D2',
        vehicleNo: null,
        transporterName: null,
        documents: [{ kind: 'po', code: 'PO-1002' }],
      });
      const starts = snapshot.dockAppointments.map((a) => a.startsAt as string);
      expect([...starts].sort()).toEqual(starts);
      expect(starts.every((s) => s >= istMidnightOf(TODAY) && s < istMidnightOf(TOMORROW))).toBe(true);
    });

    it('A15 / C4: no dock_appointment.* outbox payload carries the note or the cancel reason', async () => {
      const rows = (await sql`select type, payload from outbox_messages where tenant_id = ${tenantId} and type like 'dock_appointment.%'`) as unknown as {
        type: string;
        payload: { appointment: Record<string, unknown> };
      }[];
      expect(new Set(rows.map((row) => row.type))).toEqual(new Set(['dock_appointment.booked', 'dock_appointment.rescheduled', 'dock_appointment.cancelled', 'dock_appointment.arrived']));
      for (const row of rows) {
        expect(Object.keys(row.payload)).toEqual(['appointment']);
        expect('note' in row.payload.appointment).toBe(false);
        expect('cancelReason' in row.payload.appointment).toBe(false);
      }
    });

    it('the TS status vocabulary equals the 0110 CHECK', async () => {
      const rows = (await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'dock_appointments_status_check'`) as unknown as { def: string }[];
      expect([...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...DOCK_APPOINTMENT_STATUSES].sort());
    });

    it('RLS (AD-24): a portal stamp sees only its client’s appointments, never a null-client one; documents ride the parent; tenants isolate', async () => {
      const glow = (await sql<{ id: string }[]>`select id from dock_appointments where tenant_id = ${tenantId} and client_id = ${glowCo} limit 1`)[0]!.id;
      const mixed = (await sql<{ id: string }[]>`select a.id from dock_appointments a where a.tenant_id = ${tenantId} and a.client_id is null
        and exists (select 1 from dock_appointment_documents d where d.appointment_id = a.id) limit 1`)[0]!.id;
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        const read = (tenant: string, client: string | null) =>
          rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenant}, true)`;
            if (client !== null) await tx`select set_config('app.client_id', ${client}, true)`;
            const appointments = await tx.unsafe(`select id from dock_appointments where id in ('${glow}'::uuid, '${mixed}'::uuid)`);
            const documents = await tx.unsafe(`select appointment_id from dock_appointment_documents where appointment_id in ('${glow}'::uuid, '${mixed}'::uuid)`);
            return {
              appointments: (appointments as unknown as { id: string }[]).map((row) => row.id).sort(),
              documentParents: [...new Set((documents as unknown as { appointment_id: string }[]).map((row) => row.appointment_id))].sort(),
            };
          });
        expect(await read(tenantId, null)).toEqual({ appointments: [glow, mixed].sort(), documentParents: [glow, mixed].sort() });
        expect(await read(tenantId, glowCo)).toEqual({ appointments: [glow], documentParents: [glow] });
        expect(await read(tenantId, brewCo)).toEqual({ appointments: [], documentParents: [] });
        expect(await read(uuidv7(), null)).toEqual({ appointments: [], documentParents: [] });
      } finally {
        await rls.end();
      }
    });

    it('punctualityOf: the raw delta truncated toward zero; the grace edges are on time', () => {
      const start = at(TOMORROW, '10:30');
      const plus = (ms: number) => new Date(Date.parse(start) + ms).toISOString();
      expect(punctualityOf(start, 15, plus(15 * MINUTE))).toEqual({ punctuality: 'on_time', punctualityMinutes: 15 });
      expect(punctualityOf(start, 15, plus(15 * MINUTE + 59_000))).toEqual({ punctuality: 'on_time', punctualityMinutes: 15 });
      expect(punctualityOf(start, 15, plus(16 * MINUTE))).toEqual({ punctuality: 'late', punctualityMinutes: 16 });
      expect(punctualityOf(start, 15, plus(-15 * MINUTE))).toEqual({ punctuality: 'on_time', punctualityMinutes: -15 });
      expect(punctualityOf(start, 15, plus(-16 * MINUTE))).toEqual({ punctuality: 'early', punctualityMinutes: -16 });
      expect(punctualityOf(start, 0, plus(30_000))).toEqual({ punctuality: 'on_time', punctualityMinutes: 0 });
      expect(IST_OFFSET_MS).toBe(330 * MINUTE);
    });
  });
});
