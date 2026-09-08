import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import { parseIdempotencyKey } from '../../shared/idempotency/idempotency.seam';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Param decorator for the raw `Idempotency-Key` header. A custom decorator
 * (not `@Headers`) so the OpenAPI document carries exactly one parameter per
 * endpoint — the required one documented via `@ApiHeaders`.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const header = request.headers['idempotency-key'];
    return typeof header === 'string' ? header : undefined;
  },
);

/**
 * Command-layer idempotency (AD-5). The header must be a client-generated
 * ULID; the key + payload hash de-dupe in the same transaction as the write
 * (see registration.command.ts / warehouse.command.ts). Malformed or missing
 * keys are rejected before any state changes.
 */
export function parseRequiredIdempotencyKey(raw: string | undefined): string {
  if (!raw) {
    throw new ProblemException(
      'idempotency-key-required',
      400,
      'Idempotency-Key header is required',
      'Every mutating request carries a client-generated ULID Idempotency-Key header.',
    );
  }
  if (!parseIdempotencyKey(raw)) {
    throw new ProblemException(
      'idempotency-key-invalid',
      400,
      'Idempotency-Key must be a 26-character ULID',
      `The Idempotency-Key header must match the ULID format (got "${raw}").`,
    );
  }
  return raw;
}

/** Stable payload fingerprint — canonical JSON of the command, sha256. */
export function hashCommandPayload(command: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(command), 'utf8').digest('hex');
}