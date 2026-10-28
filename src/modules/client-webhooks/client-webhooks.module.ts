import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { OutboundModule } from '../outbound/outbound.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InboundModule } from '../inbound/inbound.module';
import { ClientWebhooksCommand } from './client-webhooks.command';
import { ClientWebhooksFacade } from './client-webhooks.facade';
import { WebhookEnqueue, WebhookEnqueueHandler } from './webhook.enqueue';
import { WebhookSender } from './webhook.sender';

/**
 * The client-webhooks module (story 5-2a): owns `webhook_endpoints`,
 * `webhook_events` and `webhook_deliveries` (module-exclusive writes —
 * `test/architecture.spec.ts`).
 *
 * - `WebhookEnqueueHandler` subscribes to `grn.recorded` and
 *   `order.dispatched` in `onApplicationBootstrap` (last on the bus) and
 *   queues one frozen event per subject; it makes no network call.
 * - `WebhookSender` sweeps, claims and sends — driven per tenant by the jobs
 *   shell's `WebhookSenderWorker` through `ClientWebhooksFacade`; the only
 *   socket to a client URL is `webhook-http.ts`.
 * - `ClientWebhooksCommand` is the staff surface (`clients.manage`).
 *
 * Imports the outbound, catalog and inbound modules for their read seams
 * only (`orderClientIdsInTx`, `kitParentLineIdsInTx`, `skuLabelsInTx`,
 * `poCodesByIdsInTx`, `receiptQcHeldLineIdsInTx`); clients and tenancy
 * through their exported `…InTx` functions.
 */
@Module({
  imports: [SharedModule, OutboundModule, CatalogModule, InboundModule],
  providers: [WebhookEnqueue, WebhookEnqueueHandler, WebhookSender, ClientWebhooksCommand, ClientWebhooksFacade],
  exports: [ClientWebhooksFacade, ClientWebhooksCommand],
})
export class ClientWebhooksModule {}
