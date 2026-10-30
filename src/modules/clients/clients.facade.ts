import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import {
  CLIENT_EMAIL_EVENTS,
  MAX_CLIENT_CONTACTS,
  MAX_CLIENT_LIST,
  clientContacts,
  clients,
  isAllocationRule,
  type AllocationRule,
  type ClientContactRole,
  type ClientEmailEvent,
  type ClientStatus,
} from './clients.schema';
import { latestClientEmailsByAddressInTx, type LatestClientEmail } from '../mail/mail.facade';
import type { UserRole, UserStatus } from '../../shared/db/schema';
import { getMemberPortalFactsIn } from '../tenancy/tenancy.service';
import { addressFromColumns, type AddressSnapshot } from '../../shared/primitives/address';

// Story 5-2b (D10) — the email-event vocabulary, re-exported for the siblings
// that reach this module only through its facade (`client-emails`).
export { CLIENT_EMAIL_EVENTS, CLIENT_EMAIL_EVENT_TEMPLATE, type ClientEmailEvent } from './clients.schema';

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
  /**
   * Story 21-5 — the tax details a services tax invoice names the recipient
   * by. All nullable (never required at create); written only by
   * `ClientsCommand.updateTaxDetails`.
   */
  readonly taxDetails: ClientTaxDetails;
  /**
   * Story 1-2a — the registered address (null when unset). A stored snapshot
   * from before 1-2a carries neither address; the controller reads it as null.
   */
  readonly registeredAddress: ClientRegisteredAddress | null;
  /** Story 1-2a — the return-to address, in the shipment shape (null when unset). */
  readonly returnAddress: AddressSnapshot | null;
  /**
   * Story 1-2b — the client's receiving policy. OPTIONAL on the type: a
   * `ClientMutationSnapshot` stored in an idempotency key before 1-2b replays
   * without it (every fresh read carries it).
   */
  readonly receivingPolicy?: ClientReceivingPolicy;
  /**
   * Story 4-3a — the client's outbound allocation policy. OPTIONAL on the
   * type: a `ClientMutationSnapshot` stored before 4-3a replays without it
   * (every fresh read carries it).
   */
  readonly allocationPolicy?: ClientAllocationPolicy;
  /**
   * Story 5-2b — the Reply-To of the client's receipt and dispatch emails
   * (null = the deployment's). OPTIONAL on the type: a
   * `ClientMutationSnapshot` stored before 5-2b replays without it (the
   * controller reads it `?? null`); every fresh read carries it.
   */
  readonly emailReplyTo?: string | null;
}

/**
 * Story 4-3a — how a client's stock is allocated to its customer orders: the
 * rule (`fefo` | `fifo`) and the minimum remaining shelf life at dispatch
 * (IST calendar days; null = none). Applied by the wave plan, the short-pick
 * re-plan and the pick draw; the minimum also by ATP.
 */
export interface ClientAllocationPolicy {
  readonly allocationRule: AllocationRule;
  readonly minOutboundShelfLifeDays: number | null;
}

/** Story 4-3a — the policy every client starts with (and an unknown id reads). */
export const DEFAULT_ALLOCATION_POLICY: ClientAllocationPolicy = {
  allocationRule: 'fefo',
  minOutboundShelfLifeDays: null,
};

/** Story 4-3a — the allocation columns of a client row (an unknown stored rule reads `fefo`, fail-safe to the default). */
export function allocationPolicyOf(row: {
  readonly allocationRule: string;
  readonly minOutboundShelfLifeDays: number | null;
}): ClientAllocationPolicy {
  return {
    allocationRule: isAllocationRule(row.allocationRule) ? row.allocationRule : 'fefo',
    minOutboundShelfLifeDays: row.minOutboundShelfLifeDays,
  };
}

/**
 * Story 1-2b — how a client's goods are received: the over-receipt
 * tolerance (basis points of the ordered / announced quantity that book at
 * once), QC on receipt, expiry required on batch-tracked lines and the
 * minimum remaining shelf life (IST calendar days, only beside
 * `expiryRequired`). The defaults reproduce the pre-1-2b receipt exactly.
 */
