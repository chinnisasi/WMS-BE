import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { CarrierCommandService } from './carrier.command';
import { CarriersFacade } from './carriers.facade';

/**
 * Carriers module (Story 4.6b) — the carrier substrate, stood up as the two
 * halves that need each other:
 *
 *  - the **adapter registry** (`carrier-registry.ts`): a compile-time,
 *    import-time `Map` naming the supported carriers (Delhivery, Blue Dart,
 *    Ecom Express — the human OQ1 decision, 2026-09-16) and, per carrier, the
 *    credential fields it requires. Additive: a new carrier is one
 *    `registerCarrierAdapter` call and no migration.
 *  - the **credential vault** (`carrier_connections`, module-exclusive):
 *    one tenant-scoped row per configured carrier account, its secret
 *    material sealed with `envelope.ts` under `CARRIER_ENCRYPTION_KEY` and
 *    **never readable back over the wire** (AD-15). Connect, rotate and
 *    disconnect are commands behind `carrier.manage` (Owner + Ops Manager);
 *    disconnect is a hard DELETE, because a status flip would leave sealed
 *    secret material at rest after the operator asked for it to be gone.
 *
 * Scope, deliberately: **no network calls and no HTTP client dependency.**
 * Adapters are declarative descriptors; `rate()`, `label()` and `track()` are
 * not declared at all — nothing calls them today (rating is deferred, labels
 * and manifests are 4-6c), and a method signature guessed before its first
 * caller is a shipped interface to unpick. The port grows those arms in the
 * story that consumes them; `CarriersFacade` is the seam they grow from.
 *
 * Imports `SharedModule` only (DATABASE, OUTBOX_SINK — the spine
 * primitives); the tenancy helpers the command uses at entry
 * (`assertPermission`, `getMemberRoleIn`) are the shared command-entry
 * pattern's file-level functions, so this module takes no cross-module edge
 * and nothing can cycle back into it. `CarriersFacade` is exported ALONE —
 * the architecture test fails any sibling that reaches past it (AD-6).
 */
@Module({
  imports: [SharedModule],
  providers: [CarrierCommandService, CarriersFacade],
  exports: [CarriersFacade],
})
export class CarriersModule {}
