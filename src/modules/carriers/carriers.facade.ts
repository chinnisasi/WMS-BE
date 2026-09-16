import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { carrierConnections } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { buildPage, decodeCursor } from '../../shared/primitives/pagination';
import type { Page } from '../../shared/primitives/pagination';
import { CarrierCommandService, CONNECTION_COLUMNS, toConnectionView } from './carrier.command';
import type {
  CarrierConnectionView,
  ConnectCarrierCommand,
  DisconnectCarrierCommand,
  RotateCarrierCredentialCommand,
} from './carrier.command';
import { listCarrierAdapters } from './carrier-registry';
import type { CarrierAdapter } from './carrier-registry';
import { openCredential } from './carrier-credentials';
import type { CarrierCredential } from './carrier-credentials';
import { carrierConnectionNotFound, invalidCursor } from './carriers.errors';

// The facade is the only sibling-facing seam (AD-6, architecture test): the
// shapes a consumer needs ride along here so nothing imports the module's
// internals. 4-6c's labels and (deferred) rating consume THIS file.
export type {
  CarrierConnectionView,
  ConnectCarrierCommand,
  DisconnectCarrierCommand,
  RotateCarrierCredentialCommand,
} from './carrier.command';
export type { CarrierAdapter, CarrierCredentialField } from './carrier-registry';
export type { CarrierCredential } from './carrier-credentials';

export const DEFAULT_CARRIER_PAGE_SIZE = 50;

export interface ListCarrierConnectionsQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The cursor is opaque to clients but crafted input is still possible — a
 * base64-valid payload with a non-uuid `id` would reach the `::uuid` cast in
 * SQL and surface as a 500 instead of a 400 (the shared `decodeCursorSafe`
 * pattern; `UUID_RE` is retro A3's one matcher).
 */
const CURSOR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function decodeCursorSafe(cursor: string): { createdAt: string; id: string } {
  let decoded: { createdAt: string; id: string };
  try {
    decoded = decodeCursor(cursor);
  } catch {
    throw invalidCursor();
  }
  // `Date.parse` alongside the shape regex: a shape-valid but impossible
  // instant (month 99) would otherwise reach the `::timestamptz` cast as a
  // 500 (the tenancy.service pattern).
  if (
    !UUID_RE.test(decoded.id) ||
    !CURSOR_INSTANT_RE.test(decoded.createdAt) ||
    Number.isNaN(Date.parse(decoded.createdAt))
  ) {
    throw invalidCursor();
  }
  return decoded;
}

/**
 * The carriers module's public surface (Story 4.6b) — the ONLY way any other
 * module, or the api shell, reaches carrier state (AD-6). Two halves, exactly
 * as the story describes them:
 *
 *  - the **adapter registry** (`catalogue()`): which carriers exist and what
 *    each needs to be configured with. Compile-time, additive, no DB.
 *  - the **credential vault**: the tenant's configured accounts — connect,
 *    rotate and disconnect through the command service, plus the read seam.
 *
 * `listConnections` and `resolveConnection` return the connection's PUBLIC
 * FACE only: the sealed blob is not even selected (`CONNECTION_COLUMNS`), so
 * there is no path by which a list row could grow a secret.
 *
 * This story makes **no network calls** — `rate()`, `label()` and `track()`
 * are deliberately not declared anywhere. The port grows those arms in the
 * story that consumes them (labels: 4-6c; rating: deferred).
 */
@Injectable()
export class CarriersFacade {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CarrierCommandService) private readonly commands: CarrierCommandService,
  ) {}

  /**
   * The registry catalogue — code, display name, credential fields. How any
   * future surface learns what to ask an operator for (the credential shape
   * is never hard-coded client-side).
   */
  catalogue(): readonly CarrierAdapter[] {
    return listCarrierAdapters();
  }

  /** `carrier.manage` — seals a tenant's credential for one carrier. */
  async connect(
    command: ConnectCarrierCommand,
    idempotencyKey: string,
  ): Promise<CarrierConnectionView> {
    return this.commands.connect(command, idempotencyKey);
  }

  /** `carrier.manage` — replaces the material in place, keeping the row id. */
  async rotate(
    command: RotateCarrierCredentialCommand,
    idempotencyKey: string,
  ): Promise<CarrierConnectionView> {
    return this.commands.rotate(command, idempotencyKey);
  }

  /** `carrier.manage` — the hard delete (AD-15: disconnect deletes). */
  async disconnect(
    command: DisconnectCarrierCommand,
    idempotencyKey: string,
  ): Promise<CarrierConnectionView> {
    return this.commands.disconnect(command, idempotencyKey);
  }

  /** The tenant's configured connections — a read, open to any member. */
  async listConnections(
    tenantId: string,
    query: ListCarrierConnectionsQuery = {},
  ): Promise<Page<CarrierConnectionView>> {
    // The route DTO already bounds `limit` (1..200) — pass it through;
    // clamping here would silently rewrite a bad request instead of
    // rejecting it.
    const pageSize = query.limit ?? DEFAULT_CARRIER_PAGE_SIZE;
    const before = query.cursor === undefined ? undefined : decodeCursorSafe(query.cursor);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select(CONNECTION_COLUMNS)
        .from(carrierConnections)
        .where(
          and(
            eq(carrierConnections.tenantId, tenantId),
            before === undefined
              ? undefined
              : sql`(${carrierConnections.createdAt}, ${carrierConnections.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`,
          ),
        )
        .orderBy(desc(carrierConnections.createdAt), desc(carrierConnections.id))
        .limit(pageSize + 1);
      return buildPage(rows.map(toConnectionView), pageSize);
    });
  }

  /** One connection by id, or null — cross-tenant ids are simply invisible. */
  async resolveConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<CarrierConnectionView | null> {
    if (!UUID_RE.test(connectionId)) {
      return null;
    }
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select(CONNECTION_COLUMNS)
        .from(carrierConnections)
        .where(
          and(eq(carrierConnections.id, connectionId), eq(carrierConnections.tenantId, tenantId)),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toConnectionView(row);
    });
  }

  /**
   * **The adapter-use seam, and the only read that opens the envelope.**
   *
   * It exists for the stories that actually call a carrier — 4-6c's labels,
   * and rating when it lands: they resolve a connection id, open its material
   * here, and hand it straight to the carrier client they own. Nothing in
   * THIS story calls it (4.6b makes no network calls).
   *
   * The rules for any caller, and they are not negotiable: the returned
   * record is request-scoped plaintext — never logged, never in a response
   * DTO, an outbox payload, an audit row, a ledger reference doc or an
   * idempotency snapshot, and never persisted anywhere. A caller that must
   * remember WHICH credential it used stores the connection id and
   * `credentialVersion`, which is exactly why rotation keeps the row id.
   */
  async openCredentialForAdapterUse(
    tenantId: string,
    connectionId: string,
  ): Promise<CarrierCredential> {
    if (!UUID_RE.test(connectionId)) {
      throw carrierConnectionNotFound();
    }
    const sealed = await withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ credentialSealed: carrierConnections.credentialSealed })
        .from(carrierConnections)
        .where(
          and(eq(carrierConnections.id, connectionId), eq(carrierConnections.tenantId, tenantId)),
        )
        .limit(1);
      return rows[0]?.credentialSealed ?? null;
    });
    if (sealed === null) {
      throw carrierConnectionNotFound();
    }
    return openCredential(sealed);
  }
}
