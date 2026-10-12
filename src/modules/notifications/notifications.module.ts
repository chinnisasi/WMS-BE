import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { NotificationsDeliveryHandler } from './notifications.delivery';
import { NotificationsFacade } from './notifications.facade';
import { PushEnqueueHandler } from './push.enqueue';
import { PushSender } from './push.sender';
import { PUSH_GATEWAY, pushGatewayFromEnv } from './push-gateway';

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
 * HTTP surface.
 *
 * Story 9-2b adds the mobile pushes: `push_deliveries` (module-exclusive),
 * filled by `PushEnqueueHandler` (an outbox subscriber that only INSERTS —
 * no network) and drained by `PushSender` behind
 * `NotificationsFacade.sendDuePushes` (the jobs shell's `PushSenderWorker`
 * drives it) through the `PUSH_GATEWAY` port, selected by the
 * `PUSH_GATEWAY` env mode. Devices are read and cleared only through
 * tenancy's push-target functions.
 *
 * PROVIDER ORDER IS LOAD-BEARING: the delivery handler subscribes before the
 * push enqueue, so on the three approval raises the panel entry is written
 * before the push handler runs (the bus runs handlers in subscription
 * order, and a throw stops the rest).
 */
@Module({
  imports: [SharedModule],
  providers: [
    NotificationsDeliveryHandler,
    PushEnqueueHandler,
    { provide: PUSH_GATEWAY, useFactory: () => pushGatewayFromEnv() },
    PushSender,
    NotificationsFacade,
  ],
  exports: [NotificationsFacade],
})
export class NotificationsModule {}