export interface ClientReceivingPolicy {
  readonly receivingToleranceBps: number;
  readonly qcOnReceipt: boolean;
  readonly expiryRequired: boolean;
  readonly minShelfLifeDays: number | null;
  /**
   * Story 2-4b — a batch-tracked line with a mfg date and no typed expiry
   * gets its batch expiry from mfg + the SKU's shelf life (default on).
   */
  readonly deriveExpiry: boolean;
}

/** Story 1-2b — the policy every client starts with: the pre-1-2b receipt (2-4b: deriving, the column's default). */
export const DEFAULT_RECEIVING_POLICY: ClientReceivingPolicy = {
  receivingToleranceBps: 0,
  qcOnReceipt: false,
  expiryRequired: false,
  minShelfLifeDays: null,
  deriveExpiry: true,
};

/** Story 1-2b — the policy columns of a client row. */
export function receivingPolicyOf(row: {
  readonly receivingToleranceBps: number;
  readonly qcOnReceipt: boolean;
  readonly expiryRequired: boolean;
  readonly minShelfLifeDays: number | null;
  readonly deriveExpiry: boolean;
}): ClientReceivingPolicy {
  return {
    receivingToleranceBps: row.receivingToleranceBps,
    qcOnReceipt: row.qcOnReceipt,
    expiryRequired: row.expiryRequired,
    minShelfLifeDays: row.minShelfLifeDays,
    deriveExpiry: row.deriveExpiry,
  };
}

/** Story 1-2b — true when the policy is exactly the pre-1-2b receipt. */
export function isDefaultReceivingPolicy(policy: ClientReceivingPolicy): boolean {
  return (
    policy.receivingToleranceBps === 0 &&
    !policy.qcOnReceipt &&
    !policy.expiryRequired &&
    policy.minShelfLifeDays === null &&
    policy.deriveExpiry
  );
}

/** Story 1-2a — a client's registered address (the billing columns' shapes). */
export interface ClientRegisteredAddress {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  /** A two-digit GST registration state code. */
  readonly stateCode: string;
  readonly pincode: string;
}

/** Story 21-5 — a client's tax details (every field nullable). */
export interface ClientTaxDetails {
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly billingLine1: string | null;
  readonly billingLine2: string | null;
  readonly billingCity: string | null;
  /** A two-digit GST registration state code. */
  readonly billingStateCode: string | null;
  readonly billingPincode: string | null;
}

/**
 * Story 1-2a — one contact of a client brand, as every read and write of
 * contacts returns it. Never on the clients list (decision 6): read through
 * `GET …/clients/{c}/contacts` by staff only.
 */
export interface ClientContactSnapshot {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  /** A subset of `CLIENT_CONTACT_ROLES`, in vocabulary order; empty = a general contact. */
  readonly roles: readonly ClientContactRole[];
  /** Exactly one contact is primary while any exist (listed first; 5.2's default recipient). */
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Story 5-2b — the client emails this contact opted into (sorted, in
   * vocabulary order). OPTIONAL on the type: a contact snapshot stored before
   * 5-2b replays without it (the controller reads it `?? []`).
   */
  readonly emailEvents?: readonly ClientEmailEvent[];
}

/**
 * Story 5-2b — one contact as the contacts LIST returns it: the snapshot plus
 * the latest client email to its address (`lastEmail`, null when none) — a
 * list-only field, never on a stored mutation snapshot.
 */
export interface ClientContactListEntry extends ClientContactSnapshot {
  readonly lastEmail: LatestClientEmail | null;
}

