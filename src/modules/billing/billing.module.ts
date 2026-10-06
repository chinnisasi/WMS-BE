import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { BillingFacade } from './billing.facade';
import { RateCardCommand } from './rate-card.command';

/**
 * Billing module (story 21-3 stands it up with rate cards; metering 21-4 and
 * client invoices 21-5 join it). Owns `rate_cards` and `rate_card_lines`
 * exclusively. Reads the client entity only through `clients.facade.ts` (and
 * locks its row there for the dated transitions), writes no other module's
 * table, and exposes its reads through `BillingFacade` / the file-level
 * `…InTx` functions in `billing.facade.ts`.
 */
@Module({
  imports: [SharedModule],
  providers: [RateCardCommand, BillingFacade],
  exports: [RateCardCommand, BillingFacade],
})
export class BillingModule {}
