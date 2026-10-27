import { crc32 } from 'node:zlib';
import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 2-5a (decision 3, amended by A12): the allow-list image sanitizer.
 *
 * Pure and synchronous. It never decodes pixels: it walks the container
 * structurally, keeps only what the allow-list names, drops the metadata it
 * names (EXIF/GPS, XMP, IPTC, comments, text chunks, thumbnails, MPF), drops
 * every byte after the end-of-image (polyglot tails) and refuses everything
 * else. The output re-sanitizes to identical bytes — the stored `sha256` is of
 * these bytes, so idempotence is load-bearing.
 *
 * Refusals:
 *   - 415 `attachment-type-unsupported` — not JPEG/PNG/WebP by magic bytes,
 *     or an animated PNG/WebP;
 *   - 422 `attachment-too-large` — more than MAX_IMAGE_BYTES;
 *   - 422 `attachment-content-invalid` — malformed structure, a bad CRC, an
 *     unknown critical chunk, a refused JPEG marker, a side 0 or > MAX_IMAGE_SIDE.
 */

export const ATTACHMENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AttachmentImageType = (typeof ATTACHMENT_IMAGE_TYPES)[number];
export const MAX_IMAGE_BYTES = 10_485_760;
export const MAX_IMAGE_SIDE = 8000;

export interface SanitizedImage {
  contentType: AttachmentImageType;
  bytes: Buffer;
  width: number;
  height: number;
}

type SniffedType = AttachmentImageType | 'heic' | 'svg' | 'gif' | 'pdf' | null;

const SNIFF_LABEL: Record<Exclude<SniffedType, AttachmentImageType | 'heic' | null>, string> = {
  svg: 'SVG',
  gif: 'GIF',
  pdf: 'PDF',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ISO-BMFF major/compatible brands of the HEIF family (HEIC, HEIF image/sequence). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

function view(raw: Uint8Array): Buffer {
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.toString('latin1', start, Math.min(end, buf.length));
}

/** Sniffs by magic bytes only: one of the three, or 'heic' | 'svg' | 'gif' | 'pdf' | null (unknown). */
export function sniffImageType(raw: Uint8Array): SniffedType {
  const b = view(raw);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'pdf';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const boxSize = b.readUInt32BE(0);
    const end = Math.min(boxSize >= 16 ? boxSize : 16, b.length);
    if (HEIF_BRANDS.has(ascii(b, 8, 12))) return 'heic';
    for (let i = 16; i + 4 <= end; i += 4) {
      if (HEIF_BRANDS.has(ascii(b, i, i + 4))) return 'heic';
    }
    return null;
  }
  // SVG is text: an optional BOM and whitespace, then markup that names <svg.
  let head = ascii(b, 0, 4096);
  if (head.startsWith('ï»¿')) head = head.slice(3);
  head = head.trimStart();
  if (head.startsWith('<') && /<svg[\s>/]/i.test(head)) return 'svg';
  return null;
}

function unsupported(detail: string): ProblemException {
  return new ProblemException('attachment-type-unsupported', 415, 'Unsupported attachment type', detail);
}

function invalid(rule: string): ProblemException {
  return new ProblemException('attachment-content-invalid', 422, 'Invalid attachment content', rule);
}

function checkSides(format: string, width: number, height: number): void {
  if (width < 1 || height < 1) {
    throw invalid(`${format} image has a zero side (${width}×${height}); each side must be 1..${MAX_IMAGE_SIDE} px.`);
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw invalid(`${format} image is ${width}×${height} px; each side must be at most ${MAX_IMAGE_SIDE} px.`);
  }
}

/** Throws ProblemException (src/shared/problem-details/problem.exception.ts) on refusal. Never decodes pixels. */
export function sanitizeImage(raw: Uint8Array): SanitizedImage {
  if (raw.byteLength > MAX_IMAGE_BYTES) {
    throw new ProblemException(
      'attachment-too-large',
      422,
      'Attachment too large',
      `The photo is ${raw.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES} bytes (10 MiB).`,
    );
  }
  const buf = view(raw);
  const sniffed = sniffImageType(buf);
  switch (sniffed) {
    case 'image/jpeg':
      return walk(() => sanitizeJpeg(buf));
    case 'image/png':
      return walk(() => sanitizePng(buf));
    case 'image/webp':
      return walk(() => sanitizeWebp(buf));
    case 'heic':
      throw unsupported('HEIC photos are not supported — export as JPEG.');
    case null:
      throw unsupported('Only JPEG, PNG and WebP photos are accepted; this file is not a recognised image.');
    default:
      throw unsupported(`Only JPEG, PNG and WebP photos are accepted; this file is ${SNIFF_LABEL[sniffed]}.`);
  }
}

