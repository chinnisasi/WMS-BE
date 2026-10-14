import { UUID_RE } from '../../shared/primitives/ids';
import { fromMilli } from '../../shared/primitives/quantity';
import { ROLE_CAPABILITIES, type Capability } from '../tenancy/permissions';
import { COUNT_VARIANCE_STATUSES, REJECTED_OP_STATUSES, type UserRole } from '../../shared/db/schema';

/**
 * Story 9-2 — the notification panel's sources, as data.
 *
 * Every source is one raise event and its resolve event(s), keyed by a
 * per-occurrence id the raise mints (`source_id`). The event type strings are
 * the EMITTING modules' (`stock_adjustment.*` inventory, `count.variance.*`
 * movements, `over_receipt.*` / `qc_hold.*` inbound, `device.rejected_op.*`
 * tenancy, `replenishment.*` replenishment, `channel.sync.*` channels) —
 * repeated here as literals because the notifications module may import no
 * sibling's internals (AD-6; `test/architecture.spec.ts`), and pinned equal
 * to the emitters' constants by `test/notifications.spec.ts`.
 *
 * The vocabulary is mirrored in three layers (IMPLEMENTATION-GUIDE §4): this
 * tuple, the `notifications_source_type_check` CHECK in
 * `drizzle/0067_notifications.sql`, and the API's discriminated union — the
 * first two pinned together by the notifications suite.
 */
export const NOTIFICATION_SOURCE_TYPES = [
  'stock-adjustment',
  'count-variance',
  'over-receipt',
  'rejected-op',
  'reorder-breach',
  'batch-alert',
  'qc-hold',
  'channel-sync',
  // Story 9-3b — the first PER-USER source: a finished audit export,
  // addressed to its requester only (`recipient_user_id`).
  'audit-export',
  // Story 9-3c — a ledger chain break (inventory's integrity check). Owner
  // only (`ledger.acknowledge`), one entry per break, never pushed.
  'ledger-chain-break',
] as const;

export type NotificationSourceType = (typeof NOTIFICATION_SOURCE_TYPES)[number];

// ── the resolutions — what cleared an entry, per source ─────────────────────

/**
 * Every resolution a source's resolve events can carry (a closed list per
 * source; a resolve outside it is malformed and acked).
 */
/** A status vocabulary minus its one open state — the states a resolve lands on. */
function resolvedStates<const T extends readonly string[]>(statuses: T): readonly Exclude<T[number], 'open'>[] {
  return statuses.filter((status): status is Exclude<T[number], 'open'> => status !== 'open');
}

/**
 * Where the emitter's vocabulary is a shared tuple it is DERIVED here (the
 * variance and rejected-op statuses, minus `open`); the replenishment and
 * channel reasons live in their modules' event files, which this module may
 * not import (AD-6) — `test/notifications.spec.ts` pins those equal.
 */
export const SOURCE_RESOLUTIONS = {
  'stock-adjustment': ['approved', 'rejected'],
  'count-variance': resolvedStates(COUNT_VARIANCE_STATUSES),
  'over-receipt': ['approved', 'rejected'],
  'rejected-op': resolvedStates(REJECTED_OP_STATUSES),
  'reorder-breach': ['recovered', 'dismissed', 'actioned', 'policy-removed'],
  'batch-alert': ['resolved', 'dismissed'],
  'qc-hold': ['released'],
  'channel-sync': ['recovered', 'disconnected'],
  // Story 9-3b — an export's entry stays open until its file expires;
  // downloading does not resolve it (the spec's decision).
  'audit-export': ['expired'],
  // Story 9-3c — open until an owner acknowledges it; detection never
  // auto-heals, so nothing else resolves it.
  'ledger-chain-break': ['acknowledged'],
} as const satisfies Record<NotificationSourceType, readonly string[]>;

// ── the summaries — a per-source allowlist, built key by key ────────────────

