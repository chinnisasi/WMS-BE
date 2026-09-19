/**
 * The ledger event grammar (Story 2.1, AD-11): event types exist **only by
 * registration** in this versioned registry — no free-form emission. New
 * event types are added by registering them with the grammar version that
 * introduces them; grammar changes are additive only — an arm is never
 * renumbered and never repurposed.
 *
 * The registry is the single authority `appendLedgerEvent` consults before
 * any write: an unregistered event type, a `reference_doc` kind the type
 * does not declare, or a batch/serial arm on a type that does not allow
 * them, fails the movement before touching any table.
 */

/** Grammar version introduced with Story 2.1 — monotonic, additive only. */
export const LEDGER_GRAMMAR_VERSION = 1;

/** The typed `reference_doc` union arms (AD-11): discriminated by `kind`. */
export type LedgerReferenceDoc =
  | {
      readonly kind: 'manual-adjustment';
      /** Machine reason for the correction (e.g. `stock-count`, `damage`). */
      readonly reasonCode: string;
      /** The Ops Manager's free-text note carried verbatim. */
      readonly note: string;
      /**
       * Story 2.4 — the recorded reason when a draw overrides the FEFO
       * default batch with an explicit one (absent on every other
       * adjustment). Optional and additive: old events' canonical bytes are
       * unchanged (the key serializes only when present).
       */
      readonly overrideReason?: string;
      /**
       * Story 10.3 — the handling units this adjustment consumed, sorted.
       *
       * A catch-weight write-off must NAME the cases it scraps (a handling
       * unit has no location, so an aggregate delta cannot say which case was
       * damaged), and those names belong inside the tamper-evident chain for
       * the same reason pack's do: a case that never shipped is a case whose
       * disposal has to be provable. `referenceDoc` is already hashed, so the
       * ids ride it rather than a new `ledger_events` column — hashing a new
       * column would change every pre-existing event's canonical bytes.
       *
       * Optional and additive: absent on every non-catch-weight adjustment,
       * whose canonical bytes are therefore unchanged.
       */
      readonly handlingUnitIds?: readonly string[];
    }
  // Story 3.3 — the receipt arm: every `grn.received` movement names the GRN
  // it landed under, and (when received against a purchase order) the PO and
  // the exact line. NEW union arm — `manual-adjustment` is never reshaped.
  | {
      readonly kind: 'grn-receipt';
      readonly grnId: string;
      /** Absent on a blind receipt's events (no PO to name). */
      readonly poId?: string;
      /** Absent on the blind arm and on an approved-excess event with no line. */
      readonly poLineId?: string;
    }
  // Story 3.4 — the QC-hold arm: every `qc.held` / `qc.released` movement
  // names the hold that produced it. `fromBinId` rides the `qc.held` events
  // only (the origin captured at hold time — release reads the hold row's
  // `bin_id`, never a caller-chosen bin). NEW union arm — the earlier kinds
  // are never reshaped.
  | {
      readonly kind: 'qc-hold';
      readonly holdId: string;
      readonly fromBinId?: string;
    }
  // Story 3.5 — the putaway arm: every `putaway.placed` movement names the
  // GRN line whose received stock moved from the system Receiving bin, the
  // server's re-derived suggestion at placement time, and (when the operator
  // placed elsewhere) the fixed mismatch-reason enum value. NEW union arm —
  // the earlier kinds are never reshaped.
  | {
      readonly kind: 'putaway';
      readonly grnId: string;
      readonly grnLineId: string;
      /** Present only when the operator recorded a mismatch reason. */
      readonly reasonCode?: string;
      /** The server's re-derived suggestion (absent when no bin fit). */
      readonly suggestedBinId?: string;
    }
  // Story 3.6 — the bin-merge arm: every `bin.merged` movement names the
  // merge op that moved the stock (one op per source→target consolidation;
  // one event per (sku, batch) arm, per serial unit for serial-tracked
  // stock). NEW union arm — the earlier kinds are never reshaped.
  | {
      readonly kind: 'bin-merge';
      readonly mergeId: string;
    }
  // Story 4.3 — the pick arm: every `pick.picked` movement names the
  // picklist line whose planned units were drawn, the wave and order it
  // serves, and the reservation hold the same transaction settled. The
  // plan's suggested bin rides along when the operator drew somewhere else
  // (the bin a line names is a SUGGESTION re-derived at pick time), so the
  // event itself records suggestion-vs-actual. NEW union arm — the earlier
  // kinds are never reshaped.
  | {
      readonly kind: 'pick';
      readonly picklistId: string;
      readonly picklistLineId: string;
      readonly waveId: string;
      readonly orderId: string;
      readonly orderLineId: string;
      /** The order line's journal hold; absent when the line carried none. */
      readonly reservationId?: string;
      /** The plan's bin — present only when the draw bin differs from it. */
      readonly suggestedBinId?: string;
      /**
       * Story 4.4 — the short-pick facts, present ONLY on a draw the
       * operator reported short (absent on every whole-quantity pick, so
       * older events' canonical bytes are unchanged). The ledger is the one
       * record that outlives every projection, so a draw that did not match
       * its plan says so where it can never be re-derived away: how many
       * units the stop planned but never moved, and why. The putaway arm's
       * `reasonCode` is the precedent — a fixed enum, declared here so the
       * grammar names every key the event carries.
       */
      readonly shortPick?: true;
      readonly shortfallQty?: number;
      readonly reasonCode?: string;
    }
  // Story 4.5 — the pack arm: the first NON-MOVEMENT event in the system.
  // Picking already drew the units out of stock entirely (`toBinId: null` on
  // `pick.picked`), so a pack has no bin to move between: the event carries
  // `quantityDelta: 0` with BOTH bin arms null and folds no projection at
  // all. What it records is the verification — this order line's picked
  // units were counted at the bench and matched — which is why one event is
  // written per ORDER LINE (`LedgerMovement` requires a non-null `skuId`, and
  // the per-SKU chain is what keeps an item's history reconstructible).
  //
  // The optional measurements ride here because there is nowhere else
  // durable for them: a Pack Station is not an entity in this story and the
  // packing slip is a response payload, not a document. Units are explicit
  // in the key names — a bare `weight` would be a unit nobody can recover
  // from the ledger later. NEW union arm — the earlier kinds are never
  // reshaped.
  | {
      readonly kind: 'pack';
      readonly orderId: string;
      readonly orderLineId: string;
      /** Units verified at the bench for this line — what was PICKED, not ordered. */
      readonly packedQty: number;
      /** Optional parcel weight; absent when the bench recorded none. */
      readonly weightGrams?: number;
      /** Optional parcel dimensions — all three present together, or none. */
      readonly lengthMm?: number;
      readonly widthMm?: number;
      readonly heightMm?: number;
      /**
       * Story 10.3 — the handling units consumed into THIS order line, sorted.
       *
       * This is the whole tamper-evidence story for catch weight, and it is
       * why `ledger_events` gains no column: `referenceDoc` is ALREADY inside
       * `canonicalEventBytes`, so the ids are hash-chained like everything
       * else — while a historical event, whose stored jsonb simply lacks the
       * key, hashes to exactly the bytes it always did (`JSON.stringify`
       * drops absent keys). A new hashed COLUMN would instead have changed
       * every pre-existing event's canonical form and reported severity-1
       * across the whole chain, on top of the break 0026 already took.
       *
       * Sorted before hashing, matching the sibling `scanned` list in the
       * same command: scanning cases A,B,C into a parcel is the same physical
       * act as C,B,A, and two orderings must not create two packs.
       *
       * Present only on a catch-weight line — an ADDITIVE optional key, the
       * way `weightGrams` is; the arm is never reshaped.
       */
      readonly handlingUnitIds?: readonly string[];
    }
  // Story 4.6 — the dispatch arm: the SHIPMENT record, and the terminal
  // event of an order's life. Like `pack`, it moves nothing (`pick.picked`
  // already drew the units out of stock with `toBinId: null`), so the event
  // carries `quantityDelta: 0` with both bin arms null and folds no
  // projection; one is written per ORDER LINE because `LedgerMovement`
  // requires a non-null `skuId`.
  //
  // What makes it more than a status flip is what commits WITH it: every
  // `committed` hold the order owned is retired to `released` in the same
  // transaction, which is the transition that finally takes the shipped
  // units off the reserved counter and corrects ATP.
  //
  // The carrier arms are OPTIONAL FREE TEXT, deliberately (the human
  // decision, 2026-09-15) — the same place 4.5 put weight and dimensions, so
  // an operator shipping by a manual courier can record a consignment today,
  // before the carrier-adapter arc exists. The carrier stories replace them
  // with a real carrier id and an adapter-issued tracking number; these
  // fields are their migration target, not their final shape. NEW union arm
  // — the earlier kinds are never reshaped.
  | {
      readonly kind: 'dispatch';
      readonly orderId: string;
      readonly orderLineId: string;
      /** Units shipped for this line — what was PICKED, not ordered. */
      readonly dispatchedQty: number;
      /** Optional free-text carrier; absent when the operator named none. */
      readonly carrierName?: string;
      /** Optional free-text tracking reference; absent when none was given. */
      readonly trackingNumber?: string;
    };
