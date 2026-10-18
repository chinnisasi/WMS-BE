import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { ulid, uuidv7 } from '../src/shared/primitives/ids';
import { createApp } from '../src/app.factory';
import { AUTH_DATABASE, DATABASE } from '../src/shared/shared.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../src/shared/events/outbox.seam';
import { ProblemException } from '../src/shared/problem-details/problem.exception';
import {
  LEDGER_ANCHOR_KINDS,
  LEDGER_CHAIN_BREAK_DETECTORS,
  LEDGER_CHAIN_BREAK_KINDS,
} from '../src/shared/db/schema';
import { InventoryFacade } from '../src/modules/inventory/inventory.facade';
import {
  LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT,
  LEDGER_CHAIN_BROKEN_EVENT,
  LedgerService,
  MAX_BREAK_REASON_LENGTH,
  digestOverRange,
  eventHashOf,
  legacyEventHashOf,
} from '../src/modules/inventory/ledger.service';
import { LedgerIntegrityService } from '../src/modules/inventory/ledger-integrity';
import {
  retainUntilOf,
  wormObjectKey,
  type LedgerAnchorWormStore,
  type WormAnchor,
  type WormReadBack,
  type WormRef,
} from '../src/modules/inventory/ledger-anchor-worm';
import {
  CHAIN_BREAK_DETECTORS,
  CHAIN_BREAK_KINDS,
  LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT_TYPE,
  LEDGER_CHAIN_BROKEN_EVENT_TYPE,
  NOTIFICATION_SOURCES,
  SOURCE_AUDIENCE,
  SOURCE_RESOLUTIONS,
  visibleSourceTypes,
} from '../src/modules/notifications/notification-sources';
import { APPROVAL_PUSH_SOURCES } from '../src/modules/notifications/push-rules';
import {
  DEFAULT_MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK,
  LedgerIntegrityWorker,
  parseLedgerIntegrityPollMs,
  parseMaxLedgerIntegrityScopesPerTick,
} from '../src/jobs/jobs.module';
import { useSuiteDatabase, type SuiteDatabase } from './support/suite-db';
import { expectAuditRow } from './support/audit-guard';
import { testAddress } from './support/shipment-address';
import { mintSignIn } from './support/sign-in';

// Story 9-3c — ledger anchoring and chain alerts. Every matrix row is driven
// through `InventoryFacade.runLedgerIntegrity` (one warehouse per scenario,
// so each starts un-baselined) — never through timers; the worker's window
// and per-scope catch are driven with a fake facade, and its plumbing by one
// real `tick()`. The `s3` arms run against a fake WORM store assigned to the
// service's `wormStore` field; the S3 adapter itself is unit-tested against
// a mocked SDK in test/ledger-anchor-worm.spec.ts.
process.env.DATABASE_URL ??= 'postgres://wms:wms@localhost:55432/wms';
process.env.JWT_SECRET ??= 'e2e-only-secret-0123456789abcdef';
process.env.VALKEY_URL ??= 'redis://localhost:56379/0';
delete process.env.OUTBOX_RELAY_POLL_MS;
delete process.env.OUTBOX_RECONCILE_POLL_MS;
delete process.env.RESERVATION_REAPER_POLL_MS;
delete process.env.COUNT_SCHEDULER_POLL_MS;
delete process.env.STORAGE_SNAPSHOT_POLL_MS;
delete process.env.AUDIT_EXPORT_POLL_MS;
delete process.env.LEDGER_INTEGRITY_POLL_MS;
delete process.env.LEDGER_ANCHOR_WORM;
delete process.env.LEDGER_ANCHOR_MAX_RANGE;
delete process.env.LEDGER_ANCHOR_CHUNKS_PER_TICK;
delete process.env.MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK;

jest.setTimeout(120_000);

const API = '/api/v1/tenants';
const KEY_HEADER = 'Idempotency-Key';
const PASSWORD = 'correct-horse-battery';

interface Member {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
}

interface House {
  readonly warehouseId: string;
  readonly code: string;
  readonly binId: string;
}

/** A fake `s3` WORM store: records puts, serves read-backs, and fails on demand. */
class FakeWormStore implements LedgerAnchorWormStore {
  readonly mode = 's3' as const;
  readonly puts: WormAnchor[] = [];
  private readonly objects = new Map<string, WormReadBack>();
  private versions = 0;
  failPut: Error | null = null;
  getOverride: WormReadBack | 'missing' | null = null;
  getError: Error | null = null;
  /** Answer the copy row's insert with an unstorable retain-until for these anchor ids (the insert then fails). */
  readonly badRetainFor = new Set<string>();
  gets = 0;

  async put(anchor: WormAnchor): Promise<WormRef> {
    if (this.failPut !== null) throw this.failPut;
    this.puts.push(anchor);
    this.versions += 1;
    const objectKey = wormObjectKey(anchor);
    const versionId = `v${this.versions}`;
    this.objects.set(`${objectKey}#${versionId}`, {
      id: anchor.id,
      kind: anchor.kind,
      anchoredAt: anchor.anchoredAt,
      digest: anchor.digest,
      fromSeq: anchor.fromSeq,
      toSeq: anchor.toSeq,
    });
    const retainUntil = this.badRetainFor.has(anchor.id) ? 'not-an-instant' : retainUntilOf(anchor.anchoredAt, 2557);
    return { bucket: 'fake-bucket', objectKey, versionId, retainUntil };
  }

  /** The stored read-back of a copied object (for a near-miss override). */
  stored(objectKey: string, versionId: string): WormReadBack | undefined {
    return this.objects.get(`${objectKey}#${versionId}`);
  }

  async get(ref: Pick<WormRef, 'bucket' | 'objectKey' | 'versionId'>): Promise<WormReadBack | 'missing'> {
    this.gets += 1;
    if (this.getError !== null) throw this.getError;
    if (this.getOverride !== null) return this.getOverride;
    return this.objects.get(`${ref.objectKey}#${ref.versionId}`) ?? 'missing';
  }
}

