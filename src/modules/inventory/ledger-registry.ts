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
      /**
       * Story 9-3a — the pending adjustment an approval posted (set ONLY by
       * `AdjustmentApprovalCommand.decide`'s approve arm), so the adjustment
       * links to its events (`GET …/inventory/events?adjustmentPendingId=`).
       *
       * Optional and additive, and OMITTED when absent — never `null`: the
       * canonical bytes `JSON.stringify` hashes drop an absent key, so every
       * event without it (all pre-9-3a events, every immediate adjustment)
       * keeps its bytes. Pinned by `test/adjustment-approval.spec.ts` (the
       * immediate path's hash recomputes from the three pre-9-3a keys, and
       * a `null` key would change it).
       */
      readonly adjustmentPendingId?: string;
      /**
       * Story 9-3a — the count variance a resolution corrected (set ONLY by
       * `CountCommandService.resolveCountVariance`'s approve-adjust arm).
       * Optional, additive and omitted when absent, like `adjustmentPendingId`.
       */
      readonly countVarianceId?: string;
    }
  // Story 3.3 — the receipt arm: every `grn.received` movement names the GRN
  // it landed under, and (when received against a purchase order) the PO and
  // the exact line. NEW union arm — `manual-adjustment` is never reshaped.
  | {
      readonly kind: 'grn-receipt';
      readonly grnId: string;
      /** Absent on a blind receipt's events (no PO to name) and on an ASN's. */
      readonly poId?: string;
      /** Absent on the blind arm, an unmatched line, and an approved-excess event with no line. */
      readonly poLineId?: string;
      /**
       * Story 21-6 — the advance shipment notice received against, and the
       * ASN line credited. ADDITIVE optional keys, omitted when absent (on
       * submit AND approve), so a PO or blind event's canonical bytes are
       * unchanged.
       */
      readonly asnId?: string;
      readonly asnLineId?: string;
      /**
       * Story 2-4a — the GRN line a `grn.damaged` intake came from (the
       * vendor claim and 2.8's return-to-vendor need it). ADDITIVE optional
       * key, written ONLY on `grn.damaged` and omitted everywhere else, so
       * every `grn.received` event's canonical bytes are unchanged.
       */
      readonly grnLineId?: string;
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
      /**
       * Story 2-8a — the GRN line of a RECEIPT hold, on its `qc.failed`
       * events only (the credited DAMAGED units 2-8b's return to vendor must
       * tell apart from 2-4a damage). ADDITIVE optional key, omitted when
       * absent — never `null` — so every earlier event keeps its bytes.
       */
      readonly grnLineId?: string;
      /**
       * Story 2-8a — the inspection that closed the hold, on the
       * inspection's `qc.released` (passed units) and `qc.failed` (failed
       * units) events. Optional, additive and omitted when absent.
       */
      readonly inspectionId?: string;
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
    }
  // Story 12-5 — the excursion arm (FR-44): every `excursion.recorded` event
  // names the excursion row it belongs to, the origin bin the reading was
  // taken against, and the reading itself. The event is the ledger's ONLY
  // record of the excursion (AD-6/AD-11 — no side book), so the arm carries
  // enough for FR-45 to reconstruct the excursion from the ledger alone.
  // One event is written per AFFECTED (sku, bin) scope — `skuId` is never
  // null on a ledger event, so a bin holding several SKUs produces one event
  // per scope — and the event is ZERO-quantity like pack/dispatch (the
  // quarantine of the affected units is the QC-hold movements' work, which
  // ride their own `qc.held` events beside these). NEW union arm — the
  // earlier kinds are never reshaped.
  | {
      readonly kind: 'excursion';
      readonly excursionId: string;
      /** The origin bin the reading was recorded against. */
      readonly binId: string;
      /** The operator-captured reading, °C. */
      readonly readingC: number;
    }
  // Story 5-1 — the transfer arm: every `transfer.outbound` /
  // `transfer.inbound` movement names the transfer order and the line whose
  // units moved (the pick arm's line-level precedent — the two legs correlate
  // by `transferId`, and the detail read re-derives both legs from the events
  // alone). NEW union arm — the earlier kinds are never reshaped.
  | {
      readonly kind: 'transfer';
      readonly transferId: string;
      /** Absent on a ZERO-line transfer (which cannot exist today — ≥1 line). */
      readonly lineId?: string;
    }
  // Story 13-2 — the return-receipt arm: every `return.received` movement
  // names the return receipt it landed under, the return authorization it was
  // received against and the exact authorization line credited. All three are
  // always present (a receipt books only entries that matched a line). NEW
  // union arm — the earlier kinds are never reshaped.
  | {
      readonly kind: 'return-receipt';
      readonly returnReceiptId: string;
      readonly rmaId: string;
      readonly rmaLineId: string;
    }
  // Story 4-7a — the return-disposition arm: every `return.restocked` /
  // `return.scrapped` event names the disposition it books, the receipt line
  // it draws from, the authorization and the outcome. `reasonCode` (a scrap)
  // and `handlingUnitIds` (a returned case) are OMITTED when absent, never
  // `null` (the 9-3a rule), so every event carries exactly what was decided.
  // NEW union arm — the earlier kinds are never reshaped.
  | {
      readonly kind: 'return-disposition';
      readonly dispositionId: string;
      readonly returnReceiptLineId: string;
      readonly rmaId: string;
      readonly outcome: 'restock' | 'scrap';
      readonly reasonCode?: string;
      readonly handlingUnitIds?: readonly string[];
    }
  // Story 4-7b — the return-reversal arm: every `return.reversed` event names
  // the blind return authorization whose booking a reviewer rejected, the
  // receipt line it reverses and the reject reason. All three always present.
  // NEW union arm — the earlier kinds are never reshaped.
  | {
      readonly kind: 'return-reversal';
      readonly rmaId: string;
      readonly returnReceiptLineId: string;
      readonly reasonCode: string;
    }
  // Story 4-2b — the restock arm: every `pick.restocked` event names the
  // cancel-with-restock it belongs to (`restockId` — one per command, shared
  // by all its events), the order and order line whose draw it reverses, the
  // pick line that drew it and the exact `pick.picked` event (`drawEventId`)
  // it reverses — one restock per draw, so "what is still to put back" is the
  // draws without a restock naming them. NEW union arm — the earlier kinds
  // are never reshaped.
  | {
      readonly kind: 'restock';
      readonly restockId: string;
      readonly orderId: string;
      readonly orderLineId: string;
      readonly picklistLineId: string;
      readonly drawEventId: string;
    }
  // Story 3-1 — the bin-to-bin move arm: every `stock.moved` event names the
  // move it belongs to (one move = one request: a batch arm, or one event per
  // serial unit), the operator's reason code and — only when given — the
  // note. The note is OMITTED when absent, never `null` (the 9-3a rule), so
  // the canonical bytes carry exactly what was said. NEW union arm — the
  // earlier kinds are never reshaped.
  | {
      readonly kind: 'bin-move';
      readonly moveId: string;
      /** The move reason (`MOVE_REASON_CODES`, movements/move-reason.ts). */
      readonly reasonCode: string;
      /** The operator's note, trimmed; present only when one was given. */
      readonly note?: string;
    }
  // Story 2-8b — the vendor-return arm: every `rtv.dispatched` event names the
  // return-to-vendor document it left under and the exact line dispatched
  // (`vendorReturnLineId` — named so it cannot be read as a PO or GRN line)
  // and, only when the line names one, the GRN line the units came from (the
  // vendor's debit-note source). `grnLineId` is OMITTED when absent, never
  // `null` (the 9-3a rule). NEW union arm — the earlier kinds are never
  // reshaped.
  | {
      readonly kind: 'vendor-return';
      readonly vendorReturnId: string;
      readonly vendorReturnLineId: string;
      readonly grnLineId?: string;
    };