export function toClientContactSnapshot(row: typeof clientContacts.$inferSelect): ClientContactSnapshot {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    roles: row.roles as ClientContactRole[],
    isPrimary: row.isPrimary,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    emailEvents: row.emailEvents as ClientEmailEvent[],
  };
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
    taxDetails: {
      legalName: row.legalName,
      gstin: row.gstin,
      billingLine1: row.billingLine1,
      billingLine2: row.billingLine2,
      billingCity: row.billingCity,
      billingStateCode: row.billingStateCode,
      billingPincode: row.billingPincode,
    },
    registeredAddress:
      row.registeredLine1 === null
        ? null
        : {
            line1: row.registeredLine1,
            line2: row.registeredLine2,
            city: row.registeredCity ?? '',
            stateCode: row.registeredStateCode ?? '',
            pincode: row.registeredPincode ?? '',
          },
    returnAddress: addressFromColumns({
      contactName: row.returnContactName,
      phone: row.returnPhone,
      line1: row.returnLine1,
      line2: row.returnLine2,
      city: row.returnCity,
      state: row.returnState,
      pincode: row.returnPincode,
    }),
    receivingPolicy: receivingPolicyOf(row),
    allocationPolicy: allocationPolicyOf(row),
    emailReplyTo: row.emailReplyTo,
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

  /**
   * Story 1-1 — the device catalog snapshot's `clients` arm: the named
   * clients (every client a SKU or an open document of the snapshot
   * references), `{id, code, name, active}`, in the `listClients` order. An
   * id the tenant does not hold is absent. A read in its own transaction —
   * the api shell composes it beside the other arms, never nested.
   */
  async snapshotClients(
    tenantId: string,
    clientIds: readonly string[],
  ): Promise<{ id: string; code: string; name: string; active: boolean; receivingPolicy: ClientReceivingPolicy }[]> {
    const wanted = [...new Set(clientIds)];
    if (wanted.length === 0) {
      return [];
    }
    // The referenced ids directly — never the capped `listClients` read, which
    // would lose clients past `MAX_CLIENT_LIST`.
    const rows = await withTenantTransaction(this.db, tenantId, (tx) =>
      tx
        .select({
          id: clients.id,
          code: clients.code,
          name: clients.name,
          status: clients.status,
          // Story 1-2b — the receiving policy rides to the handheld so it can
          // WARN (never block) at the dock; the server decides on replay.
          receivingToleranceBps: clients.receivingToleranceBps,
          qcOnReceipt: clients.qcOnReceipt,
          expiryRequired: clients.expiryRequired,
          minShelfLifeDays: clients.minShelfLifeDays,
          deriveExpiry: clients.deriveExpiry,
        })
        .from(clients)
        .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, wanted)))
        .orderBy(desc(clients.systemOwned), asc(clients.code)),
    );
    return rows.map((client) => ({
      id: client.id,
      code: client.code,
      name: client.name,
      active: client.status === 'active',
      receivingPolicy: receivingPolicyOf(client),
    }));
  }

  /**
   * Story 1-2a — one client's contacts, the primary first, then by name, then
   * by id (at most 20). 404 when the client is not this tenant's. A staff
   * read (any operator session — decision 6); never a portal read.
   */
  async listClientContacts(tenantId: string, clientId: string): Promise<ClientContactListEntry[]> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertClientInTenantInTx(tx, tenantId, clientId);
      const rows = await tx
        .select()
        .from(clientContacts)
        .where(and(eq(clientContacts.tenantId, tenantId), eq(clientContacts.clientId, clientId)))
        .orderBy(desc(clientContacts.isPrimary), asc(clientContacts.name), asc(clientContacts.id));
      // Story 5-2b — each contact's latest client email (the badge), one
      // indexed read for the whole list.
      const latest = await latestClientEmailsByAddressInTx(tx, tenantId, clientId, rows.map((row) => row.email));
      return rows.map((row) => ({ ...toClientContactSnapshot(row), lastEmail: latest.get(row.email) ?? null }));
    });
  }

  /**
   * Story 1-2b — one client's receiving policy, 404 when the client is not
   * this tenant's. A staff read (any operator session — never the portal).
   */
  async getReceivingPolicy(tenantId: string, clientId: string): Promise<ClientReceivingPolicy> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          receivingToleranceBps: clients.receivingToleranceBps,
          qcOnReceipt: clients.qcOnReceipt,
          expiryRequired: clients.expiryRequired,
          minShelfLifeDays: clients.minShelfLifeDays,
          deriveExpiry: clients.deriveExpiry,
        })
        .from(clients)
        .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw clientNotFound(clientId);
      }
      return receivingPolicyOf(row);
    });
  }

  /**
   * Story 4-3a (A12) — one client's allocation policy, 404 when the client is
   * not this tenant's. A staff read (any operator session — never the
   * portal); the api shell composes the panel's counts beside it.
   */
  async getAllocationPolicy(tenantId: string, clientId: string): Promise<ClientAllocationPolicy> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ allocationRule: clients.allocationRule, minOutboundShelfLifeDays: clients.minOutboundShelfLifeDays })
        .from(clients)
        .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw clientNotFound(clientId);
      }
      return allocationPolicyOf(row);
    });
  }

  /** Story 21-7 — `GET …/portal/me` (see `portalMeIn`). */
  async portalMe(tenantId: string, userId: string, clientId: string): Promise<PortalMe> {
    return portalMeIn(this.db, tenantId, userId, clientId);
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

/**
 * Story 5-2b (A3) — the contacts of a client opted into `event`, sorted by
 * email, at most `MAX_CLIENT_CONTACTS` (the client's whole contact list is
 * bounded at it). The recipients of one client email; `client-emails` never
 * queries `client_contacts` itself.
 *
 * Read `FOR SHARE`: a contact edit or remove (which updates or deletes the
 * row) committing during an in-flight enqueue either waits for the enqueue to
 * commit — so its cancel then sees and cancels the rows just queued — or, if
 * it locked first, makes the enqueue wait and re-read the committed opt-out.
 * Either way no row is queued past an opt-out that has already cancelled.
 */
export async function subscribedContactsInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  event: ClientEmailEvent,
): Promise<{ id: string; email: string }[]> {
  if (!(CLIENT_EMAIL_EVENTS as readonly string[]).includes(event)) return [];
  return tx
    .select({ id: clientContacts.id, email: clientContacts.email })
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.tenantId, tenantId),
        eq(clientContacts.clientId, clientId),
        sql`${clientContacts.emailEvents} @> array[${event}]::text[]`,
      ),
    )
    .orderBy(asc(clientContacts.email))
    .limit(MAX_CLIENT_CONTACTS)
    .for('share');
}

