import { BadRequestException, Catch, PayloadTooLargeException } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { ProblemException } from '../problem-details/problem.exception';

/** Story 2-5a — the photo upload's byte cap (10 MB), mirrored by `MAX_IMAGE_BYTES` in the sanitizer. */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 10_485_760;

/**
 * Story 2-5a (A15) — multer's limits on a photo upload, as problem details.
 * The `SheetUploadFilter` sibling: platform-express turns LIMIT_FILE_SIZE into
 * a 413 PayloadTooLargeException (→ 422 `attachment-too-large`) and every
 * other multer limit (files, fields, field size, parts, an unexpected field)
 * into a 400 BadRequestException (→ 400 `validation-failed`, naming it).
 * Route-scoped: only the photo upload routes carry it, and their handlers
 * validate no JSON body, so a BadRequestException here is multer's.
 */
@Catch(PayloadTooLargeException, BadRequestException)
export class AttachmentUploadFilter implements ExceptionFilter {
  catch(exception: PayloadTooLargeException | BadRequestException): void {
    if (exception instanceof PayloadTooLargeException) {
      throw new ProblemException(
        'attachment-too-large',
        422,
        'Photo too large',
        `The photo exceeds the ${MAX_ATTACHMENT_UPLOAD_BYTES}-byte (10 MB) cap.`,
      );
    }
    throw new ProblemException('validation-failed', 400, 'Invalid photo upload', `The upload is malformed: ${exception.message}.`);
  }
}

/** A15 — the multer limits of every photo upload route. */
export const ATTACHMENT_UPLOAD_LIMITS = {
  fileSize: MAX_ATTACHMENT_UPLOAD_BYTES,
  files: 1,
  fields: 4,
  fieldSize: 256,
  parts: 6,
} as const;
