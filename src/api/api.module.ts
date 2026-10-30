import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { EchoController } from './echo.controller';
import { DevicesController } from './devices.controller';
import { InventoryController } from './inventory.controller';
import { InboundController } from './inbound.controller';
import { OutboundController } from './outbound.controller';
import { ShippingController } from './shipping.controller';
import { ConsignmentController } from './consignment.controller';
import { ReceivingController } from './receiving.controller';
import { GateInController } from './gate-in.controller';
import { DockController } from './dock.controller';
import { PutawayController } from './putaway.controller';
import { CarriersController } from './carriers.controller';
import { ChannelsController } from './channels.controller';
import { WebhooksController } from './webhooks.controller';
import { ComplianceController } from './compliance.controller';
import { LicencesController } from './licences.controller';
import { InvoicingController } from './invoicing.controller';
import { EwayController } from './eway.controller';
import { MovementsController } from './movements.controller';
import { OpenApiController } from './openapi.controller';
import { NotFoundController } from './not-found.controller';
import { OpenApiDocumentHolder } from './openapi-document.holder';
import { InventoryModule } from '../modules/inventory/inventory.module';
import { InboundModule } from '../modules/inbound/inbound.module';
import { ComplianceModule } from '../modules/compliance/compliance.module';
import { InvoicingModule } from '../modules/invoicing/invoicing.module';
import { OutboundModule } from '../modules/outbound/outbound.module';
import { PutawayModule } from '../modules/putaway/putaway.module';
import { CarriersModule } from '../modules/carriers/carriers.module';
import { CatalogModule } from '../modules/catalog/catalog.module';
import { TenancyModule } from '../modules/tenancy/tenancy.module';
import { MovementsModule } from '../modules/movements/movements.module';
import { ReplenishmentModule } from '../modules/replenishment/replenishment.module';
import { ChannelsModule } from '../modules/channels/channels.module';
import { ReplenishmentController } from './replenishment.controller';
import { ReportingController } from './reporting.controller';
import { ReportingModule } from '../modules/reporting/reporting.module';
import { ClientsController } from './clients.controller';
import { PartnersController } from './partners.controller';
import { PartnersModule } from '../modules/partners/partners.module';
import { ClientsModule } from '../modules/clients/clients.module';
import { RateCardsController } from './rate-cards.controller';
import { BillingUsageController } from './billing-usage.controller';
import { ClientInvoicesController } from './client-invoices.controller';
import { ClientInvoiceNotesController } from './client-invoice-notes.controller';
import { ClientChargesController } from './client-charges.controller';
import { BillingModule } from '../modules/billing/billing.module';
import { PortalController } from './portal.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { ReturnsController } from './returns.controller';
import { VendorReturnsController } from './vendor-returns.controller';
import { ClientReturnsController } from './client-returns.controller';
import { ReturnsModule } from '../modules/returns/returns.module';
import { SharedModule } from '../shared/shared.module';
import { ValkeyModule } from '../shared/valkey/valkey.module';
import { ReadinessService } from './readiness.service';
import { ClientWebhooksController } from './client-webhooks.controller';
import { ClientWebhooksModule } from '../modules/client-webhooks/client-webhooks.module';
import { ClientEmailsModule } from '../modules/client-emails/client-emails.module';
import { RecallsController } from './recalls.controller';
import { RecallsModule } from '../modules/recalls/recalls.module';

/**
 * api shell: the only HTTP surface of the monolith. Story 1.1 exposes
 * health, echo, and the versioned OpenAPI document — nothing else.
 * Story 2.1 wires the inventory surface (adjustment command + event
 * timeline read) here; stock state is consumed only through
 * `InventoryFacade`.
 *
 * Story 2.4: the adjustment's batch/serial arms compose cross-facade at the
 * api layer (AD-6 — inventory imports nothing cross-module), so the shell
 * also imports `CatalogModule` (batch/serial identity ensure + expiry) and
 * `TenancyModule` (the fail-closed capability assert that must run BEFORE
 * any identity creation). Both modules are spine-singletons already imported
 * by the root — no new module instances, no duplicate routes.
 *
 * Story 3.1: the inbound surface (PO create/amend/
 * close/list/detail) rides the same shape — `InboundModule` is a
 * spine-singleton already imported by the root; every mutation goes through
 * `InboundFacade`.
 *
 * Story 3.3: the receiving surface (device `grn.submit` + catalog snapshot,
 * web GRN list + over-receipt queue/approvals) rides the same shape —
 * `ReceivingController` consumes `ReceivingFacade` only.
 *
 * Story 3.5: the putaway surface (device `putaway.place`, web task +
 * placement reads) rides the same shape — `PutawayController` consumes
 * `PutawayFacade` only; the device snapshot gains the bins + putawayTasks
 * fields through the receiving facade's additive composition.
 *
 * Story 4.6b: the carriers surface (adapter catalogue + the tenant
 * credential vault — connect/list/rotate/disconnect) rides the same shape.
 * `CarriersModule` is a spine-singleton already imported by the root and
 * exports only `CarriersFacade`; the sealed credential never reaches a
 * response DTO, so the shell has nothing to redact.
 */