describe('ledger anchoring and chain alerts (e2e, story 9-3c)', () => {
  let app: INestApplication;
  let suiteDb: SuiteDatabase;
  let sql: postgres.Sql<Record<string, unknown>>;
  let facade: InventoryFacade;
  let service: LedgerIntegrityService;
  let relay: OutboxRelay;

  let tenantId: string;
  let owner: Member;
  let ops: Member;
  let skuId: string;

  const saved = { maxRange: 0, chunksPerTick: 0, wormStore: null as unknown as LedgerAnchorWormStore };
  const httpReq = () => request(app.getHttpServer());

  async function signIn(email: string): Promise<string> {
    return (await mintSignIn(app, { email, password: PASSWORD })).body.accessToken as string;
  }

  async function newHouse(label: string): Promise<House> {
    const code = `${label}-${ulid().slice(10, 16).toUpperCase()}`;
    const warehouse = await httpReq()
      .post(`${API}/${tenantId}/warehouses`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set(KEY_HEADER, ulid())
      .send({ origin: testAddress(), code, name: `Integrity ${label}` })
      .expect(201);
    const warehouseId = warehouse.body.id as string;
    const zone = await httpReq()
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set(KEY_HEADER, ulid())
      .send({ code: 'A', name: `Zone ${label}` })
      .expect(201);
    await httpReq()
      .post(`${API}/${tenantId}/warehouses/${warehouseId}/zones/${zone.body.id as string}/bins`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set(KEY_HEADER, ulid())
      .send({ capacity: 1_000_000, type: 'shelf', code: 'A-01-01' })
      .expect(201);
    const bins = await sql`select b.id from bins b join zones z on z.id = b.zone_id where z.warehouse_id = ${warehouseId}`;
    return { warehouseId, code, binId: bins[0]!.id as string };
  }

  /** `n` adjustments of +1 (one ledger event each); returns the last seq. */
  async function seedEvents(house: House, n: number): Promise<number> {
    let seq = 0;
    for (let i = 0; i < n; i += 1) {
      const res = await httpReq()
        .post(`${API}/${tenantId}/inventory/adjustments`)
        .set('Authorization', `Bearer ${owner.token}`)
        .set(KEY_HEADER, ulid())
        .send({ warehouseId: house.warehouseId, skuId, binId: house.binId, quantityDelta: 1, reasonCode: 'stock-count', note: 'integrity spec' })
        .expect(201);
      seq = res.body.event.seq as number;
    }
    return seq;
  }

  /** The deliberate tamper: the replication-role bypass the append-only trigger does not cover. */
  async function tamper(statement: string, params: unknown[]): Promise<void> {
    const raw = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
    try {
      await raw.unsafe('set session_replication_role = replica');
      await raw.unsafe(statement, params as never[]);
      await raw.unsafe('set session_replication_role = DEFAULT');
    } finally {
      await raw.end();
    }
  }

  /** Rewrite events `fromSeq..toSeq` exactly as migration 0026 did: `quantity_delta × 1000`, hashes untouched. */
  function makeLegacy(house: House, fromSeq: number, toSeq: number): Promise<void> {
    return tamper(
      'update ledger_events set quantity_delta = quantity_delta * 1000 where tenant_id = $1 and warehouse_id = $2 and seq between $3 and $4',
      [tenantId, house.warehouseId, fromSeq, toSeq],
    );
  }

  function editEvent(house: House, seq: number): Promise<void> {
    return tamper('update ledger_events set quantity_delta = quantity_delta + 1 where tenant_id = $1 and warehouse_id = $2 and seq = $3', [
      tenantId,
      house.warehouseId,
      seq,
    ]);
  }

  /**
   * Appends a zero-delta event with a genuinely valid hash (the production
   * composer) — the shape a `pack.packed`/`dispatch.dispatched` leaves,
   * without driving an order through the floor.
   */
  async function appendZero(house: House): Promise<number> {
    const head = (await sql`
      select seq, event_hash from ledger_events
      where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId} order by seq desc limit 1`)[0];
    const seq = head === undefined ? 1 : (head.seq as number) + 1;
    const prevHash = head === undefined ? '0'.repeat(64) : (head.event_hash as string);
    const clientId = (await sql`select client_id from skus where id = ${skuId}`)[0]!.client_id as string;
    const id = uuidv7();
    const at = new Date().toISOString();
    const doc = { kind: 'pack', orderId: uuidv7() };
    const eventHash = eventHashOf({
      id, tenantId, warehouseId: house.warehouseId, seq, type: 'pack.packed', schemaVersion: 1, skuId, quantityDelta: 0,
      fromBinId: null, toBinId: null, batchRef: null, serialRef: null, actorUserId: owner.userId,
      occurredAt: at, recordedAt: at, referenceDoc: doc as never, prevHash,
    });
    await sql`insert into ledger_events (id, tenant_id, warehouse_id, seq, type, schema_version, sku_id, quantity_delta, from_bin_id, to_bin_id,
                batch_ref, serial_ref, actor_user_id, occurred_at, recorded_at, reference_doc, prev_hash, event_hash, client_id)
              values (${id}, ${tenantId}, ${house.warehouseId}, ${seq}, 'pack.packed', 1, ${skuId}, 0, null, null,
                null, null, ${owner.userId}, ${at}::text::timestamptz, ${at}::text::timestamptz, ${sql.json(doc)}, ${prevHash}, ${eventHash}, ${clientId})`;
    return seq;
  }

  function run(house: House) {
    return facade.runLedgerIntegrity(tenantId, house.warehouseId);
  }

  async function stateOf(house: House): Promise<Record<string, unknown> | undefined> {
    const rows = await sql`select * from ledger_integrity_state where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId}`;
    return rows[0] as Record<string, unknown> | undefined;
  }

  async function anchorsOf(house: House): Promise<{ id: string; kind: string; from_seq: number; to_seq: number; digest: string }[]> {
    return (await sql`
      select id, kind, from_seq, to_seq, digest from ledger_anchors
      where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId} order by to_seq`) as unknown as {
      id: string;
      kind: string;
      from_seq: number;
      to_seq: number;
      digest: string;
    }[];
  }

  async function breaksOf(house: House): Promise<Record<string, unknown>[]> {
    return (await sql`
      select * from ledger_chain_breaks where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId} order by first_seq, kind`) as unknown as Record<string, unknown>[];
  }

  async function brokenAlerts(house: House): Promise<Record<string, unknown>[]> {
    const rows = await sql`
      select payload from outbox_messages
      where tenant_id = ${tenantId} and type = 'ledger.chain_broken' and payload ->> 'warehouseId' = ${house.warehouseId}
      order by created_at`;
    return rows.map((row) => row.payload as Record<string, unknown>);
  }

  async function entriesOf(house: House): Promise<Record<string, unknown>[]> {
    return (await sql`
      select source_id, summary, resolution, resolved_at from notifications
      where tenant_id = ${tenantId} and source_type = 'ledger-chain-break' and warehouse_id = ${house.warehouseId}`) as unknown as Record<string, unknown>[];
  }

  async function drainAll(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await sql`update outbox_messages set next_attempt_at = now() where status = 'pending'`;
      const drained = await relay.drain(100);
      if (drained.length === 0) return;
    }
  }

  async function integrityRow(house: House, member: Member = owner): Promise<Record<string, unknown>> {
    const res = await httpReq().get(`${API}/${tenantId}/inventory/ledger/integrity`).set('Authorization', `Bearer ${member.token}`).expect(200);
    return (res.body.warehouses as Record<string, unknown>[]).find((row) => row.warehouseId === house.warehouseId)!;
  }

  function acknowledge(house: House, breakId: string, member: Member, key = ulid()): request.Test {
    return httpReq()
      .post(`${API}/${tenantId}/warehouses/${house.warehouseId}/inventory/ledger/breaks/${breakId}/acknowledge`)
      .set('Authorization', `Bearer ${member.token}`)
      .set(KEY_HEADER, key);
  }

  beforeAll(async () => {
    suiteDb = await useSuiteDatabase('ledger_integrity');
    app = await createApp(false);
    await app.init();
    sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => undefined });
    facade = app.get(InventoryFacade);
    service = app.get(LedgerIntegrityService);
    relay = app.get<unknown>(OUTBOX_RELAY) as OutboxRelay;
    saved.maxRange = service.maxRange;
    saved.chunksPerTick = service.chunksPerTick;
    saved.wormStore = service.wormStore;

    const email = `owner-${ulid().toLowerCase()}@example.com`;
    const registered = await httpReq()
      .post(API)
      .set(KEY_HEADER, ulid())
      .send({ name: `Integrity Co ${ulid()}`, ownerEmail: email, password: PASSWORD })
      .expect(201);
    tenantId = registered.body.tenant.id as string;
    owner = { userId: registered.body.owner.id as string, email, token: await signIn(email) };
    const opsEmail = `ops-${ulid().toLowerCase()}@example.com`;
    const invited = await httpReq()
      .post(`${API}/${tenantId}/users`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set(KEY_HEADER, ulid())
      .send({ email: opsEmail, role: 'ops_manager' })
      .expect(201);
    await httpReq()
      .post(`${API}/${tenantId}/accept-invite`)
      .set(KEY_HEADER, ulid())
      .send({ token: invited.body.inviteToken as string, password: PASSWORD })
      .expect(200);
    ops = { userId: invited.body.user.id as string, email: opsEmail, token: await signIn(opsEmail) };

    const csvHeader = 'sku_code,name,uom,uom_conversions,gst_rate,hsn,batch_tracked,serial_tracked,reorder_point,reorder_qty,barcode';
    await httpReq()
      .post(`${API}/${tenantId}/catalog/imports`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set(KEY_HEADER, ulid())
      .field('mode', 'initial')
      .attach('file', Buffer.from(`${csvHeader}\nSKU-LI,Clove,pcs,,1800,,,,,`, 'utf8'), { filename: 'catalog.csv', contentType: 'text/csv' })
      .expect(201);
    const skus = await httpReq().get(`${API}/${tenantId}/catalog/skus`).set('Authorization', `Bearer ${owner.token}`).expect(200);
    skuId = (skus.body.items as { code: string; id: string }[]).find((item) => item.code === 'SKU-LI')!.id;
  });

  afterEach(() => {
    service.maxRange = saved.maxRange;
    service.chunksPerTick = saved.chunksPerTick;
    service.wormStore = saved.wormStore;
  });

  afterAll(async () => {
    const db = app.get<unknown>(DATABASE) as { $client?: { end(): Promise<void> } };
    await db.$client?.end();
    const authDb = app.get<unknown>(AUTH_DATABASE) as { $client?: { end(): Promise<void> } };
    await authDb.$client?.end();
    await sql.end();
    await app.close();
    await suiteDb.drop();
  });

  // ── the vocabulary, the surface, the isolation ─────────────────────────────

  describe('the vocabulary and the surface', () => {
    it('the anchor kind, break kind and detector tuples equal the 0071 CHECKs; notifications’ literals equal inventory’s', async () => {
      const def = async (name: string): Promise<string> =>
        ((await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`)[0] as { def: string }).def;
      const inList = (text: string) => [...text.matchAll(/'([a-z-]+)'::text/g)].map((match) => match[1]).sort();
      expect(inList(await def('ledger_anchors_kind_check'))).toEqual([...LEDGER_ANCHOR_KINDS].sort());
      expect(inList(await def('ledger_chain_breaks_kind_check'))).toEqual([...LEDGER_CHAIN_BREAK_KINDS].sort());
      expect(inList(await def('ledger_chain_breaks_detected_by_check'))).toEqual([...LEDGER_CHAIN_BREAK_DETECTORS].sort());
      expect([...CHAIN_BREAK_KINDS]).toEqual([...LEDGER_CHAIN_BREAK_KINDS]);
      expect([...CHAIN_BREAK_DETECTORS]).toEqual([...LEDGER_CHAIN_BREAK_DETECTORS]);
      expect(LEDGER_CHAIN_BROKEN_EVENT_TYPE).toBe(LEDGER_CHAIN_BROKEN_EVENT);
      expect(LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT_TYPE).toBe(LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT);
      expect(LEDGER_CHAIN_BROKEN_EVENT).toBe('ledger.chain_broken');
      expect(LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT).toBe('ledger.chain_break_acknowledged');
    });

    it('the panel source: raised on ledger.chain_broken, resolved by the acknowledgement, owner-only, never pushed', () => {
      const spec = NOTIFICATION_SOURCES['ledger-chain-break'];
      expect(spec.raise.type).toBe(LEDGER_CHAIN_BROKEN_EVENT);
      expect(spec.resolves.map((r) => r.type)).toEqual([LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT]);
      expect([...SOURCE_RESOLUTIONS['ledger-chain-break']]).toEqual(['acknowledged']);
      expect(SOURCE_AUDIENCE['ledger-chain-break']).toEqual({ capability: 'ledger.acknowledge' });
      expect(visibleSourceTypes('owner')).toContain('ledger-chain-break');
      for (const role of ['ops_manager', 'operator', 'accountant', 'client'] as const) {
        expect(visibleSourceTypes(role)).not.toContain('ledger-chain-break');
      }
      expect((APPROVAL_PUSH_SOURCES as readonly string[]).includes('ledger-chain-break')).toBe(false);
    });

    it('OpenAPI lists the four routes', async () => {
      const doc = (await httpReq().get('/api/v1/openapi.json').expect(200)).body as { paths: Record<string, Record<string, unknown>> };
      expect(doc.paths['/tenants/{tenantId}/inventory/ledger/integrity']?.get).toBeDefined();
      expect(doc.paths['/tenants/{tenantId}/warehouses/{warehouseId}/inventory/ledger/anchors']?.get).toBeDefined();
      expect(doc.paths['/tenants/{tenantId}/warehouses/{warehouseId}/inventory/ledger/anchors/{anchorId}/proof']?.get).toBeDefined();
      expect(doc.paths['/tenants/{tenantId}/warehouses/{warehouseId}/inventory/ledger/breaks/{breakId}/acknowledge']?.post).toBeDefined();
    });

    it('the three tables are tenant-isolated under RLS (wms_rls_probe sees only its stamped tenant)', async () => {
      const house = await newHouse('RLS');
      await seedEvents(house, 2);
      await run(house);
      await editEvent(house, 1);
      // A WORM copy row to probe (inserted by hand: the fake store is not on).
      const anchor = (await anchorsOf(house))[0]!;
      await sql`insert into ledger_anchor_worm_copies (anchor_id, tenant_id, bucket, object_key, version_id, retain_until, copied_at)
                values (${anchor.id}, ${tenantId}, 'b', 'k', 'v', now(), now())`;
      await facade.verifyChain(tenantId, house.warehouseId).catch(() => undefined);
      const url = new URL(process.env.DATABASE_URL!);
      url.username = 'wms_rls_probe';
      url.password = 'wms_rls_probe';
      const rls = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (const table of ['ledger_integrity_state', 'ledger_chain_breaks', 'ledger_anchor_worm_copies']) {
          expect(await rls.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId])).toHaveLength(0);
          const foreign = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${uuidv7()}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId]);
          });
          expect(foreign).toHaveLength(0);
          const own = await rls.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
            return tx.unsafe(`select 1 from ${table} where tenant_id = $1`, [tenantId]);
          });
          expect(own.length).toBeGreaterThan(0);
        }
      } finally {
        await rls.end();
      }
    });

    it('the WORM copy rows are append-only at the database (UPDATE, DELETE and TRUNCATE refused)', async () => {
      const rows = await sql`select anchor_id from ledger_anchor_worm_copies where tenant_id = ${tenantId} limit 1`;
      const anchorId = rows[0]!.anchor_id as string;
      await expect(sql`update ledger_anchor_worm_copies set version_id = 'v9' where anchor_id = ${anchorId}`).rejects.toThrow(/append-only/i);
      await expect(sql`delete from ledger_anchor_worm_copies where anchor_id = ${anchorId}`).rejects.toThrow(/append-only/i);
      await expect(sql.unsafe('truncate ledger_anchor_worm_copies')).rejects.toThrow(/append-only/i);
    });
  });

  // ── the legacy form ────────────────────────────────────────────────────────

  describe('the pre-0026 form', () => {
    it('legacyEventHashOf reproduces a ×1000-rewritten event and applies only to whole multiples of 1000', async () => {
      const house = await newHouse('FORM');
      await seedEvents(house, 1);
      const before = (await sql`select * from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId}`)[0]!;
      const canonical = {
        id: before.id as string,
        tenantId: before.tenant_id as string,
        warehouseId: before.warehouse_id as string,
        seq: before.seq as number,
        type: before.type as string,
        schemaVersion: before.schema_version as number,
        skuId: before.sku_id as string,
        quantityDelta: Number(before.quantity_delta),
        fromBinId: before.from_bin_id as string | null,
        toBinId: before.to_bin_id as string | null,
        batchRef: before.batch_ref as string | null,
        serialRef: before.serial_ref as string | null,
        actorUserId: before.actor_user_id as string,
        occurredAt: (before.occurred_at as Date).toISOString(),
        recordedAt: (before.recorded_at as Date).toISOString(),
        referenceDoc: before.reference_doc as never,
        prevHash: before.prev_hash as string,
      };
      expect(eventHashOf(canonical)).toBe(before.event_hash);
      // The 0026 rewrite of this event: × 1000, hash untouched — the legacy
      // form reproduces the stored hash, the current form no longer does.
      const rewritten = { ...canonical, quantityDelta: canonical.quantityDelta * 1000 };
      expect(eventHashOf(rewritten)).not.toBe(before.event_hash);
      expect(legacyEventHashOf(rewritten)).toBe(before.event_hash);
      // Not a multiple of 1000 → no legacy form; zero → identical to the current form.
      expect(legacyEventHashOf({ ...canonical, quantityDelta: canonical.quantityDelta + 1 })).toBeNull();
      expect(legacyEventHashOf({ ...canonical, quantityDelta: 0 })).toBe(eventHashOf({ ...canonical, quantityDelta: 0 }));
    });

    it('an un-baselined warehouse still reads its pre-0026 events as broken (verifyChain reads B = 0)', async () => {
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('UNBASE');
      await seedEvents(house, 3);
      await makeLegacy(house, 1, 2);
      const report = await facade.verifyChain(tenantId, house.warehouseId);
      expect(report.ok).toBe(false);
      expect((report as { reason: string }).reason).toContain('hash mismatch at seq 1');
      expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain('SEVERITY-1');
    });
  });

  // ── the matrix ─────────────────────────────────────────────────────────────

  describe('the integrity run', () => {
    it('clean warehouse: B = 0; one verified anchor 1..10; verified through 10; no break', async () => {
      const house = await newHouse('CLEAN');
      await seedEvents(house, 10);
      const summary = await run(house);
      expect(summary).toMatchObject({ baselined: true, legacyThroughSeq: 0, anchored: 1, anchorBreakId: null, failedSteps: [] });
      expect(await anchorsOf(house)).toEqual([expect.objectContaining({ kind: 'verified', from_seq: 1, to_seq: 10 })]);
      const state = await stateOf(house);
      expect(state).toMatchObject({ legacy_through_seq: 0, verified_through_seq: 10, broken_at_seq: null });
      expect(state!.verified_at).not.toBeNull();
      expect(state!.last_run_at).not.toBeNull();
      expect(await breaksOf(house)).toEqual([]);
      const row = await integrityRow(house);
      expect(row).toMatchObject({ warehouseCode: house.code, baselined: true, legacyThroughSeq: 0, verifiedThroughSeq: 10, brokenAtSeq: null, wormPending: 1, breaks: [] });
      expect(row.lastAnchor).toMatchObject({ kind: 'verified', fromSeq: 1, toSeq: 10, worm: null });
      // A second run: nothing new — still clean, no second anchor.
      expect(await run(house)).toMatchObject({ baselined: false, anchored: 0, anchorBreakId: null });
      expect(await anchorsOf(house)).toHaveLength(1);
    });

    it('legacy prefix: B = 5; a legacy anchor 1..5 and a verified 6..9; no alert; the view reads 5 pre-0026 events', async () => {
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('LEGACY');
      await seedEvents(house, 9);
      await makeLegacy(house, 1, 5);
      const summary = await run(house);
      expect(summary).toMatchObject({ baselined: true, legacyThroughSeq: 5, anchored: 1, anchorBreakId: null, reverifyBreakIds: [], failedSteps: [] });
      expect((await anchorsOf(house)).map((a) => [a.kind, a.from_seq, a.to_seq])).toEqual([
        ['legacy', 1, 5],
        ['verified', 6, 9],
      ]);
      expect(await breaksOf(house)).toEqual([]);
      expect(await brokenAlerts(house)).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
      expect(await integrityRow(house)).toMatchObject({ legacyThroughSeq: 5, verifiedThroughSeq: 9, brokenAtSeq: null });
      // verifyChain over the whole chain now reads B and passes; the legacy
      // anchor's digest is the digest over the stored hashes.
      expect((await facade.verifyChain(tenantId, house.warehouseId)).ok).toBe(true);
      expect((await facade.exportDigest(tenantId, house.warehouseId, 1, 5)).digest).toBe((await anchorsOf(house))[0]!.digest);
      // The rotation re-verifies the legacy range with B too: clean.
      for (let i = 0; i < 3; i += 1) expect((await run(house)).reverifyBreakIds).toEqual([]);
    });

    it('edited legacy event: a break at #3, never a legacy match', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('EDITLEG');
      await seedEvents(house, 6);
      await makeLegacy(house, 1, 5);
      await editEvent(house, 3);
      const summary = await run(house);
      expect(summary.legacyThroughSeq).toBe(2);
      expect(summary.anchorBreakId).not.toBeNull();
      expect((await breaksOf(house)).map((b) => [b.kind, b.first_seq, b.detected_by])).toEqual([['chain', 3, 'anchor']]);
      expect((await breaksOf(house))[0]!.reason).toContain('hash mismatch at seq 3');
      expect((await anchorsOf(house)).map((a) => [a.kind, a.from_seq, a.to_seq])).toEqual([['legacy', 1, 2]]);
      expect((await stateOf(house))!.broken_at_seq).toBe(3);
    });

    it('bounded anchoring: MAX_RANGE 10 × 2 chunks anchors 1..10 and 11..20 this tick, 21..25 the next', async () => {
      service.maxRange = 10;
      service.chunksPerTick = 2;
      const house = await newHouse('BOUND');
      await seedEvents(house, 25);
      expect((await run(house)).anchored).toBe(2);
      expect((await anchorsOf(house)).map((a) => [a.from_seq, a.to_seq])).toEqual([
        [1, 10],
        [11, 20],
      ]);
      expect((await stateOf(house))!.verified_through_seq).toBe(20);
      expect((await run(house)).anchored).toBe(1);
      expect((await anchorsOf(house)).map((a) => [a.from_seq, a.to_seq])).toEqual([
        [1, 10],
        [11, 20],
        [21, 25],
      ]);
    });

    it('legacy anchors are chunked by MAX_RANGE too', async () => {
      service.maxRange = 4;
      const house = await newHouse('LEGCHUNK');
      await seedEvents(house, 10);
      await makeLegacy(house, 1, 10);
      expect((await run(house)).legacyThroughSeq).toBe(10);
      expect((await anchorsOf(house)).map((a) => [a.kind, a.from_seq, a.to_seq])).toEqual([
        ['legacy', 1, 4],
        ['legacy', 5, 8],
        ['legacy', 9, 10],
      ]);
    });

    it('tail tamper: one break, one alert, one owner entry, no anchor; status "Broken at #N"; a re-detection adds nothing (WARN only)', async () => {
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const house = await newHouse('TAIL');
      await seedEvents(house, 4);
      expect((await run(house)).anchored).toBe(1);
      await seedEvents(house, 3); // 5..7, unanchored
      await editEvent(house, 6);
      const summary = await run(house);
      expect(summary.anchored).toBe(0);
      expect(summary.anchorBreakId).not.toBeNull();
      const breaks = await breaksOf(house);
      expect(breaks.map((b) => [b.kind, b.first_seq, b.detected_by, b.anchor_id])).toEqual([['chain', 6, 'anchor', null]]);
      expect(await anchorsOf(house)).toHaveLength(1);
      const alerts = await brokenAlerts(house);
      expect(alerts).toEqual([
        {
          warehouseId: house.warehouseId,
          fromSeq: 6,
          toSeq: 7,
          reason: expect.stringContaining('hash mismatch at seq 6'),
          breakId: breaks[0]!.id,
          kind: 'chain',
          detectedBy: 'anchor',
          firstSeq: 6,
        },
      ]);
      const severity = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('SEVERITY-1'));
      expect(severity).toHaveLength(1);
      expect(severity[0]).toContain(`seq=6..7`);
      await drainAll();
      expect(await entriesOf(house)).toEqual([
        expect.objectContaining({ source_id: breaks[0]!.id, summary: { kind: 'chain', firstSeq: 6, reason: expect.stringContaining('hash mismatch at seq 6'), detectedBy: 'anchor' }, resolution: null }),
      ]);
      // Owner-only: the owner's panel shows it, the ops manager's does not.
      const panel = async (member: Member) =>
        ((await httpReq().get(`${API}/${tenantId}/notifications`).query({ limit: 100 }).set('Authorization', `Bearer ${member.token}`).expect(200)).body.items as { sourceType: string; sourceId: string }[]).filter(
          (item) => item.sourceType === 'ledger-chain-break' && item.sourceId === breaks[0]!.id,
        );
      expect(await panel(owner)).toHaveLength(1);
      expect(await panel(ops)).toHaveLength(0);
      // Never pushed.
      expect(Number((await sql`select count(*)::int as n from push_deliveries where tenant_id = ${tenantId}`)[0]!.n)).toBe(0);
      expect(await integrityRow(house)).toMatchObject({ brokenAtSeq: 6, verifiedThroughSeq: 4 });

      // Re-detection on the next tick: no new row, alert or entry — WARN only.
      // (The relay deletes a row on ack, so the drained first alert is gone:
      // any alert row now would be a new one.)
      errors.mockClear();
      expect(await brokenAlerts(house)).toEqual([]);
      await run(house);
      expect(await brokenAlerts(house)).toEqual([]);
      await drainAll();
      expect(await breaksOf(house)).toHaveLength(1);
      expect(await entriesOf(house)).toHaveLength(1);
      expect(errors.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('SEVERITY-1'))).toEqual([]);
      expect(warns.mock.calls.map((call) => String(call[0])).some((line) => line.includes('re-detected') && line.includes('seq=6..7'))).toBe(true);
    });

    it('deleted event: a gap is a break (missing events, first missing seq), never a 422 — one entry', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('GAP');
      await seedEvents(house, 6);
      await tamper('delete from ledger_events where tenant_id = $1 and warehouse_id = $2 and seq = 4', [tenantId, house.warehouseId]);
      const summary = await run(house);
      expect(summary.failedSteps).toEqual([]);
      expect(summary.anchorBreakId).not.toBeNull();
      const breaks = await breaksOf(house);
      expect(breaks.map((b) => [b.kind, b.first_seq, b.detected_by])).toEqual([['chain', 4, 'anchor']]);
      expect(breaks[0]!.reason).toContain('missing events in seq range 1..6');
      expect(await anchorsOf(house)).toEqual([]);
      await drainAll();
      expect(await entriesOf(house)).toHaveLength(1);
      expect(await integrityRow(house)).toMatchObject({ brokenAtSeq: 4 });
    });

    it('anchored-range tamper: the rotation finds it (reverify); the tail keeps anchoring; the status stays broken', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('ANCHORED');
      await seedEvents(house, 6);
      expect((await run(house)).reverifiedAnchorId).not.toBeNull(); // anchors 1..6, re-verifies it (clean)
      await seedEvents(house, 3); // 7..9
      await editEvent(house, 3);
      const second = await run(house); // anchors 7..9; the rotation moves on to 7..9
      expect(second.anchored).toBe(1);
      expect(second.reverifyBreakIds).toEqual([]);
      const third = await run(house); // the rotation wraps to 1..6
      expect(third.reverifyBreakIds).toHaveLength(1);
      expect((await breaksOf(house)).map((b) => [b.kind, b.first_seq, b.detected_by])).toEqual([['chain', 3, 'reverify']]);
      await seedEvents(house, 2); // 10..11 — the tail still anchors
      expect((await run(house)).anchored).toBe(1);
      expect(await integrityRow(house)).toMatchObject({ brokenAtSeq: 3, verifiedThroughSeq: 11 });
    });

    it('the anchor digest is required: a range whose stored hashes were rewritten consistently is a digest-mismatch break', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('DIGEST');
      await seedEvents(house, 1);
      await run(house); // anchor 1..1
      // A superuser who rewrites the event AND its hash consistently (a
      // genesis event: no successor link to fix) passes the walk — only the
      // anchor's digest catches it.
      const row = (await sql`select * from ledger_events where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId} and seq = 1`)[0]!;
      const forged = eventHashOf({
        id: row.id as string,
        tenantId,
        warehouseId: house.warehouseId,
        seq: 1,
        type: row.type as string,
        schemaVersion: row.schema_version as number,
        skuId: row.sku_id as string,
        quantityDelta: Number(row.quantity_delta) + 1000,
        fromBinId: row.from_bin_id as string | null,
        toBinId: row.to_bin_id as string | null,
        batchRef: row.batch_ref as string | null,
        serialRef: row.serial_ref as string | null,
        actorUserId: row.actor_user_id as string,
        occurredAt: (row.occurred_at as Date).toISOString(),
        recordedAt: (row.recorded_at as Date).toISOString(),
        referenceDoc: row.reference_doc as never,
        prevHash: row.prev_hash as string,
      });
      await tamper('update ledger_events set quantity_delta = quantity_delta + 1000, event_hash = $3 where tenant_id = $1 and warehouse_id = $2 and seq = 1', [
        tenantId,
        house.warehouseId,
        forged,
      ]);
      expect((await facade.verifyChain(tenantId, house.warehouseId)).ok).toBe(true);
      const summary = await run(house);
      expect(summary.reverifyBreakIds).toHaveLength(1);
      const breaks = await breaksOf(house);
      expect(breaks.map((b) => [b.kind, b.first_seq, b.detected_by])).toEqual([['chain', 1, 'reverify']]);
      expect(breaks[0]!.reason).toContain('anchor digest mismatch');
    });

    it('baseline race: two concurrent baselines write one state row and no duplicate legacy anchor', async () => {
      service.maxRange = 3;
      const house = await newHouse('RACE');
      await seedEvents(house, 7);
      await makeLegacy(house, 1, 7);
      const results = await Promise.all([
        service.ensureBaseline(tenantId, house.warehouseId),
        service.ensureBaseline(tenantId, house.warehouseId),
      ]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results.map((r) => r.legacyThroughSeq)).toEqual([7, 7]);
      expect(Number((await sql`select count(*)::int as n from ledger_integrity_state where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId}`)[0]!.n)).toBe(1);
      expect((await anchorsOf(house)).map((a) => [a.kind, a.from_seq, a.to_seq])).toEqual([
        ['legacy', 1, 3],
        ['legacy', 4, 6],
        ['legacy', 7, 7],
      ]);
    });

    it('existing anchors are kept at baseline (no legacy anchors) and re-verify with B', async () => {
      const house = await newHouse('PREANCH');
      await seedEvents(house, 4);
      // A pre-9-3c anchor on a dev database, then the 0026 rewrite under it.
      const anchored = await facade.anchorChain(tenantId, house.warehouseId);
      expect('digest' in anchored).toBe(true);
      await makeLegacy(house, 1, 4);
      const summary = await run(house);
      expect(summary).toMatchObject({ legacyThroughSeq: 4, reverifyBreakIds: [], anchorBreakId: null });
      expect((await anchorsOf(house)).map((a) => [a.kind, a.from_seq, a.to_seq])).toEqual([['verified', 1, 4]]);
      expect(await breaksOf(house)).toEqual([]);
    });

    it('an empty warehouse: a state row with B = 0, verified through 0, no anchor', async () => {
      const house = await newHouse('EMPTY');
      expect(await run(house)).toMatchObject({ baselined: true, legacyThroughSeq: 0, anchored: 0, failedSteps: [] });
      expect(await stateOf(house)).toMatchObject({ legacy_through_seq: 0, verified_through_seq: 0 });
      expect(await anchorsOf(house)).toEqual([]);
    });

    it('worker off (never run): the warehouse reads not baselined, never verified', async () => {
      const house = await newHouse('OFF');
      await seedEvents(house, 2);
      expect(await integrityRow(house)).toMatchObject({
        baselined: false,
        legacyThroughSeq: 0,
        verifiedThroughSeq: null,
        verifiedAt: null,
        lastRunAt: null,
        brokenAtSeq: null,
        lastAnchor: null,
        breaks: [],
      });
    });
  });

  // ── verifyChain's range (PENDING a14) ──────────────────────────────────────

  describe('verifyChain validates its range', () => {
    it('fromSeq 0, a fraction, or toSeq < fromSeq → 400 validation-failed and no break row', async () => {
      const house = await newHouse('RANGE');
      await seedEvents(house, 2);
      for (const [from, to] of [
        [0, undefined],
        [-1, undefined],
        [1.5, undefined],
        [2, 1],
        [1, 2.5],
      ] as [number, number | undefined][]) {
        const caught = await facade.verifyChain(tenantId, house.warehouseId, from, to).then(
          () => null,
          (err: unknown) => err,
        );
        expect(caught).toBeInstanceOf(ProblemException);
        expect((caught as ProblemException).getStatus()).toBe(400);
        expect(((caught as ProblemException).getResponse() as { code: string }).code).toBe('validation-failed');
      }
      expect(await breaksOf(house)).toEqual([]);
      expect(await brokenAlerts(house)).toEqual([]);
    });
  });

  // ── the acknowledgement ────────────────────────────────────────────────────

  describe('acknowledge', () => {
    let house: House;
    let breakId: string;

    beforeAll(async () => {
      house = await newHouse('ACK');
      await seedEvents(house, 3);
      await editEvent(house, 2);
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await run(house);
      errors.mockRestore();
      breakId = (await breaksOf(house))[0]!.id as string;
      await drainAll();
    });

    it('ops_manager → 403 role-denied; an unknown id and another warehouse’s → 404 chain-break-not-found', async () => {
      const denied = await acknowledge(house, breakId, ops).expect(403);
      expect(denied.body.code).toBe('role-denied');
      expect((await acknowledge(house, uuidv7(), owner).expect(404)).body.code).toBe('chain-break-not-found');
      const other = await newHouse('ACKOTHER');
      expect((await acknowledge(other, breakId, owner).expect(404)).body.code).toBe('chain-break-not-found');
      expect((await acknowledge(house, 'not-a-uuid', owner).expect(400)).body.code).toBe('validation-failed');
    });

    it('the owner acknowledges: 200 ChainBreakDto, audited, the entry resolves; a replay re-serves; a second key → 409; nothing is repaired', async () => {
      const key = ulid();
      const first = await acknowledge(house, breakId, owner, key).expect(200);
      expect(first.body).toMatchObject({ id: breakId, kind: 'chain', firstSeq: 2, detectedBy: 'anchor', acknowledgedBy: owner.userId, anchorId: null });
      expect(first.body.acknowledgedAt).toMatch(/Z$/);
      await expectAuditRow({ tenantId, key, action: 'ledger_chain_break.acknowledged', targetType: 'ledger_chain_break', targetId: breakId, actorUserId: owner.userId });
      const replay = await acknowledge(house, breakId, owner, key).expect(200);
      expect(replay.body).toEqual(first.body);
      await expectAuditRow({ tenantId, key, action: 'ledger_chain_break.acknowledged', targetType: 'ledger_chain_break', targetId: breakId, actorUserId: owner.userId });
      const again = await acknowledge(house, breakId, owner).expect(409);
      expect(again.body.code).toBe('chain-break-acknowledged');
      const acked = await sql`select payload from outbox_messages where tenant_id = ${tenantId} and type = 'ledger.chain_break_acknowledged'`;
      expect(acked.map((row) => row.payload)).toEqual([{ breakId, warehouseId: house.warehouseId }]);
      await drainAll();
      expect(await entriesOf(house)).toEqual([expect.objectContaining({ source_id: breakId, resolution: 'acknowledged' })]);
      // Acknowledging repairs nothing: the next tick re-detects (WARN), adds no
      // alert, and the status stays broken — now acknowledged.
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(await brokenAlerts(house)).toEqual([]); // the first alert was drained (deleted on ack)
      expect((await run(house)).anchored).toBe(0);
      expect(await brokenAlerts(house)).toEqual([]); // no new alert
      await drainAll();
      expect(errors.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('SEVERITY-1'))).toEqual([]);
      expect(await entriesOf(house)).toEqual([expect.objectContaining({ resolution: 'acknowledged' })]);
      const row = await integrityRow(house);
      expect(row.brokenAtSeq).toBe(2);
      expect((row.breaks as { acknowledgedAt: string | null }[]).every((b) => b.acknowledgedAt !== null)).toBe(true);
    });

    describe('same-key race: the replay under the break-row lock', () => {
      const handle = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

      async function waitParked(holderPid: number, min: number): Promise<void> {
        const probe = handle();
        try {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const waiting = (await probe`
              select a.pid, pg_blocking_pids(a.pid) as blockers from pg_stat_activity a
              where a.wait_event_type = 'Lock' and a.state = 'active'
                and a.query ilike '%"ledger_chain_breaks"%' and a.query ilike '%for update%'
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
          throw new Error(`fewer than ${min} request(s) parked on the break row`);
        } finally {
          await probe.end();
        }
      }

      it('two same-key acknowledgements parked on the lock both answer the same 200 — one acknowledgement, one key, one audit row', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const raceHouse = await newHouse('ACKRACE');
        await seedEvents(raceHouse, 2);
        await editEvent(raceHouse, 1);
        await run(raceHouse);
        const raceBreak = (await breaksOf(raceHouse))[0]!.id as string;
        const key = ulid();
        const holder = handle();
        let first: Promise<request.Response> | undefined;
        let second: Promise<request.Response> | undefined;
        try {
          await holder.begin(async (tx) => {
            const locked = (await tx`
              select pg_backend_pid() as pid from ledger_chain_breaks where tenant_id = ${tenantId} and id = ${raceBreak} for update
            `) as unknown as { pid: number }[];
            first = (async () => acknowledge(raceHouse, raceBreak, owner, key))();
            second = (async () => acknowledge(raceHouse, raceBreak, owner, key))();
            await waitParked(locked[0]!.pid, 2);
          });
          const [a, b] = await Promise.all([first!, second!]);
          const outcome = (res: request.Response): number | string => (res.status === 200 ? 200 : `${res.status} ${(res.body as { code?: string }).code}`);
          expect([outcome(a), outcome(b)]).toEqual([200, 200]);
          expect(a.body).toEqual(b.body);
        } finally {
          await Promise.allSettled([first, second]);
          await holder.end();
        }
        expect(Number((await sql`select count(*)::int as n from idempotency_keys where tenant_id = ${tenantId} and key = ${key}`)[0]!.n)).toBe(1);
        await expectAuditRow({ tenantId, key, action: 'ledger_chain_break.acknowledged', targetType: 'ledger_chain_break', targetId: raceBreak, actorUserId: owner.userId });
        expect(
          Number((await sql`select count(*)::int as n from outbox_messages where tenant_id = ${tenantId} and type = 'ledger.chain_break_acknowledged' and payload ->> 'breakId' = ${raceBreak}`)[0]!.n),
        ).toBe(1);
      });
    });
  });

  // ── WORM ───────────────────────────────────────────────────────────────────

  describe('the WORM copy and read-back (s3, fake store)', () => {
    it('copies each anchor after commit: put called, copy row written; the view names the object and retain-until', async () => {
      const fake = new FakeWormStore();
      service.wormStore = fake;
      const house = await newHouse('WORM');
      await seedEvents(house, 3);
      const summary = await run(house);
      expect(summary).toMatchObject({ anchored: 1, wormCopied: 1, wormFailed: 0 });
      expect(fake.puts).toHaveLength(1);
      expect(fake.puts[0]).toMatchObject({ tenantId, warehouseId: house.warehouseId, kind: 'verified', fromSeq: 1, toSeq: 3 });
      const anchor = (await anchorsOf(house))[0]!;
      const copies = await sql`select * from ledger_anchor_worm_copies where anchor_id = ${anchor.id}`;
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({
        bucket: 'fake-bucket',
        object_key: `ledger-anchors/${tenantId}/${house.warehouseId}/000000000003-${anchor.id}.json`,
        version_id: 'v1',
      });
      const res = await httpReq().get(`${API}/${tenantId}/inventory/ledger/integrity`).set('Authorization', `Bearer ${owner.token}`).expect(200);
      expect(res.body.wormStore).toBe('s3');
      const row = (res.body.warehouses as Record<string, unknown>[]).find((r) => r.warehouseId === house.warehouseId)!;
      expect(row.wormPending).toBe(0);
      expect(row.lastAnchor).toMatchObject({ worm: { bucket: 'fake-bucket', versionId: 'v1', retainUntil: retainUntilOf(fake.puts[0]!.anchoredAt, 2557) } });
      // The next run reads the copy back (clean) and copies nothing new.
      expect(await run(house)).toMatchObject({ wormCopied: 0, reverifyBreakIds: [] });
      expect(fake.puts).toHaveLength(1);
    });

    it('a put failure writes no row, counts in wormPending, and is retried next tick', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const fake = new FakeWormStore();
      fake.failPut = Object.assign(new Error('Bucket is missing Object Lock Configuration'), { name: 'InvalidRequest' });
      service.wormStore = fake;
      const house = await newHouse('WORMFAIL');
      await seedEvents(house, 2);
      expect(await run(house)).toMatchObject({ anchored: 1, wormCopied: 0, wormFailed: 1, failedSteps: [] });
      expect(Number((await sql`select count(*)::int as n from ledger_anchor_worm_copies where tenant_id = ${tenantId} and anchor_id in (select id from ledger_anchors where warehouse_id = ${house.warehouseId})`)[0]!.n)).toBe(0);
      expect((await integrityRow(house)).wormPending).toBe(1);
      fake.failPut = null;
      expect(await run(house)).toMatchObject({ wormCopied: 1, wormFailed: 0 });
      expect((await integrityRow(house)).wormPending).toBe(0);
    });

    it('a transport error on read-back is logged and never a break; the rotation still advances and the read retries next time round', async () => {
      const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fake = new FakeWormStore();
      service.wormStore = fake;
      const house = await newHouse('WORMNET');
      await seedEvents(house, 2);
      await run(house); // anchor + copy
      const cursorBefore = (await stateOf(house))!.reverify_after_seq;
      await sql`update ledger_integrity_state set reverify_after_seq = 0 where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId}`;
      fake.getError = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      expect((await run(house)).reverifyBreakIds).toEqual([]);
      expect(await breaksOf(house)).toEqual([]);
      // Never pinned: the chain re-verify passed, so the cursor moves on.
      expect((await stateOf(house))!.reverify_after_seq).toBe(2);
      expect(warns.mock.calls.map((call) => String(call[0])).some((line) => line.includes('not a break') && line.includes('TimeoutError'))).toBe(true);
      expect(cursorBefore).toBe(2);
      // The rotation comes back round (one anchor: the next run) and reads again.
      fake.getError = null;
      const before = fake.gets;
      expect((await run(house)).reverifyBreakIds).toEqual([]);
      expect(fake.gets).toBe(before + 1);
    });

    it('a different digest is one worm break naming the anchor; a re-detection adds nothing', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fake = new FakeWormStore();
      service.wormStore = fake;
      const house = await newHouse('WORMDIFF');
      await seedEvents(house, 2);
      await run(house);
      const anchor = (await anchorsOf(house))[0]!;
      fake.getOverride = { id: anchor.id, kind: anchor.kind, anchoredAt: fake.puts[0]!.anchoredAt, digest: 'f'.repeat(64), fromSeq: 1, toSeq: 2 };
      expect((await run(house)).reverifyBreakIds).toHaveLength(1);
      await run(house);
      const breaks = await breaksOf(house);
      expect(breaks.map((b) => [b.kind, b.first_seq, b.anchor_id, b.detected_by])).toEqual([['worm', 1, anchor.id, 'reverify']]);
      expect(breaks[0]!.reason).toContain('WORM copy mismatch');
      expect(await brokenAlerts(house)).toEqual([expect.objectContaining({ kind: 'worm', breakId: breaks[0]!.id, firstSeq: 1, detectedBy: 'reverify' })]);
      await drainAll();
      expect(await entriesOf(house)).toEqual([expect.objectContaining({ summary: expect.objectContaining({ kind: 'worm', firstSeq: 1 }) })]);
    });

    it('a missing object is one worm break naming the anchor', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const fake = new FakeWormStore();
      service.wormStore = fake;
      const house = await newHouse('WORMGONE');
      await seedEvents(house, 2);
      await run(house);
      const anchor = (await anchorsOf(house))[0]!;
      fake.getOverride = 'missing';
      await run(house);
      const breaks = await breaksOf(house);
      expect(breaks.map((b) => [b.kind, b.first_seq, b.anchor_id])).toEqual([['worm', 1, anchor.id]]);
      expect(breaks[0]!.reason).toContain('WORM copy missing');
    });
  });

  // ── the reads ──────────────────────────────────────────────────────────────

  describe('the gated reads', () => {
    let house: House;

    beforeAll(async () => {
      service.maxRange = 2;
      house = await newHouse('READS');
      await seedEvents(house, 5);
      await run(house);
      service.maxRange = saved.maxRange;
    });

    it('ops_manager → 403 role-denied on all three', async () => {
      const anchor = (await anchorsOf(house))[0]!;
      for (const path of [
        `${API}/${tenantId}/inventory/ledger/integrity`,
        `${API}/${tenantId}/warehouses/${house.warehouseId}/inventory/ledger/anchors`,
        `${API}/${tenantId}/warehouses/${house.warehouseId}/inventory/ledger/anchors/${anchor.id}/proof`,
      ]) {
        const res = await httpReq().get(path).set('Authorization', `Bearer ${ops.token}`).expect(403);
        expect(res.body.code).toBe('role-denied');
      }
    });

    it('the anchors list pages newest range first on to_seq; a bad cursor → 400 invalid-cursor; an unknown warehouse → 404', async () => {
      const base = `${API}/${tenantId}/warehouses/${house.warehouseId}/inventory/ledger/anchors`;
      const first = await httpReq().get(base).query({ limit: 2 }).set('Authorization', `Bearer ${owner.token}`).expect(200);
      expect((first.body.items as { fromSeq: number; toSeq: number }[]).map((a) => [a.fromSeq, a.toSeq])).toEqual([
        [5, 5],
        [3, 4],
      ]);
      expect(first.body.nextCursor).not.toBeNull();
      const second = await httpReq().get(base).query({ limit: 2, cursor: first.body.nextCursor as string }).set('Authorization', `Bearer ${owner.token}`).expect(200);
      expect((second.body.items as { fromSeq: number; toSeq: number }[]).map((a) => [a.fromSeq, a.toSeq])).toEqual([[1, 2]]);
      expect(second.body.nextCursor).toBeNull();
      expect((await httpReq().get(base).query({ cursor: 'nope' }).set('Authorization', `Bearer ${owner.token}`).expect(400)).body.code).toBe('invalid-cursor');
      expect((await httpReq().get(base).query({ limit: 201 }).set('Authorization', `Bearer ${owner.token}`).expect(400)).body.code).toBe('validation-failed');
      expect(
        (await httpReq().get(`${API}/${tenantId}/warehouses/${uuidv7()}/inventory/ledger/anchors`).set('Authorization', `Bearer ${owner.token}`).expect(404)).body.code,
      ).toBe('not-found');
    });

    it('the proof: its lines recompute to the digest (sha256 over the "\\n"-joined lines); an unknown anchor → 404 anchor-not-found', async () => {
      for (const anchor of await anchorsOf(house)) {
        const res = await httpReq()
          .get(`${API}/${tenantId}/warehouses/${house.warehouseId}/inventory/ledger/anchors/${anchor.id}/proof`)
          .set('Authorization', `Bearer ${owner.token}`)
          .expect(200);
        const proof = res.body as { lines: string[]; recomputedDigest: string; matches: boolean; anchor: { digest: string; kind: string }; legacyForm: string | null; algorithm: string };
        const independent = createHash('sha256').update(proof.lines.join('\n'), 'utf8').digest('hex');
        expect(independent).toBe(anchor.digest);
        expect(proof.recomputedDigest).toBe(anchor.digest);
        expect(proof.anchor.digest).toBe(anchor.digest);
        expect(proof.matches).toBe(true);
        expect(proof.legacyForm).toBeNull();
        expect(proof.algorithm).toContain('sha256');
        expect(proof.lines).toHaveLength(anchor.to_seq - anchor.from_seq + 1);
        expect(proof.lines[0]!.startsWith(`${anchor.from_seq}:`)).toBe(true);
      }
      const unknown = await httpReq()
        .get(`${API}/${tenantId}/warehouses/${house.warehouseId}/inventory/ledger/anchors/${uuidv7()}/proof`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(404);
      expect(unknown.body.code).toBe('anchor-not-found');
    });

    it('a legacy anchor’s proof explains the pre-0026 form; a copied anchor’s proof names its WORM object', async () => {
      const fake = new FakeWormStore();
      service.wormStore = fake;
      const legacy = await newHouse('PROOFLEG');
      await seedEvents(legacy, 3);
      await makeLegacy(legacy, 1, 3);
      await run(legacy);
      const anchor = (await anchorsOf(legacy))[0]!;
      expect(anchor.kind).toBe('legacy');
      const res = await httpReq()
        .get(`${API}/${tenantId}/warehouses/${legacy.warehouseId}/inventory/ledger/anchors/${anchor.id}/proof`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(res.body.legacyForm).toContain('quantity_delta / 1000');
      expect(res.body.matches).toBe(true);
      expect(res.body.anchor.worm).toMatchObject({ bucket: 'fake-bucket', versionId: 'v1' });
      expect(digestOverRange((res.body.lines as string[]).map((line) => ({ seq: Number(line.split(':')[0]), eventHash: line.split(':')[1]! })))).toBe(anchor.digest);
    });
  });

  // ── review fixes (code review, 2026-10-14) ─────────────────────────────────

  describe('review fixes', () => {
    it('at or below B ONLY the pre-0026 form passes: dividing a legacy event’s quantity by 1000 is a break', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('DIV1000');
      await seedEvents(house, 5);
      await makeLegacy(house, 1, 5);
      expect((await run(house)).legacyThroughSeq).toBe(5);
      // Undo 0026's ×1000 on event 3: it now hashes in the CURRENT form.
      await tamper('update ledger_events set quantity_delta = quantity_delta / 1000 where tenant_id = $1 and warehouse_id = $2 and seq = 3', [tenantId, house.warehouseId]);
      const report = await facade.verifyChain(tenantId, house.warehouseId);
      expect(report.ok).toBe(false);
      expect((report as { reason: string }).reason).toContain('hash mismatch at seq 3');
      // The rotation's re-verify of the legacy anchor finds it too.
      await run(house);
      expect((await breaksOf(house)).map((b) => [b.kind, b.first_seq])).toEqual([['chain', 3]]);
    });

    it('a recorded break reason is bounded to 200 characters, and its panel entry is still raised', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('LONGWHY');
      await seedEvents(house, 1);
      await run(house);
      const recorded = await app.get(LedgerService).recordChainBreak(tenantId, {
        warehouseId: house.warehouseId, kind: 'chain', fromSeq: 1, toSeq: 1, firstSeq: 1, anchorId: null, reason: `x${'y'.repeat(700)}`, detectedBy: 'verify',
      });
      const row = (await breaksOf(house))[0]!;
      expect((row.reason as string).length).toBe(MAX_BREAK_REASON_LENGTH);
      await drainAll();
      expect(await entriesOf(house)).toEqual([expect.objectContaining({ source_id: recorded.breakId })]);
    });

    it('a second, lower break moves broken_at_seq down and re-stamps it; a later, higher one changes neither', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('LOWER');
      await seedEvents(house, 1);
      await run(house);
      const ledger = app.get(LedgerService);
      const record = (firstSeq: number) =>
        ledger.recordChainBreak(tenantId, { warehouseId: house.warehouseId, kind: 'chain', fromSeq: firstSeq, toSeq: firstSeq, firstSeq, anchorId: null, reason: 'r', detectedBy: 'verify' });
      const stamp = async () => (await sql`select broken_at_seq, broken_detected_at::text as at from ledger_integrity_state where tenant_id = ${tenantId} and warehouse_id = ${house.warehouseId}`)[0]!;
      await record(5);
      const first = await stamp();
      expect(first.broken_at_seq).toBe(5);
      await new Promise((r) => setTimeout(r, 5));
      await record(3);
      const lowered = await stamp();
      expect(lowered.broken_at_seq).toBe(3);
      expect(lowered.at).not.toBe(first.at);
      await record(7);
      expect(await stamp()).toEqual(lowered);
    });

    it('the database refuses to clear or raise broken_at_seq, and to delete or rewrite a break', async () => {
      const house = await newHouse('GUARDS');
      await seedEvents(house, 1);
      await run(house);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await app.get(LedgerService).recordChainBreak(tenantId, { warehouseId: house.warehouseId, kind: 'chain', fromSeq: 1, toSeq: 1, firstSeq: 1, anchorId: null, reason: 'r', detectedBy: 'verify' });
      await expect(sql`update ledger_integrity_state set broken_at_seq = null, broken_detected_at = null where warehouse_id = ${house.warehouseId}`).rejects.toThrow(/never cleared or raised/);
      await expect(sql`update ledger_integrity_state set broken_at_seq = 2 where warehouse_id = ${house.warehouseId}`).rejects.toThrow(/never cleared or raised/);
      await expect(sql`delete from ledger_chain_breaks where warehouse_id = ${house.warehouseId}`).rejects.toThrow(/append-only/);
      await expect(sql`update ledger_chain_breaks set reason = 'x' where warehouse_id = ${house.warehouseId}`).rejects.toThrow(/append-only/);
    });

    it('the baseline seeds broken_at_seq only from a pre-baseline break ABOVE B', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      // At or below B: a manual verify read a pre-0026 event in the current form.
      const legacy = await newHouse('SEEDLOW');
      await seedEvents(legacy, 5);
      await makeLegacy(legacy, 1, 4);
      expect((await facade.verifyChain(tenantId, legacy.warehouseId)).ok).toBe(false);
      expect((await breaksOf(legacy)).map((b) => b.first_seq)).toEqual([1]);
      expect(await service.ensureBaseline(tenantId, legacy.warehouseId)).toEqual({ created: true, legacyThroughSeq: 4 });
      expect(await stateOf(legacy)).toMatchObject({ broken_at_seq: null, broken_detected_at: null });
      // Above B: a real tamper the baseline must not forget.
      const tampered = await newHouse('SEEDHIGH');
      await seedEvents(tampered, 4);
      await editEvent(tampered, 3);
      expect((await facade.verifyChain(tenantId, tampered.warehouseId)).ok).toBe(false);
      expect(await service.ensureBaseline(tenantId, tampered.warehouseId)).toEqual({ created: true, legacyThroughSeq: 0 });
      expect((await stateOf(tampered))!.broken_at_seq).toBe(3);
      expect((await stateOf(tampered))!.broken_detected_at).not.toBeNull();
    });

    it('verifyChain refuses a toSeq beyond the head (400) and records no break', async () => {
      const house = await newHouse('BEYOND');
      await seedEvents(house, 2);
      const caught = await facade.verifyChain(tenantId, house.warehouseId, 1, 3).then(() => null, (err: unknown) => err);
      expect(caught).toBeInstanceOf(ProblemException);
      expect((caught as ProblemException).getStatus()).toBe(400);
      expect(((caught as ProblemException).getResponse() as { code: string }).code).toBe('validation-failed');
      expect(await breaksOf(house)).toEqual([]);
      expect((await facade.verifyChain(tenantId, house.warehouseId, 1, 2)).ok).toBe(true);
    });

    it('one deletion is ONE break row whoever finds it: a head-bounded verifyChain and the worker both name the missing seq', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const house = await newHouse('ONEGAP');
      await seedEvents(house, 6);
      await tamper('delete from ledger_events where tenant_id = $1 and warehouse_id = $2 and seq = 4', [tenantId, house.warehouseId]);
      const report = await facade.verifyChain(tenantId, house.warehouseId);
      expect(report).toMatchObject({ ok: false, fromSeq: 4, firstSeq: 4 });
      expect((report as { reason: string }).reason).toContain('missing events');
      await run(house);
      const breaks = await breaksOf(house);
      expect(breaks.map((b) => [b.kind, b.first_seq])).toEqual([['chain', 4]]);
      expect(breaks[0]!.detected_by).toBe('verify');
    });

    it('an anchors cursor above int4 is 400 invalid-cursor', async () => {
      const house = await newHouse('BIGCUR');
      const cursor = Buffer.from(JSON.stringify({ toSeq: 3_000_000_000 }), 'utf8').toString('base64url');
      const res = await httpReq()
        .get(`${API}/${tenantId}/warehouses/${house.warehouseId}/inventory/ledger/anchors`)
        .query({ cursor })
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(400);
      expect(res.body.code).toBe('invalid-cursor');
    });

    it('the integrity read lists the newest 10 breaks, newest first, and counts every open one (openBreakCount)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const house = await newHouse('TWELVE');
      await seedEvents(house, 1);
      await run(house);
      const ledger = app.get(LedgerService);
      const ids: string[] = [];
      for (let seq = 1; seq <= 12; seq += 1) {
        ids.push((await ledger.recordChainBreak(tenantId, { warehouseId: house.warehouseId, kind: 'chain', fromSeq: seq, toSeq: seq, firstSeq: seq, anchorId: null, reason: 'r', detectedBy: 'verify' })).breakId);
      }
      // The ten newest are acknowledged; the two OLDEST stay open and are not listed.
      await sql`update ledger_chain_breaks set acknowledged_by = ${owner.userId}, acknowledged_at = now() where id = any(${ids.slice(2)}::uuid[])`;
      const row = await integrityRow(house);
      expect((row.breaks as { id: string; acknowledgedAt: string | null }[]).map((b) => b.id)).toEqual([...ids].reverse().slice(0, 10));
      expect((row.breaks as { acknowledgedAt: string | null }[]).every((b) => b.acknowledgedAt !== null)).toBe(true);
      expect(row.openBreakCount).toBe(2);
    });

    it('a WORM copy whose id, kind or anchoredAt differs (digest and range intact) is a worm break', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const fake = new FakeWormStore();
      service.wormStore = fake;
      const house = await newHouse('WORMMETA');
      await seedEvents(house, 2);
      await run(house);
      const copy = (await sql`select object_key, version_id from ledger_anchor_worm_copies where tenant_id = ${tenantId} and anchor_id = ${(await anchorsOf(house))[0]!.id}`)[0]!;
      const stored = fake.stored(copy.object_key as string, copy.version_id as string)!;
      fake.getOverride = { ...stored, anchoredAt: '2020-01-01T00:00:00.000Z' };
      expect((await run(house)).reverifyBreakIds).toHaveLength(1);
      expect((await breaksOf(house)).map((b) => b.kind)).toEqual(['worm']);
    });

    it('a failed copy-row insert after a successful put is counted and the remaining anchors still copy', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      service.maxRange = 2;
      const fake = new FakeWormStore();
      service.wormStore = fake;
      const house = await newHouse('WORMROW');
      await seedEvents(house, 4);
      // Anchor first (no copy yet), then poison the first anchor's copy row.
      service.wormStore = saved.wormStore;
      await run(house);
      const anchors = await anchorsOf(house);
      expect(anchors).toHaveLength(2);
      fake.badRetainFor.add(anchors[0]!.id);
      service.wormStore = fake;
      expect(await run(house)).toMatchObject({ wormCopied: 1, wormFailed: 1, failedSteps: [] });
      expect((await integrityRow(house)).wormPending).toBe(1);
    });

    it('the baseline scan chunk is a field: chunk 3 over 8 legacy events still finds B = 8', async () => {
      service.baselineScanChunk = 3;
      try {
        const house = await newHouse('CHUNK3');
        await seedEvents(house, 8);
        await makeLegacy(house, 1, 8);
        expect((await run(house)).legacyThroughSeq).toBe(8);
      } finally {
        service.baselineScanChunk = 1_000;
      }
    });

    it('zero-delta events: leading ones on a clean chain give B = 0 and no legacy anchor; trailing ones after a legacy prefix stop B at the last non-zero', async () => {
      const clean = await newHouse('ZEROFIRST');
      await appendZero(clean);
      await appendZero(clean);
      await seedEvents(clean, 1);
      expect((await run(clean)).legacyThroughSeq).toBe(0);
      expect((await anchorsOf(clean)).map((a) => [a.kind, a.from_seq, a.to_seq])).toEqual([['verified', 1, 3]]);

      const legacy = await newHouse('ZEROAFTER');
      await seedEvents(legacy, 3);
      await makeLegacy(legacy, 1, 3);
      await appendZero(legacy);
      await appendZero(legacy);
      await seedEvents(legacy, 1);
      const summary = await run(legacy);
      expect(summary).toMatchObject({ legacyThroughSeq: 3, anchorBreakId: null });
      expect((await anchorsOf(legacy)).map((a) => [a.kind, a.from_seq, a.to_seq])).toEqual([
        ['legacy', 1, 3],
        ['verified', 4, 6],
      ]);
    });

    it('the boot refuses a bad LEDGER_ANCHOR_MAX_RANGE or LEDGER_ANCHOR_CHUNKS_PER_TICK', () => {
      for (const [name, value] of [
        ['LEDGER_ANCHOR_MAX_RANGE', '0'],
        ['LEDGER_ANCHOR_MAX_RANGE', 'lots'],
        ['LEDGER_ANCHOR_CHUNKS_PER_TICK', '-1'],
        ['LEDGER_ANCHOR_CHUNKS_PER_TICK', '1.5'],
      ] as const) {
        process.env[name] = value;
        try {
          expect(() => new LedgerIntegrityService(null as never, null as never, null as never, saved.wormStore)).toThrow(new RegExp(name));
        } finally {
          delete process.env[name];
        }
      }
    });
  });

  // ── the worker ─────────────────────────────────────────────────────────────

  describe('the LedgerIntegrityWorker', () => {
    it('is env-gated: unset or 0 is OFF; a bad value fails the boot; the scope cap defaults to 50', () => {
      expect(parseLedgerIntegrityPollMs(undefined)).toBe(0);
      expect(parseLedgerIntegrityPollMs('0')).toBe(0);
      expect(parseLedgerIntegrityPollMs('3600000')).toBe(3_600_000);
      expect(() => parseLedgerIntegrityPollMs('soon')).toThrow(/LEDGER_INTEGRITY_POLL_MS/);
      expect(parseMaxLedgerIntegrityScopesPerTick(undefined)).toBe(DEFAULT_MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK);
      expect(DEFAULT_MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK).toBe(50);
      expect(() => parseMaxLedgerIntegrityScopesPerTick('0')).toThrow(/MAX_LEDGER_INTEGRITY_SCOPES_PER_TICK/);
      const worker = app.get(LedgerIntegrityWorker);
      worker.onApplicationBootstrap();
      expect((worker as unknown as { timer: unknown }).timer).toBeUndefined();
    });

    it('one real tick runs every warehouse of the suite’s tenant (the plumbing)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const house = await newHouse('TICK');
      await seedEvents(house, 2);
      const worker = new LedgerIntegrityWorker(app.get(AUTH_DATABASE) as never, facade);
      worker.maxScopesPerTick = 1_000;
      const result = await worker.tick();
      expect(result.carried).toBe(result.total);
      expect(result.total).toBe(Number((await sql`select count(*)::int as n from warehouses`)[0]!.n));
      expect(await stateOf(house)).toMatchObject({ verified_through_seq: 2 });
    });

    it('the rotating window: past the cap each tick starts where the last stopped; a failing tenant or scope never stops the rest', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const cap = 5;
      const total = 8;
      const fakeScopes = Array.from({ length: total }, (_, i) => ({ tenantId, warehouseId: `wh-${i}` }));
      const calls: string[] = [];
      const fake = {
        ledgerIntegrityScopesOf: async (t: string) => {
          if (t !== tenantId) throw new Error('a poison tenant');
          return fakeScopes;
        },
        runLedgerIntegrity: async (_t: string, warehouseId: string) => {
          calls.push(warehouseId);
          if (warehouseId === 'wh-0') throw new Error('a poison scope');
          return { anchored: 0, wormCopied: 0, baselined: false } as never;
        },
      };
      // A second tenant whose listing throws.
      await httpReq().post(API).set(KEY_HEADER, ulid()).send({ name: `Poison ${ulid()}`, ownerEmail: `p-${ulid().toLowerCase()}@example.com`, password: PASSWORD }).expect(201);
      const worker = new LedgerIntegrityWorker(app.get(AUTH_DATABASE) as never, fake as never);
      worker.maxScopesPerTick = cap;
      expect(await worker.tick()).toEqual({ carried: cap, total });
      expect(calls).toEqual(['wh-0', 'wh-1', 'wh-2', 'wh-3', 'wh-4']);
      calls.length = 0;
      expect(await worker.tick()).toEqual({ carried: cap, total });
      // Starts where the last stopped (an advance by the number carried) and wraps.
      expect(calls).toEqual(['wh-5', 'wh-6', 'wh-7', 'wh-0', 'wh-1']);
    });
  });
});
