import type { ClientEmailTemplate } from '../mail/mail.facade';

/**
 * The clients module's schema face (story 21-1, AD-6): the table's
 * definition lives in the shared schema file like every other table; this
 * re-export is the module's OWNED view of it — the single import path other
 * files use, so a later story that moves or reshapes the table has one place
 * to re-point.
 */
export {
  CLIENT_CONTACT_ROLES,
  CLIENT_STATUSES,
  SELF_CLIENT_CODE,
  clientContacts,
  clients,
  type Client,
  type ClientContactRole,
  type ClientStatus,
} from '../../shared/db/schema';
/**
 * Story 21-2b — the created-client vocabulary, mirrored by the migration
 * 0059 CHECKs (`clients_code_format`, `clients_self_code_reserved`,
 * `clients_name_length`): a code is stored UPPERCASE (the warehouse-code
 * convention), 2..32 characters of A-Z / 0-9 / `-`, starting with a letter
 * or digit. The system-owned `self` client is exempt (it keeps its
 * lowercase identity code) and `SELF` is reserved for it.
 */
export const CLIENT_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
/** The name cap — the tenant name's own cap, because `self` mirrors it. */
export const CLIENT_NAME_MAX = 200;
/**
 * The client list is unpaginated and bounded: a 3PL holds tens of brands,
 * not thousands, and the list feeds pickers that need the whole set. A
 * tenant past this bound would see the first 500 (system-owned first, then
 * by code) — a deliberate ceiling, revisited with client filters (PENDING).
 */
export const MAX_CLIENT_LIST = 500;
/** Story 1-2a — the most contacts one client holds (a 21st is 409 `contact-limit`). */
export const MAX_CLIENT_CONTACTS = 20;
/** Story 1-2a — the contact name ceiling (the 0077 CHECK). */
export const CLIENT_CONTACT_NAME_MAX = 120;
/**
 * Story 1-2b — the receiving policy's ranges, mirrored by the migration 0078
 * CHECKs (`clients_receiving_tolerance_range`, `clients_min_shelf_life_range`)
 * and the command's own named 400s. The tolerance is in BASIS POINTS
 * (10000 = 100 %); the minimum remaining life in IST calendar days.
 */
export const RECEIVING_TOLERANCE_BPS_MAX = 10_000;
export const MIN_SHELF_LIFE_DAYS_MIN = 1;
export const MIN_SHELF_LIFE_DAYS_MAX = 3650;
/**
 * Story 4-3a — the outbound allocation policy's vocabulary and range, owned
 * here (the client policy row) and defined once in the shared primitive the
 * draw and promise sides read (`shared/primitives/batch-allocation.ts`).
 * Mirrored by the 0094 CHECKs (`clients_allocation_rule_check`,
 * `clients_min_outbound_shelf_life_range` and their `picklist_lines` twins),
 * pinned by `test/allocation-rules.spec.ts`.
 */
export {
  ALLOCATION_RULES,
  MIN_OUTBOUND_SHELF_LIFE_DAYS_MAX,
  MIN_OUTBOUND_SHELF_LIFE_DAYS_MIN,
  isAllocationRule,
  type AllocationRule,
} from '../../shared/primitives/batch-allocation';

/**
 * Story 5-2b (D10) — the client emails a contact may opt into: 5-2a's public
 * event names, mirrored by the 0114 `client_contacts_email_events_check` CHECK
 * (no NULL, no duplicate), the DTO's `@IsIn` and the web. Owned here (not in
 * `client-emails`) because the contact commands cancel by template and
 * `client-emails` imports `clients.facade` — the map there would cycle.
 * Pinned against the CHECK by `test/client-master.spec.ts`.
 */
export const CLIENT_EMAIL_EVENTS = ['receipt.recorded', 'order.dispatched'] as const;
export type ClientEmailEvent = (typeof CLIENT_EMAIL_EVENTS)[number];

/** Story 5-2b — the email template each event is sent with (`mail-rules.ts` `EMAIL_TEMPLATES`). */
export const CLIENT_EMAIL_EVENT_TEMPLATE = {
  'receipt.recorded': 'client-receipt',
  'order.dispatched': 'client-dispatch',
} as const satisfies Record<ClientEmailEvent, ClientEmailTemplate>;
