import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { PartnersCommand } from './partners.command';
import { PartnersFacade } from './partners.facade';

/**
 * Partners module (story 1-3): the business partner master — one record per
 * GST registration, with the roles vendor / consignee / transporter — and its
 * client links. Owns `business_partners` (the renamed Story 3.1 `vendors`)
 * and `partner_client_links`; nothing outside this module writes either
 * (test/architecture.spec.ts). Siblings read through `partners.facade.ts`:
 * inbound's PO guard (`assertVendorLinkedInTx`) and replenishment's
 * default-vendor pick (`findDefaultVendorForClientInTx`) — file-level
 * functions on the caller's transaction, the `clients.facade` shape — so the
 * module imports only `SharedModule` and the clients facade's functions.
 */
@Module({
  imports: [SharedModule],
  providers: [PartnersCommand, PartnersFacade],
  exports: [PartnersCommand, PartnersFacade],
})
export class PartnersModule {}
