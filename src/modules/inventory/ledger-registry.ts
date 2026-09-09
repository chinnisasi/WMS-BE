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
    };
// Later stories extend this union with NEW kinds (receipt, pick, transfer,
// …) — never by reshaping an existing arm.

/** One registered grammar entry: an event type and what it may carry. */
export interface LedgerEventTypeDefinition {
  /** Registry name — the `ledger_events.type` value (`stock.adjusted`). */
  readonly type: string;
  /** Grammar version that introduced this type (additive evolution). */
  readonly sinceVersion: number;
  /** The `reference_doc.kind` values this event type may carry. */
  readonly referenceKinds: readonly string[];
  /** Story 2.4's batch arm — nothing populates it until that story. */
  readonly allowsBatchArm: boolean;
  /** Story 2.4's serial arm — nothing populates them until that story. */
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
 * producer, exercisable end-to-end. Later stories register their types
 * here (receipts, picks, transfers, …); nothing else may emit events.
 */
registerLedgerEventType({
  type: 'stock.adjusted',
  sinceVersion: 1,
  referenceKinds: ['manual-adjustment'],
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