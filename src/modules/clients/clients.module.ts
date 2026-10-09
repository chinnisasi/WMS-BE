import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { ClientsCommand } from './clients.command';
import { ClientsFacade } from './clients.facade';
import { PortalSessionGuard } from './portal-session.guard';

/**
 * Clients module (story 21-1 stood up the table; 21-2b gives it its admin
 * surface). Owns the `clients` table: the create/rename command and the read
 * facade. Sibling modules reach the table only through `ensure-self-client.ts`
 * and the file-level `…InTx` reads in `clients.facade.ts` — the
 * `ensureReceivingBinInTx` seam shape — never by writing it.
 */
@Module({
  imports: [SharedModule],
  // Story 21-7 — `PortalSessionGuard` (the clients module owns portal
  // scoping): DI-wired here and exported so the api shell's portal
  // controller resolves it with its DATABASE dependency.
  providers: [ClientsCommand, ClientsFacade, PortalSessionGuard],
  exports: [ClientsCommand, ClientsFacade, PortalSessionGuard],
})
export class ClientsModule {}