@Module({
  // Story 21-7 — SharedModule: Nest instantiates a route guard in the
  // CONTROLLER's module, so `PortalSessionGuard`'s DATABASE dependency must
  // resolve here too.
  imports: [SharedModule, ValkeyModule, InventoryModule, InboundModule, OutboundModule, PutawayModule, CarriersModule, CatalogModule, TenancyModule, ComplianceModule, InvoicingModule, MovementsModule, ReplenishmentModule, ChannelsModule, ReportingModule, ClientsModule, BillingModule, NotificationsModule, ReturnsModule, PartnersModule, ClientWebhooksModule, ClientEmailsModule, RecallsModule],
  controllers: [
    HealthController,
    EchoController,
    DevicesController,
    InventoryController,
    InboundController,
    OutboundController,
    // Story 4-4a — client-arranged shipping (the staff and handheld routes).
    ShippingController,
    // Story 4-6a — the order consignment record (staff).
    ConsignmentController,
    ReceivingController,
    // Story 2-3a — the gate-in (record, amend, unload — web and device —,
    // gate-out, list, detail) through `GateInFacade` (inbound).
    GateInController,
    // Story 2-3b — the dock doors, schedule, appointments and calendar
    // through `DockFacade` (inbound).
    DockController,
    PutawayController,
    CarriersController,
    // Story 12-5 — the compliance surface (excursion record/list/resolve)
    // rides the same shape: `ComplianceModule` is a spine-singleton already
    // imported by the root; every mutation goes through `ExcursionFacade`.
    ComplianceController,
    // Story 1-6c — the drug and FSSAI licences (list, coverage gaps, add,
    // edit, withdraw) through `LicenceFacade` (compliance).
    LicencesController,
    // Story 5-1 — the movements surface (the transfer-order lifecycle) rides
    // the same shape: `MovementsModule` is a spine-singleton already imported
    // by the root; every mutation goes through `MovementsFacade`.
    MovementsController,
    // Story 6-1 — the replenishment surface (reorder-policy overrides, the
    // breach queue, the suggested-PO queue + submit) rides the same shape:
    // `ReplenishmentModule` is a spine-singleton already imported by the
    // root; every mutation goes through `ReplenishmentFacade`.
    ReplenishmentController,
    // Story 7-1 — the channels surface (connections, buffers, sync health)
    // rides the same shape: `ChannelsModule` is a spine-singleton already
    // imported by the root; every mutation goes through
    // `ChannelsCommandService` / `ChannelsFacade`.
    ChannelsController,
    // Story 8-1 — the invoicing surface (invoice list/detail + the manual
    // generate/regenerate) rides the same shape: `InvoicingModule` is a
    // spine-singleton already imported by the root; the mutation goes
    // through `InvoicingCommand`, the reads through `InvoicingFacade`.
    InvoicingController,
    EwayController,
    // Story 9-1 — the reporting surface (the per-warehouse Overview) rides
    // the same shape: `ReportingModule` exports `ReportingFacade` only, and
    // the api shell is the ONLY importer of the module (decision 6's guard).
    ReportingController,
    // Story 21-2b — the client admin surface (list, create, rename) rides
    // the same shape: `ClientsModule` is a spine-singleton already imported
    // by the root; the mutations go through `ClientsCommand`, the list
    // through `ClientsFacade`.
    ClientsController,
    // Story 5-2a — a client's outbound webhooks (staff-configured, clients.manage).
    ClientWebhooksController,
    // Story 1-3 — the business partner master (list, create, edit, status,
    // client links): `PartnersModule` is a spine-singleton already imported
    // by the root; the mutations go through `PartnersCommand`, the list
    // through `PartnersFacade`.
    PartnersController,
    // Story 21-3 — the rate-card surface (list, in-force, draft, edit,
    // activate, cancel, discard) rides the same shape: `BillingModule` is a
    // spine-singleton already imported by the root; the mutations go through
    // `RateCardCommand`, the reads through `BillingFacade`.
    RateCardsController,
    // Story 21-4 — the metered-usage read (member-open; never the portal's).
    BillingUsageController,
    // Story 21-5 — client invoices (prepare, list, detail, refresh, discard,
    // issue, dispute/settle/void) — `ClientInvoiceService` owns every rule.
    ClientInvoicesController,
    ClientInvoiceNotesController,
    ClientChargesController,
    // Story 21-7 — the client portal (read-only, `PortalSessionGuard` from
    // the clients module): each read is its owning module's facade method.
    PortalController,
    // Story 9-2 — the notification panel (list, the bell's status, the
    // opened mark): `NotificationsModule` exports `NotificationsFacade` only.
    NotificationsController,
    // Story 3-7a — the batch recall (open / add / close through
    // `RecallsFacade`, qc.manage; the reads and the report through
    // `ReportingFacade`).
    RecallsController,
    // Story 13-1 — return authorizations (create, cancel, the returnable
    // read, list, detail): `ReturnsModule` exports `ReturnsFacade` only.
    ReturnsController,
    // Story 2-8b — the return to vendor (create, pick, dispatch, cancel, the
    // reads): `InboundModule` exports `VendorReturnFacade`.
    VendorReturnsController,
    // Story 4-7c — the return to client (create, pick, dispatch, cancel, the
    // reads): `ReturnsModule` exports `ReturnsFacade`.
    ClientReturnsController,
    // Story 7-2 — the channel webhook surface (guardless by construction:
    // the provider's AUTHORITY is its signature, not a session). The
    // last-siblings convention keeps NotFoundController LAST (registered
    // after webhooks so its catch-all routes cannot shadow them).
    WebhooksController,
    OpenApiController,
    NotFoundController,
  ],
  providers: [OpenApiDocumentHolder, ReadinessService],
})
export class ApiModule {}