/**
 * Every read is bounds-checked before it is made; a Buffer RangeError that
 * still escapes a walker means the structure lied about a length, so it is a
 * 422 like any other truncation — never a 500.
 */
function walk(fn: () => SanitizedImage): SanitizedImage {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RangeError) throw invalid('Image structure is truncated or has an out-of-range length.');
    throw err;
  }
}

// ---------------------------------------------------------------- JPEG ----

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DHT = 0xc4;
const DRI = 0xdd;
const COM = 0xfe;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
/** Baseline, extended sequential and progressive Huffman — the only frames accepted. */
const ACCEPTED_SOF = new Set([0xc0, 0xc1, 0xc2]);

function isRst(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function isApp(marker: number): boolean {
  return marker >= 0xe0 && marker <= 0xef;
}

function hex(marker: number): string {
  return `0xFF${marker.toString(16).toUpperCase().padStart(2, '0')}`;
}

function startsWith(buf: Buffer, start: number, end: number, tag: string): boolean {
  return end - start >= tag.length && buf.toString('latin1', start, start + tag.length) === tag;
}

/**
 * APP0 keeps only JFIF (a JFXX thumbnail extension is dropped), APP2 only an
 * ICC profile (MPF and everything else dropped), APP14 only Adobe; every
 * other APPn and COM is dropped wherever it occurs.
 */
function keepAppSegment(marker: number, buf: Buffer, payloadStart: number, payloadEnd: number): boolean {
  if (marker === APP0) return startsWith(buf, payloadStart, payloadEnd, 'JFIF\0');
  if (marker === APP2) return startsWith(buf, payloadStart, payloadEnd, 'ICC_PROFILE\0');
  if (marker === APP14) return startsWith(buf, payloadStart, payloadEnd, 'Adobe');
  return false;
}

function sanitizeJpeg(buf: Buffer): SanitizedImage {
  const out: Buffer[] = [Buffer.from([0xff, SOI])];
  let pos = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let scans = 0;

  for (;;) {
    // A marker: one or more 0xFF (fill bytes), then a non-0xFF code.
    if (pos >= buf.length) throw invalid('JPEG is truncated: it ends before the end-of-image marker.');
    if (buf.readUInt8(pos) !== 0xff) {
      throw invalid(`JPEG has garbage at byte ${pos} where a marker was expected.`);
    }
    while (pos < buf.length && buf.readUInt8(pos) === 0xff) pos += 1;
    if (pos >= buf.length) throw invalid('JPEG is truncated: it ends before the end-of-image marker.');
    const marker = buf.readUInt8(pos);
    pos += 1;

    if (marker === EOI) {
      if (!sawFrame || scans === 0) throw invalid('JPEG reaches the end-of-image marker with no frame or no scan.');
      out.push(Buffer.from([0xff, EOI]));
      break; // everything after EOI (a polyglot tail, an MPF second image) is dropped
    }
    if (marker === 0x00 || marker === SOI || isRst(marker) || marker === 0x01) {
      throw invalid(`JPEG marker ${hex(marker)} is not allowed outside entropy-coded data.`);
    }

    // Every remaining marker carries a two-byte length that includes itself.
    if (pos + 2 > buf.length) throw invalid(`JPEG is truncated inside the ${hex(marker)} segment length.`);
    const length = buf.readUInt16BE(pos);
    if (length < 2) throw invalid(`JPEG segment ${hex(marker)} has an invalid length ${length}.`);
    const payloadStart = pos + 2;
    const segEnd = pos + length;
    if (segEnd > buf.length) throw invalid(`JPEG is truncated inside the ${hex(marker)} segment.`);
    const segment = (): Buffer => Buffer.concat([Buffer.from([0xff, marker]), buf.subarray(pos, segEnd)]);

    if (isApp(marker) || marker === COM) {
      if (isApp(marker) && keepAppSegment(marker, buf, payloadStart, segEnd)) out.push(segment());
      pos = segEnd;
      continue;
    }
    if (marker === DQT || marker === DHT || marker === DRI) {
      out.push(segment());
      pos = segEnd;
      continue;
    }
    if (ACCEPTED_SOF.has(marker)) {
      if (sawFrame) throw invalid('JPEG has more than one start-of-frame marker.');
      if (length < 8) throw invalid('JPEG start-of-frame segment is too short.');
      const components = buf.readUInt8(payloadStart + 5);
      if (components < 1 || components > 4 || length !== 8 + 3 * components) {
        throw invalid('JPEG start-of-frame segment has an invalid component count or length.');
      }
      height = buf.readUInt16BE(payloadStart + 1);
      width = buf.readUInt16BE(payloadStart + 3);
      checkSides('JPEG', width, height);
      sawFrame = true;
      out.push(segment());
      pos = segEnd;
      continue;
    }
    if (marker === SOS) {
      if (!sawFrame) throw invalid('JPEG has a start-of-scan before its start-of-frame.');
      if (length < 3) throw invalid('JPEG start-of-scan segment is too short.');
      const ns = buf.readUInt8(payloadStart);
      if (ns < 1 || ns > 4 || length !== 6 + 2 * ns) {
        throw invalid('JPEG start-of-scan segment has an invalid component count or length.');
      }
      out.push(segment());
      pos = copyEntropyData(buf, segEnd, out);
      scans += 1;
      continue;
    }
    throw invalid(
      `JPEG marker ${hex(marker)} is not supported; only baseline, extended and progressive Huffman JPEG are accepted.`,
    );
  }

  return {
    contentType: 'image/jpeg',
    bytes: Buffer.concat(out),
    width,
    height,
  };
}

/**
 * Copies a scan's entropy-coded data up to the next real marker. Inside it,
 * `FF 00` is a stuffed byte and `FF D0..D7` a restart marker; runs of `FF`
 * before a marker are fill bytes and are not copied (so the output is
 * canonical and re-sanitizes to itself). Returns the offset of the 0xFF that
 * starts the next real marker.
 */
function copyEntropyData(buf: Buffer, start: number, out: Buffer[]): number {
  let runStart = start;
  let i = start;
  for (;;) {
    const ff = buf.indexOf(0xff, i);
    if (ff === -1) throw invalid('JPEG is truncated inside entropy-coded data: no end-of-image marker.');
    let j = ff;
    while (j < buf.length && buf.readUInt8(j) === 0xff) j += 1;
    if (j >= buf.length) throw invalid('JPEG is truncated inside entropy-coded data: no end-of-image marker.');
    const code = buf.readUInt8(j);
    if (code === 0x00 && j === ff + 1) {
      i = j + 1; // stuffed 0xFF data byte
      continue;
    }
    if (code === 0x00) {
      // FF FF 00: fill bytes before a stuffed byte are not valid
      throw invalid(`JPEG entropy-coded data has fill bytes before a stuffed byte at ${ff}.`);
    }
    out.push(buf.subarray(runStart, ff));
    if (isRst(code)) {
      out.push(Buffer.from([0xff, code]));
      runStart = j + 1;
      i = j + 1;
      continue;
    }
    return j - 1; // the last 0xFF of the run, followed by the marker code
  }
}

// ----------------------------------------------------------------- PNG ----

const PNG_KEPT = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'pHYs',
  'bKGD',
]);
const PNG_ANIMATION = new Set(['acTL', 'fcTL', 'fdAT']);
const PNG_BIT_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function sanitizePng(buf: Buffer): SanitizedImage {
  const out: Buffer[] = [PNG_SIGNATURE];
  let pos = 8;
  let width = 0;
  let height = 0;
  let index = 0;
  let sawIdat = false;

  for (;;) {
    if (pos + 12 > buf.length) throw invalid('PNG is truncated: it ends before the IEND chunk.');
    const length = buf.readUInt32BE(pos);
    if (length > 0x7fffffff) throw invalid(`PNG chunk at byte ${pos} has an invalid length.`);
    const type = ascii(buf, pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalid(`PNG chunk at byte ${pos} has an invalid type.`);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buf.length) throw invalid(`PNG is truncated inside the ${type} chunk.`);
    const expected = buf.readUInt32BE(dataEnd);
    if (crc32(buf.subarray(pos + 4, dataEnd)) >>> 0 !== expected) {
      throw invalid(`PNG chunk ${type} has a bad CRC.`);
    }
    if (PNG_ANIMATION.has(type)) throw unsupported('Animated PNG (APNG) is not supported — send a still photo.');

    if (index === 0) {
      if (type !== 'IHDR' || length !== 13) throw invalid('PNG must start with a 13-byte IHDR chunk.');
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      const bitDepth = buf.readUInt8(dataStart + 8);
      const colorType = buf.readUInt8(dataStart + 9);
      if (!(PNG_BIT_DEPTHS[colorType] ?? []).includes(bitDepth)) {
        throw invalid(`PNG IHDR has an invalid bit depth ${bitDepth} for colour type ${colorType}.`);
      }
      if (
        buf.readUInt8(dataStart + 10) !== 0 ||
        buf.readUInt8(dataStart + 11) !== 0 ||
        buf.readUInt8(dataStart + 12) > 1
      ) {
        throw invalid('PNG IHDR has an invalid compression, filter or interlace method.');
      }
      checkSides('PNG', width, height);
    } else if (type === 'IHDR') {
      throw invalid('PNG has more than one IHDR chunk.');
    }
    index += 1;

    const critical = type.charCodeAt(0) < 0x61; // uppercase first letter
    if (PNG_KEPT.has(type)) {
      out.push(buf.subarray(pos, chunkEnd));
    } else if (critical) {
      throw invalid(`PNG has an unknown critical chunk ${type}.`);
    }
    // any other ancillary chunk (tEXt, zTXt, iTXt, eXIf, tIME, …) is dropped
    pos = chunkEnd;

    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') {
      if (length !== 0) throw invalid('PNG IEND chunk must be empty.');
      if (!sawIdat) throw invalid('PNG has no IDAT chunk.');
      break; // everything after IEND is dropped
    }
  }

  return { contentType: 'image/png', bytes: Buffer.concat(out), width, height };
}