/**
 * Story 21-5 — one client's full snapshot (its tax details included), 404
 * `not-found` when absent. Billing's client invoice reads the recipient
 * through it (after locking the row with `lockClientInTx`).
 */
export async function getClientInTx(tx: TenantTx, tenantId: string, clientId: string): Promise<ClientSnapshot> {
  const rows = await tx
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return toClientSnapshot(row);
}

/**
 * Story 2-8b (decision 6) — the brand as a goods-out document FREEZES it (the
 * return-to-vendor's consignor; 4-7c's return to client reuses it). Every key
 * present, null where empty: the legal name and GSTIN from the tax details,
 * the registered address. Frozen at the document's create; a later client
 * edit never rewrites it.
 */
export interface ClientPartySnapshotV1 {
  readonly v: 1;
  readonly code: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly registeredAddress: ClientRegisteredAddress | null;
}

/** The v1 party snapshot of a client read (`getClientInTx`). */
export function clientPartySnapshotOf(client: ClientSnapshot): ClientPartySnapshotV1 {
  return {
    v: 1,
    code: client.code,
    name: client.name,
    legalName: client.taxDetails.legalName ?? null,
    gstin: client.taxDetails.gstin ?? null,
    registeredAddress:
      client.registeredAddress === null
        ? null
        : {
            line1: client.registeredAddress.line1,
            line2: client.registeredAddress.line2 ?? null,
            city: client.registeredAddress.city,
            stateCode: client.registeredAddress.stateCode,
            pincode: client.registeredAddress.pincode,
          },
  };
}

/** A client's facts plus its status — what a priced relationship checks (21-3). */
export interface LockedClientFacts extends ClientFacts {
  readonly status: ClientStatus;
  /** Story 5-1a — the brand's name (a portal invite's email names it). */
  readonly name: string;
}

