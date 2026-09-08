import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ProblemDetails } from './problem-details';
import { problem } from './problem-details';

const PROBLEM_JSON = 'application/problem+json; charset=utf-8';

/**
 * Renders every unhandled and framework exception as an RFC 9457
 * problem-details document with a machine-readable `code`.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetailsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<{
      headersSent?: boolean;
      status: (n: number) => unknown;
      set: (k: string, v: string) => unknown;
      send: (b: unknown) => unknown;
    }>();
    const req = http.getRequest<{ url?: string }>();

    let details: ProblemDetails;
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const code =
        typeof body === 'object' && body !== null && 'code' in body
          ? String((body as { code: unknown }).code)
          : httpCodeToProblemCode(status);
      // ValidationPipe puts field errors in `message` (string or string[]);
      // preserve them so clients can render substance, not just a code.
      const rawMessage =
        typeof body === 'object' && body !== null && 'message' in body
          ? (body as { message: unknown }).message
          : undefined;
      const errors = Array.isArray(rawMessage)
        ? rawMessage.map(String)
        : typeof rawMessage === 'string'
          ? [rawMessage]
          : undefined;
      details = {
        ...problem(
          code,
          status,
          exception.message,
          errors ? errors.join('; ') : undefined,
          errors ? { errors } : undefined,
        ),
        ...(typeof req?.url === 'string' ? { instance: req.url } : {}),
      };
    } else {
      // Unexpected faults are logged server-side (with stack) and reported
      // without internals.
      this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
      details = problem('internal-error', HttpStatus.INTERNAL_SERVER_ERROR, 'Internal Server Error');
    }

    if (res.headersSent) {
      // The response already started streaming — rendering now would throw
      // ERR_HTTP_HEADERS_SENT from inside the error filter itself.
      return;
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
