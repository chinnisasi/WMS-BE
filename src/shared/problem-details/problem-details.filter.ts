import type { ArgumentsHost, ExceptionFilter} from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ProblemDetails } from './problem-details';
import { problem } from './problem-details';

const PROBLEM_JSON = 'application/problem+json; charset=utf-8';

/**
 * Renders every unhandled and framework exception as an RFC 9457
 * problem-details document with a machine-readable `code`.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status: (n: number) => unknown; set: (k: string, v: string) => unknown; send: (b: unknown) => unknown }>();

    let details: ProblemDetails;
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const code =
        typeof body === 'object' && body !== null && 'code' in body
          ? String((body as { code: unknown }).code)
          : httpCodeToProblemCode(status);
      details = problem(
        code,
        status,
        exception.message,
        typeof body === 'object' && body !== null && 'detail' in body
          ? String((body as { detail: unknown }).detail)
          : undefined,
      );
    } else {
      // Unexpected faults are logged server-side and reported without internals.
      details = problem('internal-error', HttpStatus.INTERNAL_SERVER_ERROR, 'Internal Server Error');
    }

    res.status(details.status);
    res.set('Content-Type', PROBLEM_JSON);
    res.send(details);
  }
}

function httpCodeToProblemCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'validation-failed';
    case HttpStatus.UNAUTHORIZED:
      return 'unauthenticated';
    case HttpStatus.FORBIDDEN:
      return 'permission-denied';
    case HttpStatus.NOT_FOUND:
      return 'not-found';
    case HttpStatus.CONFLICT:
      return 'conflict';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'unprocessable';
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR === status ? 'internal-error' : `http-${status}`;
  }
}