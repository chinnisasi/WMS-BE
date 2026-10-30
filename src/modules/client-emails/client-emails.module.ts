import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { OutboundModule } from '../outbound/outbound.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InboundModule } from '../inbound/inbound.module';
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
  imports: [SharedModule, OutboundModule, CatalogModule, InboundModule],
  providers: [ClientEmailsEnqueueHandler, ClientEmailsFacade],
  exports: [ClientEmailsFacade],
})
export class ClientEmailsModule {}
