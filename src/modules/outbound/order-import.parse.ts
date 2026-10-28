import { createHash } from 'node:crypto';
import { importTooLarge, type SheetRow } from '../../shared/import/sheet-reader';
import { isQuantityText } from '../../shared/import/quantity-cell';
import { decimalRupeesToPaise } from '../../shared/primitives/money';
import { isIsoDate } from '../../shared/primitives/time';
import { normalizeClientOrderRef } from './order.command';

/**
 * The order import's pure half (story 4-1c): the file's column contract per
 * surface, the caps, the row-error vocabulary, reading and refusing cells,
 * grouping rows into orders by client order number, merging each order's
 * per-order cells, and the derived per-order idempotency key. No database —
 * `order-import.command.ts` does the lookups and hands every order to the
 * one-at-a-time create.
 */

// ── the file contract ────────────────────────────────────────────────────────

/** Which route the file came in on: the staff Outbound import or the client portal's. */
export const ORDER_IMPORT_SURFACES = ['staff', 'portal'] as const;
export type OrderImportSurface = (typeof ORDER_IMPORT_SURFACES)[number];

/** The per-line columns (staff: `rate` too). */
const LINE_COLUMNS = ['sku', 'quantity'] as const;

/**
 * The per-order columns, after `order_ref` (and, staff only, `client`). An
 * order's rows may repeat each or leave it blank after the first (decision 8).
 */
export const ORDER_IMPORT_ORDER_CELLS = [
  'ship_to_name',
  'ship_to_phone',
  'ship_to_line1',
  'ship_to_line2',
  'ship_to_city',
  'ship_to_state',
  'ship_to_pincode',
  'consignee_gstin',
  'consignee_legal_name',
  'order_type',
  'priority',
  'ship_by',
  'cod_amount',
] as const;
export type OrderImportOrderCell = (typeof ORDER_IMPORT_ORDER_CELLS)[number];

/**
 * Every column each surface reads (case-insensitive, any order; anything else
 * is ignored). The portal has no `client` (the client is the session's) and
 * no `rate` (a portal line carries none, 4-1a) — a portal file carrying either
 * column has it ignored like any unknown column.
 */
export const ORDER_IMPORT_COLUMNS: Readonly<Record<OrderImportSurface, readonly string[]>> = {
  staff: [...LINE_COLUMNS, 'rate', 'order_ref', 'client', 'warehouse', ...ORDER_IMPORT_ORDER_CELLS],
  portal: [...LINE_COLUMNS, 'order_ref', 'warehouse', ...ORDER_IMPORT_ORDER_CELLS],
};

/** The per-order cells an order must carry on at least one of its rows. */
const REQUIRED_ORDER_CELLS: readonly OrderImportOrderCell[] = [
  'ship_to_name',
  'ship_to_phone',
  'ship_to_line1',
  'ship_to_city',
  'ship_to_state',
  'ship_to_pincode',
];

/** The header must carry these (400 `missing-columns`, naming each one absent). */
export const ORDER_IMPORT_REQUIRED_COLUMNS: readonly string[] = ['sku', 'quantity', 'order_ref', ...REQUIRED_ORDER_CELLS];

/**
 * The caps (decision 6, A3): every order is several transactions and a grant
 * per line, all inside one HTTP request. Decision 6's rule — "if the worst
 * case does not finish, the caps are lowered, never the time" — set them: on
 * a local stack an order costs about 75 ms plus about 50 ms per line (a
 * 10-line `createOrder` measured 0.53 s), so the spec's first 2,000 rows /
 * 200 orders took five 15-second Imports. At 300 rows / 100 orders the worst
 * case is about 22 s of work — two Imports, the second completing it
 * (pinned by test/order-import.spec.ts). A bigger file is split, or waits for
 * the async import (PENDING). The 200-line order cap is the create's own
 * (`MAX_ORDER_LINES`), enforced here because the command checks only "at
 * least one line"; an order over it is the row error `too-many-lines`.
 */
export const MAX_ORDER_IMPORT_ROWS = 300;
export const MAX_ORDER_IMPORT_ORDERS = 100;
/** `MAX_ORDER_LINES` (outbound.dto) — restated, since the DTO file imports this one; the unit spec pins them equal. */
export const MAX_ORDER_IMPORT_LINES = 200;

