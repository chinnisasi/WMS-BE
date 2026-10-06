import { Transform } from 'class-transformer';
import { ValidateBy, buildMessage } from 'class-validator';
import { ProblemException } from '../problem-details/problem.exception';

/**
 * Story 9-1 — the shared list-filter vocabulary every dashboard drill rides:
 * a half-open instant window `[from, to)` and an explicit boolean flag.
 *
 * Lives in shared/primitives because seven list reads across five modules
 * take the same two filters, and the dashboard's reconciliation promise
 * ("page the drill to exhaustion and you get the tile's count") only holds
 * if every one of them reads the bounds the same way: `from` INCLUSIVE, `to`
 * EXCLUSIVE, both absolute instants.
 */

/**
 * An ISO-8601 instant WITH its zone designator (`Z` or `±HH:MM`). A bare
 * local time is refused — "18:30" means a different instant on every server,
 * and the window is the whole point. Up to microsecond precision (a Postgres
 * `timestamptz`), so a drill's `to` built from a full-precision instant
 * round-trips.
 */
export const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** True when `value` is a real ISO-8601 instant (the regex AND a date that exists). */
export function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = INSTANT_RE.exec(value);
  if (match === null) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  // Date.parse rolls impossible dates (Feb 31 → Mar 3) — the calendar parts
  // must exist on their own.
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const daysInMonth = new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hours <= 23 && minutes <= 59 && seconds <= 59;
}

/** class-validator decorator: the property is an ISO-8601 instant with a zone designator. */
export function IsInstant(): PropertyDecorator {
  return ValidateBy({
    name: 'isInstant',
    validator: {
      validate: (value: unknown) => isInstant(value),
      defaultMessage: buildMessage(
        (each) => `${each}$property must be an ISO-8601 instant with a zone designator (e.g. 2026-10-06T18:30:00Z) — got "$value"`,
      ),
    },
  });
}

/**
 * The explicit boolean query flag: exactly `'true'` or `'false'` become
 * booleans; ANY other spelling stays a string so `@IsBoolean()` refuses it
 * by name. (`enableImplicitConversion` would turn `'false'` into `true` — the
 * non-empty-string truthiness trap — and `'1'`/`'yes'` into silent accepts.)
 */
export function BooleanFlag(): PropertyDecorator {
  return Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  });
}

/**
 * A repeatable query parameter: `?type=a&type=b` arrives as an array, a
 * single `?type=a` as a string — both become an array here so one
 * `each: true` validator covers both spellings.
 */
export function RepeatableParam(): PropertyDecorator {
  return Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    return typeof raw === 'string' ? [raw] : raw;
  });
}

/**
 * The cross-field half the DTO cannot express: `from` must be strictly
 * before `to` when both are given (an empty or inverted window is a request
 * bug, not "no rows"). 400 `validation-failed`, naming both bounds.
 */
export function assertInstantRange(from: string | undefined, to: string | undefined): void {
  if (from === undefined || to === undefined) return;
  if (Date.parse(from) >= Date.parse(to)) {
    throw new ProblemException(
      'validation-failed',
      400,
      'Invalid time window',
      `from must be strictly before to — got from=${from}, to=${to} (the window is [from, to), to exclusive).`,
    );
  }
}