export interface StockAdjustmentSummary {
  readonly skuId: string;
  /** Signed, base units of the SKU's UoM. */
  readonly quantityDelta: number;
  readonly reasonCode: string;
}
export interface CountVarianceSummary {
  readonly skuId: string;
  /** Counted − expected, base units. */
  readonly delta: number;
}
export interface OverReceiptSummary {
  readonly grnCode: string;
  readonly skuId: string;
  /** Base units. */
  readonly excessQty: number;
}
export interface RejectedOpSummary {
  readonly opType: string;
  readonly problemCode: string;
}
export interface ReorderBreachSummary {
  readonly skuId: string;
  /** ATP at detection, base units. */
  readonly atpQty: number;
  /** The effective reorder point at detection, base units. */
  readonly pointQty: number;
}
export interface BatchAlertSummary {
  readonly kind: 'expiry_upcoming' | 'aged';
  readonly skuId: string;
  readonly batchCode: string;
  /** The expiry arm only. */
  readonly expiryDate?: string;
  /** The aged arm only — the frozen age in whole days. */
  readonly ageDays?: number;
}
export interface QcHoldSummary {
  readonly skuId: string;
  readonly reason: string;
}
export interface ChannelSyncSummary {
  readonly connectionId: string;
}

/**
 * Story 9-3b — why an export failed: the tenancy module's
 * `AUDIT_EXPORT_FAILURE_REASONS`, repeated as a literal (this module may
 * import no sibling's internals — AD-6) and pinned equal by
 * `test/audit-export.spec.ts`.
 */
export const AUDIT_EXPORT_FAILURE_REASONS = ['too-many-events', 'interrupted', 'export-error'] as const;
export type AuditExportFailureReason = (typeof AUDIT_EXPORT_FAILURE_REASONS)[number];

/** Story 9-3b — one summary arm for both raises (the `BatchAlertSummary` shape). */
export interface AuditExportSummary {
  readonly status: 'ready' | 'failed';
  /** The failed arm only. */
  readonly reason?: AuditExportFailureReason;
  /** The ready arm only — the events in the file. */
  readonly rowCount?: number;
}

/**
 * Story 9-3c — the two ledger integrity event types (inventory's
 * `LEDGER_CHAIN_BROKEN_EVENT` / `LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT`),
 * repeated as literals (AD-6) and pinned equal by
 * `test/ledger-integrity.spec.ts`.
 */
export const LEDGER_CHAIN_BROKEN_EVENT_TYPE = 'ledger.chain_broken';
export const LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT_TYPE = 'ledger.chain_break_acknowledged';
/** Story 9-3c — inventory's break kinds and detectors, repeated here (AD-6) and pinned equal. */
export const CHAIN_BREAK_KINDS = ['chain', 'worm'] as const;
export const CHAIN_BREAK_DETECTORS = ['anchor', 'reverify', 'verify'] as const;

/** Story 9-3c — one ledger chain break. */
export interface LedgerChainBreakSummary {
  readonly kind: (typeof CHAIN_BREAK_KINDS)[number];
  /** The lowest broken seq (a `worm` break: the anchor's first seq). */
  readonly firstSeq: number;
  readonly reason: string;
  readonly detectedBy: (typeof CHAIN_BREAK_DETECTORS)[number];
}

export type NotificationSummary =
  | StockAdjustmentSummary
  | CountVarianceSummary
  | OverReceiptSummary
  | RejectedOpSummary
  | ReorderBreachSummary
  | BatchAlertSummary
  | QcHoldSummary
  | ChannelSyncSummary
  | AuditExportSummary
  | LedgerChainBreakSummary;

/** A raise decoded: the entry's identity, its warehouse, its summary and (9-3b) its recipient. */
export interface DecodedRaise {
  readonly sourceType: NotificationSourceType;
  readonly sourceId: string;
  readonly warehouseId: string | null;
  readonly summary: NotificationSummary;
  /**
   * Story 9-3b — the one member the entry is addressed to; null for every
   * capability-routed source. Carried by the resolve too, so a tombstone
   * (a resolve that arrived first) is never written without it.
   */
  readonly recipientUserId: string | null;
}

/**
 * A resolve decoded: `ignore` is the designed no-op (an under-threshold
 * count variance resolves, but no raise was ever emitted for it, so it must
 * leave no row).
 */
export type DecodedResolve =
  | {
      readonly kind: 'resolve';
      readonly sourceType: NotificationSourceType;
      readonly sourceId: string;
      readonly warehouseId: string | null;
      readonly resolution: string;
      /** Story 9-3b — see `DecodedRaise.recipientUserId`. */
      readonly recipientUserId: string | null;
    }
  | { readonly kind: 'ignore' };

type Payload = Record<string, unknown>;

/** A string field bounded in length (the summary never carries an essay). */
const MAX_TEXT = 500;