/**
 * The closed vocabulary of a refused row's reason (A6) — published as the
 * response DTO's enum, so the web's labels are a `Record` over it.
 *
 * - the file's: `missing-value` … `too-many-lines`;
 * - the create's, passed through with its own detail: `validation-failed` …
 *   `order-backorder-rejected` (an order's refusal sits on its first row);
 * - `order-changed-since-first-run` — a derived key answering 422
 *   `idempotency-key-reuse`;
 * - `order-refused` — any other 4xx from the create, its code in the detail.
 */
export const ORDER_IMPORT_ROW_ERROR_CODES = [
  'missing-value',
  'unknown-client',
  'unknown-warehouse',
  'wrong-warehouse',
  'unknown-sku',
  'sku-client-mismatch',
  'mixed-client',
  'client-required',
  'invalid-quantity',
  'quantity-precision',
  'invalid-rate',
  'invalid-cod-amount',
  'invalid-ship-by',
  'order-rows-disagree',
  'duplicate-sku-in-order',
  'duplicate-order-in-file',
  'too-many-lines',
  'validation-failed',
  'not-found',
  'duplicate-client-order-ref',
  'client-departed',
  'client-suspended',
  'sku-inactive',
  'licence-not-covered',
  'order-catalog-changed',
  'order-backorder-rejected',
  'order-changed-since-first-run',
  'order-refused',
] as const;
export type OrderImportRowErrorCode = (typeof ORDER_IMPORT_ROW_ERROR_CODES)[number];

/** One refused row: the spreadsheet row (header = row 1), its order number (null when blank), why. */
export interface OrderImportRowError {
  readonly rowNumber: number;
  readonly orderRef: string | null;
  readonly code: OrderImportRowErrorCode;
  readonly detail: string;
}

export function orderRowError(
  rowNumber: number,
  orderRef: string | null,
  code: OrderImportRowErrorCode,
  detail: string,
): OrderImportRowError {
  return { rowNumber, orderRef, code, detail };
}

// ── cells ────────────────────────────────────────────────────────────────────

const SHIP_BY_DATE = /^(\d{4}-\d{2}-\d{2})$/;
/** An XLSX date cell as the shared reader renders it (`dateCells: 'ist-wall-clock'`) — midnight only. */
const SHIP_BY_DATE_CELL = /^(\d{4}-\d{2}-\d{2})T00:00:00\.000\+05:30$/;

export const SHIP_BY_REFUSAL =
  'ship_by must be YYYY-MM-DD (e.g. 2026-10-30) or an Excel date cell — 30/10/2026 and 10/30/2026 are refused because they are ambiguous.';

/**
 * The `ship_by` cell (A7): `YYYY-MM-DD`, or an XLSX date cell whose time is
 * 00:00 (read as the IST wall clock the sheet shows). Blank is null. Anything
 * else — a day-first or month-first date, a time, an Excel serial — is
 * refused, never guessed. The bounds (today to 365 days ahead, IST) are the
 * create's, judged on the day each order's own create captures.
 */
export function parseShipBy(text: string): { ok: true; date: string | null } | { ok: false; detail: string } {
  const value = text.trim();
  if (value === '') return { ok: true, date: null };
  const match = SHIP_BY_DATE.exec(value) ?? SHIP_BY_DATE_CELL.exec(value);
  if (match !== null && isIsoDate(match[1]!)) return { ok: true, date: match[1]! };
  return { ok: false, detail: `${SHIP_BY_REFUSAL} (got "${value}")` };
}

