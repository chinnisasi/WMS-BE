import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { OutboundModule } from '../outbound/outbound.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InboundModule } from '../inbound/inbound.module';
import { InboundFacade } from '../inbound/inbound.facade';
import { MailModule } from '../mail/mail.module';
import { MailAttachmentRegistry } from '../mail/mail.facade';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AttachmentsFacade } from '../attachments/attachments.facade';
import { OutboundFacade } from '../outbound/outbound.facade';
import { ClientEmailsEnqueueHandler } from './client-emails.enqueue';
import { ClientEmailsFacade } from './client-emails.facade';

/**
 * The client-emails module (story 5-2b): receipt and dispatch emails to a
 * client brand's opted-in contacts. It owns NO table — the rows are the mail
 * module's `email_messages`, written only through `mail.facade`
 * (`queueClientEmailInTx`) and sent by 5-1a's sender.
 *
 * - `ClientEmailsEnqueueHandler` subscribes to `grn.recorded` and
 *   `order.dispatched` in `onModuleInit` and queues one row per recipient;
 *   it makes no network call.
 * - `ClientEmailsFacade` is the staff log read (`GET …/clients/{c}/emails`).
 *
 * Imports the outbound, catalog and inbound modules for their read seams
 * only (`orderClientIdsInTx`, `kitParentLineIdsInTx`, `skuLabelsInTx`,
 * `poCodesByIdsInTx`); clients, tenancy and mail through their exported
 * `…InTx` functions.
 */
@Module({
  // Story 2-9a (D13) — MailModule for its attachment registry (the singleton
  // the sender holds).
  // Story 4-4a (D8) — AttachmentsModule for the stored-file renderer.
  imports: [SharedModule, OutboundModule, CatalogModule, InboundModule, MailModule, AttachmentsModule],
  providers: [ClientEmailsEnqueueHandler, ClientEmailsFacade],
  exports: [ClientEmailsFacade],
})
export class ClientEmailsModule implements OnModuleInit {
  constructor(
    @Inject(MailAttachmentRegistry) private readonly attachments: MailAttachmentRegistry,
    @Inject(InboundFacade) private readonly inbound: InboundFacade,
    @Inject(AttachmentsFacade) private readonly files: AttachmentsFacade,
    @Inject(OutboundFacade) private readonly outbound: OutboundFacade,
  ) {}

  /**
   * Story 2-9a (decision 17) — the receipt email's GRN PDF: mail renders it at
   * send time through this renderer, in a read-only transaction stamped with
   * the row's client (the portal's scope). Both process roles build the full
   * `AppModule`, so the worker has it too.
   */
  onModuleInit(): void {
    this.attachments.register('grn-pdf', (tx, tenantId, clientId, grnId) => this.inbound.grnDocumentPdfInTx(tx, tenantId, clientId, grnId));
    // Story 4-5a (A20) — the dispatch email's packing slip (client audience),
    // on the registry's client-stamped, read-only transaction; null when the
    // order is not that client's or not dispatched (sent without the file).
    this.attachments.register('packing-slip-pdf', (tx, tenantId, clientId, orderId) => this.outbound.packingSlipPdfInTx(tx, tenantId, clientId, orderId));
    // Story 4-4a (D8) — a shipping document or a signed-sheet page: the stored
    // bytes (attachments) under the derived file name (outbound), both read on
    // the registry's client-stamped, read-only transaction.
    this.attachments.register('stored-file', async (tx, tenantId, clientId, attachmentId) => {
      const file = await this.files.readForMail(tx, tenantId, clientId, attachmentId);
      if (file === null) return null;
      const filename = await this.outbound.shippingFileNameInTx(tx, tenantId, clientId, file.row);
      if (filename === null) return null;
      return { filename, contentType: file.row.contentType ?? 'application/octet-stream', content: file.content };
    });
  }
}