// ---------------------------------------------------------------- WebP ----

const VP8X_FLAG_ANIMATION = 0x02;
const VP8X_FLAG_XMP = 0x04;
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_RESERVED = 0xc1;

function sanitizeWebp(buf: Buffer): SanitizedImage {
  const riffSize = buf.readUInt32LE(4);
  if (riffSize < 4 || riffSize % 2 !== 0) throw invalid('WebP RIFF size is invalid.');
  const riffEnd = 8 + riffSize;
  if (riffEnd > buf.length) throw invalid('WebP is truncated: the file is shorter than its RIFF size.');

  const kept: Buffer[] = [];
  let pos = 12;
  let first = true;
  let vp8x: Buffer | null = null;
  let canvas: { width: number; height: number } | null = null;
  let image: { width: number; height: number } | null = null;
  let sawIccp = false;
  let sawAlph = false;

  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) throw invalid('WebP is truncated inside a chunk header.');
    const fourcc = ascii(buf, pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    const paddedEnd = dataEnd + (size % 2);
    if (paddedEnd > riffEnd) throw invalid(`WebP is truncated inside the ${fourcc.trim()} chunk.`);
    const data = buf.subarray(dataStart, dataEnd);
    const isFirst = first;
    first = false;
    pos = paddedEnd;

    if (fourcc === 'ANIM' || fourcc === 'ANMF') {
      throw unsupported('Animated WebP is not supported — send a still photo.');
    }
    if (fourcc === 'EXIF' || fourcc === 'XMP ') continue; // dropped

    if (isFirst && fourcc !== 'VP8X' && fourcc !== 'VP8 ' && fourcc !== 'VP8L') {
      throw invalid(`WebP must start with a VP8, VP8L or VP8X chunk, not ${fourcc.trim()}.`);
    }
    if (image !== null) throw invalid(`WebP has a ${fourcc.trim()} chunk after its image data.`);

    switch (fourcc) {
      case 'VP8X': {
        if (!isFirst) throw invalid('WebP VP8X chunk must be the first chunk.');
        if (size !== 10) throw invalid('WebP VP8X chunk must be 10 bytes.');
        const flags = data.readUInt8(0);
        if (flags & VP8X_FLAG_ANIMATION) throw unsupported('Animated WebP is not supported — send a still photo.');
        if (flags & VP8X_FLAG_RESERVED) throw invalid('WebP VP8X chunk sets reserved flags.');
        canvas = {
          width: data.readUIntLE(4, 3) + 1,
          height: data.readUIntLE(7, 3) + 1,
        };
        checkSides('WebP', canvas.width, canvas.height);
        // a copy: the EXIF and XMP flags are cleared because those chunks are dropped
        vp8x = Buffer.from(buf.subarray(dataStart - 8, dataEnd));
        vp8x[8] = flags & ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP);
        kept.push(vp8x);
        continue;
      }
      case 'ICCP':
        if (vp8x === null) throw invalid('WebP ICCP chunk requires a VP8X header.');
        if (sawIccp || sawAlph) throw invalid('WebP ICCP chunk is duplicated or out of order.');
        sawIccp = true;
        break;
      case 'ALPH':
        if (vp8x === null) throw invalid('WebP ALPH chunk requires a VP8X header.');
        if (sawAlph) throw invalid('WebP has more than one ALPH chunk.');
        sawAlph = true;
        break;
      case 'VP8 ':
        image = vp8Dimensions(data);
        break;
      case 'VP8L':
        if (sawAlph) throw invalid('WebP ALPH chunk cannot accompany lossless VP8L data.');
        image = vp8lDimensions(data);
        break;
      default:
        throw invalid(`WebP chunk ${JSON.stringify(fourcc)} is not allowed.`);
    }
    kept.push(chunkBytes(buf, dataStart - 8, dataEnd, size));
  }

  if (image === null) throw invalid('WebP has no VP8 or VP8L image data.');
  if (vp8x === null && kept.length !== 1) throw invalid('Simple-format WebP must hold exactly one image chunk.');
  const dims = canvas ?? image;
  if (canvas !== null && (image.width > canvas.width || image.height > canvas.height)) {
    throw invalid('WebP image data is larger than its VP8X canvas.');
  }
  checkSides('WebP', dims.width, dims.height);

  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  // bytes after the RIFF end (a polyglot tail) are dropped
  return {
    contentType: 'image/webp',
    bytes: Buffer.concat([header, body]),
    width: dims.width,
    height: dims.height,
  };
}