/**
 * Story 21-3 — lock the client row on the caller's transaction and return its
 * facts, 404 `not-found` when absent. The rate-card activation and cancel
 * commands serialise on it: every card transition of one client runs under
 * this one row lock, so two activations can never interleave; 21-5's client
 * invoice prepare, refresh and issue take it too. A lock, never a write — the
 * clients module still owns the table.
 *
 * Story 1-2a — `FOR NO KEY UPDATE`, no longer `FOR UPDATE`: it still
 * conflicts with itself, with `FOR SHARE` (the create-gates) and with the
 * status command's `FOR UPDATE`, but NOT with `FOR KEY SHARE` — so a long
 * invoice prepare never queues every order create of the client behind it
 * (`assertClientTakesWorkInTx` takes `FOR KEY SHARE`).
 */
export async function lockClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
  // Story 1-3 — a link reactivation reads status under `FOR KEY SHARE`
  // (the "no new work" gate's mode); every other caller keeps the default.
  mode: 'no key update' | 'key share' = 'no key update',
): Promise<LockedClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1)
    .for(mode);
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  return { ...row, status: row.status as ClientStatus };
}

/**
 * Story 1-2a — "no new work": the ONE gate every path that creates work for a
 * client runs (PO / ASN / order / RMA create, channel ingest and mappings,
 * catalog import, SKU client correction, kit and variant attach, a positive
 * adjustment or count gain). It takes the client row `FOR KEY SHARE` on the
 * caller's transaction — weakest lock, so concurrent creators never
 * serialise against each other nor against the non-status writers' `FOR NO
 * KEY UPDATE` — but it conflicts with the status command's `FOR UPDATE`:
 * a departure and a creation serialise, and a creation arriving behind a
 * committing departure re-reads `departed` (READ COMMITTED). 404 when
 * absent; 409 `client-departed` when departed. A SUSPENDED client still
 * takes work (decision 5 — suspension cuts only the portal).
 *
 * Where to call it: anywhere in the transaction BEFORE ITS FIRST WRITE (the
 * gate must hold the key share across the write). Its position relative to
 * the caller's other locks is free: the departure locks ONLY the client row
 * (`FOR UPDATE`) and its wind-down reads take no row locks, so no lock this
 * caller already holds can be waited on by a departure — no cycle, whatever
 * the order (callers take it after SKU, product, connection or advisory
 * locks today).
 */
export async function assertClientTakesWorkInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<LockedClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1)
    .for('key share');
  const row = rows[0];
  if (row === undefined) {
    throw clientNotFound(clientId);
  }
  if (row.status === 'departed') {
    throw clientDeparted(clientLabel(row));
  }
  return { id: row.id, code: row.code, name: row.name, systemOwned: row.systemOwned, status: row.status as ClientStatus };
}

/**
 * Story 1-2a — the departed clients among `clientIds`, under the same `FOR
 * KEY SHARE` as `assertClientTakesWorkInTx` (the receipt's per-line refusal
 * reads them so a departure cannot commit between the read and the booking).
 * Returns id → refusal label; an unknown id is absent.
 */
export async function departedClientsInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, distinct)))
    .orderBy(asc(clients.id))
    .for('key share');
  return new Map(rows.filter((row) => row.status === 'departed').map((row) => [row.id, clientLabel(row)]));
}

/**
 * Story 1-2b — the receiving policies of `clientIds` (id → policy; an unknown
 * id is absent). A plain read on the caller's transaction: a receipt reads
 * the policy committed when it reads it — there is no serialisation against
 * a policy edit (spec, read semantics). The receipt reads it ONCE, beside
 * `departedClientsInTx`, before any document lock.
 */
export async function receivingPoliciesInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, ClientReceivingPolicy>> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      id: clients.id,
      receivingToleranceBps: clients.receivingToleranceBps,
      qcOnReceipt: clients.qcOnReceipt,
      expiryRequired: clients.expiryRequired,
      minShelfLifeDays: clients.minShelfLifeDays,
      deriveExpiry: clients.deriveExpiry,
    })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, distinct)));
  return new Map(rows.map((row) => [row.id, receivingPolicyOf(row)]));
}