// Later stories extend this union with NEW kinds (transfer, …) — never by
// reshaping an existing arm.

/** One registered grammar entry: an event type and what it may carry. */
export interface LedgerEventTypeDefinition {
  /** Registry name — the `ledger_events.type` value (`stock.adjusted`). */
  readonly type: string;
  /** Grammar version that introduced this type (additive evolution). */
  readonly sinceVersion: number;
  /** The `reference_doc.kind` values this event type may carry. */
  readonly referenceKinds: readonly string[];
  /** Story 2.4's batch arm (open on `stock.adjusted` since that story). */
  readonly allowsBatchArm: boolean;
  /** Story 2.4's serial arm (open on `stock.adjusted` since that story). */
  readonly allowsSerialArm: boolean;
}

const REGISTRY = new Map<string, LedgerEventTypeDefinition>();

/**
 * The one registration point. Registering a duplicate type fails loudly —
 * a grammar arm is declared once.
 */
export function registerLedgerEventType(definition: LedgerEventTypeDefinition): void {
  if (REGISTRY.has(definition.type)) {
    throw new Error(`Ledger event type already registered: ${definition.type}`);
  }
  REGISTRY.set(definition.type, definition);
}

/**
 * Grammar v1: the manual Ops-Manager adjustment — the first movement
 * producer, exercisable end-to-end. Story 2.4 opens its reserved batch/serial
 * arms (additive — old events with both arms null verify identically; the
 * flags gate NEW writes only). Later stories register their types here
 * (receipts, picks, transfers, …); nothing else may emit events.
 */
