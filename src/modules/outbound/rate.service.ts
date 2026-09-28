import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { orderLines, orders, skus, warehouses } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { CarriersFacade, rateThroughAdapter } from '../carriers/carriers.facade';
import type {
  CarrierConnectionView,
  CarrierRateRequest,
} from '../carriers/carriers.facade';

/**
 * The problem code whose per-connection refusal is a RATE ITEM, not a read
 * failure. Clients branch on the code, never on prose — this constant is the
 * branch key on both sides (the port's `unconfiguredRateArm` throws it, the
 * read renders it as an item, the FE chip shows it verbatim).
 */
const TRANSPORT_UNCONFIGURED = 'carrier-transport-unconfigured';

/** A byte comparison — the item sort's contract is byte-stable, never
 * ICU-locale-dependent (`localeCompare` can reorder between environments). */
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

// ── snapshots ────────────────────────────────────────────────────────────────

/** One quoted item's money — integer paise (AD-9), an INR rate. */
export interface RateQuote {
  readonly amountPaise: number;
}

/**
 * One refused item: the carrier's typed refusal, carried in the problem's own
 * words so the surface can render it verbatim (the FE branches on `code`,
 * never on prose).
 */
export interface RateRefusal {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
}

/** One live connection's answer: quoted OR refused, exactly one. */
export interface RateItem {
  readonly connectionId: string;
  readonly carrierCode: string;
  readonly carrierName: string;
  readonly quote: RateQuote | null;
  readonly refusal: RateRefusal | null;
}

/** The rate-shopping read's answer — recomputed per request, never stored. */
export interface OrderRatesSnapshot {
  readonly rates: {
    readonly orderId: string;
    /** One item per live connection, sorted by carrierCode. */
    readonly items: readonly RateItem[];
  };
}

/**
 * The rate-shopping read (Story 4.6d): one `ready_to_dispatch` order priced
 * against every live carrier connection the tenant has configured — one
 * quoted-or-refused item per connection, sorted by carrier code.
 *
 * ── rating is a READ ─────────────────────────────────────────────────────────
 *
 * No state changes anywhere: no order flip, no shipment, no outbox event, no
 * ledger event, no audit row, no idempotency key (reads are never
 * capability-gated, and there is no Idempotency-Key on the route). The quotes
 * are recomputed per request — there is no quote table, no rate history, no
 * rate log (the story's Never list).
 *
 * ── one transaction, no row locks ────────────────────────────────────────────
 *
 * The order read, the weight aggregate and the per-connection credential
 * opens run in ONE `withTenantTransaction` with no row locks (read-only; a
 * concurrent pack or dispatch changes the answer of the NEXT read, not this
 * one). The credential passthrough needs the tx handle — that is what makes
 * the single transaction load-bearing. The tenant's live connections are
 * enumerated BEFORE this transaction opens, because `listConnections` is a
 * facade method that opens its own `withTenantTransaction` — and calling one
 * inside a held transaction queues a second pool connection behind the first
 * (the documented pool-nesting deadlock). A connection connected after the
 * walk is quoted on the next read, not this one; the walk's cost is bounded
 * by the one-connection-per-carrier unique index.
 *
 * ── the weight aggregate ─────────────────────────────────────────────────────
 *
 * Σ(qty_milli ÷ 1000 × sku.weight_grams) over the order's lines — kit
 * component lines COUNTED (the physical goods live on components, AD-19) and
 * kit parent lines EXCLUDED (a kit parent is a line some other line names as
 * its `parentLineId`; ordinary lines and kit parents both carry a null
 * `parent_line_id`, so the marker is "does any child point at me"). A line
 * whose SKU carries no `weight_grams` refuses the WHOLE quote — 409 naming
 * the unweighted SKUs (the manifest's offender-enumeration precedent): a
 * quote without weight is a lie, and the operator fixes the catalog and
 * retries. The sum runs in SQL over `numeric` — a milli-unit quantity times
 * a gram weight overflows JS numbers and bigint long before it overflows
 * numeric, and the read must not fail on the order it is trying to price —
 * the aggregate is exact in SQL, and the JS boundary it is handed over is
 * guarded explicitly: past 2^53 grams the read refuses with a clean 409, not
 * a silently-wrong quote.
 *
 * ── the adapter calls ────────────────────────────────────────────────────────
 *
 * Per connection, the same seam the label command rides: the credential
 * opened in-tx (`openCredentialForAdapterUseInTx` — request-scoped plaintext,
 * never logged, never persisted, never in any response) and the arm called
 * through the facade's `rateThroughAdapter` glue. The DIRECT carriers' typed
 * 501 `carrier-transport-unconfigured` lands as that connection's refused
 * item — the refusal is a first-class rendered arm, not a swallowed error.
 * Any OTHER failure (a 503 unreadable credential, a sandbox bug) fails the
 * whole read: those are deployment faults, not quotes. The real-transport
 * carries — timeout guard, adapter call out of the held tx — ride the 4-6c
 * defer unchanged (both arms are in-process today, so nothing inside the tx
 * can block on a network).
 */