// Later stories extend this union with NEW kinds — never by reshaping an
// existing arm.

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
 * first). Story 2-6a opens the serial arm: a serial-tracked line books ONE
 * event per captured unit (+1, `serialRef` = the catalog serial id, the
 * line's batch carried) — at submit for the applied units, at over-receipt
 * approval for the pending ones. Additive: every older event carries a null
 * serial arm and verifies identically; the flag gates new writes only.
 */
registerLedgerEventType({
  type: 'grn.received',
  sinceVersion: 1,
  referenceKinds: ['grn-receipt'],
  allowsBatchArm: true,
  allowsSerialArm: true,
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
 * Grammar v1, Story 4-2b — the restock of a cancelled order's drawn units: a
 * pure INTAKE (`fromBinId` null, `toBinId` the destination — the
 * `grn.received` convention), the exact reversal of ONE `pick.picked` draw
 * (its magnitude, its batch arm and its serial arm; the reference names the
 * draw). Written only by `CancelRestockCommandService` after every placement
 * gate and the reconcile-quarantine check on the destination. The serial
 * guard admits it as a re-entry (a serial whose latest event is the draw has
 * `toBinId` null), and the command first proves that latest event IS this
 * draw (409 `restock-serial-moved` otherwise). Both identity arms are OPEN.
 * The reconcile and metering folds read it by its bin arms (`['to']` — on-hand
 * rises); it nets the pick (`PICK_NETTING_TYPES`), so a recall's held and
 * dispatched figures exclude restocked units. Not a billed movement type.
 * Registers sinceVersion 1.
 */
registerLedgerEventType({
  type: 'pick.restocked',
  sinceVersion: 1,
  referenceKinds: ['restock'],
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

/**
 * Grammar v1, Story 12-5 — the temperature excursion (FR-44): one ZERO-delta
 * event per AFFECTED (sku, bin) scope, recording that a temperature excursion
 * was observed against the bin and that the scope's stock was quarantined.
 * The third non-movement type, for the same reason as pack/dispatch: the
 * affected units' actual relocation is the ordinary QC-hold semantics'
 * `qc.held` movements (the excursion records a hold per scope beside these
 * events), so the event carries `quantityDelta: 0` with both bin arms null
 * and folds no projection. What it durably records is the excursion itself —
 * the reference doc names the excursion row, the origin bin and the reading,
 * which is the whole FR-45 reconstruction contract from the ledger alone.
 *
 * Both identity arms stay CLOSED, like pack/dispatch: the excursion recounts
 * neither batches nor serials (it is a reading against a bin, and the
 * per-scope identity rides `skuId`), and opening an arm would let a caller
 * record a batch/serial claim the reading never made. Registers
 * sinceVersion 1 — no new grammar version; the reference-doc union appends
 * only.
 */
registerLedgerEventType({
  type: 'excursion.recorded',
  sinceVersion: 1,
  referenceKinds: ['excursion'],
  allowsBatchArm: false,
  allowsSerialArm: false,
});

/**
 * Grammar v1, Story 5-1 — the transfer outbound leg: one event per (sku,
 * batch) arm of each line, moving the units from the line's source bin into
 * the source warehouse's system IN-TRANSIT bin (a RELOCATION — fromBin +
 * toBin carried on ONE event, the putaway/merge convention; the magnitude
 * folds both projections from the single delta). The units leave the source
 * bin and the source warehouse's ATP drops by exactly that quantity
 * (`inTransitUnits` — the stock now sits in the IN-TRANSIT bin, which the
 * hook counts). Serial-tracked lines carry one event per serial unit
 * (magnitude 1, the batch arm carried with it — the putaway convention), and
 * the outbound leg's serial events are the identity source the inbound leg
 * derives its arms from (the qc.released precedent). Registers sinceVersion
 * 1 — no new grammar version; the reference-doc union appends only.
 */
registerLedgerEventType({
  type: 'transfer.outbound',
  sinceVersion: 1,
  referenceKinds: ['transfer'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 5-1 — the transfer inbound leg: one event per (sku,
 * batch) arm moving the parked units out of the in-transit bin. TWO shapes,
 * one per warehouse topology, both carrying `referenceDoc {kind:'transfer'}`:
 * - same warehouse: a RELOCATION from the warehouse's system IN-TRANSIT bin
 *   into the destination bin (both bin arms carried, one chain);
 * - cross warehouse: a pure DRAW on the SOURCE chain (`fromBinId` = the
 *   source IN-TRANSIT bin, `toBinId` null — the `pick.picked` precedent: the
 *   units leave that chain entirely) beside an INTAKE on the DESTINATION
 *   chain (`fromBinId` null, `toBinId` = the destination bin), written in ONE
 *   transaction so a rollback rolls back both chains. Serial arms derive
 *   from the outbound leg's own events — exactly the units that were parked,
 *   never a re-scan. Registers sinceVersion 1 — no new grammar version; the
 *   reference-doc union appends only.
 */
registerLedgerEventType({
  type: 'transfer.inbound',
  sinceVersion: 1,
  referenceKinds: ['transfer'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 13-2 — the return receipt (FR-47): one POSITIVE INTAKE per
 * applied entry, landing the returned units in the warehouse's system
 * RETURNS bin from no bin (`fromBinId` null, `toBinId` = RETURNS — never a
 * sign-flipped `grn.received`, never a reversal of the dispatch: receiving
 * analytics and inbound KPIs stay clean, the ledger stays append-only). The
 * units are then "received, awaiting disposition": on-hand, but excluded
 * from ATP by `returnsAwaitingUnits` until 13-3 dispositions them. The event
 * time is the op's device `occurredAt`; the client is the SKU's (21-2b).
 *
 * BOTH identity arms are OPEN: a batch-tracked unit carries the batch it was
 * picked from (re-used, never created — the serial's own pick `batchRef` for
 * a batch-and-serial SKU), and a serial-tracked unit carries its serial —
 * one event per serial unit, magnitude 1. The serial guard admits the intake
 * because the serial's latest event is its `pick.picked` DRAW (`toBinId`
 * null): out of stock, free to re-enter. Reconcile and metering fold it by
 * its bin arms with no change. Registers sinceVersion 1 — no new grammar
 * version; the reference-doc union appends only.
 */
registerLedgerEventType({
  type: 'return.received',
  sinceVersion: 1,
  referenceKinds: ['return-receipt'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 2-4a — the damaged receipt intake: one POSITIVE INTAKE per
 * GRN line that arrived with damaged units, landing them in the warehouse's
 * system DAMAGED bin from no bin (`fromBinId` null, `toBinId` = DAMAGED) — the
 * `return.received` intake precedent, never a `grn.received` into another
 * bin: `grn.received` means "a credited receipt into Receiving", and putaway,
 * the billing notes and over-receipt approval all reason about it, so a
 * distinct type leaves each of them unchanged. The units are on-hand but
 * excluded from ATP by `damagedUnits`; they leave by a write-off (a
 * negative `stock.adjusted` out of DAMAGED) or a return to vendor (2-8b's
 * `rtv.dispatched`). The reference is the receipt arm
 * (`grn-receipt`): the GRN, the header's PO or ASN (never a line — damaged
 * units credit no document line) and the `grnLineId`. The batch arm is OPEN
 * (a batch-tracked line's damaged units keep their batch); the serial arm is
 * CLOSED — damage on a serial-tracked line is refused at receipt (decision 9).
 * Reconcile and metering fold it by its bin arms unchanged (it bills storage
 * like any on-hand — decision 8). Registers sinceVersion 1 — no new grammar
 * version; the reference arm gains one optional key only.
 */
registerLedgerEventType({
  type: 'grn.damaged',
  sinceVersion: 1,
  referenceKinds: ['grn-receipt'],
  allowsBatchArm: true,
  allowsSerialArm: false,
});

/**
 * Grammar v1, Story 2-8a — the QC inspection's failed units: a RELOCATION
 * from the warehouse's system QC-hold bin into its system DAMAGED bin on the
 * same batch arm (`fromBinId` QC-HOLD, `toBinId` DAMAGED, one event per arm
 * with failed units). The reference is the hold arm (`qc-hold`) with the
 * `inspectionId` and, for a receipt hold, the `grnLineId` — the failed units
 * stay credited on their document line (they were received), which is what
 * tells them apart from 2-4a's `grn.damaged`. In DAMAGED the units fall under
 * `damagedUnits` (ATP-excluded, write-off only) exactly like 2-4a damage. It
 * meters 0 (a `both`-shape relocation: storage continues). The batch arm is
 * OPEN; the serial arm CLOSED (serial-tracked stock is never QC-held).
 * Registers sinceVersion 1 — no new grammar version.
 */
registerLedgerEventType({
  type: 'qc.failed',
  sinceVersion: 1,
  referenceKinds: ['qc-hold'],
  allowsBatchArm: true,
  allowsSerialArm: false,
});

/**
 * Grammar v1, Story 3-1 — the bin-to-bin move: stock relocating between two
 * bins of ONE warehouse on the operator's say-so (the handheld's `stock.move`
 * op or the web Moves page). A RELOCATION like putaway and merge — `fromBinId`
 * (the origin) and `toBinId` (the target) on ONE event, the magnitude folding
 * both projections, so the origin is debited and the target credited in the
 * same transaction. One event per batch arm; a serial-tracked move writes one
 * magnitude-1 event per serial unit, each carrying the batch its latest event
 * carried (the merge convention). Both identity arms are open. It meters 0
 * (a `both`-shape event) and changes no ATP: both bins are storage bins.
 * Registers sinceVersion 1 — no new grammar version; the reference-doc union
 * appends only.
 */
registerLedgerEventType({
  type: 'stock.moved',
  sinceVersion: 1,
  referenceKinds: ['bin-move'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 4-7a — the restock of a returned unit (FR-48): a
 * RELOCATION from the warehouse's system RETURNS bin into a storage bin
 * (`fromBinId` RETURNS, `toBinId` the target — the putaway/move convention,
 * one event folding both bins), after every placement gate. The units leave
 * "awaiting disposition" (`returnsAwaitingUnits`) and join ATP. One event
 * per disposition; a serial-tracked unit is one magnitude-1 event carrying
 * its serial (the serial guard admits it: its latest event is the
 * `return.received` intake into RETURNS). Both identity arms are OPEN. It
 * meters 0 (a `both`-shape relocation). Registers sinceVersion 1.
 */
registerLedgerEventType({
  type: 'return.restocked',
  sinceVersion: 1,
  referenceKinds: ['return-disposition'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 4-7a — the scrap of a returned unit: a pure DRAW out of
 * the system RETURNS bin (`fromBinId` RETURNS, `toBinId` null — the
 * `pick.picked` / write-off convention), with the reason on the reference.
 * Never a negative `stock.adjusted`: a scrapped return is a disposition of a
 * return, and adjustment analytics stay clean. Both identity arms are OPEN
 * (a scrapped serial leaves stock — its latest event names no bin). It meters
 * `['from']` (on-hand drops). Registers sinceVersion 1.
 */
registerLedgerEventType({
  type: 'return.scrapped',
  sinceVersion: 1,
  referenceKinds: ['return-disposition'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 4-7b — the reversal of a blind return's booking at
 * review (decision 8): a reviewer rejected a parcel the handheld received
 * with no RMA (mis-scanned, not the client's goods, a duplicate), so each of
 * its receipt lines' `return.received` intakes is undone by a pure DRAW out
 * of the system RETURNS bin (`fromBinId` RETURNS, `toBinId` null — the
 * `return.scrapped` convention), never a negative `return.received` and never
 * a `stock.adjusted` (adjustment analytics stay clean). Both identity arms
 * are OPEN: a reversed serial leaves stock (its latest event names no bin),
 * so a correct re-receipt of the same unit passes `serial-in-stock`. It
 * meters `['from']` (storage accrued for exactly the hours the units were
 * booked — A26). The recall trace nets it against `returned` (D5).
 * Registers sinceVersion 1 — no new grammar version.
 */
registerLedgerEventType({
  type: 'return.reversed',
  sinceVersion: 1,
  referenceKinds: ['return-reversal'],
  allowsBatchArm: true,
  allowsSerialArm: true,
});

/**
 * Grammar v1, Story 2-8b — the return to vendor: a pure DRAW out of the
 * warehouse's system DAMAGED bin (`fromBinId` DAMAGED, `toBinId` null — the
 * `pick.picked` / write-off convention), one event per dispatched line with
 * its batch arm, written at the RTV's dispatch — the one moment the units
 * leave the building (the handheld pick moves nothing). The reference is the
 * vendor-return arm (the document, the line, and the source GRN line when
 * the line names one). ATP-neutral: `damagedUnits` and on-hand drop together.
 * It meters `['from']` (storage stops the day the units leave). The batch arm
 * is OPEN; the serial arm CLOSED — DAMAGED holds no serial-tracked units
 * (`grn.damaged` and `qc.failed` keep theirs closed; the RTV refuses a serial
 * line, 409 `rtv-sku-unsupported`). Reconcile and replay fold it by its bin
 * arms unchanged. Registers sinceVersion 1 — no new grammar version.
 */
registerLedgerEventType({
  type: 'rtv.dispatched',
  sinceVersion: 1,
  referenceKinds: ['vendor-return'],
  allowsBatchArm: true,
  allowsSerialArm: false,
});

/** The registered definition — `undefined` for an unregistered type. */
export function getLedgerEventType(type: string): LedgerEventTypeDefinition | undefined {
  return REGISTRY.get(type);
}

export function isRegisteredLedgerEventType(type: string): boolean {
  return REGISTRY.has(type);
}
/**
 * Story 9-1 — every registered type, in registration order: the timeline's
 * `type` filter validates against it (an unknown type is a 400 naming the
 * known set, never a silently empty page). Read at call time, never frozen
 * into a module-load constant, so a type registered later is admitted too.
 */
export function registeredLedgerEventTypes(): readonly string[] {
  return [...REGISTRY.keys()];
}
