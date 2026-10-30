/**
 * Story 4-5a (A25, A38, D3) — a carton label's code: the order's parcel tag
 * (`parcel-tag.ts`, `O` + the order id's last 16 hex digits) + `.` + the pack
 * number (1–99) + `.` + the carton number (1–200), with no leading zeros —
 * `O0123456789ABCDEF.1.2`, at most 24 characters, Code 128 subset B.
 *
 * Like the parcel tag it is a MATCH KEY, never resolved server-side alone:
 * the prefix finds the order in a list the client holds, and the pack number
 * makes a superseded pack's labels detectably stale. The `.` keeps it out of
 * the AWB shape. The DB backstop is `order_cartons_code_shape` and
 * `order_cartons_code_derived` (0117).
 *
 * Pure. Mirrored byte for byte in wms-fe and wms-mobile `src/lib/carton-code.ts`,
 * all three pinned by the shared `carton-code.vectors.json` (same sha256).
 */

import { CARTON_CODE_RE } from './awb';
import { parcelTagCode } from './parcel-tag';

/** The highest pack number (`order_packs_seq_range`). */
export const MAX_CARTON_PACK_SEQ = 99;
/** The highest carton number (`order_cartons_seq_range`). */
export const MAX_CARTON_SEQ = 200;

export interface ParsedCartonCode {
  /** The order's parcel tag, upper-case (`O` + 16 hex). */
  readonly parcelTag: string;
  readonly packSeq: number;
  readonly seq: number;
}

/** The code printed on carton `seq` of pack `packSeq` of `orderId`. */
export function cartonCode(orderId: string, packSeq: number, seq: number): string {
  if (!Number.isInteger(packSeq) || packSeq < 1 || packSeq > MAX_CARTON_PACK_SEQ) {
    throw new RangeError(`A pack number is 1–${MAX_CARTON_PACK_SEQ} (got ${packSeq}).`);
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_CARTON_SEQ) {
    throw new RangeError(`A carton number is 1–${MAX_CARTON_SEQ} (got ${seq}).`);
  }
  return `${parcelTagCode(orderId)}.${packSeq}.${seq}`;
}

/** Read a scanned carton code (trimmed and upper-cased first), or null when it is not one. */
export function parseCartonCode(raw: string): ParsedCartonCode | null {
  const value = raw.trim().toUpperCase();
  if (!CARTON_CODE_RE.test(value)) return null;
  const [parcelTag, pack, carton] = value.split('.') as [string, string, string];
  const packSeq = Number(pack);
  const seq = Number(carton);
  if (packSeq > MAX_CARTON_PACK_SEQ || seq > MAX_CARTON_SEQ) return null;
  return { parcelTag, packSeq, seq };
}