@Injectable()
export class RateService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // Cross-module composition through the facade only (AD-6): the
    // connection walk, the in-tx credential open and the adapter glue — the
    // outbound module touches no carriers table and sees no sealed blob.
    @Inject(CarriersFacade) private readonly carriers: CarriersFacade,
  ) {}

  /** `GET .../orders/{orderId}/rates` — a read; null when the order is unknown. */
  async getOrderRates(tenantId: string, orderId: string): Promise<OrderRatesSnapshot | null> {
    const connections = await this.listAllConnections(tenantId);

    return withTenantTransaction(this.db, tenantId, async (tx) => {
      // ── the order — read-only, no row locks (rating writes nothing) ─────
      const orderRows = await tx
        .select({
          id: orders.id,
          status: orders.status,
          warehouseId: orders.warehouseId,
          destinationPincode: orders.destinationPincode,
        })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
        .limit(1);
      const order = orderRows[0];
      if (order === undefined) {
        return null;
      }

      // ── the state guard: an allow-list of exactly `ready_to_dispatch` ──
      if (order.status !== 'ready_to_dispatch') {
        throw rateConflict(
          'Order is not ratable',
          `Order "${order.id}" reads "${order.status}" — only a packed (ready_to_dispatch) order is rated.`,
        );
      }

      // ── the origin pincode (the warehouse's, read at rate time) ─────────
      const originRows = await tx
        .select({ originPincode: warehouses.originPincode })
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, order.warehouseId)))
        .limit(1);

      // ── the weight aggregate (kit components counted, kit parents out) ──
      // The kit-parent marker: `parent_line_id` is set on component CHILDREN
      // and null on ordinary lines AND kit parents, so "some other line of
      // this order points at me" is the only reliable parent test.
      const kitParent = sql`exists (
        select 1 from order_lines child
        where child.parent_line_id = ${orderLines.id}
          and child.tenant_id = ${orderLines.tenantId}
          and child.order_id = ${orderLines.orderId}
      )`;
      const contributor = sql`(${orderLines.parentLineId} is not null or not ${kitParent})`;

      // Missing weight refuses the WHOLE quote (the human decision): the
      // offending SKU codes, code-sorted, named in the detail.
      const unweighted = await tx
        .selectDistinct({ skuCode: skus.code })
        .from(orderLines)
        .innerJoin(skus, eq(skus.id, orderLines.skuId))
        .where(
          and(
            eq(orderLines.tenantId, tenantId),
            eq(orderLines.orderId, order.id),
            isNull(skus.weightGrams),
            contributor,
          ),
        )
        .orderBy(asc(skus.code));
      if (unweighted.length > 0) {
        throw missingWeight(unweighted.map((row) => row.skuCode));
      }

      const weightRows = await tx
        .select({
          lineCount: sql<number>`count(*)::int`,
          // milli-units × grams = milli-grams; the aggregate ceils to whole
          // grams (a parcel never carries a fraction of a gram). `numeric`
          // because the product overflows bigint at the pathological edge,
          // and text so no driver-side float can touch it.
          totalGrams: sql<string>`coalesce(ceil(sum(${orderLines.qty}::numeric * ${skus.weightGrams}) / 1000), 0)::text`,
        })
        .from(orderLines)
        .innerJoin(skus, eq(skus.id, orderLines.skuId))
        .where(
          and(
            eq(orderLines.tenantId, tenantId),
            eq(orderLines.orderId, order.id),
            isNotNull(skus.weightGrams),
            contributor,
          ),
        );
      const weightRow = weightRows[0];
      if (weightRow === undefined || weightRow.lineCount === 0) {
        // Unreachable for a real order (every order carries ≥ 1 contributing
        // line — a kit parent always explodes) — but the arm must not quote a
        // weightless order if the data ever says otherwise.
        throw missingWeight([]);
      }
      const weightGrams = Number(weightRow.totalGrams);
      // The SQL aggregate is exact in `numeric`, but handing it to JS re-opens
      // the boundary the text cast was bought to close: a pathological
      // (accepted-bounds) order can aggregate past 2^53 grams, and a
      // `Number` beyond that silently loses precision — a wrong quote, the
      // one thing a rate read must never be. The boundary is guarded
      // explicitly: past it the read refuses cleanly instead of mispricing.
      if (!Number.isSafeInteger(weightGrams)) {
        throw rateConflict(
          'Order cannot be rated',
          'The order’s aggregated shippable weight exceeds the ratable range.',
        );
      }

      // ── per live connection: open the credential in-tx, call the glue ───
      const items: RateItem[] = [];
      for (const connection of connections) {
        const credential = await this.carriers.openCredentialForAdapterUseInTx(
          tx,
          tenantId,
          connection.id,
        );
        const request: CarrierRateRequest = {
          orderRef: order.id,
          originPincode: originRows[0]?.originPincode ?? null,
          destinationPincode: order.destinationPincode,
          weightGrams,
        };
        try {
          const quote = await rateThroughAdapter(connection.carrierCode, credential, request);
          items.push({
            connectionId: connection.id,
            carrierCode: connection.carrierCode,
            carrierName: connection.carrierName,
            quote,
            refusal: null,
          });
        } catch (err) {
          // The DIRECT carriers' typed 501 is that connection's ITEM — a
          // refused carrier is a rate-shopping answer, not a failure. Every
          // other throw is this read's own fault and fails the read.
          if (err instanceof ProblemException && transportUnconfigured(err)) {
            items.push({
              connectionId: connection.id,
              carrierCode: connection.carrierCode,
              carrierName: connection.carrierName,
              quote: null,
              refusal: refusalOf(err),
            });
            continue;
          }
          throw err;
        }
      }

      // The item order is a contract (the matrix): carrierCode ascending —
      // deterministic regardless of the connection walk's recency order. The
      // comparator is a byte comparison, not `localeCompare`: the contract is
      // byte-stable, and an ICU-locale-dependent comparator can reorder codes
      // (case folding, collation tables) between environments.
      items.sort((a, b) => cmp(a.carrierCode, b.carrierCode) || cmp(a.connectionId, b.connectionId));

      return { rates: { orderId: order.id, items } };
    });
  }

  /**
   * The tenant's live connections — the configured carriers, every one of
   * them rated. A keyset walk over the facade's own paginated read, run
   * BEFORE the rate transaction opens (the pool-nesting rule — see the class
   * docstring).
   */
  private async listAllConnections(tenantId: string): Promise<readonly CarrierConnectionView[]> {
    const items: CarrierConnectionView[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await this.carriers.listConnections(
        tenantId,
        cursor === null ? {} : { cursor },
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    return items;
  }
}

/**
 * The caught exception is THE typed 501 when the rendered body's code says
 * so — decided on the machine code, never on prose or status alone.
 */
function transportUnconfigured(err: ProblemException): boolean {
  return (err.getResponse() as { code?: string }).code === TRANSPORT_UNCONFIGURED;
}

/** The refusal item's fields, in the problem's own words. */
function refusalOf(err: ProblemException): RateRefusal {
  const body = err.getResponse() as {
    code: string;
    status: number;
    title: string;
    detail?: string;
  };
  return {
    code: body.code,
    status: body.status,
    title: body.title,
    detail: body.detail ?? body.title,
  };
}

/**
 * The detail cap (the `namedSample` rule in pack.command.ts): a refusal may
 * enumerate the offenders, but a multi-kilobyte `detail` is unreadable to the
 * operator AND a payload amplification an unauthenticated-adjacent caller
 * controls. The COUNT is what tells them the size; the sample tells them
 * where to start.
 */
const MAX_ENUMERATED_IN_DETAIL = 20;

function namedSample(items: readonly string[]): string {
  if (items.length <= MAX_ENUMERATED_IN_DETAIL) {
    return items.join('; ');
  }
  const shown = items.slice(0, MAX_ENUMERATED_IN_DETAIL).join('; ');
  return `${shown}; … and ${items.length - MAX_ENUMERATED_IN_DETAIL} more`;
}

/**
 * 409 `missing-sku-weight` — the human decision (2026-09-28): a quote without
 * weight is a lie. The refusal names the unweighted SKUs so the operator can
 * fix the catalog and retry (retryable after the weights are set).
 */
function missingWeight(skuCodes: readonly string[]): ProblemException {
  const detail =
    skuCodes.length === 0
      ? 'No weighted order line contributes to this order’s shippable weight.'
      : `These SKUs carry no weight_grams, so the order cannot be priced: ${namedSample([...skuCodes])}. Set the weights and retry.`;
  return new ProblemException(
    'missing-sku-weight',
    409,
    'Order cannot be rated',
    detail,
  );
}

function rateConflict(title: string, detail: string): ProblemException {
  return new ProblemException('conflict', 409, title, detail);
}