function uuid(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function text(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null;
}

function finite(payload: Payload, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An optional warehouse: absent or null is null; anything else must be a uuid. */
function optionalWarehouse(payload: Payload): string | null | undefined {
  const value = payload.warehouseId;
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}

/** Milli-units → base units at the edge; a value the converter refuses is malformed. */
function baseUnits(milli: number): number | null {
  try {
    return fromMilli(milli);
  } catch {
    return null;
  }
}

function oneOf<T extends string>(payload: Payload, key: string, allowed: readonly T[]): T | null {
  const value = payload[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Builds a raise (or null when the payload is malformed — the subscriber
 * acks a malformed publication; no retry can fix a shape).
 */
type RaiseDecoder = (
  payload: Payload,
) => { sourceId: string; warehouseId: string | null; summary: NotificationSummary; recipientUserId?: string } | null;

/** Builds a resolve (null = malformed). */
type ResolveDecoder = (
  payload: Payload,
) => { sourceId: string; warehouseId: string | null; resolution: string; recipientUserId?: string } | 'ignore' | null;

interface SourceSpec {
  readonly raise: { readonly type: string; readonly decode: RaiseDecoder };
  /**
   * Story 9-3b — further raise events of the SAME entry (an export raises on
   * `ready` OR on `failed`, never both: the runner's finish is conditional).
   */
  readonly moreRaises?: readonly { readonly type: string; readonly decode: RaiseDecoder }[];
  readonly resolves: readonly { readonly type: string; readonly decode: ResolveDecoder }[];
}

function withWarehouse<T>(payload: Payload, build: (warehouseId: string | null) => T | null): T | null {
  const warehouseId = optionalWarehouse(payload);
  return warehouseId === undefined ? null : build(warehouseId);
}

/** A resolve whose resolution is fixed by the event type itself. */
function fixedResolve(idKey: string, resolution: string): ResolveDecoder {
  return (payload) => {
    const sourceId = uuid(payload, idKey);
    if (sourceId === null) return null;
    return withWarehouse(payload, (warehouseId) => ({ sourceId, warehouseId, resolution }));
  };
}

/** A resolve whose resolution is a payload field from a closed list. */
function fieldResolve(idKey: string, field: string, allowed: readonly string[]): ResolveDecoder {
  return (payload) => {
    const sourceId = uuid(payload, idKey);
    const resolution = oneOf(payload, field, allowed);
    if (sourceId === null || resolution === null) return null;
    return withWarehouse(payload, (warehouseId) => ({ sourceId, warehouseId, resolution }));
  };
}

export const NOTIFICATION_SOURCES: Readonly<Record<NotificationSourceType, SourceSpec>> = {
  'stock-adjustment': {
    raise: {
      type: 'stock_adjustment.pending_approval',
      decode: (payload) => {
        const sourceId = uuid(payload, 'pendingAdjustmentId');
        const skuId = uuid(payload, 'skuId');
        const quantityDelta = finite(payload, 'quantityDelta');
        const reasonCode = text(payload, 'reasonCode');
        if (sourceId === null || skuId === null || quantityDelta === null || reasonCode === null) return null;
        return withWarehouse(payload, (warehouseId) => ({
          sourceId,
          warehouseId,
          summary: { skuId, quantityDelta, reasonCode } satisfies StockAdjustmentSummary,
        }));
      },
    },
    resolves: [
      { type: 'stock_adjustment.approved', decode: fixedResolve('pendingAdjustmentId', 'approved') },
      { type: 'stock_adjustment.rejected', decode: fixedResolve('pendingAdjustmentId', 'rejected') },
    ],
  },
  'count-variance': {
    raise: {
      type: 'count.variance.threshold_exceeded',
      decode: (payload) => {
        const sourceId = uuid(payload, 'varianceId');
        const skuId = uuid(payload, 'skuId');
        const delta = finite(payload, 'delta');
        if (sourceId === null || skuId === null || delta === null) return null;
        return withWarehouse(payload, (warehouseId) => ({
          sourceId,
          warehouseId,
          summary: { skuId, delta } satisfies CountVarianceSummary,
        }));
      },
    },
    resolves: [
      {
        type: 'count.variance.resolved',
        decode: (payload) => {
          // Only an over-threshold variance was raised; an ordinary one's
          // resolve must leave no row (no raise will ever fill a tombstone).
          // A payload without the flag (an event committed before 9-2)
          // resolves as before — at worst one tombstone per in-flight event.
          if (payload.overThreshold === false) return 'ignore';
          return fieldResolve('varianceId', 'status', SOURCE_RESOLUTIONS['count-variance'])(payload);
        },
      },
    ],
  },
  'over-receipt': {
    raise: {
      type: 'over_receipt.requested',
      decode: (payload) => {
        const sourceId = uuid(payload, 'overReceiptId');
        const grnCode = text(payload, 'grnCode');
        const skuId = uuid(payload, 'skuId');
        const excessQty = finite(payload, 'excessQty');
        if (sourceId === null || grnCode === null || skuId === null || excessQty === null) return null;
        return withWarehouse(payload, (warehouseId) => ({
          sourceId,
          warehouseId,
          summary: { grnCode, skuId, excessQty } satisfies OverReceiptSummary,
        }));
      },
    },
    resolves: [
      { type: 'over_receipt.approved', decode: fixedResolve('overReceiptId', 'approved') },
      { type: 'over_receipt.rejected', decode: fixedResolve('overReceiptId', 'rejected') },
    ],
  },
  'rejected-op': {
    raise: {
      type: 'device.rejected_op.raised',
      decode: (payload) => {
        const sourceId = uuid(payload, 'rejectedOpId');
        const opType = text(payload, 'opType');
        const problemCode = text(payload, 'problemCode');
        if (sourceId === null || opType === null || problemCode === null) return null;
        // A device op names no warehouse the panel can trust — none stored.
        return { sourceId, warehouseId: null, summary: { opType, problemCode } satisfies RejectedOpSummary };
      },
    },
    resolves: [
      {
        type: 'device.rejected_op.resolved',
        decode: (payload) => {
          const sourceId = uuid(payload, 'rejectedOpId');
          const resolution = oneOf(payload, 'status', SOURCE_RESOLUTIONS['rejected-op']);
          if (sourceId === null || resolution === null) return null;
          return { sourceId, warehouseId: null, resolution };
        },
      },
    ],
  },
  'reorder-breach': {
    raise: {
      type: 'replenishment.breach_detected',
      decode: (payload) => {
        const sourceId = uuid(payload, 'breachId');
        const skuId = uuid(payload, 'skuId');
        const atpMilli = finite(payload, 'atpMilli');
        const pointMilli = finite(payload, 'pointMilli');
        if (sourceId === null || skuId === null || atpMilli === null || pointMilli === null) return null;
        const atpQty = baseUnits(atpMilli);
        const pointQty = baseUnits(pointMilli);
        if (atpQty === null || pointQty === null) return null;
        return withWarehouse(payload, (warehouseId) => ({
          sourceId,
          warehouseId,
          summary: { skuId, atpQty, pointQty } satisfies ReorderBreachSummary,
        }));
      },
    },
    resolves: [
      {
        type: 'replenishment.breach_cleared',
        decode: fieldResolve('breachId', 'reason', SOURCE_RESOLUTIONS['reorder-breach']),
      },
    ],
  },
  'batch-alert': {
    raise: {
      type: 'replenishment.batch_alert_raised',
      decode: (payload) => {
        const sourceId = uuid(payload, 'alertId');
        const kind = oneOf(payload, 'kind', ['expiry_upcoming', 'aged'] as const);
        const skuId = uuid(payload, 'skuId');
        const batchCode = text(payload, 'batchCode');
        if (sourceId === null || kind === null || skuId === null || batchCode === null) return null;
        let detected: { expiryDate: string } | { ageDays: number };
        if (kind === 'expiry_upcoming') {
          const expiryDate = text(payload, 'expiryDate');
          if (expiryDate === null || Number.isNaN(Date.parse(expiryDate))) return null;
          detected = { expiryDate };
        } else {
          const ageDays = finite(payload, 'ageDays');
          if (ageDays === null || !Number.isInteger(ageDays) || ageDays < 0) return null;
          detected = { ageDays };
        }
        return withWarehouse(payload, (warehouseId) => ({
          sourceId,
          warehouseId,
          summary: { kind, skuId, batchCode, ...detected } satisfies BatchAlertSummary,
        }));
      },
    },
    resolves: [
      {
        type: 'replenishment.batch_alert_cleared',
        decode: fieldResolve('alertId', 'reason', SOURCE_RESOLUTIONS['batch-alert']),
      },
    ],
  },
  'qc-hold': {
    raise: {
      type: 'qc_hold.placed',
      decode: (payload) => {
        const sourceId = uuid(payload, 'holdId');
        const skuId = uuid(payload, 'skuId');
        const reason = text(payload, 'reason');
        if (sourceId === null || skuId === null || reason === null) return null;
        return withWarehouse(payload, (warehouseId) => ({
          sourceId,
          warehouseId,
          summary: { skuId, reason } satisfies QcHoldSummary,
        }));
      },
    },
    resolves: [{ type: 'qc_hold.released', decode: fixedResolve('holdId', 'released') }],
  },
  'channel-sync': {
    raise: {
      type: 'channel.sync.degraded',
      decode: (payload) => {
        const sourceId = uuid(payload, 'episodeId');
        const connectionId = uuid(payload, 'connectionId');
        if (sourceId === null || connectionId === null) return null;
        return { sourceId, warehouseId: null, summary: { connectionId } satisfies ChannelSyncSummary };
      },
    },
    resolves: [
      {
        type: 'channel.sync.recovered',
        decode: (payload) => {
          const sourceId = uuid(payload, 'episodeId');
          const resolution = oneOf(payload, 'reason', SOURCE_RESOLUTIONS['channel-sync']);
          if (sourceId === null || resolution === null || uuid(payload, 'connectionId') === null) return null;
          return { sourceId, warehouseId: null, resolution };
        },
      },
    ],
  },
  'audit-export': {
    // Story 9-3b (tenancy's runner). The entry is the export's own id,
    // addressed to `requestedBy`; it stores no warehouse.
    raise: {
      type: 'audit_export.ready',
      decode: (payload) => {
        const sourceId = uuid(payload, 'exportId');
        const recipientUserId = uuid(payload, 'requestedBy');
        const rowCount = finite(payload, 'rowCount');
        if (sourceId === null || recipientUserId === null || rowCount === null || !Number.isInteger(rowCount) || rowCount < 0) return null;
        return { sourceId, warehouseId: null, recipientUserId, summary: { status: 'ready', rowCount } satisfies AuditExportSummary };
      },
    },
    moreRaises: [
      {
        type: 'audit_export.failed',
        decode: (payload) => {
          const sourceId = uuid(payload, 'exportId');
          const recipientUserId = uuid(payload, 'requestedBy');
          const reason = oneOf(payload, 'reason', AUDIT_EXPORT_FAILURE_REASONS);
          if (sourceId === null || recipientUserId === null || reason === null) return null;
          return { sourceId, warehouseId: null, recipientUserId, summary: { status: 'failed', reason } satisfies AuditExportSummary };
        },
      },
    ],
    resolves: [
      {
        type: 'audit_export.expired',
        decode: (payload) => {
          const sourceId = uuid(payload, 'exportId');
          const recipientUserId = uuid(payload, 'requestedBy');
          if (sourceId === null || recipientUserId === null) return null;
          return { sourceId, warehouseId: null, recipientUserId, resolution: 'expired' };
        },
      },
    ],
  },
  'ledger-chain-break': {
    // Story 9-3c (inventory's break recorder). The entry is the break row's
    // own id; one per break (a re-detection appends no event). The reason
    // is bounded like every summary text (the recorder's reasons are short).
    raise: {
      type: LEDGER_CHAIN_BROKEN_EVENT_TYPE,
      decode: (payload) => {
        const sourceId = uuid(payload, 'breakId');
        const kind = oneOf(payload, 'kind', CHAIN_BREAK_KINDS);
        const detectedBy = oneOf(payload, 'detectedBy', CHAIN_BREAK_DETECTORS);
        const firstSeq = finite(payload, 'firstSeq');
        const reason = text(payload, 'reason');
        if (sourceId === null || kind === null || detectedBy === null || reason === null) return null;
        if (firstSeq === null || !Number.isInteger(firstSeq) || firstSeq < 1) return null;
        return withWarehouse(payload, (warehouseId) => ({
          sourceId,
          warehouseId,
          summary: { kind, firstSeq, reason, detectedBy } satisfies LedgerChainBreakSummary,
        }));
      },
    },
    resolves: [{ type: LEDGER_CHAIN_BREAK_ACKNOWLEDGED_EVENT_TYPE, decode: fixedResolve('breakId', 'acknowledged') }],
  },
};

/** Every event type the subscriber listens to → how to read it. */
export type EventRoute =
  | { readonly arm: 'raise'; readonly sourceType: NotificationSourceType; readonly decode: RaiseDecoder }
  | { readonly arm: 'resolve'; readonly sourceType: NotificationSourceType; readonly decode: ResolveDecoder };

export const EVENT_ROUTES: ReadonlyMap<string, EventRoute> = new Map(
  NOTIFICATION_SOURCE_TYPES.flatMap((sourceType): [string, EventRoute][] => {
    const spec = NOTIFICATION_SOURCES[sourceType];
    return [
      [spec.raise.type, { arm: 'raise', sourceType, decode: spec.raise.decode }],
      ...(spec.moreRaises ?? []).map((raise): [string, EventRoute] => [
        raise.type,
        { arm: 'raise', sourceType, decode: raise.decode },
      ]),
      ...spec.resolves.map((resolve): [string, EventRoute] => [
        resolve.type,
        { arm: 'resolve', sourceType, decode: resolve.decode },
      ]),
    ];
  }),
);

/** Decodes one event for its route; null = malformed. */
export function decodeRaise(route: Extract<EventRoute, { arm: 'raise' }>, payload: unknown): DecodedRaise | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const decoded = route.decode(payload as Payload);
  if (decoded === null) return null;
  return {
    sourceType: route.sourceType,
    sourceId: decoded.sourceId,
    warehouseId: decoded.warehouseId,
    summary: decoded.summary,
    recipientUserId: decoded.recipientUserId ?? null,
  };
}

export function decodeResolve(route: Extract<EventRoute, { arm: 'resolve' }>, payload: unknown): DecodedResolve | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const decoded = route.decode(payload as Payload);
  if (decoded === null) return null;
  if (decoded === 'ignore') return { kind: 'ignore' };
  return {
    kind: 'resolve',
    sourceType: route.sourceType,
    sourceId: decoded.sourceId,
    warehouseId: decoded.warehouseId,
    resolution: decoded.resolution,
    recipientUserId: decoded.recipientUserId ?? null,
  };
}

// ── routing: who sees what ──────────────────────────────────────────────────

/**
 * Who can ACT on each source — the capability its resolving command
 * enforces (never the payloads' `notifyRole` hints, which disagree). The
 * count variance is special: its over-threshold resolution is owner-only by
 * the resolve command's frozen-threshold guard (`count.command.ts`), not by
 * a capability, so the rule is a role.
 *
 * Story 9-3b — the first PER-USER audience: `{capability, recipient: true}`
 * means the role must hold the capability AND the entry is served only to
 * its `recipient_user_id` (the reads add `recipient_user_id IS NULL OR
 * recipient_user_id = $me`, so every capability-routed source is unchanged).
 */
export type SourceAudience =
  | { readonly capability: Capability; readonly recipient?: undefined }
  | { readonly capability: Capability; readonly recipient: true }
  | { readonly role: 'owner' };

export const SOURCE_AUDIENCE: Readonly<Record<NotificationSourceType, SourceAudience>> = {
  'stock-adjustment': { capability: 'adjustments.approve' },
  'count-variance': { role: 'owner' },
  'over-receipt': { capability: 'review.decide' },
  'rejected-op': { capability: 'review.decide' },
  'reorder-breach': { capability: 'replenishment.manage' },
  'batch-alert': { capability: 'replenishment.manage' },
  'qc-hold': { capability: 'qc.manage' },
  'channel-sync': { capability: 'channel.manage' },
  'audit-export': { capability: 'audit.view', recipient: true },
  // Story 9-3c — the capability of the command that resolves it (the
  // acknowledge): owner-only.
  'ledger-chain-break': { capability: 'ledger.acknowledge' },
};

/** The source types a role sees — an allowlist; an unknown role sees none. */
export function visibleSourceTypes(role: UserRole): NotificationSourceType[] {
  const capabilities = ROLE_CAPABILITIES[role];
  if (capabilities === undefined) return [];
  return NOTIFICATION_SOURCE_TYPES.filter((sourceType) => {
    const audience = SOURCE_AUDIENCE[sourceType];
    return 'role' in audience ? role === audience.role : capabilities.has(audience.capability);
  });
}
