/**
 * Demo seed — ONE fresh, fully populated demo tenant, created entirely
 * through the real HTTP API of a running backend.
 *
 * Every record goes through the real command layer: guards, ledger,
 * idempotency keys, audit rows and the outbox. Nothing is written to the
 * database directly. Each run registers a NEW tenant with timestamp-suffixed
 * emails, so the script can be re-run as often as you like; earlier demo
 * tenants are left untouched.
 *
 * Usage (from the wms-be directory, with the backend running — see the
 * README's "Demo data" section for the env it needs):
 *
 *   bun run seed:demo
 *   bun run seed:demo -- --base-url http://localhost:3000/api/v1 --web-url http://localhost:3001
 *
 * What it seeds (each step is reported OK / SKIPPED with the reason; a
 * failing step never aborts the run — later steps that depend on it skip):
 *
 *   1. tenant + owner, and an ops manager, an operator and an accountant
 *   2. two warehouses (Bengaluru DC, Mumbai FC) with zones and bin grids,
 *      incl. a chilled zone
 *   3. a catalog via the CSV import: plain units, a kg SKU, batch-tracked,
 *      serial-tracked, catch-weight, a product with variants, a kit, a
 *      hazard-classed SKU, HSN/GST and reorder points
 *   4. inbound: vendors, a PO, an enrolled handheld + operator badge-in,
 *      a GRN against the PO (batches, a partial line, an over-receipt left
 *      pending), a blind receipt (catch-weight cases), putaway, a QC hold
 *   5. inventory: serial and near-expiry batch intake, an immediate
 *      adjustment, two over-threshold adjustments left PENDING, count tasks
 *      (one submitted with a variance, one open), transfers between the two
 *      warehouses (one received, one in transit), a temperature excursion
 *   6. outbound: a sandbox carrier connection, orders at every stage —
 *      dispatched (labelled + manifested), ready to dispatch, picked,
 *      waved-but-planned, accepted and backordered
 *   7. invoicing: GST invoices raised by the dispatch handler (outbox), an
 *      e-way bill for the high-value inter-state order (generated through
 *      the sandbox gateway when EWAY_GATEWAY=sandbox)
 *   8. returns: an RMA on a dispatched order and a device return receipt
 *      with condition grades, one entry refused to the review queue; a
 *      second RMA left open
 *   9. 3PL: a client brand with tax details, its own SKUs, an active rate
 *      card, an ASN received in part, a dispatched client order and a
 *      client-portal login
 *  10. replenishment + expiry policies (the scheduler raises breaches and
 *      batch alerts), an audit export request, and a fresh enrollment code
 *      for pairing a real handheld
 *
 * Exceptions to "HTTP only": none. Every step uses a public route; the
 * device steps (receiving, putaway, picks, count submit, transfer receipt,
 * return receipt) run under a real enrolled device + badge-in session, just
 * as the handheld does.
 *
 * Background workers are what turn some of this into visible state —
 * invoices and e-way bills (OUTBOX_RELAY_POLL_MS), reorder breaches and
 * batch alerts (REPLENISHMENT_SCHEDULER_POLL_MS), audit exports
 * (AUDIT_EXPORT_POLL_MS), ledger integrity (LEDGER_INTEGRITY_POLL_MS).
 * With a worker off, its step reports SKIPPED/"not observed" and the seed
 * carries on.
 */

import { enrolmentOf, signInTwoStep } from './lib/two-step-sign-in';

// The API's JSON bodies are consumed loosely here (a seed script, not a
// typed client) — one deliberate `any` alias instead of a hundred casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// ── arguments ──────────────────────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

const BASE_URL = (argValue('--base-url') ?? process.env.SEED_BASE_URL ?? 'http://localhost:3000/api/v1').replace(/\/$/, '');
const WEB_URL = argValue('--web-url') ?? process.env.SEED_WEB_URL ?? 'http://localhost:3001';

const PASSWORD = 'Demo@12345';
const DEVICE_PIN = '2468';

// ── output ─────────────────────────────────────────────────────────────────

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

// ── ids ────────────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastUlidMs = -1;
let lastUlidRandom: number[] = [];

/** A monotonic ULID (26 chars, Crockford base32) — the Idempotency-Key shape. */
function ulid(): string {
  let ms = Date.now();
  if (ms <= lastUlidMs) {
    ms = lastUlidMs;
    let i = lastUlidRandom.length - 1;
    while (i >= 0 && lastUlidRandom[i] === 31) lastUlidRandom[i--] = 0;
    if (i >= 0) lastUlidRandom[i]! += 1;
  } else {
    lastUlidRandom = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  lastUlidMs = ms;
  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  return time + lastUlidRandom.map((n) => CROCKFORD[n]).join('');
}

// ── time ───────────────────────────────────────────────────────────────────

/** Second-precision UTC instant, Z-suffixed (the device ops' `occurredAt` shape). */
function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** The IST calendar date `offsetDays` from today, `YYYY-MM-DD`. */
function istDate(offsetDays = 0): string {
  const ist = new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000);
  return ist.toISOString().slice(0, 10);
}

/** A UTC instant `offsetDays` from now (the batch dates' ISO-8601 instant shape). */
function isoDaysFromNow(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── HTTP ───────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: Json,
  ) {
    const code = typeof body === 'object' && body !== null ? (body.code ?? '') : '';
    const detail = typeof body === 'object' && body !== null ? (body.detail ?? body.title ?? '') : String(body).slice(0, 200);
    super(`${method} ${path} → ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`);
  }
}

interface CallOptions {
  readonly token?: string | undefined;
  readonly body?: unknown;
  readonly form?: FormData;
  /** Send an Idempotency-Key (default: every non-GET). */
  readonly idempotent?: boolean;
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.idempotent ?? method !== 'GET') headers['Idempotency-Key'] = ulid();
  let payload: FormData | string | undefined;
  if (options.form !== undefined) {
    payload = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }
  const response = await fetch(`${BASE_URL}${path}`, payload === undefined ? { method, headers } : { method, headers, body: payload });
  const text = await response.text();
  let body: Json = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    /* non-JSON body — kept as text */
  }
  if (!response.ok) throw new ApiError(method, path, response.status, body);
  return { status: response.status, body };
}

/** The id of a created resource, whichever envelope the route answers with. */
function idOf(body: Json, ...keys: string[]): string {
  for (const key of keys) {
    const id = body?.[key]?.id;
    if (typeof id === 'string') return id;
  }
  if (typeof body?.id === 'string') return body.id as string;
  throw new Error(`no id in response (looked under ${keys.join(', ') || 'the body'}): ${JSON.stringify(body).slice(0, 300)}`);
}

// ── step bookkeeping ───────────────────────────────────────────────────────

interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly note: string;
}

const results: StepResult[] = [];

async function step(name: string, run: () => Promise<string | void>): Promise<boolean> {
  process.stdout.write(`• ${name} … `);
  try {
    const note = (await run()) ?? '';
    results.push({ name, ok: true, note });
    say(`OK${note ? ` — ${note}` : ''}`);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, note: reason });
    say(`SKIPPED — ${reason}`);
    return false;
  }
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`prerequisite missing: ${what}`);
  return value;
}

// ── demo state ─────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // yyyymmddhhmm
const suffix = `${stamp}${Math.floor(Math.random() * 900 + 100)}`;
const emailOf = (role: string): string => `${role}.${suffix}@demo-wms.example.com`;
const TENANT_NAME = `Demo Traders ${stamp.slice(0, 8)}-${suffix.slice(-5)}`;

interface Account {
  readonly role: string;
  readonly email: string;
  token: string;
  signedInAt: number;
  userId?: string;
}

const accounts = new Map<string, Account>();
let tenantId: string | undefined;

/**
 * Story 6-1b — the owner signs in in two steps; the seed holds the owner's
 * authenticator (`scripts/lib/two-step-sign-in.ts`) and prints it at the end
 * so a person can add it to a real app. Other roles answer in one step.
 */
async function signIn(email: string): Promise<string> {
  const body = await signInTwoStep(BASE_URL, email, PASSWORD);
  return body.accessToken;
}

/** A fresh-enough web session for the role (tokens live 15 minutes; refreshed at 10). */
async function tokenFor(role: string): Promise<string> {
  const account = need(accounts.get(role), `${role} account`);
  if (Date.now() - account.signedInAt > 10 * 60_000) {
    account.token = await signIn(account.email);
    account.signedInAt = Date.now();
  }
  return account.token;
}

