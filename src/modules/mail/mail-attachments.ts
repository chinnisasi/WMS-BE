import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../shared/shared.module';
import type { Database } from '../../shared/db/db';
import { withTenantTransaction, type TenantTx } from '../../shared/db/tenant-scope';
import { EMAIL_ATTACHMENT_STATEMENT_TIMEOUT, type EmailAttachmentKind } from './mail-rules';

/**
 * Story 2-9a (decision 17) — the send-time attachment PORT. Mail is a leaf
 * module every module may call, so it imports no domain module: a domain
 * module registers a renderer for a kind (`client-emails` registers
 * `grn-pdf` → `InboundFacade.grnDocumentPdfInTx` in `onModuleInit`), and the
 * sender asks the registry at send time. The dependency points inward.
 */

/** One file on an outgoing email. */
export interface EmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

/**
 * Renders one attachment in the given transaction — read-only and stamped
 * with the row's client (the portal's scope). Null when the subject is not
 * that client's, or is gone.
 */
export type EmailAttachmentRenderer = (tx: TenantTx, tenantId: string, clientId: string, ref: string) => Promise<EmailAttachment | null>;

/** Thrown by `render` when no renderer is registered for a kind (the sender checks `has` first). */
export class AttachmentRendererMissing extends Error {
  constructor(kind: string) {
    super(`no email attachment renderer is registered for "${kind}"`);
    this.name = 'AttachmentRendererMissing';
  }
}

/**
 * The registry: a Nest singleton exported by `MailModule` (D13), so the
 * renderer `client-emails` registers is the one the sender holds — in the api
 * AND the worker process (both build the full `AppModule`).
 */
@Injectable()
export class MailAttachmentRegistry {
  private readonly renderers = new Map<EmailAttachmentKind, EmailAttachmentRenderer>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Registers the renderer of a kind; a second registration of a kind is a programming error. */
  register(kind: EmailAttachmentKind, renderer: EmailAttachmentRenderer): void {
    if (this.renderers.has(kind)) throw new Error(`an email attachment renderer for "${kind}" is already registered`);
    this.renderers.set(kind, renderer);
  }

  has(kind: string): boolean {
    return this.renderers.has(kind as EmailAttachmentKind);
  }

  /**
   * Renders one attachment in its OWN transaction: READ ONLY, stamped with
   * the row's client (`{ clientId }` — the portal copy's scope, A13), under
   * a 15 s statement timeout (A15). Throws what the renderer throws.
   */
  async render(kind: string, tenantId: string, clientId: string, ref: string): Promise<EmailAttachment | null> {
    const renderer = this.renderers.get(kind as EmailAttachmentKind);
    if (renderer === undefined) throw new AttachmentRendererMissing(kind);
    return withTenantTransaction(
      this.db,
      tenantId,
      async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${EMAIL_ATTACHMENT_STATEMENT_TIMEOUT}'`));
        return renderer(tx, tenantId, clientId, ref);
      },
      { accessMode: 'read only', clientId },
    );
  }
}
