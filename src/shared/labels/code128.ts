/**
 * Story 2-10a — an in-house Code 128 **subset B** encoder (and its decoder,
 * for tests). No barcode library: the encoder is the fit check (the symbol's
 * exact module count), the PDF renderer's bars, and — decoded back — the
 * proof that a printed label carries exactly the bin code.
 *
 * Subset B covers printable ASCII `0x20–0x7E`: a character's symbol value is
 * its code minus 32. A symbol is: start B (104), one symbol per character,
 * the mod-103 check symbol, and the stop pattern. Every symbol but the stop is
 * 11 modules wide (three bars and three spaces); the stop is 13 (four bars,
 * three spaces). So a payload of `n` characters is exactly `11·n + 35`
 * modules, quiet zones excluded.
 *
 * Pure: no I/O, no DB, no module imports.
 */

/**
 * The 107 Code 128 patterns, as bar/space widths in modules (bar first).
 * Index = symbol value. 103–105 are the three start codes; 106 is the stop.
 * Each 0–105 entry sums to 11; the stop sums to 13 (pinned in the spec).
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export const START_B = 104;
export const STOP = 106;
/** Modules of fixed overhead: start (11) + check (11) + stop (13). */
const OVERHEAD_MODULES = 35;

/** The symbol's width in modules for an `n`-character subset-B payload, quiet zones excluded. */
export function moduleCount(n: number): number {
  return 11 * n + OVERHEAD_MODULES;
}

/** Thrown for a payload subset B cannot carry; the caller turns it into its own refusal. */
export class NotBarcodableError extends Error {
  constructor(readonly payload: string, reason: string) {
    super(`"${payload}" is not barcodable: ${reason}`);
    this.name = 'NotBarcodableError';
  }
}

/**
 * Why `payload` cannot be a subset-B symbol, or `null` when it can: empty; a
 * character outside printable ASCII `0x20–0x7E` (non-ASCII, a control
 * character); a leading or trailing space (a scanner's trim would drop it, so
 * the scan would no longer equal the code).
 */
export function barcodableProblem(payload: string): string | null {
  if (payload.length === 0) return 'it is empty';
  for (let i = 0; i < payload.length; i += 1) {
    const c = payload.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      return 'it carries a character outside printable ASCII';
    }
  }
  if (payload.startsWith(' ') || payload.endsWith(' ')) {
    return 'it starts or ends with a space';
  }
  return null;
}

export function isBarcodable(payload: string): boolean {
  return barcodableProblem(payload) === null;
}

export function assertBarcodable(payload: string): void {
  const problem = barcodableProblem(payload);
  if (problem !== null) throw new NotBarcodableError(payload, problem);
}

/** The symbol values: start B, one per character, the mod-103 check, stop. */
export function code128BSymbols(payload: string): number[] {
  assertBarcodable(payload);
  const values: number[] = [START_B];
  let sum = START_B;
  for (let i = 0; i < payload.length; i += 1) {
    const value = payload.charCodeAt(i) - 32;
    values.push(value);
    sum += value * (i + 1);
  }
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/**
 * The symbol as alternating bar/space widths in modules, bar first, quiet
 * zones excluded. The widths sum to `moduleCount(payload.length)`.
 */
export function encodeCode128B(payload: string): number[] {
  const widths: number[] = [];
  for (const value of code128BSymbols(payload)) {
    for (const digit of CODE128_PATTERNS[value]!) {
      widths.push(Number(digit));
    }
  }
  return widths;
}

const PATTERN_TO_VALUE: ReadonlyMap<string, number> = new Map(CODE128_PATTERNS.map((p, i) => [p, i]));

/**
 * Decodes bar/space widths (bar first, quiet zones stripped) back to the
 * payload, verifying the start B, the check symbol and the stop. For tests —
 * it is the round trip that proves a rendered label carries the code.
 */
export function decodeCode128B(widths: readonly number[]): string {
  const stopWidth = 7;
  if (widths.length < 6 * 2 + stopWidth || (widths.length - stopWidth) % 6 !== 0) {
    throw new Error(`Code 128: ${widths.length} elements is not a whole symbol sequence`);
  }
  const values: number[] = [];
  for (let i = 0; i < widths.length - stopWidth; i += 6) {
    const key = widths.slice(i, i + 6).join('');
    const value = PATTERN_TO_VALUE.get(key);
    if (value === undefined || value > 105) throw new Error(`Code 128: unknown pattern ${key} at element ${i}`);
    values.push(value);
  }
  const stop = widths.slice(widths.length - stopWidth).join('');
  if (stop !== CODE128_PATTERNS[STOP]) throw new Error(`Code 128: bad stop pattern ${stop}`);
  if (values[0] !== START_B) throw new Error(`Code 128: expected start B, got ${values[0]}`);
  const data = values.slice(1, -1);
  const check = values[values.length - 1]!;
  let sum = START_B;
  data.forEach((value, i) => {
    sum += value * (i + 1);
  });
  if (sum % 103 !== check) throw new Error(`Code 128: check symbol ${check} does not match ${sum % 103}`);
  return data
    .map((value) => {
      if (value > 94) throw new Error(`Code 128: value ${value} is a function code, not subset-B data`);
      return String.fromCharCode(value + 32);
    })
    .join('');
}