const T = (): string => need(tenantId, 'tenant');
const as = async (role: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> =>
  call(method, `/tenants/${T()}${path}`, { token: await tokenFor(role), body });

/** The badge-in device session (30-day TTL) the floor ops run under. */
let deviceToken: string | undefined;
let deviceSession: string | undefined;
let deviceLabel: string | undefined;
const device = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> =>
  call(method, `/tenants/${T()}${path}`, { token: need(deviceSession, 'badge-in device session'), body });

interface Warehouse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** bin code → id */
  readonly bins: Map<string, string>;
  /** ambient pickable bin codes, in walk order */
  readonly ambient: string[];
  readonly chilled: string[];
}

const warehouses = new Map<string, Warehouse>();
const skus = new Map<string, string>(); // code → id
const skuCode = new Map<string, string>(); // id → code
let clientId: string | undefined;
let carrierConnectionId: string | undefined;
let wavePolicyId: string | undefined;

const BLR = (): Warehouse => need(warehouses.get('BLR'), 'Bengaluru DC');
const MUM = (): Warehouse => need(warehouses.get('MUM'), 'Mumbai FC');
const sku = (code: string): string => need(skus.get(code), `SKU ${code}`);
const bin = (wh: Warehouse, code: string): string => need(wh.bins.get(code), `bin ${code} in ${wh.code}`);

/** stock placements we know of: sku code → bin code (BLR) */
const homeBin = new Map<string, string>();
const PHONE_SERIALS = ['RDX-IMEI-358240051111001', 'RDX-IMEI-358240051111002', 'RDX-IMEI-358240051111003', 'RDX-IMEI-358240051111004', 'RDX-IMEI-358240051111005', 'RDX-IMEI-358240051111006'];

// ── addresses ──────────────────────────────────────────────────────────────

