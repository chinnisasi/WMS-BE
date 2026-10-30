import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { EMAIL_GATEWAY, emailGatewayFromEnv } from './email.gateway';
import { MailFacade } from './mail.facade';
import { MailSender } from './mail.sender';
import { MailAttachmentRegistry } from './mail-attachments';

/**
 * The mail module (story 5-1a): the email queue (`email_messages`,
 * module-exclusive writes) and its sender.
 *
 * A business command queues a message IN ITS OWN TRANSACTION through
 * `mail.facade`'s free functions (`queueEmailInTx` — a function import, so
 * the caller needs no Nest import of this module); the jobs shell's
 * `EmailSenderWorker` drains the queue through `MailFacade.sendDue`, which
 * renders a code-defined template and sends it through the `EMAIL_GATEWAY`
 * port selected by `EMAIL_PROVIDER` (`emailGatewayFromEnv` — it fails the
 * boot on a broken configuration).
 *
 * Imports nothing from tenancy (`test/architecture.spec.ts`); exports the
 * facade and (story 2-9a) the attachment registry.
 */
@Module({
  imports: [SharedModule],
  providers: [{ provide: EMAIL_GATEWAY, useFactory: () => emailGatewayFromEnv() }, MailAttachmentRegistry, MailSender, MailFacade],
  // Story 2-9a (D13) — the attachment registry: `client-emails` registers its
  // renderer on the same singleton the sender holds.
  exports: [MailFacade, MailAttachmentRegistry],
})
export class MailModule {}
