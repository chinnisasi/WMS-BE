/**
 * Time primitive (AD-9): all timestamps in the system are ISO-8601 UTC.
 * Never store local time; never format with locale on the backend.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertUtcIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    throw new Error(`Timestamp must be ISO-8601 UTC ('Z'-suffixed): ${value}`);
  }
  return value;
}