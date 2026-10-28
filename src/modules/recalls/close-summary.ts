import { RECALL_FIGURE_NAMES, type RecallLotFigures } from './recall-figures';

/**
 * Story 3-7a (A6) — the close summary, schema version 1: the figures of every
 * lot AS OF CLOSE, frozen in `batch_recalls.close_summary` and printed by the
 * detail and the report (`figure_at_close`). Built by this ONE function and
 * pinned by a golden in `test/recalls.spec.ts`: the key order below is the
 * stored bytes' order, so it never changes within a version.
 *
 *   {"v":1,"asOf":"<instant>","lots":[{"batchId","batchCode","skuId",
 *     "figures":{received, receivedDamaged, onHand, inTransit, heldInOpenOrders,
 *                dispatched, returned, returnScrapped, adjustedOut, unaccounted},
 *     "adjustedOutByReason":{"<reasonCode>": <base units>},
 *     "released": bool, "overrideReason": string|null, "dispositionNote": string|null}],
 *    "acknowledgedUnaccounted": bool, "evidenceRef": string|null}
 *
 * `returnScrapped` (4-7a's scrap of a returned unit, merged after the design)
 * sits after `returned`. "Disposition" is `adjustedOutByReason` (negative
 * `stock.adjusted` grouped by its reason code) plus `returnScrapped`; the
 * return-to-vendor (2-8b) and return-to-client (13-x) arms join it when they
 * ship (PENDING).
 */
export const CLOSE_SUMMARY_VERSION = 1;

export interface CloseSummaryLotInput {
  readonly batchId: string;
  readonly batchCode: string;
  readonly skuId: string;
  readonly figures: RecallLotFigures;
  readonly adjustedOutByReason: Readonly<Record<string, number>>;
  readonly released: boolean;
  readonly overrideReason: string | null;
  readonly dispositionNote: string | null;
}

export interface CloseSummaryLot {
  readonly batchId: string;
  readonly batchCode: string;
  readonly skuId: string;
  readonly figures: RecallLotFigures;
  readonly adjustedOutByReason: Readonly<Record<string, number>>;
  readonly released: boolean;
  readonly overrideReason: string | null;
  readonly dispositionNote: string | null;
}

export interface CloseSummaryV1 {
  readonly v: 1;
  readonly asOf: string;
  readonly lots: readonly CloseSummaryLot[];
  readonly acknowledgedUnaccounted: boolean;
  readonly evidenceRef: string | null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The v1 summary — lots in batch-code then batch-id order, every key in its fixed position. */
export function buildCloseSummary(input: {
  readonly asOf: string;
  readonly lots: readonly CloseSummaryLotInput[];
  readonly acknowledgedUnaccounted: boolean;
  readonly evidenceRef: string | null;
}): CloseSummaryV1 {
  const lots = [...input.lots]
    .sort((a, b) => compareText(a.batchCode, b.batchCode) || compareText(a.batchId, b.batchId))
    .map((lot) => ({
      batchId: lot.batchId,
      batchCode: lot.batchCode,
      skuId: lot.skuId,
      figures: Object.fromEntries(RECALL_FIGURE_NAMES.map((name) => [name, lot.figures[name]])) as RecallLotFigures,
      adjustedOutByReason: Object.fromEntries(Object.entries(lot.adjustedOutByReason).sort(([a], [b]) => compareText(a, b))),
      released: lot.released,
      overrideReason: lot.overrideReason,
      dispositionNote: lot.dispositionNote,
    }));
  return {
    v: CLOSE_SUMMARY_VERSION,
    asOf: input.asOf,
    lots,
    acknowledgedUnaccounted: input.acknowledgedUnaccounted,
    evidenceRef: input.evidenceRef,
  };
}