/** A chunk's header + data, with a zero pad byte when its size is odd. */
function chunkBytes(buf: Buffer, start: number, dataEnd: number, size: number): Buffer {
  const copy = buf.subarray(start, dataEnd);
  return size % 2 === 0 ? copy : Buffer.concat([copy, Buffer.from([0])]);
}

/** VP8 key-frame header: 3-byte frame tag, start code 9D 01 2A, then 14-bit width and height. */
function vp8Dimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 10) throw invalid('WebP VP8 chunk is too short.');
  if ((data.readUInt8(0) & 0x01) !== 0) throw invalid('WebP VP8 data does not start with a key frame.');
  if (data.readUInt8(3) !== 0x9d || data.readUInt8(4) !== 0x01 || data.readUInt8(5) !== 0x2a)
    throw invalid('WebP VP8 chunk has a bad start code.');
  const dims = {
    width: data.readUInt16LE(6) & 0x3fff,
    height: data.readUInt16LE(8) & 0x3fff,
  };
  checkSides('WebP', dims.width, dims.height);
  return dims;
}

/** VP8L header: signature 0x2F, then 14-bit (width - 1) and 14-bit (height - 1), little-endian bit order. */
function vp8lDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 5) throw invalid('WebP VP8L chunk is too short.');
  if (data.readUInt8(0) !== 0x2f) throw invalid('WebP VP8L chunk has a bad signature.');
  const bits = data.readUInt32LE(1);
  if (bits >>> 29 !== 0) throw invalid('WebP VP8L chunk has an unknown version.');
  const dims = {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
  checkSides('WebP', dims.width, dims.height);
  return dims;
}
