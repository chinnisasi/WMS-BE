import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_CLIENT_LIST, clients, type ClientStatus } from './clients.schema';

/** One client as every read of this module returns it. */
export interface ClientSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly status: ClientStatus;
  /** True only for the tenant's own `self` client (its goods, its invoices). */
  readonly systemOwned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The facts the attribution rules need about one client (bulk read). */
export interface ClientFacts {
  readonly id: string;
  readonly code: string;
  readonly systemOwned: boolean;
}

export function toClientSnapshot(row: typeof clients.$inferSelect): ClientSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    status: row.status as ClientStatus,
    systemOwned: row.systemOwned,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/**
 * The clients module's read seam (story 21-2b). Sibling modules reach the
 * `clients` table ONLY through this file and `ensure-self-client.ts` — the
 * file-level `…InTx` functions run on the CALLER's transaction (the
 * `ensureSelfClientInTx` seam shape), the injectable facade owns its own.
 */
@Injectable()
export class ClientsFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Every client of the tenant, any status — the system-owned `self` client
   * first, then by code. Bounded at `MAX_CLIENT_LIST` (unpaginated by
   * design: the list feeds pickers that need the whole set). A read —
   * member-open, never capability-gated.
   */
  async listClients(tenantId: string): Promise<ClientSnapshot[]> {
    return withTenantTransaction(this.db, tenantId, (tx) => listClientsInTx(tx, tenantId));
  }
}

export async function listClientsInTx(tx: TenantTx, tenantId: string): Promise<ClientSnapshot[]> {
  const rows = await tx
    .select()
    .from(clients)
    .where(eq(clients.tenantId, tenantId))
    .orderBy(desc(clients.systemOwned), asc(clients.code))
    .limit(MAX_CLIENT_LIST);
  return rows.map(toClientSnapshot);
}

/**
 * The client must exist in this tenant — 404 `not-found` otherwise (a
 * foreign tenant's client is indistinguishable from an unknown id). Returns
 * the row's facts.
 */
export async function assertClientInTenantInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<ClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return row;
}

/** A client's facts plus its status — what a priced relationship checks (21-3). */
export interface LockedClientFacts extends ClientFacts {
  readonly status: ClientStatus;
}

/**
 * Story 21-3 — lock the client row (`FOR UPDATE`) on the caller's
 * transaction and return its facts, 404 `not-found` when absent. The rate-card
 * activation and cancel commands serialise on it: every card transition of
 * one client runs under this one row lock, so two activations can never
 * interleave. A lock, never a write — the clients module still owns the table.
 */
export async function lockClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<LockedClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return { ...row, status: row.status as ClientStatus };
}

/** The client's status alongside its facts, without a lock (21-3's draft create). */
export async function getClientStatusInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<LockedClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return { ...row, status: row.status as ClientStatus };
}

/** Bulk facts for a set of client ids (one query; unknown ids are absent). */
export async function getClientsInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, ClientFacts>> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: clients.id, code: clients.code, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, distinct)));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Bulk id → the label a refusal prints (story 21-2b): another client by its
 * code; the tenant's own client as "<tenant name> (your company)" — never
 * the internal `self` code, which means nothing to an operator. (The self
 * client's name mirrors the tenant name.) Unknown ids are absent.
 */
export async function getClientLabelsInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, distinct)));
  return new Map(rows.map((row) => [row.id, clientLabel(row)]));
}

/** One client's refusal label (see `getClientLabelsInTx`). */
export function clientLabel(row: { code: string; name: string; systemOwned: boolean }): string {
  return row.systemOwned ? `${row.name} (your company)` : row.code;
}

/**
 * The ONE attribution rule for a document derived from its SKUs (an order,
 * a PO, a kit, a product's variants): every SKU's client must be the same
 * one, or the document is refused 409 `mixed-client` naming the client
 * codes. Returns the single client id. State-dependent (it depends on the
 * SKUs' stored clients), hence 409 — the `kit-sku-holds-stock` precedent.
 */
export async function assertSingleClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
  subject: string,
): Promise<string> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    throw new Error(`assertSingleClientInTx: no client ids for ${subject}`);
  }
  if (distinct.length === 1) {
    return distinct[0]!;
  }
  const labels = await getClientLabelsInTx(tx, tenantId, distinct);
  throw mixedClient(
    subject,
    distinct.map((id) => labels.get(id) ?? id),
  );
}

/** 409 `mixed-client` — a document whose SKUs belong to more than one client. */
export function mixedClient(subject: string, labels: readonly string[]): ProblemException {
  const named = [...new Set(labels)].sort().join(', ');
  return new ProblemException(
    'mixed-client',
    409,
    'SKUs belong to more than one client',
    `${subject} mixes SKUs of clients ${named} — one document is for one client; split it per client.`,
  );
}

export function clientNotFound(clientId: string): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Client not found',
    `No client with id "${clientId}" exists in this tenant.`,
  );
}