/** A rupee cell (`rate`, `cod_amount`): `^\d{1,8}(\.\d{1,2})?$` → integer paise, by integer arithmetic. */
export function parseRupees(text: string): number | null {
  return decimalRupeesToPaise(text.trim());
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** One data row, its cells trimmed, joined to the order its `order_ref` names. */
export interface OrderImportRow {
  readonly rowNumber: number;
  /** The normalised client order number (trimmed — A4); never blank here. */
  readonly orderRef: string;
  /** The `client` cell as written, trimmed (staff; always `''` on the portal). */
  readonly client: string;
  readonly warehouse: string;
  readonly sku: string;
  readonly quantity: string;
  /** The `rate` cell in paise; null when blank; undefined when refused. */
  readonly ratePaise: number | null | undefined;
  /** Every per-order cell as written, trimmed (`''` when blank or absent). */
  readonly cells: Readonly<Record<OrderImportOrderCell, string>>;
  /** True when one of this row's cells was refused (the row's order is refused with it). */
  readonly refused: boolean;
}

/**
 * Reads the rows. A row whose `order_ref` is blank (after the trim) belongs to
 * no order and is refused on its own (`missing-value`). Every other row joins
 * its order even when one of its cells is refused — the cell refusal then
 * refuses that order whole. Cell refusals, first failure wins per row: a blank
 * `sku` or `quantity` (`missing-value`), a quantity that is not a number
 * (`invalid-quantity`), a `rate` (staff) or `cod_amount` that is not rupees
 * (`invalid-rate` / `invalid-cod-amount`), a `ship_by` outside the grammar
 * (`invalid-ship-by`).
 */
export function readOrderImportRows(
  sheet: readonly SheetRow[],
  surface: OrderImportSurface,
): { readonly rows: OrderImportRow[]; readonly errors: OrderImportRowError[] } {
  const rows: OrderImportRow[] = [];
  const errors: OrderImportRowError[] = [];
  for (const raw of sheet) {
    const cell = (column: string): string => (raw.values[column] ?? '').trim();
    const orderRef = normalizeClientOrderRef(cell('order_ref'));
    if (orderRef === null) {
      errors.push(orderRowError(raw.rowNumber, null, 'missing-value', 'order_ref is blank — every row names the client order number it belongs to.'));
      continue;
    }
    const cells = Object.fromEntries(ORDER_IMPORT_ORDER_CELLS.map((column) => [column, cell(column)])) as Record<
      OrderImportOrderCell,
      string
    >;
    const rateText = surface === 'staff' ? cell('rate') : '';
    const ratePaise = rateText === '' ? null : (parseRupees(rateText) ?? undefined);
    const shipBy = parseShipBy(cells.ship_by);
    const cod = cells.cod_amount === '' ? null : parseRupees(cells.cod_amount);
    let refusal: OrderImportRowError | null = null;
    const refuse = (code: OrderImportRowErrorCode, detail: string): void => {
      refusal ??= orderRowError(raw.rowNumber, orderRef, code, detail);
    };
    const sku = cell('sku');
    const quantity = cell('quantity');
    if (sku === '') refuse('missing-value', 'sku is blank — every row names one SKU code.');
    else if (quantity === '') refuse('missing-value', 'quantity is blank — every row orders a quantity.');
    else if (!isQuantityText(quantity)) {
      refuse(
        'invalid-quantity',
        `quantity must be a positive number in the SKU's base unit — digits with an optional decimal point (got "${quantity}").`,
      );
    } else if (ratePaise === undefined) {
      refuse('invalid-rate', `rate is the selling price per base unit in rupees — e.g. 499 or 499.50 (got "${rateText}").`);
    } else if (cells.cod_amount !== '' && cod === null) {
      refuse('invalid-cod-amount', `cod_amount is the cash to collect in rupees — e.g. 1499 or 1499.50; leave it blank for a prepaid order (got "${cells.cod_amount}").`);
    } else if (!shipBy.ok) {
      refuse('invalid-ship-by', shipBy.detail);
    }
    if (refusal !== null) errors.push(refusal);
    rows.push({
      rowNumber: raw.rowNumber,
      orderRef,
      client: surface === 'staff' ? cell('client') : '',
      warehouse: cell('warehouse'),
      sku,
      quantity,
      ratePaise,
      cells,
      refused: refusal !== null,
    });
  }
  return { rows, errors };
}

// ── grouping ─────────────────────────────────────────────────────────────────

/** One order of the file: its rows in file order. */
export interface OrderImportGroup {
  readonly orderRef: string;
  /** The `client` cell as written on the group's rows (trimmed; `''` = blank). */
  readonly client: string;
  readonly rows: readonly OrderImportRow[];
}

/**
 * Groups rows into orders by (`client` cell, case-insensitive; `order_ref`,
 * exact after the trim) in first-appearance order (decision 2: the order of
 * each order's first row). Unlike the ASN import, a blank-client group never
 * merges into a named one (decision 9); the command refuses both when they
 * settle on the same client (`duplicate-order-in-file`).
 */
export function groupOrderImportRows(rows: readonly OrderImportRow[]): OrderImportGroup[] {
  const groups = new Map<string, { orderRef: string; client: string; rows: OrderImportRow[] }>();
  for (const row of rows) {
    const key = `${row.client.toUpperCase()}\u0000${row.orderRef}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { orderRef: row.orderRef, client: row.client, rows: [row] });
    else group.rows.push(row);
  }
  return [...groups.values()];
}

/** 422 `import-too-large` past `MAX_ORDER_IMPORT_ORDERS` orders — every group counted, refused ones included (A6). */
export function assertOrderImportCount(orderCount: number): void {
  if (orderCount > MAX_ORDER_IMPORT_ORDERS) {
    throw importTooLarge(`The file describes ${orderCount} orders — the cap is ${MAX_ORDER_IMPORT_ORDERS} per import.`);
  }
}

// ── per-order cells ──────────────────────────────────────────────────────────

/** One order's per-order values, merged from its rows (decision 8). */
export interface OrderImportHeader {
  readonly shipToName: string;
  readonly shipToPhone: string;
  readonly shipToLine1: string;
  readonly shipToLine2: string | null;
  readonly shipToCity: string;
  readonly shipToState: string;
  readonly shipToPincode: string;
  readonly consigneeGstin: string | null;
  readonly consigneeLegalName: string | null;
  /** Lower-cased (A5); a value outside the vocabulary passes for the create to refuse. */
  readonly orderType: string | null;
  readonly priority: string | null;
  readonly shipBy: string | null;
  readonly codAmountPaise: number | null;
}

/** A cell's comparable value: lower-cased type and priority (A5), the date a ship-by names, COD in paise. */
function comparable(column: OrderImportOrderCell, text: string): string | undefined {
  if (column === 'order_type' || column === 'priority') return text.toLowerCase();
  if (column === 'ship_by') {
    const parsed = parseShipBy(text);
    return parsed.ok && parsed.date !== null ? parsed.date : undefined;
  }
  if (column === 'cod_amount') {
    const paise = parseRupees(text);
    return paise === null ? undefined : String(paise);
  }
  return text;
}

/**
 * Merges an order's per-order cells: each column's value is its ONE
 * non-blank value across the order's rows. Two different non-blank values are
 * refused `order-rows-disagree` on the later row (naming the column and the
 * earlier row); a required column blank on every row is `missing-value` on
 * the order's first row. A refused cell (a bad `ship_by` or `cod_amount`)
 * carries its own refusal and is left out of the comparison.
 */
export function mergeOrderHeader(group: OrderImportGroup): {
  readonly header: OrderImportHeader;
  readonly errors: OrderImportRowError[];
} {
  const errors: OrderImportRowError[] = [];
  const first = group.rows[0]!;
  const values = new Map<OrderImportOrderCell, string>();
  for (const column of ORDER_IMPORT_ORDER_CELLS) {
    let held: { row: OrderImportRow; text: string; value: string } | null = null;
    for (const row of group.rows) {
      const text = row.cells[column];
      if (text === '') continue;
      const value = comparable(column, text);
      if (value === undefined) continue;
      if (held === null) {
        held = { row, text, value };
      } else if (value !== held.value) {
        errors.push(
          orderRowError(
            row.rowNumber,
            group.orderRef,
            'order-rows-disagree',
            `Row ${row.rowNumber}'s ${column} is "${text}" but row ${held.row.rowNumber}'s is "${held.text}" — ` +
              `every row of order "${group.orderRef}" must give the same ${column}, or leave it blank after the first.`,
          ),
        );
      }
    }
    if (held !== null) values.set(column, column === 'order_type' || column === 'priority' ? held.value : held.text);
    else if (REQUIRED_ORDER_CELLS.includes(column) && !group.rows.some((row) => row.cells[column] !== '')) {
      errors.push(
        orderRowError(first.rowNumber, group.orderRef, 'missing-value', `${column} is blank on every row of order "${group.orderRef}" — the ship-to address is required.`),
      );
    }
  }
  const text = (column: OrderImportOrderCell): string | null => values.get(column) ?? null;
  const cod = text('cod_amount');
  return {
    header: {
      shipToName: text('ship_to_name') ?? '',
      shipToPhone: text('ship_to_phone') ?? '',
      shipToLine1: text('ship_to_line1') ?? '',
      shipToLine2: text('ship_to_line2'),
      shipToCity: text('ship_to_city') ?? '',
      shipToState: text('ship_to_state') ?? '',
      shipToPincode: text('ship_to_pincode') ?? '',
      consigneeGstin: text('consignee_gstin'),
      consigneeLegalName: text('consignee_legal_name'),
      orderType: text('order_type'),
      priority: text('priority'),
      shipBy: text('ship_by') === null ? null : (parseShipBy(text('ship_by')!) as { ok: true; date: string }).date,
      codAmountPaise: cod === null ? null : parseRupees(cod),
    },
    errors,
  };
}

/** A SKU code listed twice in one order is refused on its repeat — never summed. */
export function repeatedOrderSkus(group: OrderImportGroup): OrderImportRowError[] {
  const errors: OrderImportRowError[] = [];
  const firstRow = new Map<string, number>();
  for (const row of group.rows) {
    if (row.sku === '') continue;
    const earlier = firstRow.get(row.sku);
    if (earlier === undefined) {
      firstRow.set(row.sku, row.rowNumber);
    } else {
      errors.push(
        orderRowError(
          row.rowNumber,
          group.orderRef,
          'duplicate-sku-in-order',
          `SKU "${row.sku}" is already on row ${earlier} of order "${group.orderRef}" — list each SKU once per order (quantities are not summed).`,
        ),
      );
    }
  }
  return errors;
}

/** An order over `MAX_ORDER_IMPORT_LINES` lines is refused on its first row (`too-many-lines`). */
export function tooManyLines(group: OrderImportGroup): OrderImportRowError | null {
  if (group.rows.length <= MAX_ORDER_IMPORT_LINES) return null;
  return orderRowError(
    group.rows[0]!.rowNumber,
    group.orderRef,
    'too-many-lines',
    `Order "${group.orderRef}" has ${group.rows.length} lines — an order carries at most ${MAX_ORDER_IMPORT_LINES}. Split it into two orders with different order numbers.`,
  );
}

// ── the derived per-order key ────────────────────────────────────────────────

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The parts a derived key is computed from — none of them a lookup's answer (A2). */
export interface OrderImportKeyParts {
  readonly surface: OrderImportSurface;
  readonly fileSha256: string;
  readonly warehouseId: string;
  /** Staff: the `client` cell as written, trimmed and upper-cased (`''` when blank). Portal: the session's client id. */
  readonly client: string;
  /** The normalised `order_ref`. */
  readonly orderRef: string;
}

/**
 * One order's idempotency key, DERIVED from the import's (decision 3, A2):
 * the import key's 10-character time prefix plus 16 characters of
 * `sha256(importKey : 'order-import' : surface : fileSha256 : warehouseId :
 * client : orderRef)` in the ULID alphabet (the `refusedGrnLinesOpId` shape).
 * A retry of the same import with the same file derives the same keys, so
 * every order already created replays. Never equal to the import key.
 */
export function orderImportOrderKey(importKey: string, parts: OrderImportKeyParts): string {
  const digest = createHash('sha256')
    .update(
      [importKey, 'order-import', parts.surface, parts.fileSha256, parts.warehouseId, parts.client.toUpperCase(), parts.orderRef].join(':'),
      'utf8',
    )
    .digest();
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET.charAt(digest[i]! & 31);
  const derived = importKey.slice(0, 10).toUpperCase() + tail;
  if (derived !== importKey) return derived;
  const last = derived.charAt(25);
  return derived.slice(0, 25) + (last === '0' ? '1' : '0');
}
