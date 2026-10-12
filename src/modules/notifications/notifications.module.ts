import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { NotificationsDeliveryHandler } from './notifications.delivery';
import { NotificationsFacade } from './notifications.facade';

/**
 * The notifications module (story 9-2): the web notification panel.
 *
 * Owns `notifications` and `notification_reads` (module-exclusive writes —
 * `test/architecture.spec.ts`). It reads NO sibling's table: the entries are
 * a projection filled by `NotificationsDeliveryHandler` from the owning
 * modules' outbox events (raise → entry, resolve → resolved), so the panel
 * is one indexed read however many modules feed it. The one cross-module
 * import is tenancy's role read + capability map (`getMemberRoleIn`,
 * `ROLE_CAPABILITIES`) — the routing rule ("a member sees what it can act
 * on") is the commands' own authority, not a copy of it.
 *
 * Exports only the facade; the api shell's `NotificationsController` is the
 * HTTP surface. Mobile pushes are story 9-2b.
 */
@Module({
  imports: [SharedModule],
  providers: [NotificationsDeliveryHandler, NotificationsFacade],
  exports: [NotificationsFacade],
})
export class NotificationsModule {}
