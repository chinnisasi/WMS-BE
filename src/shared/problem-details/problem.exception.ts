import { HttpException } from '@nestjs/common';
import { problem } from './problem-details';

/**
 * Throws an exception the ProblemDetailsFilter renders as an RFC 9457
 * problem-details document with a machine-readable `code` — the way command
 * services and controllers reject business faults (duplicate email, reuse of
 * an idempotency key with a different payload, …).
 */
export class ProblemException extends HttpException {
  constructor(code: string, status: number, title: string, detail?: string) {
    // `message` mirrors the human detail so the filter's rendered `title` and
    // `detail` stay consistent with this intent.
    super({ ...problem(code, status, title, detail), message: detail ?? title }, status);
  }
}

/**
 * Walks an error's `cause` chain (drizzle wraps driver errors in
 * `DrizzleQueryError`) looking for a Postgres unique-violation (23505) on the
 * named constraint/index. The driver exposes the constraint via the
 * `constraint` property when present, else only inside the message.
 */
export function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.code === '23505') {
      const constraint =
        typeof candidate.constraint === 'string' ? candidate.constraint : undefined;
      const message = typeof candidate.message === 'string' ? candidate.message : '';
      return (
        (constraint !== undefined && constraint.includes(constraintName)) ||
        message.includes(constraintName)
      );
    }
    current = candidate.cause;
  }
  return false;
}