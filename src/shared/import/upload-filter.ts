import { Catch, PayloadTooLargeException } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { ProblemException } from '../problem-details/problem.exception';
import { MAX_SHEET_UPLOAD_BYTES } from './sheet-reader';

/**
 * Multer's own middleware errors never reach this filter as MulterError —
 * platform-express' FileInterceptor transforms LIMIT_FILE_SIZE into a plain
 * 413 PayloadTooLargeException first. This route-scoped filter intercepts
 * that shape and translates it: an oversized upload surfaces as 422
 * `import-too-large` problem-details, not a bare 413. Anything else is
 * rethrown for the global problem-details filter.
 *
 * Moved here from the catalog controller (the ASN import story) so both
 * spreadsheet imports — the catalog's and the ASN import — use one copy.
 */
@Catch(PayloadTooLargeException)
export class SheetUploadFilter implements ExceptionFilter {
  // The 413's own body is multer's internal message — the translated problem
  // details carry the documented cap wording instead.
  catch(): void {
    throw new ProblemException(
      'import-too-large',
      422,
      'Import exceeds the row or size cap',
      `The file exceeds the ${MAX_SHEET_UPLOAD_BYTES}-byte (${MAX_SHEET_UPLOAD_BYTES / (1024 * 1024)} MB) cap.`,
    );
  }
}
