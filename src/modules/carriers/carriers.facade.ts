import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { carrierConnections } from '../../shared/db/schema';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import type { TenantTx } from '../../shared/db/tenant-scope';
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
import { getCarrierAdapter, listCarrierAdapters } from './carrier-registry';
import type { CarrierAdapter } from './carrier-registry';
import { MissingCarrierEncryptionKeyError, openCredential } from './carrier-credentials';
import type { CarrierCredential } from './carrier-credentials';
import {
  carrierConnectionNotFound,
  carrierCredentialUnreadable,
  carrierEncryptionUnavailable,
  invalidCursor,
} from './carriers.errors';
import type { CarrierLabelRequest, CarrierLabelResult } from './carrier-label-port';

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
export type { CarrierLabelRequest, CarrierLabelResult } from './carrier-label-port';

export const DEFAULT_CARRIER_PAGE_SIZE = 50;

/**
 * The one entry the label command (Story 4.6c) uses to reach the port: look
 * the adapter up by code and call its `label` arm. Living here keeps the
 * outbound module's carriers import set to exactly `carriers.facade` — the
 * registry lookup is seam glue, not a registry internal. Unreachable through
 * the command path (the connection's carrier code was validated against the
 * registry at connect time) — a loud stop, not a silent guess.
 */
export async function labelThroughAdapter(
  carrierCode: string,
  credential: CarrierCredential,
  request: CarrierLabelRequest,
): Promise<CarrierLabelResult> {
  const adapter = getCarrierAdapter(carrierCode);
  if (adapter === undefined) {
    throw new Error(`No carrier adapter registered: ${carrierCode}`);
  }
  return adapter.label(credential, request);
}

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
 * Story 4.6c grew the port's first real arm — `labelThroughAdapter` plus the
 * IN-TX passthroughs below, which the shipment command's label arm uses
 * inside its own transaction (the standalone facade `label()` that opened a
 * second transaction had no caller and is gone) — the DIRECT carriers' arms
 * are typed refusals and `sandbox` is the in-process stand-in, so there are
 * still **no network calls** and the backend gains no HTTP client. `rate()`
 * and `track()` remain undeclared (rating: deferred; tracking writeback: the
 * outbox event, Epic 7).
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

  /**
   * The in-transaction passthroughs (the `getPickTasksInTx` precedent):
   * 4-6c's shipment command runs ONE `withTenantTransaction`, and calling a
   * facade method that opens its own would queue a second pool connection
   * inside a held one — the documented pool-nesting deadlock. So the
   * shipment command calls THESE on the same `tx` it already holds.
   */
  async resolveConnectionInTx(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
  ): Promise<CarrierConnectionView | null> {
    if (!UUID_RE.test(connectionId)) {
      return null;
    }
    const rows = await tx
      .select(CONNECTION_COLUMNS)
      .from(carrierConnections)
      .where(and(eq(carrierConnections.id, connectionId), eq(carrierConnections.tenantId, tenantId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toConnectionView(row);
  }

  /** Same contract as `openCredentialForAdapterUse`, inside the caller's tx. */
  async openCredentialForAdapterUseInTx(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
  ): Promise<CarrierCredential> {
    const sealed = await this.readSealedCredentialInTx(tx, tenantId, connectionId);
    if (sealed === null) {
      throw carrierConnectionNotFound();
    }
    return openSealedCredential(sealed, connectionId);
  }

  private async readSealedCredentialInTx(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
  ): Promise<string | null> {
    if (!UUID_RE.test(connectionId)) {
      throw carrierConnectionNotFound();
    }
    const rows = await tx
      .select({ credentialSealed: carrierConnections.credentialSealed })
      .from(carrierConnections)
      .where(and(eq(carrierConnections.id, connectionId), eq(carrierConnections.tenantId, tenantId)))
      .limit(1);
    return rows[0]?.credentialSealed ?? null;
  }
}

/**
 * The one credential-open mapping (the in-tx adapter-use arm's): a missing
 * key and an unopenable blob are the same 503s either way — never a raw 500.
 */
function openSealedCredential(sealed: string, connectionId: string): CarrierCredential {
  try {
    return openCredential(sealed);
  } catch (err) {
    if (err instanceof MissingCarrierEncryptionKeyError) {
      // Same fault, same answer as connect/rotate — never a raw 500.
      throw carrierEncryptionUnavailable();
    }
    // The blob is there and the key is there, but the envelope will not
    // open: the realistic trigger is a key that was changed after this
    // material was sealed (AES-GCM authenticates, so it fails closed rather
    // than handing back garbage). The operator's way out is to rotate the
    // connection under the current key, which the detail says.
    throw carrierCredentialUnreadable(connectionId);
  }
}
