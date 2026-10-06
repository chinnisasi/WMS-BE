import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/shared.module';
import { ReportingFacade } from './reporting.facade';

/**
 * Reporting module (story 9-1): the operational dashboard's read model.
 *
 * Owns NO tables. Its tiles read the owning modules' tables directly,
 * read-only — decision 6, the one named exception to AD-6's facade rule,
 * guarded by `test/architecture.spec.ts` (reporting writes nothing; nothing
 * but the api shell imports it). See `kpis.ts` for the exception's terms.
 * The audit trail and exports (9-3) join this module later.
 */
@Module({
  imports: [SharedModule],
  providers: [ReportingFacade],
  exports: [ReportingFacade],
})
export class ReportingModule {}
