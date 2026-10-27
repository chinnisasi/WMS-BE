import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { AttachmentsFacade } from './attachments.facade';
import { FILE_STORE, fileStoreFromEnv } from './file-store';

/**
 * Story 2-5a — the attachments module: the `attachments` table, the
 * file-storage port (`FILE_STORE=none|local|s3`, env-switched — guide §8),
 * the allow-list image sanitizer, the upload gate and the retention sweep.
 * It imports no sibling module; its consumers (inbound's receipt photos, the
 * jobs shell's `AttachmentSweepWorker`) import it. Exports the facade and the
 * port token.
 */
@Module({
  imports: [SharedModule],
  providers: [{ provide: FILE_STORE, useFactory: () => fileStoreFromEnv() }, AttachmentsFacade],
  exports: [AttachmentsFacade, FILE_STORE],
})
export class AttachmentsModule {}