/**
 * Story 4-3a — the allocation policies of `clientIds` (id → policy). The
 * `receivingPoliciesInTx` shape: a plain, UNLOCKED read on the caller's
 * transaction — a plan reads the policy committed when it reads it, there is
 * no serialisation against a policy edit. An unknown id maps to
 * `DEFAULT_ALLOCATION_POLICY` (every requested id is present). The wave plan
 * reads it ONCE for all its clients (A10).
 */
export async function allocationPoliciesInTx(
  tx: TenantTx,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, ClientAllocationPolicy>> {
  const distinct = [...new Set(clientIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      id: clients.id,
      allocationRule: clients.allocationRule,
      minOutboundShelfLifeDays: clients.minOutboundShelfLifeDays,
    })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, distinct)));
  const found = new Map(rows.map((row) => [row.id, allocationPolicyOf(row)]));
  return new Map(distinct.map((id) => [id, found.get(id) ?? DEFAULT_ALLOCATION_POLICY]));
}

/**
 * Story 1-2a — every departed client of the tenant (an unlocked read): the
 * replenishment sweep and expiry scan skip their SKUs.
 */
export async function departedClientIdsInTx(tx: TenantTx, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.status, 'departed')));
  return new Set(rows.map((row) => row.id));
}

/** Story 1-2a — 409 `client-departed`: work refused for a client that has left. */
export function clientDeparted(label: string): ProblemException {
  return new ProblemException(
    'client-departed',
    409,
    'The client has departed',
    `Client ${label} has departed — it takes no new work. An owner can reactivate it in Settings → Clients.`,
  );
}

/**
 * Story 21-10 — the client's facts under a `FOR SHARE` row lock on the
 * caller's transaction, 404 `not-found` when absent. The gates that refuse a
 * non-active client while CREATING something under it (the rate-card draft,
 * the portal ASN announce, the portal-user invite) read status through this,
 * so a suspend (`ClientsCommand.updateStatus`, which takes `FOR UPDATE`)
 * cannot commit between the gate's read and its insert: a gate already
 * holding the share lock makes the suspend wait, and a gate arriving behind
 * a committing suspend waits and — READ COMMITTED — re-reads the committed
 * `suspended`. Lock order: the client first, then documents; nothing locks a
 * card or an ASN before its client, so there is no cycle. Share locks do not
 * conflict with each other, so concurrent gates never serialise.
 */
export async function shareLockClientInTx(
  tx: TenantTx,
  tenantId: string,
  clientId: string,
): Promise<LockedClientFacts> {
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1)
    .for('share');
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
 * The ASN import (2026-10-17) — clients named BY CODE in a file, in bulk, in
 * the caller's transaction. Matched case-insensitively on `upper(code)`:
 * codes are stored upper-case except the tenant's own `self`, and `SELF` is
 * reserved for it (`clients_self_code_reserved`), so the upper-cased match
 * is unambiguous and also lets a file name the tenant's own goods `self`.
 * The map is keyed by the UPPER-CASED code; an unknown code is absent.
 */
export async function getClientsByCodesInTx(
  tx: TenantTx,
  tenantId: string,
  codes: readonly string[],
): Promise<Map<string, ClientFacts & { readonly label: string }>> {
  const upper = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter((code) => code !== ''))];
  if (upper.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(sql`upper(${clients.code})`, upper)));
  return new Map(
    rows.map((row) => [
      row.code.toUpperCase(),
      { id: row.id, code: row.code, systemOwned: row.systemOwned, label: clientLabel(row) },
    ]),
  );
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

/**
 * Story 1-1 — operator-facing SKU code labels for a refusal that lists codes.
 * A SKU code is unique per (tenant, client) only, so once the tenant holds
 * more than one client each code is labelled `CODE (client)`; a one-client
 * tenant reads the bare code, as before. Distinct, in input order.
 */
