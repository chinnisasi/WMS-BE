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
    };
// Later stories extend this union with NEW kinds (pick, transfer, …) — never
// by reshaping an existing arm.

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

/** The registered definition — `undefined` for an unregistered type. */
export function getLedgerEventType(type: string): LedgerEventTypeDefinition | undefined {
  return REGISTRY.get(type);
}

export function isRegisteredLedgerEventType(type: string): boolean {
  return REGISTRY.has(type);
}