registerLedgerEventType({
  type: 'stock.adjusted',
  sinceVersion: 1,
  referenceKinds: ['manual-adjustment'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 3.3 — the receipt movement: one event per GRN line (the
 * within-open portion at submit; the excess again on over-receipt approval),
 * landing stock in the warehouse's system Receiving bin. Batch-tracked
 * receipts carry the batch arm (identity ensured through the catalog facade
 * first); serial intake has no receive path yet (serials stay ledger-capable,
 * the story's Never list keeps serial capture out) — the serial arm stays
 * closed on this type.
 */
registerLedgerEventType({
  type: 'grn.received',
  sinceVersion: 1,
  referenceKinds: ['grn-receipt'],
  allowsBatchArm: true,
  allowsSerialArm: false,
});

/**
 * Grammar v1, Story 3.4 — the QC-hold movements: a hold moves the whole
 * (sku, bin) scope's on-hand into the warehouse's system QC-hold bin (one
 * `qc.held` event per batch on-hand row, the origin bin on the reference),
 * and a release moves exactly those units back (the same batch arms, derived
 * from the hold's own `qc.held` events — a concurrent hold of the same SKU
 * from another origin bin must never return with the wrong release). Both
 * types register since v1 (no new grammar version — arms append only); the
 * serial arm stays closed (v1 captures no serials into holds).
 */
registerLedgerEventType({
  type: 'qc.held',
  sinceVersion: 1,
  referenceKinds: ['qc-hold'],
  allowsBatchArm: true,
  allowsSerialArm: false,
});

registerLedgerEventType({
  type: 'qc.released',
  sinceVersion: 1,
  referenceKinds: ['qc-hold'],
  allowsBatchArm: true,
  allowsSerialArm: false,
});

/**
 * Grammar v1, Story 3.5 — the putaway movement: stock moving from the
 * warehouse's system Receiving bin into the operator's target storage bin
 * (fromBin + toBin carried on ONE event — the movement is a relocation, the
 * ledger folds both projections from the single magnitude). Batch-tracked
 * placements carry the batch arm (one event per batch arm); serial-tracked
 * placements carry the serial arm (one event per serial unit, mirroring
 * `stock.adjusted`'s serial pattern — the serial's location record must move
 * with its stock). Registers sinceVersion 1: no new grammar version — the
 * reference-doc arm appends only.
 */
registerLedgerEventType({
  type: 'putaway.placed',
  sinceVersion: 1,
  referenceKinds: ['putaway'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 3.6 — the bin-merge movement: stock moving from a source
 * bin into the merge's target bin, folded from ONE event like the putaway
 * relocation (both bin arms carried, the magnitude folds +target −source).
 * One event per (sku, batch) arm; serial-tracked stock moves one two-arm
 * event per serial unit (the putaway convention — the serial's location
 * record must move with its stock), with the batch arm carried on the
 * per-serial events too. Never a direct `stock_on_hand` write — the merge is
 * real ledger movements, replay/reconciliation/audit all see them. Registers
 * sinceVersion 1: no new grammar version — the reference-doc arm appends
 * only.
 */
registerLedgerEventType({
  type: 'bin.merged',
  sinceVersion: 1,
  referenceKinds: ['bin-merge'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 4.3 — the pick movement: reserved units leaving their
 * storage bin on a scan-verified pick. Unlike the putaway/merge relocations
 * this is a pure DRAW — `fromBinId` is the bin the operator scanned and
 * `toBinId` is null: the units leave stock here, and the order's onward
 * journey (pack, dispatch) is 4.5/4.6's ledger arms, not a bin this story
 * invents. One event per (sku, batch) arm of the draw; serial-tracked stock
 * draws one event per serial unit (magnitude 1, the batch arm carried with
 * it — the putaway convention, so the serial's location record leaves with
 * its stock). Never a direct `stock_on_hand` write: the ledger's sufficiency
 * guard refusing a negative on-hand IS this story's conflict behaviour.
 * Registers sinceVersion 1: no new grammar version — the reference-doc arm
 * appends only.
 */
registerLedgerEventType({
  type: 'pick.picked',
  sinceVersion: 1,
  referenceKinds: ['pick'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 4.5 — the pack verification: one ZERO-quantity event per
 * order line, recording that the line's picked units were counted at the
 * bench and matched. It is the first registered type that moves nothing:
 * both bin arms are null, so `appendMovement` folds neither `stock_on_hand`
 * nor `batch_on_hand`, and the event exists purely as the durable record of
 * the verification (plus the optional weight/dimensions on its reference
 * doc). The hash chain still covers it like every other event.
 *
 * Both arms stay CLOSED. A pack verifies an order line against what was
 * picked, in base units; it re-counts neither batches nor serials, and
 * opening an arm this story does not write would let a future caller record
 * a batch/serial claim the verification never made. 4.6's dispatch arm is
 * where per-unit identity next matters. Registers sinceVersion 1: no new
 * grammar version — the reference-doc arm appends only.
 */
registerLedgerEventType({
  type: 'pack.packed',
  sinceVersion: 1,
  referenceKinds: ['pack'],
  allowsBatchArm: false,
  allowsSerialArm: false,
});

/**
 * Grammar v1, Story 4.6 — the dispatch: one ZERO-quantity event per order
 * line recording that the order shipped. The second non-movement type, for
 * the same reason as the first: the units left `stock_on_hand` at pick, so
 * both bin arms are null and `appendMovement` folds nothing. What the event
 * durably records is the SHIPMENT — the terminal fact of the order's life —
 * plus the optional free-text carrier and tracking reference on its
 * reference doc, which have nowhere else durable to live until the carrier
 * adapter arrives.
 *
 * Both identity arms stay CLOSED, like `pack.packed`. Dispatch re-counts
 * nothing: it ships exactly the units `pick.picked` already drew, and those
 * events carry the batch/serial identity. Opening an arm here would let a
 * caller record a batch or serial claim the dispatch never verified.
 * Registers sinceVersion 1 — no new grammar version; the reference-doc union
 * appends only.
 */
registerLedgerEventType({
  type: 'dispatch.dispatched',
  sinceVersion: 1,
  referenceKinds: ['dispatch'],
  allowsBatchArm: false,
  allowsSerialArm: false,
});

/** The registered definition — `undefined` for an unregistered type. */
export function getLedgerEventType(type: string): LedgerEventTypeDefinition | undefined {
  return REGISTRY.get(type);
}

export function isRegisteredLedgerEventType(type: string): boolean {
  return REGISTRY.has(type);
}