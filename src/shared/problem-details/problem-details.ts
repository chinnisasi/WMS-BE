/**
 * RFC 9457 problem-details primitive (AD-9). Every error response from the
 * api shell is a problem-details document carrying a machine-readable
 * `code` — clients branch on `code`, never on prose.
 */

export interface ProblemDetails {
  /** Stable URI identifying the problem class. */
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  /** Machine-readable error code — the contract clients branch on. */
  readonly code: string;
  readonly [extension: string]: unknown;
}

export function problemType(code: string): string {
  return `https://wms.example.com/problems/${code}`;
}

export function problem(
  code: string,
  status: number,
  title: string,
  detail?: string,
  extensions?: Record<string, unknown>,
): ProblemDetails {
  return {
    type: problemType(code),
    title,
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...extensions,
  };
}
