import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction } from '../../shared/db/tenant-scope';
import { UUID_RE } from '../../shared/primitives/ids';
import { decodeCursor, encodeCursor } from '../../shared/primitives/pagination';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { assertClientInTenantInTx, clientNotFound } from '../clients/clients.facade';
import {
  clientEmailCountsTodayInTx,
  listClientEmailsInTx,
  mailProviderEnabled,
  type EmailStatus,
} from '../mail/mail.facade';
import {
  CLIENT_EMAIL_DAILY_CAP,
  CLIENT_EMAIL_LOG_PAGE_DEFAULT,
  CLIENT_EMAIL_LOG_PAGE_MAX,
  clientEmailEnabled,
} from './client-email-rules';

/** Story 5-2b — one row of a client's email log. */
export interface ClientEmailLogItem {
  readonly id: string;
  readonly kind: 'receipt' | 'dispatch' | 'shipment-document';
  /** The GRN code, the order reference, or a shipping document's label (from the stored params). */
  readonly subjectLabel: string;
  readonly to: string;
  readonly status: EmailStatus;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Story 5-2b — `GET …/clients/{c}/emails`. */
export interface ClientEmailLog {
  readonly items: readonly ClientEmailLogItem[];
  readonly nextCursor: string | null;
  /** `EMAIL_PROVIDER ≠ off` — mail is sent (or logged) on this server at all. */
  readonly mailEnabled: boolean;
  /** A4 — `CLIENT_EMAIL_ENABLED`: client notices are queued on this server. */
  readonly clientMailEnabled: boolean;
  /** A5 — today's count of each notice has reached the daily limit (later events today were not emailed). */
  readonly capReachedToday: { readonly receipt: boolean; readonly dispatch: boolean; readonly shipmentDocument: boolean };
}

export interface ClientEmailLogQuery {
  readonly problems?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

/** A cursor's instant: an ISO-8601 UTC instant (anything else would 500 on `::timestamptz`). */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

const malformedCursor = () =>
  new ProblemException('validation-failed', 400, 'Malformed cursor', 'cursor is not a cursor this list issued.');

/**
 * Story 5-2b — the client-emails module's read: a client's receipt and
 * dispatch emails, newest first, for ANY staff session (the contacts read's
 * audience, 1-2a decision 6 — never the portal). 404 for an unknown or
 * another tenant's client. The rows live in the mail module, read only
 * through `mail.facade`.
 */
@Injectable()
export class ClientEmailsFacade {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listClientEmails(tenantId: string, clientId: string, query: ClientEmailLogQuery): Promise<ClientEmailLog> {
    const limit = Math.min(Math.max(query.limit ?? CLIENT_EMAIL_LOG_PAGE_DEFAULT, 1), CLIENT_EMAIL_LOG_PAGE_MAX);
    let after: { createdAt: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      try {
        after = decodeCursor(query.cursor);
      } catch {
        throw malformedCursor();
      }
      if (
        typeof after.id !== 'string' ||
        !UUID_RE.test(after.id) ||
        typeof after.createdAt !== 'string' ||
        !ISO_INSTANT_RE.test(after.createdAt) ||
        Number.isNaN(Date.parse(after.createdAt))
      ) {
        throw malformedCursor();
      }
    }
    if (!UUID_RE.test(clientId)) throw clientNotFound(clientId);
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      await assertClientInTenantInTx(tx, tenantId, clientId);
      const rows = await listClientEmailsInTx(tx, tenantId, clientId, { problems: query.problems === true, after, limit });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const counts = await clientEmailCountsTodayInTx(tx, tenantId, clientId);
      return {
        items: page.map((row) => ({
          id: row.id,
          kind: row.template === 'client-receipt' ? 'receipt' : row.template === 'client-shipment-document' ? 'shipment-document' : 'dispatch',
          subjectLabel: row.subjectLabel,
          to: row.to,
          status: row.status,
          errorCode: row.errorCode,
          attempts: row.attempts,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        // The raw, full-precision `created_at` (§7a — a truncated cursor breaks the walk).
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ createdAt: last.cursorAt, id: last.id }) : null,
        mailEnabled: mailProviderEnabled(),
        clientMailEnabled: clientEmailEnabled(),
        capReachedToday: {
          receipt: counts['client-receipt'] >= CLIENT_EMAIL_DAILY_CAP,
          dispatch: counts['client-dispatch'] >= CLIENT_EMAIL_DAILY_CAP,
          shipmentDocument: counts['client-shipment-document'] >= CLIENT_EMAIL_DAILY_CAP,
        },
      };
    });
  }
}