const ADDRESSES = {
  blrOrigin: { contactName: 'Ravi Kumar', phone: '+91 98450 10001', line1: 'Plot 42, KIADB Industrial Area', line2: 'Hoskote', city: 'Bengaluru', state: 'Karnataka', pincode: '562114' },
  mumOrigin: { contactName: 'Sneha Patil', phone: '+91 98200 20002', line1: 'Gala 7, Rajlaxmi Logistics Park', line2: 'Bhiwandi', city: 'Thane', state: 'Maharashtra', pincode: '421302' },
  customers: [
    { contactName: 'Ananya Iyer', phone: '+91 99000 11223', line1: '14, 5th Cross, Indiranagar', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
    { contactName: 'Sharma Electronics', phone: '+91 98201 33445', line1: 'Shop 3, Lamington Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400007' },
    { contactName: 'Karthik Reddy', phone: '+91 90000 55667', line1: 'Flat 302, Jubilee Enclave', line2: 'Road No. 36', city: 'Hyderabad', state: 'Telangana', pincode: '500033' },
    { contactName: 'Meera Nair', phone: '+91 94470 77889', line1: 'TC 25/1830, Statue Road', city: 'Thiruvananthapuram', state: 'Kerala', pincode: '695001' },
    { contactName: 'Arjun Mehta', phone: '+91 98250 99001', line1: '12, Satellite Road', city: 'Ahmedabad', state: 'Gujarat', pincode: '380015' },
    { contactName: 'Divya Rao', phone: '+91 97400 12121', line1: '88, HSR Layout Sector 2', city: 'Bengaluru', state: 'Karnataka', pincode: '560102' },
    { contactName: 'Rahul Verma', phone: '+91 98110 34343', line1: 'B-17, Saket', city: 'New Delhi', state: 'Delhi', pincode: '110017' },
    { contactName: 'Pooja Shetty', phone: '+91 98860 56565', line1: '5, Bendoorwell', city: 'Mangaluru', state: 'Karnataka', pincode: '575002' },
  ],
};

const GSTIN = { blr: '29AAACD7395K1Z4', mum: '27AAACD7395K1Z8', buyerMum: '27AABCS4412Q1Z3', client: '29AAGCG4321M1Z7' };

// ── the catalog ────────────────────────────────────────────────────────────

const CATALOG_HEADER = [
  'sku_code', 'name', 'uom', 'gst_rate', 'hsn', 'batch_tracked', 'serial_tracked', 'catch_weight_tracked',
  'reorder_point', 'reorder_qty', 'barcode', 'storage_class', 'hazard_class', 'abc_class', 'weight_grams',
  'product', 'variant_values', 'kit_components',
];

const PRODUCT_NAME = 'Classic Cotton T-Shirt';

/** [code, name, uom, gstBps, hsn, batch, serial, catchWeight, reorderPoint, reorderQty, barcode, storage, hazard, abc, weightG, product, variantValues, kit] */
const CATALOG_ROWS: string[][] = [
  ['RICE-BAS-1KG', 'India Gate Basmati Rice 1 kg', 'pcs', '500', '1006', 'false', 'false', 'false', '500', '1000', '8901000000011', '', '', 'a', '1020', '', '', ''],
  ['TURMERIC-200G', 'Turmeric Powder 200 g', 'pcs', '500', '0910', 'false', 'false', 'false', '60', '300', '8901000000028', '', '', 'a', '210', '', '', ''],
  ['SUGAR-LOOSE', 'Refined Sugar (loose)', 'kg', '500', '1701', 'false', 'false', 'false', '100', '500', '8901000000035', '', '', 'b', '', '', '', ''],
  ['PANEER-200G', 'Fresh Paneer 200 g', 'pcs', '500', '0406', 'true', 'false', 'false', '40', '150', '8901000000042', 'chilled', '', 'a', '205', '', '', ''],
  ['VITC-TABS-60', 'Vitamin C Tablets (60)', 'pcs', '1200', '3004', 'true', 'false', 'false', '50', '200', '8901000000059', '', '', 'b', '90', '', '', ''],
  ['PHONE-RDX-X1', 'Redix X1 Smartphone 128 GB', 'pcs', '1800', '8517', 'false', 'true', 'false', '', '', '8901000000066', '', '', 'a', '190', '', '', ''],
  ['TV-LED-43', 'Vistara 43" 4K LED TV', 'pcs', '1800', '8528', 'false', 'false', 'false', '4', '10', '8901000000073', '', '', 'a', '8200', '', '', ''],
  ['CHEESE-WHEEL', 'Gouda Cheese Wheel (catch weight)', 'case', '1200', '0406', 'false', 'false', 'true', '', '', '8901000000080', 'chilled', '', 'c', '', '', '', ''],
  ['SANITIZER-5L', 'Hand Sanitizer 5 L (70% IPA)', 'pcs', '1800', '3808', 'false', 'false', 'false', '', '', '8901000000097', '', 'flammable', 'c', '4600', '', '', ''],
  ['DETERGENT-1KG', 'Matic Detergent Powder 1 kg', 'pcs', '1800', '3402', 'false', 'false', 'false', '80', '400', '8901000000103', '', '', 'b', '1010', '', '', ''],
  ['NOTEBOOK-A5', 'Ruled Notebook A5 (200 pages)', 'pcs', '1200', '4820', 'false', 'false', 'false', '', '', '8901000000110', '', '', 'c', '280', '', '', ''],
  ['BOTTLE-STEEL-1L', 'Steel Water Bottle 1 L', 'pcs', '1800', '7323', 'false', 'false', 'false', '', '', '8901000000127', '', '', 'b', '350', '', '', ''],
  ['TSHIRT-M-NAVY', 'Classic Cotton T-Shirt — M / Navy', 'pcs', '500', '6109', 'false', 'false', 'false', '', '', '8901000000134', '', '', 'b', '180', PRODUCT_NAME, 'size=M; colour=Navy', ''],
  ['TSHIRT-L-NAVY', 'Classic Cotton T-Shirt — L / Navy', 'pcs', '500', '6109', 'false', 'false', 'false', '', '', '8901000000141', '', '', 'b', '190', PRODUCT_NAME, 'size=L; colour=Navy', ''],
  ['TSHIRT-L-WHITE', 'Classic Cotton T-Shirt — L / White', 'pcs', '500', '6109', 'false', 'false', 'false', '', '', '8901000000158', '', '', 'b', '190', PRODUCT_NAME, 'size=L; colour=White', ''],
  ['HAMPER-FESTIVE', 'Festive Pantry Hamper (kit)', 'pcs', '500', '2106', 'false', 'false', 'false', '', '', '8901000000165', '', '', '', '', '', '', 'RICE-BAS-1KG:2;TURMERIC-200G:1;BOTTLE-STEEL-1L:1'],
];

const CLIENT_CATALOG_ROWS: string[][] = [
  ['GLOW-SERUM-30', 'GlowCo Vitamin C Serum 30 ml', 'pcs', '1800', '3304', 'false', 'false', 'false', '', '', '8909000000012', '', '', 'a', '80', '', '', ''],
  ['GLOW-SPF50-50', 'GlowCo Sunscreen SPF 50 50 ml', 'pcs', '1800', '3304', 'false', 'false', 'false', '', '', '8909000000029', '', '', 'a', '75', '', '', ''],
  ['GLOW-LIPBALM', 'GlowCo Tinted Lip Balm', 'pcs', '1800', '3304', 'false', 'false', 'false', '', '', '8909000000036', '', '', 'b', '15', '', '', ''],
];

function csvOf(rows: string[][]): string {
  return [CATALOG_HEADER, ...rows].map((row) => row.map((cell) => (/[",]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')).join('\n');
}

async function importCatalog(rows: string[][], forClient?: string): Promise<string> {
  const form = new FormData();
  form.append('mode', 'initial');
  if (forClient !== undefined) form.append('clientId', forClient);
  form.append('file', new Blob([csvOf(rows)], { type: 'text/csv' }), 'catalog.csv');
  const res = await call('POST', `/tenants/${T()}/catalog/imports`, { token: await tokenFor('owner'), form });
  const body = res.body;
  const failed = (body.errors ?? body.failures ?? []) as Json[];
  await loadSkus();
  const committed = body.committedRows ?? body.committed ?? '?';
  const failedCount = body.failedRows ?? failed.length;
  if (Number(failedCount) > 0) {
    const detail = failed.slice(0, 5).map((f) => `${f.skuCode ?? f.rowNumber}: ${f.code} ${f.detail ?? f.message ?? ''}`).join('; ');
    return `${committed} rows committed, ${failedCount} failed (${detail})`;
  }
  return `${committed} rows committed`;
}

async function loadSkus(): Promise<void> {
  let cursor: string | null = null;
  do {
    const res = await as('owner', 'GET', `/catalog/skus?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of res.body.items as Json[]) {
      skus.set(item.code, item.id);
      skuCode.set(item.id, item.code);
    }
    cursor = res.body.nextCursor ?? null;
  } while (cursor);
}

// ── bins ───────────────────────────────────────────────────────────────────

async function zoneWithGrid(
  wh: Warehouse,
  zone: { code: string; name: string },
  grid: { aisleFrom: string; aisleTo: string; baysPerAisle: number; levelsPerBay: number; storageClass?: string },
): Promise<number> {
  const zoneId = idOf((await as('owner', 'POST', `/warehouses/${wh.id}/zones`, zone)).body, 'zone');
  await as('owner', 'POST', `/warehouses/${wh.id}/zones/${zoneId}/bins/grid`, { ...grid, capacity: 100000, type: 'shelf' });
  let cursor: string | null = null;
  let count = 0;
  do {
    const res = await as('owner', 'GET', `/warehouses/${wh.id}/zones/${zoneId}/bins?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of res.body.items as Json[]) {
      wh.bins.set(item.code, item.id);
      if (grid.storageClass === 'chilled') wh.chilled.push(item.code);
      else wh.ambient.push(item.code);
      count++;
    }
    cursor = res.body.nextCursor ?? null;
  } while (cursor);
  wh.ambient.sort();
  wh.chilled.sort();
  return count;
}

// ── outbound helpers ───────────────────────────────────────────────────────

interface OrderSpec {
  readonly label: string;
  readonly wh: () => Warehouse;
  readonly lines: { code: string; quantity: number; ratePaise: number }[];
  readonly destination: Record<string, string>;
  readonly consigneeGstin?: string;
  readonly consigneeLegalName?: string;
}

const orders = new Map<string, { id: string; spec: OrderSpec }>();

async function createOrder(spec: OrderSpec): Promise<string> {
  const res = await as('ops_manager', 'POST', '/outbound/orders', {
    warehouseId: spec.wh().id,
    lines: spec.lines.map((l) => ({ skuId: sku(l.code), quantity: l.quantity, ratePaise: l.ratePaise })),
    destination: spec.destination,
    ...(spec.consigneeGstin ? { consigneeGstin: spec.consigneeGstin, consigneeLegalName: spec.consigneeLegalName } : {}),
  });
  const order = res.body.order ?? res.body;
  orders.set(spec.label, { id: order.id, spec });
  const backordered = (order.lines as Json[] | undefined)?.some((l) => l.status === 'backordered' || Number(l.shortfallQty) > 0);
  return backordered ? 'backordered' : (order.status as string);
}

const orderId = (label: string): string => need(orders.get(label), `order ${label}`).id;

async function pickPicklist(picklist: Json, whId: string, serialPool: string[]): Promise<number> {
  let picked = 0;
  for (const line of picklist.lines as Json[]) {
    if (line.binId === null || Number(line.qty) <= 0) continue;
    const isPhone = line.skuId === skus.get('PHONE-RDX-X1');
    const serials = isPhone ? serialPool.splice(0, Number(line.qty)) : undefined;
    await device('POST', '/outbound/picks', {
      warehouseId: whId,
      picklistId: line.picklistId,
      picklistLineId: line.id,
      skuId: line.skuId,
      binId: line.binId,
      qty: Number(line.qty),
      occurredAt: nowUtc(),
      ...(serials ? { serials } : {}),
    });
    picked++;
  }
  return picked;
}

function scannedOf(picklist: Json): { skuId: string; qty: number }[] {
  const bySku = new Map<string, number>();
  for (const line of picklist.lines as Json[]) bySku.set(line.skuId, (bySku.get(line.skuId) ?? 0) + Number(line.qty));
  return [...bySku].map(([skuId, qty]) => ({ skuId, qty: Math.round(qty * 1000) / 1000 }));
}

// ── putaway helper ─────────────────────────────────────────────────────────

const CHILLED_SKUS = new Set(['PANEER-200G', 'CHEESE-WHEEL']);
const usedBins = new Set<string>();

/** The bin a SKU lives in: its existing home, else the next free bin of its class (client goods → zone D). */
function assignBin(code: string): string {
  const existing = homeBin.get(code);
  if (existing !== undefined) return existing;
  const wh = BLR();
  const pool = CHILLED_SKUS.has(code)
    ? wh.chilled
    : code.startsWith('GLOW-')
      ? wh.ambient.filter((b) => b.startsWith('D-'))
      : wh.ambient.filter((b) => !b.startsWith('D-'));
  const free = need(pool.find((b) => !usedBins.has(b)), `a free bin for ${code}`);
  usedBins.add(free);
  homeBin.set(code, free);
  return free;
}

/** Places one putaway task into the SKU's assigned bin (a reason code when it differs from the suggestion). */
async function putAway(task: Json, code: string): Promise<void> {
  const binCode = assignBin(code);
  const suggested = task.suggestedBin?.binCode as string | undefined;
  const body = {
    warehouseId: BLR().id,
    grnId: task.grnId,
    grnLineId: task.grnLineId,
    skuId: task.skuId,
    batchId: task.batchId ?? null,
    qty: Number(task.qty),
    toBinId: bin(BLR(), binCode),
    occurredAt: nowUtc(),
  };
  const withReason = suggested !== undefined && suggested !== binCode;
  try {
    await device('POST', '/putaway/placements', withReason ? { ...body, reasonCode: 'operator-preference' } : body);
  } catch (error) {
    // The suggestion is re-derived at placement time (a sibling batch line
    // placed a moment ago moves it), so the listed one can be stale: retry
    // once with the reason arm flipped.
    if (!(error instanceof ApiError && error.status === 400 && /reason/i.test(String(error.body?.detail)))) throw error;
    await device('POST', '/putaway/placements', withReason ? body : { ...body, reasonCode: 'operator-preference' });
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  say(`WMS demo seed → ${BASE_URL}`);
  try {
    await call('GET', '/health', { idempotent: false });
  } catch (error) {
    say(`The backend is not reachable at ${BASE_URL}/health (${error instanceof Error ? error.message : String(error)}).`);
    say('Start it first (see README → Demo data), then re-run.');
    process.exit(1);
  }
  say('');

  // ── 1. tenant and people ─────────────────────────────────────────────────
  say('1. Tenant and users');
  await step('Register tenant + owner', async () => {
    const res = await call('POST', '/tenants', { body: { name: TENANT_NAME, ownerEmail: emailOf('owner'), password: PASSWORD, gstin: GSTIN.blr } });
    tenantId = res.body.tenant.id as string;
    const token = await signIn(emailOf('owner'));
    accounts.set('owner', { role: 'owner', email: emailOf('owner'), token, signedInAt: Date.now(), userId: res.body.user?.id });
    return `${TENANT_NAME} (${tenantId})`;
  });
  for (const role of ['ops_manager', 'operator', 'accountant']) {
    await step(`Invite + accept ${role}`, async () => {
      const email = emailOf(role.replace('_', '-'));
      const invited = await as('owner', 'POST', '/users', { email, role });
      await call('POST', `/tenants/${T()}/accept-invite`, { body: { token: invited.body.inviteToken, password: PASSWORD } });
      accounts.set(role, { role, email, token: await signIn(email), signedInAt: Date.now(), userId: invited.body.user?.id });
      return email;
    });
  }

  // ── 2. warehouses ────────────────────────────────────────────────────────
  say('\n2. Warehouses, zones and bins');
  await step('Warehouse Bengaluru DC (zones A/B ambient, C chilled)', async () => {
    const res = await as('owner', 'POST', '/warehouses', { code: 'BLR-DC', name: 'Bengaluru DC', origin: ADDRESSES.blrOrigin, gstin: GSTIN.blr });
    const wh: Warehouse = { id: idOf(res.body, 'warehouse'), code: 'BLR-DC', name: 'Bengaluru DC', bins: new Map(), ambient: [], chilled: [] };
    warehouses.set('BLR', wh);
    let n = await zoneWithGrid(wh, { code: 'A', name: 'Ambient racking A' }, { aisleFrom: 'A', aisleTo: 'B', baysPerAisle: 4, levelsPerBay: 3 });
    n += await zoneWithGrid(wh, { code: 'D', name: 'Dry goods D' }, { aisleFrom: 'D', aisleTo: 'D', baysPerAisle: 3, levelsPerBay: 2 });
    n += await zoneWithGrid(wh, { code: 'C', name: 'Cold room C' }, { aisleFrom: 'C', aisleTo: 'C', baysPerAisle: 2, levelsPerBay: 2, storageClass: 'chilled' });
    return `${n} bins`;
  });
  await step('Warehouse Mumbai FC (zone A ambient)', async () => {
    const res = await as('owner', 'POST', '/warehouses', { code: 'MUM-FC', name: 'Mumbai FC', origin: ADDRESSES.mumOrigin, gstin: GSTIN.mum });
    const wh: Warehouse = { id: idOf(res.body, 'warehouse'), code: 'MUM-FC', name: 'Mumbai FC', bins: new Map(), ambient: [], chilled: [] };
    warehouses.set('MUM', wh);
    const n = await zoneWithGrid(wh, { code: 'A', name: 'Fast movers A' }, { aisleFrom: 'A', aisleTo: 'A', baysPerAisle: 3, levelsPerBay: 2 });
    return `${n} bins`;
  });

  // ── 3. catalog ───────────────────────────────────────────────────────────
  say('\n3. Catalog');
  await step(`Product "${PRODUCT_NAME}" (variant axes size, colour)`, async () => {
    await as('owner', 'POST', '/catalog/products', { name: PRODUCT_NAME, axes: ['size', 'colour'] });
  });
  await step('Catalog CSV import (16 SKUs: kg, batch, serial, catch-weight, variants, kit, hazard)', async () => {
    return importCatalog(CATALOG_ROWS);
  });

  // ── 4. inbound ───────────────────────────────────────────────────────────
  say('\n4. Inbound');
  let vendorId: string | undefined;
  await step('Vendors', async () => {
    vendorId = idOf((await as('owner', 'POST', '/vendors', { code: 'V-KRISHNA', name: 'Krishna Agro Foods Pvt Ltd', isDefault: true })).body, 'vendor');
    await as('owner', 'POST', '/vendors', { code: 'V-VISTARA', name: 'Vistara Electronics Distributors' });
    return '2 vendors';
  });
  let poId: string | undefined;
  let poLines = new Map<string, string>(); // sku id → po line id
  await step('Purchase order PO-BLR-0001', async () => {
    const lines: [string, number, number][] = [
      ['RICE-BAS-1KG', 400, 9500],
      ['TURMERIC-200G', 300, 4200],
      ['SUGAR-LOOSE', 250.5, 4100],
      ['PANEER-200G', 120, 8000],
      ['VITC-TABS-60', 200, 15000],
      ['TV-LED-43', 12, 2250000],
      ['DETERGENT-1KG', 150, 11000],
      ['NOTEBOOK-A5', 200, 4500],
      ['BOTTLE-STEEL-1L', 120, 26000],
      ['TSHIRT-M-NAVY', 60, 18000],
      ['TSHIRT-L-NAVY', 60, 18000],
      ['TSHIRT-L-WHITE', 60, 18000],
    ];
    const res = await as('ops_manager', 'POST', '/inbound/purchase-orders', {
      warehouseId: BLR().id,
      vendorId: need(vendorId, 'vendor'),
      code: 'PO-BLR-0001',
      lines: lines.map(([code, orderedQty, unitCostPaise]) => ({ skuId: sku(code), orderedQty, unitCostPaise })),
    });
    const po = res.body.purchaseOrder ?? res.body;
    poId = po.id as string;
    poLines = new Map((po.lines as Json[]).map((l) => [l.skuId as string, l.id as string]));
    // A second, untouched PO so the PO list has an open one.
    await as('ops_manager', 'POST', '/inbound/purchase-orders', {
      warehouseId: MUM().id,
      vendorId: need(vendorId, 'vendor'),
      code: 'PO-MUM-0001',
      lines: [
        { skuId: sku('RICE-BAS-1KG'), orderedQty: 300, unitCostPaise: 9500 },
        { skuId: sku('DETERGENT-1KG'), orderedQty: 100, unitCostPaise: 11000 },
      ],
    });
    return `${lines.length} lines (+ PO-MUM-0001 left open)`;
  });

  await step('Enroll handheld "BLR Dock Scanner 1" + operator badge-in', async () => {
    const minted = await as('owner', 'POST', '/devices/enrollment-codes', {});
    deviceLabel = 'BLR Dock Scanner 1';
    const enrolled = await call('POST', `/tenants/${T()}/devices/enroll`, { body: { code: minted.body.code, label: deviceLabel, pin: DEVICE_PIN } });
    deviceToken = enrolled.body.deviceToken as string;
    const badge = await call('POST', `/tenants/${T()}/devices/badge-in`, {
      token: deviceToken,
      body: { operatorEmail: need(accounts.get('operator'), 'operator').email, pin: DEVICE_PIN },
      idempotent: false,
    });
    deviceSession = badge.body.accessToken as string;
  });

  const grnIds: string[] = [];
  await step('GRN against PO-BLR-0001 (batches, a short line, an over-receipt left pending)', async () => {
    const line = (code: string, qty: number, batch?: { code: string; mfg: string }) => ({
      poLineId: need(poLines.get(sku(code)), `PO line ${code}`),
      skuId: sku(code),
      batchCode: batch?.code ?? null,
      mfgDate: batch?.mfg ?? null,
      qty,
    });
    const res = await device('POST', '/receiving/goods-receipts', {
      warehouseId: BLR().id,
      poId: need(poId, 'PO'),
      occurredAt: nowUtc(),
      lines: [
        line('RICE-BAS-1KG', 400),
        line('TURMERIC-200G', 300),
        line('SUGAR-LOOSE', 250.5),
        line('PANEER-200G', 70, { code: 'PNR-2610A', mfg: isoDaysFromNow(-3) }),
        line('PANEER-200G', 50, { code: 'PNR-2610B', mfg: isoDaysFromNow(-1) }),
        line('VITC-TABS-60', 200, { code: 'VTC-2609', mfg: isoDaysFromNow(-40) }),
        line('TV-LED-43', 12),
        line('DETERGENT-1KG', 110),
        line('NOTEBOOK-A5', 220),
        line('BOTTLE-STEEL-1L', 120),
        line('TSHIRT-M-NAVY', 60),
        line('TSHIRT-L-NAVY', 60),
        line('TSHIRT-L-WHITE', 60),
      ],
    });
    const grn = res.body.goodsReceipt ?? res.body;
    grnIds.push(grn.id);
    const excess = (grn.lines as Json[]).filter((l) => Number(l.excessQty) > 0).length;
    return `${grn.code}, ${(grn.lines as Json[]).length} lines, ${excess} over-receipt pending review, detergent short by 40`;
  });

  await step('Blind receipt (unannounced: catch-weight cheese cases + sanitizer)', async () => {
    const weights = [4820, 5110, 4975, 5230, 4890, 5045];
    const res = await device('POST', '/receiving/goods-receipts', {
      warehouseId: BLR().id,
      poId: null,
      blindReasonCode: 'unannounced-delivery',
      occurredAt: nowUtc(),
      lines: [
        { poLineId: null, skuId: sku('CHEESE-WHEEL'), batchCode: null, mfgDate: null, qty: weights.length, weightsGrams: weights },
        { poLineId: null, skuId: sku('SANITIZER-5L'), batchCode: null, mfgDate: null, qty: 40 },
      ],
    });
    const grn = res.body.goodsReceipt ?? res.body;
    grnIds.push(grn.id);
    const cases = ((grn.lines as Json[]).find((l) => l.skuId === sku('CHEESE-WHEEL'))?.handlingUnitIds ?? []) as string[];
    return `${grn.code}, ${cases.length} cheese cases weighed (${weights.join('/')} g)`;
  });

  await step('Putaway (device) — everything but the detergent line', async () => {
    const tasks = (await as('owner', 'GET', `/putaway/tasks?warehouseId=${BLR().id}`)).body.items as Json[];
    let placed = 0;
    const failures: string[] = [];
    for (const task of tasks) {
      const code = skuCode.get(task.skuId) ?? task.skuCode;
      if (code === 'DETERGENT-1KG') continue; // left as open putaway work
      try {
        await putAway(task, code);
        placed++;
      } catch (error) {
        failures.push(`${code}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (placed === 0) throw new Error(`no placement succeeded: ${failures.slice(0, 3).join(' | ')}`);
    if (failures.length > 0) throw new Error(`${placed} placed, ${failures.length} failed: ${failures.join(' | ')}`);
    return `${placed} tasks placed, one SKU per bin; detergent left as open putaway work`;
  });

  await step('QC hold on the sanitizer stock', async () => {
    const binCode = need(homeBin.get('SANITIZER-5L'), 'sanitizer bin');
    await as('ops_manager', 'POST', '/receiving/qc-holds', {
      warehouseId: BLR().id,
      skuId: sku('SANITIZER-5L'),
      binId: bin(BLR(), binCode),
      reason: 'Leaking caps on 3 cartons — awaiting supplier inspection',
    });
    return `bin ${binCode}`;
  });

  // ── 5a. stock intake by adjustment (serials, near-expiry batch) ─────────
  say('\n5. Inventory');
  await step('Serial intake: 6 Redix X1 phones (one serial per unit)', async () => {
    const binCode = assignBin('PHONE-RDX-X1');
    await as('ops_manager', 'POST', '/inventory/adjustments', {
      warehouseId: BLR().id,
      skuId: sku('PHONE-RDX-X1'),
      binId: bin(BLR(), binCode),
      quantityDelta: PHONE_SERIALS.length,
      reasonCode: 'stock-count',
      note: 'Opening stock — serialised handsets',
      serials: PHONE_SERIALS,
    });
    return `bin ${binCode}`;
  });
  await step('Near-expiry batch: Vitamin C VTC-2511 expiring in 20 days', async () => {
    const binCode = need(homeBin.get('VITC-TABS-60'), 'vitamin C bin');
    await as('ops_manager', 'POST', '/inventory/adjustments', {
      warehouseId: BLR().id,
      skuId: sku('VITC-TABS-60'),
      binId: bin(BLR(), binCode),
      quantityDelta: 40,
      reasonCode: 'found',
      note: 'Older lot found during aisle walk',
      batch: { code: 'VTC-2511', mfgDate: isoDaysFromNow(-345), expiryDate: isoDaysFromNow(20) },
    });
  });

  // ── 6. outbound ──────────────────────────────────────────────────────────
  say('\n6. Outbound');
  await step('Carrier connection (sandbox carrier)', async () => {
    const res = await as('owner', 'POST', '/carriers/connections', { carrierCode: 'sandbox', accountLabel: 'Sandbox Express (demo)', credential: { accountToken: 'demo-sandbox-token' } });
    carrierConnectionId = idOf(res.body, 'connection');
  });
  await step('Wave policies', async () => {
    const res = await as('ops_manager', 'POST', '/outbound/wave-policies', { warehouseId: BLR().id, name: 'Standard — single order', grouping: 'single', priority: 1 });
    wavePolicyId = idOf(res.body, 'policy');
    await as('ops_manager', 'POST', '/outbound/wave-policies', { warehouseId: BLR().id, name: 'Evening batch (18:00 cutoff)', grouping: 'batch', maxOrders: 20, cutoffLocalTime: '18:00' });
    await as('ops_manager', 'POST', '/outbound/wave-policies', { warehouseId: MUM().id, name: 'Mumbai — single order', grouping: 'single' });
  });

  const c = ADDRESSES.customers;
  const specs: OrderSpec[] = [
    { label: 'SO-1 grocery + phone (→ dispatched, returned)', wh: BLR, destination: c[0]!, lines: [{ code: 'RICE-BAS-1KG', quantity: 5, ratePaise: 14900 }, { code: 'TURMERIC-200G', quantity: 2, ratePaise: 6500 }, { code: 'PHONE-RDX-X1', quantity: 1, ratePaise: 1899900 }] },
    { label: 'SO-2 2× TV to Mumbai B2B (→ dispatched, e-way)', wh: BLR, destination: c[1]!, consigneeGstin: GSTIN.buyerMum, consigneeLegalName: 'Sharma Electronics Pvt Ltd', lines: [{ code: 'TV-LED-43', quantity: 2, ratePaise: 3149900 }] },
    { label: 'SO-3 T-shirts + festive hamper kit (→ dispatched)', wh: BLR, destination: c[2]!, lines: [{ code: 'TSHIRT-M-NAVY', quantity: 2, ratePaise: 49900 }, { code: 'TSHIRT-L-WHITE', quantity: 1, ratePaise: 49900 }, { code: 'HAMPER-FESTIVE', quantity: 1, ratePaise: 129900 }] },
    { label: 'SO-4 paneer + sugar (→ packed + labelled, ready to dispatch)', wh: BLR, destination: c[3]!, lines: [{ code: 'PANEER-200G', quantity: 6, ratePaise: 9500 }, { code: 'SUGAR-LOOSE', quantity: 2.5, ratePaise: 4800 }] },
    { label: 'SO-5 bottles + notebooks (→ picked, not packed)', wh: BLR, destination: c[4]!, lines: [{ code: 'BOTTLE-STEEL-1L', quantity: 3, ratePaise: 59900 }, { code: 'NOTEBOOK-A5', quantity: 10, ratePaise: 7500 }] },
    { label: 'SO-6 rice bulk (→ in a planned wave)', wh: BLR, destination: c[5]!, lines: [{ code: 'RICE-BAS-1KG', quantity: 20, ratePaise: 14500 }] },
    { label: 'SO-7 vitamins (→ accepted)', wh: BLR, destination: c[6]!, lines: [{ code: 'VITC-TABS-60', quantity: 4, ratePaise: 34900 }] },
    { label: 'SO-8 15× TV (→ backordered)', wh: BLR, destination: c[7]!, lines: [{ code: 'TV-LED-43', quantity: 15, ratePaise: 3149900 }] },
  ];
  await step(`Orders (${specs.length}, manual entry)`, async () => {
    const outcomes: string[] = [];
    for (const spec of specs) outcomes.push(`${spec.label.split(' ')[0]}:${await createOrder(spec)}`);
    return outcomes.join(', ');
  });

  let mainWave: Json;
  await step('Wave for SO-1..SO-5 generated and released', async () => {
    const ids = ['SO-1', 'SO-2', 'SO-3', 'SO-4', 'SO-5'].map((p) => orderId(need([...orders.keys()].find((k) => k.startsWith(`${p} `)), p)));
    const created = await as('ops_manager', 'POST', '/outbound/waves', { warehouseId: BLR().id, policyId: need(wavePolicyId, 'wave policy'), orderIds: ids });
    const waveId = idOf(created.body, 'wave');
    await as('ops_manager', 'POST', `/outbound/waves/${waveId}/release`, {});
    mainWave = (await as('owner', 'GET', `/outbound/waves/${waveId}`)).body.wave;
    return `${(mainWave.picklists as Json[]).length} picklists`;
  });

  const label = (prefix: string): string => need([...orders.keys()].find((k) => k.startsWith(`${prefix} `)), prefix);
  const picklistOf = (prefix: string): Json => {
    const id = orderId(label(prefix));
    return need((need(mainWave, 'released wave').picklists as Json[]).find((p) => p.orderId === id || (p.lines as Json[]).some((l) => l.orderId === id)), `picklist of ${prefix}`);
  };

  await step('Picks on the handheld (SO-1..SO-5, incl. a serial pick)', async () => {
    const pool = [...PHONE_SERIALS];
    let lines = 0;
    for (const p of ['SO-1', 'SO-2', 'SO-3', 'SO-4', 'SO-5']) lines += await pickPicklist(picklistOf(p), BLR().id, pool);
    return `${lines} pick lines confirmed`;
  });

  await step('Pack SO-1..SO-4', async () => {
    for (const p of ['SO-1', 'SO-2', 'SO-3', 'SO-4']) {
      await as('ops_manager', 'POST', `/outbound/orders/${orderId(label(p))}/pack`, { scanned: scannedOf(picklistOf(p)), weightGrams: 2500, dimensionsMm: { lengthMm: 400, widthMm: 300, heightMm: 250 } });
    }
  });

  await step('Labels via the sandbox carrier (SO-1..SO-4)', async () => {
    for (const p of ['SO-1', 'SO-2', 'SO-3', 'SO-4']) {
      await as('ops_manager', 'POST', `/outbound/orders/${orderId(label(p))}/label`, {
        carrierConnectionId: need(carrierConnectionId, 'carrier connection'),
        weightGrams: p === 'SO-2' ? 19000 : 2500,
        dimensionsMm: p === 'SO-2' ? { lengthMm: 1100, widthMm: 180, heightMm: 700 } : { lengthMm: 400, widthMm: 300, heightMm: 250 },
      });
    }
  });

  await step('Dispatch SO-1, SO-2, SO-3', async () => {
    for (const p of ['SO-1', 'SO-2', 'SO-3']) await as('ops_manager', 'POST', `/outbound/orders/${orderId(label(p))}/dispatch`, {});
  });

  await step('Manifest for the dispatched shipments', async () => {
    const shipmentIds: string[] = [];
    for (const p of ['SO-1', 'SO-2', 'SO-3']) {
      const res = await as('owner', 'GET', `/outbound/orders/${orderId(label(p))}/shipment`);
      shipmentIds.push(idOf(res.body, 'shipment'));
    }
    const res = await as('ops_manager', 'POST', `/warehouses/${BLR().id}/outbound/manifests`, { shipmentIds });
    return `${shipmentIds.length} shipments${res.body.manifest?.code ? ` (${res.body.manifest.code})` : ''}`;
  });

  await step('Second wave with SO-6, left planned (not released)', async () => {
    await as('ops_manager', 'POST', '/outbound/waves', { warehouseId: BLR().id, policyId: need(wavePolicyId, 'wave policy'), orderIds: [orderId(label('SO-6'))] });
  });

  // ── 5b. inventory controls (after the picks, so they never block them) ──
  say('\n5b. Inventory controls');
  await step('Immediate adjustment: 3 rice bags damaged', async () => {
    const res = await as('ops_manager', 'POST', '/inventory/adjustments', {
      warehouseId: BLR().id,
      skuId: sku('RICE-BAS-1KG'),
      binId: bin(BLR(), need(homeBin.get('RICE-BAS-1KG'), 'rice bin')),
      quantityDelta: -3,
      reasonCode: 'damaged',
      note: 'Torn bags found at the pick face',
    });
    return `HTTP ${res.status}`;
  });
  await step('Adjustment approval threshold = 100 units', async () => {
    await as('owner', 'PUT', '/inventory/adjustment-policies', { quantityThreshold: 100 });
  });
  await step('Two over-threshold adjustments left PENDING owner approval', async () => {
    const a = await as('ops_manager', 'POST', '/inventory/adjustments', {
      warehouseId: BLR().id,
      skuId: sku('TURMERIC-200G'),
      binId: bin(BLR(), need(homeBin.get('TURMERIC-200G'), 'turmeric bin')),
      quantityDelta: 150,
      reasonCode: 'found',
      note: 'Unrecorded pallet found behind racking B-03',
    });
    const b = await as('ops_manager', 'POST', '/inventory/adjustments', {
      warehouseId: BLR().id,
      skuId: sku('NOTEBOOK-A5'),
      binId: bin(BLR(), need(homeBin.get('NOTEBOOK-A5'), 'notebook bin')),
      quantityDelta: -120,
      reasonCode: 'shrinkage',
      note: 'Cycle count shortfall — suspected mis-ship',
    });
    if (a.status !== 202 || b.status !== 202) throw new Error(`expected 202 pend, got ${a.status}/${b.status}`);
    return 'both 202 (pending)';
  });

  await step('Count task on the turmeric bin, submitted with a variance', async () => {
    const binId = bin(BLR(), need(homeBin.get('TURMERIC-200G'), 'turmeric bin'));
    const res = await as('ops_manager', 'POST', '/movements/counts', { warehouseId: BLR().id, binId });
    const task = res.body.task ?? res.body.countTask ?? res.body;
    // The count is blind — the task carries no expected quantities — so read
    // the bin's on-hand from the stock projection and count every SKU in it,
    // turmeric 4 short. (Submitting 0 here recorded a −297 variance.)
    const stock = await as('ops_manager', 'GET', `/warehouses/${BLR().id}/inventory/stock?binId=${binId}&limit=200`);
    const onHand = ((stock.body.items ?? []) as Json[]).filter((e) => Number(e.quantity) > 0);
    const turmeric = onHand.find((e) => e.skuId === sku('TURMERIC-200G'));
    if (turmeric === undefined) throw new Error('no turmeric on hand in its bin to count');
    const counted = onHand.map((e) => ({
      skuId: e.skuId,
      countedQuantity: Math.max(0, Number(e.quantity) - (e.skuId === sku('TURMERIC-200G') ? 4 : 0)),
    }));
    await device('POST', `/movements/counts/${task.id}/submit`, { lines: counted });
    return `turmeric counted ${Number(turmeric.quantity) - 4} of ${Number(turmeric.quantity)} (4 short)`;
  });
  await step('Count task on the bottle bin, left open for the handheld', async () => {
    await as('ops_manager', 'POST', '/movements/counts', { warehouseId: BLR().id, binId: bin(BLR(), need(homeBin.get('BOTTLE-STEEL-1L'), 'bottle bin')) });
  });

  await step('Transfer BLR → MUM received (turmeric + rice)', async () => {
    const res = await as('ops_manager', 'POST', '/movements/transfers', {
      sourceWarehouseId: BLR().id,
      destWarehouseId: MUM().id,
      note: 'Stock rebalancing for Mumbai demand',
      lines: [
        { skuId: sku('TURMERIC-200G'), quantity: 40, fromBinId: bin(BLR(), need(homeBin.get('TURMERIC-200G'), 'turmeric bin')), toBinId: bin(MUM(), MUM().ambient[0]!) },
        { skuId: sku('RICE-BAS-1KG'), quantity: 60, fromBinId: bin(BLR(), need(homeBin.get('RICE-BAS-1KG'), 'rice bin')), toBinId: bin(MUM(), MUM().ambient[1]!) },
      ],
    });
    const transferId = idOf(res.body, 'transfer');
    await as('ops_manager', 'POST', `/movements/transfers/${transferId}/outbound-confirm`, {});
    await device('POST', `/movements/transfers/${transferId}/inbound-confirm`, {});
    return 'received in Mumbai';
  });
  await step('Transfer BLR → MUM left in transit (T-shirts)', async () => {
    const res = await as('ops_manager', 'POST', '/movements/transfers', {
      sourceWarehouseId: BLR().id,
      destWarehouseId: MUM().id,
      lines: [{ skuId: sku('TSHIRT-L-NAVY'), quantity: 20, fromBinId: bin(BLR(), need(homeBin.get('TSHIRT-L-NAVY'), 't-shirt bin')), toBinId: bin(MUM(), MUM().ambient[2]!) }],
    });
    await as('ops_manager', 'POST', `/movements/transfers/${idOf(res.body, 'transfer')}/outbound-confirm`, {});
  });
  await step('Mumbai order (accepted, from transferred stock)', async () => {
    return createOrder({ label: 'SO-9 Mumbai turmeric (→ accepted)', wh: MUM, destination: c[1]!, lines: [{ code: 'TURMERIC-200G', quantity: 6, ratePaise: 6500 }] });
  });

  await step('Temperature excursion on the paneer bin (9.5 °C)', async () => {
    const binCode = need(homeBin.get('PANEER-200G'), 'paneer bin');
    await as('ops_manager', 'POST', '/excursions', { warehouseId: BLR().id, binId: bin(BLR(), binCode), readingC: 9.5, note: 'Reefer door left open during unloading' });
    return `bin ${binCode}`;
  });

  // ── 7. invoicing ─────────────────────────────────────────────────────────
  say('\n7. Invoicing');
  let invoices: Json[] = [];
  await step('GST invoices raised by the dispatch handler (outbox)', async () => {
    for (let i = 0; i < 20; i++) {
      invoices = (await as('accountant', 'GET', '/invoices?limit=50')).body.items as Json[];
      if (invoices.length >= 3) break;
      await sleep(1500);
    }
    if (invoices.length === 0) throw new Error('no invoice appeared within 30 s — is OUTBOX_RELAY_POLL_MS set on the backend?');
    return invoices.map((inv) => `${inv.invoiceNo ?? '(unnumbered)'} ${inv.status}`).join(', ');
  });
  await step('Price the kit order\'s component lines (kit invoices park awaiting-data — known, PENDING.md)', async () => {
    const parked = invoices.filter((inv) => inv.status === 'awaiting-data');
    if (parked.length === 0) return 'nothing parked';
    const componentRates: Record<string, number> = { 'RICE-BAS-1KG': 42000, 'TURMERIC-200G': 15000, 'BOTTLE-STEEL-1L': 57900 };
    const issued: string[] = [];
    for (const inv of parked) {
      const detail = (await as('accountant', 'GET', `/invoices/${inv.id}`)).body.invoice;
      const gaps = ((detail.document?.gaps ?? detail.gaps ?? []) as Json[]).filter((g) => g.kind === 'unpriced-line');
      const rates = gaps.map((g) => {
        const code = /line (\S+) \(/.exec(String(g.detail))?.[1] ?? '';
        return { orderLineId: g.orderLineId as string, ratePaise: componentRates[code] ?? 10000 };
      });
      const res = await as('ops_manager', 'POST', '/invoices', { orderId: inv.orderId, rates });
      const after = res.body.invoice ?? res.body;
      issued.push(`${after.invoiceNo ?? '(unnumbered)'} ${after.status}`);
    }
    invoices = (await as('accountant', 'GET', '/invoices?limit=50')).body.items as Json[];
    return issued.join(', ');
  });
  await step('E-way bill for SO-2: Part B + generate via the sandbox gateway', async () => {
    let bills: Json[] = [];
    for (let i = 0; i < 15; i++) {
      bills = (await as('accountant', 'GET', '/eway/bills?limit=50')).body.items as Json[];
      if (bills.length > 0) break;
      await sleep(1500);
    }
    const bill = need(bills[0], 'a queued e-way bill (needs the invoice issued and OUTBOX_RELAY_POLL_MS)');
    await as('accountant', 'PATCH', `/eway/bills/${bill.id}/transport`, { transMode: 1, vehicleNo: 'KA01AB1234', vehicleType: 'R', distanceKm: 985, transporterName: 'Sandbox Express' });
    try {
      const generated = await as('accountant', 'POST', `/eway/bills/${bill.id}/generate`, {});
      return `EWB ${generated.body.bill?.ewbNo ?? generated.body.ewbNo ?? 'generated'}`;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return `queued with Part B; generate refused (${error.body?.code}) — set EWAY_GATEWAY=sandbox to generate`;
      throw error;
    }
  });

  // ── 8. returns ───────────────────────────────────────────────────────────
  say('\n8. Returns');
  let rmaId: string | undefined;
  let rmaLines: Json[] = [];
  await step('Return authorization on SO-1 (2 rice + the phone)', async () => {
    const id = orderId(label('SO-1'));
    const returnable = (await as('owner', 'GET', `/returns/returnable?orderId=${id}`)).body;
    const lineOf = (code: string): Json => need((returnable.lines as Json[]).find((l) => l.skuId === sku(code)), `${code} returnable line`);
    const phone = lineOf('PHONE-RDX-X1');
    const res = await as('ops_manager', 'POST', '/returns', {
      orderId: id,
      externalReference: 'CS-TICKET-40417',
      lines: [
        { orderLineId: lineOf('RICE-BAS-1KG').orderLineId, qty: 2, reasonCode: 'damaged', reasonNote: 'Bags torn in transit' },
        { orderLineId: phone.orderLineId, qty: 1, reasonCode: 'defective', reasonNote: 'Screen flickers', serialNumbers: [(phone.returnableSerials as Json[])[0]?.serialNumber ?? PHONE_SERIALS[0]] },
      ],
    });
    rmaId = res.body.id as string;
    rmaLines = res.body.lines as Json[];
    return res.body.code as string;
  });
  await step('Return receipt on the handheld (graded; one stray unit refused to review)', async () => {
    const rice = need(rmaLines.find((l) => l.skuId === sku('RICE-BAS-1KG')), 'rice RMA line');
    const phone = need(rmaLines.find((l) => l.skuId === sku('PHONE-RDX-X1')), 'phone RMA line');
    const res = await device('POST', '/returns/receipts', {
      warehouseId: BLR().id,
      rmaId: need(rmaId, 'RMA'),
      occurredAt: nowUtc(),
      entries: [
        { rmaLineId: rice.id, skuId: sku('RICE-BAS-1KG'), qty: 1, condition: 'resaleable', note: 'Outer bag intact' },
        { rmaLineId: rice.id, skuId: sku('RICE-BAS-1KG'), qty: 1, condition: 'damaged', note: 'Torn, spilled' },
        { rmaLineId: phone.id, skuId: sku('PHONE-RDX-X1'), qty: 1, condition: 'opened', serialNumber: (phone.serials as Json[])[0]?.serialNumber },
        { rmaLineId: null, skuId: sku('TURMERIC-200G'), qty: 1, condition: 'resaleable', note: 'Not on the RMA — found in the parcel' },
      ],
    });
    return `${res.body.code ?? 'no receipt'}: ${(res.body.applied as Json[]).length} applied, ${(res.body.refused as Json[]).length} refused → review (${res.body.rmaStatus})`;
  });
  await step('Second RMA on SO-3 left open (awaiting the parcel)', async () => {
    const id = orderId(label('SO-3'));
    const returnable = (await as('owner', 'GET', `/returns/returnable?orderId=${id}`)).body;
    const line = need((returnable.lines as Json[]).find((l) => l.skuId === sku('TSHIRT-M-NAVY')), 'T-shirt returnable line');
    const res = await as('ops_manager', 'POST', '/returns', { orderId: id, lines: [{ orderLineId: line.orderLineId, qty: 1, reasonCode: 'wrong-item', reasonNote: 'Customer ordered L' }] });
    return res.body.code as string;
  });

  // ── 9. 3PL ───────────────────────────────────────────────────────────────
  say('\n9. 3PL client brand');
  await step('Client brand GlowCo Cosmetics + tax details', async () => {
    const res = await as('owner', 'POST', '/clients', { code: 'GLOWCO', name: 'GlowCo Cosmetics' });
    clientId = idOf(res.body, 'client');
    await as('owner', 'PATCH', `/clients/${clientId}/tax-details`, {
      legalName: 'GlowCo Cosmetics Pvt Ltd',
      gstin: GSTIN.client,
      billingLine1: '3rd Floor, Prestige Atrium, Residency Road',
      billingCity: 'Bengaluru',
      billingStateCode: '29',
      billingPincode: '560025',
    });
  });
  await step('Client catalog import (3 GlowCo SKUs)', async () => importCatalog(CLIENT_CATALOG_ROWS, need(clientId, 'client')));
  await step('Rate card drafted and activated from today (IST)', async () => {
    const res = await as('owner', 'POST', `/clients/${need(clientId, 'client')}/rate-cards`, {
      lines: [
        { chargeCode: 'storage', basis: 'per_thousand_units_per_day', amountPaise: 4500 },
        { chargeCode: 'inbound_handling', basis: 'per_receipt_line', amountPaise: 2500 },
        { chargeCode: 'pick', basis: 'per_pick', amountPaise: 350 },
        { chargeCode: 'outbound_handling', basis: 'per_order', amountPaise: 2000 },
      ],
    });
    const cardId = idOf(res.body, 'rateCard');
    await as('owner', 'POST', `/rate-cards/${cardId}/activate`, { effectiveFrom: istDate(0) });
    return `effective ${istDate(0)}`;
  });
  let asnId: string | undefined;
  await step('ASN from GlowCo, received in part on the handheld + put away', async () => {
    const res = await as('ops_manager', 'POST', '/inbound/asns', {
      clientId: need(clientId, 'client'),
      warehouseId: BLR().id,
      asnCode: 'GLOW-ASN-001',
      expectedAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
      lines: [
        { skuId: sku('GLOW-SERUM-30'), announcedQty: 300 },
        { skuId: sku('GLOW-SPF50-50'), announcedQty: 200 },
        { skuId: sku('GLOW-LIPBALM'), announcedQty: 500 },
      ],
    });
    const asn = res.body.asn ?? res.body;
    asnId = asn.id as string;
    const asnLines = asn.lines as Json[];
    const lineFor = (code: string): string => need(asnLines.find((l) => l.skuId === sku(code)), `ASN line ${code}`).id;
    const grn = await device('POST', '/receiving/goods-receipts', {
      warehouseId: BLR().id,
      asnId,
      occurredAt: nowUtc(),
      lines: [
        { poLineId: null, asnLineId: lineFor('GLOW-SERUM-30'), skuId: sku('GLOW-SERUM-30'), batchCode: null, mfgDate: null, qty: 300 },
        { poLineId: null, asnLineId: lineFor('GLOW-SPF50-50'), skuId: sku('GLOW-SPF50-50'), batchCode: null, mfgDate: null, qty: 150 },
      ],
    });
    const receipt = grn.body.goodsReceipt ?? grn.body;
    const tasks = ((await as('owner', 'GET', `/putaway/tasks?warehouseId=${BLR().id}`)).body.items as Json[]).filter((t) => t.grnId === receipt.id);
    for (const task of tasks) await putAway(task, skuCode.get(task.skuId) ?? task.skuCode);
    return `${receipt.code}: serum 300/300, sunscreen 150/200, lip balm 0/500 → partially received`;
  });
  await step('GlowCo order picked, packed, labelled and dispatched', async () => {
    await createOrder({ label: 'GL-1 GlowCo D2C order (→ dispatched)', wh: BLR, destination: c[5]!, lines: [{ code: 'GLOW-SERUM-30', quantity: 3, ratePaise: 59900 }, { code: 'GLOW-SPF50-50', quantity: 2, ratePaise: 44900 }] });
    const id = orderId(label('GL-1'));
    const created = await as('ops_manager', 'POST', '/outbound/waves', { warehouseId: BLR().id, policyId: need(wavePolicyId, 'wave policy'), orderIds: [id] });
    const waveId = idOf(created.body, 'wave');
    await as('ops_manager', 'POST', `/outbound/waves/${waveId}/release`, {});
    const wave = (await as('owner', 'GET', `/outbound/waves/${waveId}`)).body.wave;
    const picklist = (wave.picklists as Json[])[0];
    await pickPicklist(picklist, BLR().id, []);
    await as('ops_manager', 'POST', `/outbound/orders/${id}/pack`, { scanned: scannedOf(picklist) });
    await as('ops_manager', 'POST', `/outbound/orders/${id}/label`, { carrierConnectionId: need(carrierConnectionId, 'carrier connection'), weightGrams: 600 });
    await as('ops_manager', 'POST', `/outbound/orders/${id}/dispatch`, {});
  });
  await step('Client-portal user for GlowCo', async () => {
    const email = emailOf('glowco-portal');
    const invited = await as('owner', 'POST', '/users', { email, role: 'client', clientId: need(clientId, 'client') });
    await call('POST', `/tenants/${T()}/accept-invite`, { body: { token: invited.body.inviteToken, password: PASSWORD } });
    accounts.set('client (GlowCo portal)', { role: 'client (GlowCo portal)', email, token: '', signedInAt: 0 });
    return email;
  });

  // ── 10. alerts, policies, exports ────────────────────────────────────────
  say('\n10. Alerts, policies and the rest');
  await step('Replenishment override: Mumbai turmeric reorder point 50', async () => {
    await as('ops_manager', 'PUT', '/replenishment/policies', { warehouseId: MUM().id, skuId: sku('TURMERIC-200G'), reorderPoint: 50, reorderQty: 200 });
  });
  await step('Expiry / aging alert policy (30-day lead, 90-day aging)', async () => {
    await as('ops_manager', 'PUT', '/replenishment/expiry-policies', { expiryLeadDays: 30, agingThresholdDays: 90 });
  });
  await step('Audit trail export requested (owner)', async () => {
    const res = await as('owner', 'POST', '/reporting/audit/exports', {});
    return `status ${res.body.status ?? res.status}`;
  });
  await step('Reorder breaches raised by the replenishment scheduler', async () => {
    for (let i = 0; i < 30; i++) {
      const items = (await as('owner', 'GET', '/replenishment/breaches?status=open')).body.items as Json[];
      const whCode = (id: string): string => [...warehouses.values()].find((w) => w.id === id)?.code ?? id;
      if (items.length > 0) return `${items.length} open breach(es): ${items.map((b) => `${skuCode.get(b.skuId) ?? b.skuId}@${whCode(b.warehouseId)}`).join(', ')}`;
      await sleep(3000);
    }
    throw new Error('none observed within 90 s — set REPLENISHMENT_SCHEDULER_POLL_MS (e.g. 15000) on the backend; they appear on its next tick');
  });
  await step('Batch alerts (near-expiry Vitamin C lot)', async () => {
    for (let i = 0; i < 10; i++) {
      const items = (await as('owner', 'GET', '/replenishment/batch-alerts?status=open')).body.items as Json[];
      if (items.length > 0) return `${items.length} open alert(s): ${items.map((a) => a.kind).join(', ')}`;
      await sleep(3000);
    }
    throw new Error('none observed within 30 s — raised on the replenishment scheduler\'s next tick (REPLENISHMENT_SCHEDULER_POLL_MS)');
  });
  let pairingCode: { code: string; expiresAt: string } | undefined;
  await step('Fresh enrollment code for pairing a real handheld', async () => {
    const res = await as('owner', 'POST', '/devices/enrollment-codes', {});
    pairingCode = { code: res.body.code, expiresAt: res.body.expiresAt };
  });

  // ── summary ──────────────────────────────────────────────────────────────
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => !r.ok);
  say('');
  say('════════════════════════════════════════════════════════════════════════');
  say(' WMS DEMO TENANT READY');
  say('════════════════════════════════════════════════════════════════════════');
  say(` Web app     ${WEB_URL}`);
  say(` API         ${BASE_URL}`);
  say(` Tenant      ${TENANT_NAME}`);
  say(` Tenant id   ${tenantId ?? '(not created)'}`);
  say(` Warehouses  ${[...warehouses.values()].map((w) => `${w.name} (${w.code})`).join(', ') || '(none)'}`);
  if (clientId) say(` 3PL client  GlowCo Cosmetics (GLOWCO) — the tenant's own goods stay on its "self" client`);
  say('');
  say(` Logins (password for every account: ${PASSWORD})`);
  for (const account of accounts.values()) say(`   ${account.role.padEnd(24)} ${account.email}`);
  // Story 6-1b — the owner signs in with a second factor: add this to an
  // authenticator app (the URI as a QR code, or type the secret).
  const ownerEnrolment = accounts.has('owner') ? enrolmentOf(accounts.get('owner')!.email) : null;
  if (ownerEnrolment !== null) {
    say('');
    say(' Owner two-factor sign-in (authenticator app)');
    say(`   otpauth URI   ${ownerEnrolment.otpauthUri}`);
    say(`   Secret        ${ownerEnrolment.secret}`);
    say(`   Backup codes  ${ownerEnrolment.backupCodes.join('  ')}`);
  }
  say('');
  say(' Handheld (wms-mobile)');
  if (deviceLabel) say(`   Enrolled demo device "${deviceLabel}" — badge in with an operator email + PIN ${DEVICE_PIN}`);
  if (pairingCode) {
    say(`   Pair a new handheld with enrollment code: ${pairingCode.code}`);
    say(`   (one-time, expires ${pairingCode.expiresAt} — 15 min; mint another in web Settings → Devices)`);
    say(`   Choose your own PIN at enrollment; badge in as ${accounts.get('operator')?.email ?? 'the operator'}`);
  }
  say('');
  say(` Steps: ${ok} OK, ${skipped.length} SKIPPED`);
  for (const r of results) say(`   [${r.ok ? 'OK' : 'SKIPPED'}] ${r.name}${r.ok ? '' : ` — ${r.note}`}`);
  say('════════════════════════════════════════════════════════════════════════');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