export async function skuCodeLabelsInTx(
  tx: TenantTx,
  tenantId: string,
  refs: readonly { readonly code: string; readonly clientId: string }[],
): Promise<string[]> {
  if (refs.length === 0) {
    return [];
  }
  const all = await tx
    .select({ id: clients.id, code: clients.code, name: clients.name, systemOwned: clients.systemOwned })
    .from(clients)
    .where(eq(clients.tenantId, tenantId));
  const labels = new Map(all.map((row) => [row.id, clientLabel(row)]));
  const out = refs.map((ref) =>
    all.length > 1 ? `${ref.code} (${labels.get(ref.clientId) ?? ref.clientId})` : ref.code,
  );
  return [...new Set(out)];
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

/** Story 21-7 — what a client-portal session knows about its client. */
export interface SessionClientFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: ClientStatus;
}

/**
 * Story 21-7 — the client a portal user belongs to, read by tenant AND id,
 * on whichever runner the caller holds: sign-in's auth-time connection (it
 * has no tenant transaction yet — the tenant read beside it is the same
 * shape) or a tenant transaction. Null when absent. A read, never a lock.
 */
export async function readSessionClientIn(
  runner: Pick<TenantTx, 'select'> | Pick<Database, 'select'>,
  tenantId: string,
  clientId: string,
): Promise<SessionClientFacts | null> {
  const rows = await (runner as Pick<TenantTx, 'select'>)
    .select({ id: clients.id, code: clients.code, name: clients.name, status: clients.status })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { ...row, status: row.status as ClientStatus };
}

/**
 * Story 21-7 — 403 `client-suspended`: a client-portal user whose client is
 * not `active` (suspended or departed). Sign-in answers it AFTER the password
 * check (a wrong password stays 401); the portal guard answers it on every
 * request, so suspension bites before the 15-minute token expires. Distinct
 * from 409 `client-not-active` (a state conflict on a command's target).
 */
export function clientSuspended(): ProblemException {
  return new ProblemException(
    'client-suspended',
    403,
    'Client portal access is suspended',
    'This client brand’s portal access is suspended — contact the warehouse.',
  );
}

/**
 * Story 1-2a — 403 `client-departed`: a client-portal user whose client has
 * DEPARTED (its account with the warehouse has ended). Sign-in, the portal
 * guard and portal `me` answer it instead of `client-suspended`.
 */
export function clientAccountEnded(): ProblemException {
  return new ProblemException(
    'client-departed',
    403,
    'Client account has ended',
    "Your company's account with the warehouse has ended.",
  );
}

/** Story 1-2a — the portal refusal for a non-active client: departed or suspended. */
export function clientInactive(status: ClientStatus | null): ProblemException {
  return status === 'departed' ? clientAccountEnded() : clientSuspended();
}

/** Story 21-7 — `GET …/portal/me`: the portal user and its client, exact keys. */
export interface PortalMe {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: UserRole;
    readonly status: UserStatus;
    readonly clientId: string;
  };
  readonly client: { readonly id: string; readonly code: string; readonly name: string };
}

/**
 * Story 21-7 — the portal's own `me` (the operator `/me` stays behind the
 * operator fence): re-read in a transaction stamped with the client, after
 * `PortalSessionGuard` already confirmed both rows. A row gone between the
 * guard and here reads as the guard's own refusals.
 */
export async function portalMeIn(db: Database, tenantId: string, userId: string, clientId: string): Promise<PortalMe> {
  return withTenantTransaction(
    db,
    tenantId,
    async (tx) => {
      const user = await getMemberPortalFactsIn(tx, tenantId, userId);
      if (user === null || user.status !== 'active' || user.clientId !== clientId) {
        throw new ProblemException('unauthenticated', 401, 'Authentication required', 'The session no longer describes a client-portal user — sign in again.');
      }
      const client = await readSessionClientIn(tx, tenantId, clientId);
      if (client === null || client.status !== 'active') {
        throw clientInactive(client?.status ?? null);
      }
      return {
        user: { id: user.id, email: user.email, role: user.role, status: user.status as UserStatus, clientId },
        client: { id: client.id, code: client.code, name: client.name },
      };
    },
    { clientId },
  );
}
