import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  MAX_IMAGE_BYTES,
  sanitizeImage,
  sniffImageType,
  type SanitizedImage,
} from '../src/modules/attachments/image-sanitize';
import { ProblemException } from '../src/shared/problem-details/problem.exception';

/**
 * Story 2-5a (decision 3 / A12): the allow-list image sanitizer. A pure unit
 * suite over real encoder output — the fixtures in test/fixtures/images are
 * written by cjpeg, cwebp/webpmux/img2webp and sips, with real metadata
 * segments spliced in (see generate.sh there). Byte-level mutations
 * (truncation, a flipped CRC, a zeroed side) are applied here, in the test.
 */

const FIXTURES = join(__dirname, 'fixtures', 'images');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

interface Refusal {
  status: number;
  code: string;
  detail: string;
}

function refusal(raw: Uint8Array): Refusal {
  try {
    sanitizeImage(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    const e = err as ProblemException;
    const body = e.getResponse() as { code: string; detail: string };
    return { status: e.getStatus(), code: body.code, detail: body.detail };
  }
  throw new Error('expected sanitizeImage to refuse');
}

function expectInvalid(raw: Uint8Array, detail: RegExp): void {
  const r = refusal(raw);
  expect(r).toMatchObject({ status: 422, code: 'attachment-content-invalid' });
  expect(r.detail).toMatch(detail);
}

function expectUnsupported(raw: Uint8Array, detail: RegExp | string): void {
  const r = refusal(raw);
  expect(r).toMatchObject({ status: 415, code: 'attachment-type-unsupported' });
  if (typeof detail === 'string') expect(r.detail).toBe(detail);
  else expect(r.detail).toMatch(detail);
}

/** Sanitizes and pins idempotence: the output re-sanitizes to identical bytes. */
function clean(raw: Uint8Array): SanitizedImage {
  const first = sanitizeImage(raw);
  const second = sanitizeImage(first.bytes);
  expect(second.bytes.equals(first.bytes)).toBe(true);
  expect(second).toMatchObject({
    contentType: first.contentType,
    width: first.width,
    height: first.height,
  });
  return first;
}

// --- structural readers used only for assertions ---------------------------

interface JpegSegment {
  marker: number;
  payload: Buffer;
}

/** Every marker segment in order (entropy data skipped; RSTn and EOI listed with empty payloads). */
function jpegSegments(buf: Buffer): JpegSegment[] {
  const segs: JpegSegment[] = [{ marker: 0xd8, payload: Buffer.alloc(0) }];
  let pos = 2;
  while (pos < buf.length) {
    while (buf.readUInt8(pos) === 0xff) pos += 1;
    const marker = buf.readUInt8(pos);
    pos += 1;
    if (marker === 0xd9) {
      segs.push({ marker, payload: Buffer.alloc(0) });
      return segs;
    }
    const len = buf.readUInt16BE(pos);
    segs.push({ marker, payload: buf.subarray(pos + 2, pos + len) });
    pos += len;
    if (marker === 0xda) {
      // skip entropy data, listing restart markers
      for (;;) {
        if (buf.readUInt8(pos) === 0xff && buf.readUInt8(pos + 1) !== 0x00) {
          if (buf.readUInt8(pos + 1) >= 0xd0 && buf.readUInt8(pos + 1) <= 0xd7) {
            segs.push({
              marker: buf.readUInt8(pos + 1),
              payload: Buffer.alloc(0),
            });
            pos += 2;
            continue;
          }
          break;
        }
        pos += buf.readUInt8(pos) === 0xff ? 2 : 1;
      }
    }
  }
  throw new Error('no EOI');
}

const markers = (buf: Buffer): number[] => jpegSegments(buf).map((s) => s.marker);
const appTags = (buf: Buffer, marker: number): string[] =>
  jpegSegments(buf)
    .filter((s) => s.marker === marker)
    .map((s) => s.payload.toString('latin1', 0, s.payload.indexOf(0) === -1 ? 12 : s.payload.indexOf(0)));

function pngChunks(buf: Buffer): string[] {
  const types: string[] = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    types.push(buf.toString('latin1', pos + 4, pos + 8));
    pos += 12 + len;
  }
  return types;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function webpChunks(buf: Buffer): Array<{ fourcc: string; size: number }> {
  const chunks: Array<{ fourcc: string; size: number }> = [];
  let pos = 12;
  const end = 8 + buf.readUInt32LE(4);
  while (pos < end) {
    const size = buf.readUInt32LE(pos + 4);
    chunks.push({ fourcc: buf.toString('latin1', pos, pos + 4), size });
    pos += 8 + size + (size % 2);
  }
  expect(pos).toBe(end);
  return chunks;
}

const TAIL = Buffer.from('PK\x03\x04polyglot-zip-payload<script>alert(1)</script>', 'latin1');

// ---------------------------------------------------------------------------

describe('sniffImageType (magic bytes only)', () => {
  it.each([
    ['baseline.jpg', 'image/jpeg'],
    ['sips.png', 'image/png'],
    ['lossy.webp', 'image/webp'],
    ['photo.heic', 'heic'],
    ['photo.gif', 'gif'],
    ['photo.pdf', 'pdf'],
  ])('%s → %s', (name, type) => {
    expect(sniffImageType(fixture(name))).toBe(type);
  });

  it('recognises SVG text, with or without an XML prolog or BOM', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffImageType(Buffer.from('﻿  <?xml version="1.0"?>\n<svg width="1"></svg>'))).toBe('svg');
  });

  it('returns null for anything else', () => {
    expect(sniffImageType(Buffer.from('hello world'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('type and size refusals', () => {
  it('HEIC → 415 with the export hint', () => {
    expectUnsupported(fixture('photo.heic'), 'HEIC photos are not supported — export as JPEG.');
  });

  it.each([
    ['photo.gif', /GIF/],
    ['photo.pdf', /PDF/],
  ])('%s → 415 naming what it sniffed as', (name, detail) => {
    expectUnsupported(fixture(name), detail);
  });

  it('SVG → 415', () => {
    expectUnsupported(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), /SVG/);
  });

  it('unknown bytes and an empty file → 415', () => {
    expectUnsupported(Buffer.from('not an image at all'), /not a recognised image/);
    expectUnsupported(Buffer.alloc(0), /not a recognised image/);
  });

  it('more than 10 MiB → 422 attachment-too-large, checked before anything else', () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    fixture('baseline.jpg').copy(big);
    expect(refusal(big)).toMatchObject({
      status: 422,
      code: 'attachment-too-large',
    });
  });

  it('exactly 10 MiB is not refused for size', () => {
    const atLimit = Buffer.alloc(MAX_IMAGE_BYTES);
    const jpg = fixture('baseline.jpg');
    jpg.copy(atLimit); // a valid JPEG followed by a zero tail
    const out = clean(atLimit);
    expect(out.bytes.equals(jpg)).toBe(true);
  });
});

describe('JPEG allow-list', () => {
  it('a baseline cjpeg file passes through unchanged', () => {
    const jpg = fixture('baseline.jpg');
    const out = clean(jpg);
    expect(out).toMatchObject({
      contentType: 'image/jpeg',
      width: 24,
      height: 16,
    });
    expect(out.bytes.equals(jpg)).toBe(true);
  });

  it('accepts a Uint8Array that is not a Buffer and returns a fresh Buffer', () => {
    const jpg = fixture('baseline.jpg');
    const out = clean(new Uint8Array(jpg));
    expect(Buffer.isBuffer(out.bytes)).toBe(true);
    expect(out.bytes.equals(jpg)).toBe(true);
  });

  it('keeps restart markers inside the entropy-coded data', () => {
    const jpg = fixture('restart.jpg');
    expect(markers(jpg)).toEqual(expect.arrayContaining([0xdd, 0xd0]));
    const out = clean(jpg);
    expect(out.bytes.equals(jpg)).toBe(true);
    expect(markers(out.bytes)).toEqual(markers(jpg));
  });

  it('APP1 GPS EXIF and COM are dropped; JFIF and the ICC profile are kept', () => {
    const jpg = fixture('gps-exif-icc.jpg');
    expect(markers(jpg)).toEqual(expect.arrayContaining([0xe1, 0xfe, 0xe2]));
    const out = clean(jpg);
    expect(out).toMatchObject({ width: 24, height: 16 });
    const kept = markers(out.bytes);
    expect(kept).not.toContain(0xe1);
    expect(kept).not.toContain(0xfe);
    expect(appTags(out.bytes, 0xe0)).toEqual(['JFIF']);
    expect(appTags(out.bytes, 0xe2)).toEqual(['ICC_PROFILE']);
    expect(out.bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
    expect(out.bytes.includes(Buffer.from('WMSCam'))).toBe(false);
    // the ICC profile bytes survive verbatim
    const icc = jpegSegments(jpg).find((s) => s.marker === 0xe2)!.payload;
    expect(out.bytes.includes(icc)).toBe(true);
  });

  it('progressive: APP13, COM and APP1 between scans are dropped, every scan is kept', () => {
    const jpg = fixture('progressive-app13.jpg');
    const before = markers(jpg);
    const sos = before.filter((m) => m === 0xda).length;
    expect(sos).toBeGreaterThan(1);
    // the fixture really has the metadata after the first scan
    expect(before.indexOf(0xed)).toBeGreaterThan(before.indexOf(0xda));
    const out = clean(jpg);
    expect(out).toMatchObject({ width: 24, height: 16 });
    const after = markers(out.bytes);
    expect(after.filter((m) => m === 0xda)).toHaveLength(sos);
    expect(after).toContain(0xc2);
    for (const dropped of [0xed, 0xfe, 0xe1]) expect(after).not.toContain(dropped);
    expect(after).toEqual(before.filter((m) => ![0xed, 0xfe, 0xe1].includes(m)));
  });

  it('a JFXX thumbnail APP0 is dropped (the JFIF APP0 stays)', () => {
    const out = clean(fixture('jfxx-thumbnail.jpg'));
    expect(appTags(out.bytes, 0xe0)).toEqual(['JFIF']);
    expect(out.bytes.equals(fixture('baseline.jpg'))).toBe(true);
  });

  it('an MPF APP2 and the secondary image after EOI are dropped', () => {
    const jpg = fixture('mpf.jpg');
    expect(appTags(jpg, 0xe2)).toEqual(['MPF']);
    const out = clean(jpg);
    expect(out.bytes.equals(fixture('baseline.jpg'))).toBe(true);
    expect(out.bytes.indexOf(Buffer.from([0xff, 0xd8]), 2)).toBe(-1);
  });

  it('a polyglot tail after EOI is dropped', () => {
    const jpg = fixture('baseline.jpg');
    const out = clean(Buffer.concat([jpg, TAIL]));
    expect(out.bytes.equals(jpg)).toBe(true);
  });

  it('fill bytes before a marker are dropped, so the output is canonical', () => {
    const jpg = fixture('baseline.jpg');
    // insert two 0xFF fill bytes before the EOI marker
    const filled = Buffer.concat([jpg.subarray(0, jpg.length - 2), Buffer.from([0xff, 0xff]), jpg.subarray(-2)]);
    expect(clean(filled).bytes.equals(jpg)).toBe(true);
  });

  it('SOF3 (lossless) → 422 naming the marker', () => {
    expectInvalid(fixture('lossless-sof3.jpg'), /0xFFC3/);
  });

  it('SOF9 (arithmetic coding) → 422 naming the marker', () => {
    expectInvalid(fixture('arithmetic-sof9.jpg'), /0xFFC9/);
  });

  it('8,000 px is accepted; 8,001 px → 422', () => {
    expect(clean(fixture('wide-8000.jpg'))).toMatchObject({
      width: 8000,
      height: 1,
    });
    expectInvalid(fixture('wide-8001.jpg'), /8001×1 px; each side must be at most 8000/);
  });

  it('a 0 px side (DNL-deferred height) → 422', () => {
    const jpg = Buffer.from(fixture('baseline.jpg'));
    const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
    jpg.writeUInt16BE(0, sof + 5); // height
    expectInvalid(jpg, /zero side/);
  });

  it('truncated inside the entropy data, inside a segment, or right after SOI → 422', () => {
    const jpg = fixture('baseline.jpg');
    expectInvalid(jpg.subarray(0, jpg.length - 40), /truncated/);
    expectInvalid(jpg.subarray(0, 30), /truncated/);
    expectInvalid(jpg.subarray(0, 3), /truncated/);
  });

  it('garbage where a marker should be, or EOI with no scan → 422', () => {
    const jpg = fixture('baseline.jpg');
    const app0Len = jpg.readUInt16BE(4);
    const garbage = Buffer.concat([jpg.subarray(0, 4 + app0Len), Buffer.from([0x00]), jpg.subarray(4 + app0Len)]);
    expectInvalid(garbage, /garbage/);
    expectInvalid(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), /no frame or no scan/);
  });
});

describe('PNG allow-list', () => {
  it('a sips PNG: the eXIf chunk is dropped, sRGB is kept', () => {
    const png = fixture('sips.png');
    expect(pngChunks(png)).toContain('eXIf');
    const out = clean(png);
    expect(out).toMatchObject({
      contentType: 'image/png',
      width: 24,
      height: 16,
    });
    expect(pngChunks(out.bytes)).toEqual(pngChunks(png).filter((t) => t !== 'eXIf'));
    expect(pngChunks(out.bytes)).toContain('sRGB');
  });

  it('tEXt, zTXt, iTXt, tIME and eXIf are dropped; iCCP and pHYs are kept', () => {
    const png = fixture('metadata.png');
    expect(pngChunks(png)).toEqual(['IHDR', 'iCCP', 'pHYs', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf', 'IDAT', 'IEND']);
    const out = clean(png);
    expect(pngChunks(out.bytes)).toEqual(['IHDR', 'iCCP', 'pHYs', 'IDAT', 'IEND']);
    expect(out.bytes.includes(Buffer.from('dock 4'))).toBe(false);
  });

  it('APNG (acTL/fcTL/fdAT) → 415', () => {
    expectUnsupported(fixture('animated.png'), /APNG/);
  });

  it('an unknown critical chunk (CgBI) → 422', () => {
    expectInvalid(fixture('unknown-critical.png'), /unknown critical chunk CgBI/);
  });

  it('a bad CRC → 422, even on a chunk that would be dropped', () => {
    const png = Buffer.from(fixture('sips.png'));
    const idat = png.indexOf(Buffer.from('IDAT'));
    png.writeUInt8(png.readUInt8(idat + 10) ^ 0xff, idat + 10);
    expectInvalid(png, /IDAT chunk.*bad CRC|IDAT has a bad CRC/);
    const meta = Buffer.from(fixture('metadata.png'));
    const text = meta.indexOf(Buffer.from('tEXt')) + 6;
    meta.writeUInt8(meta.readUInt8(text) ^ 0x01, text);
    expectInvalid(meta, /tEXt has a bad CRC/);
  });

  it('a polyglot tail after IEND is dropped', () => {
    const png = fixture('metadata.png');
    const expected = clean(png).bytes;
    expect(clean(Buffer.concat([png, TAIL])).bytes.equals(expected)).toBe(true);
  });

  it('8,001 px → 422; a 0 px side → 422', () => {
    expectInvalid(fixture('wide-8001.png'), /8001×1 px/);
    const png = fixture('sips.png');
    const ihdr = Buffer.from(png.subarray(16, 29));
    ihdr.writeUInt32BE(0, 0);
    const zero = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', ihdr), png.subarray(33)]);
    expectInvalid(zero, /zero side/);
  });

  it('IHDR not first, a missing IEND, or truncation → 422', () => {
    const png = fixture('sips.png');
    const swapped = Buffer.concat([
      png.subarray(0, 8),
      pngChunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])),
      png.subarray(8),
    ]);
    expectInvalid(swapped, /must start with a 13-byte IHDR/);
    expectInvalid(png.subarray(0, png.length - 12), /truncated/);
    expectInvalid(png.subarray(0, 100), /truncated/);
  });
});

describe('WebP allow-list', () => {
  it.each([
    ['lossy.webp', 'VP8 '],
    ['lossless.webp', 'VP8L'],
    ['alpha.webp', 'VP8X'],
  ])('%s (%s) passes through unchanged with its dimensions', (name, first) => {
    const webp = fixture(name);
    expect(webpChunks(webp)[0]?.fourcc).toBe(first);
    const out = clean(webp);
    expect(out).toMatchObject({
      contentType: 'image/webp',
      width: 24,
      height: 16,
    });
    expect(out.bytes.equals(webp)).toBe(true);
  });

  it('EXIF and XMP are dropped, their VP8X flags cleared, ICC kept and the RIFF size fixed', () => {
    const webp = fixture('metadata.webp');
    const before = webpChunks(webp).map((c) => c.fourcc);
    expect(before).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8 ', 'EXIF', 'XMP ']);
    expect(webpChunks(webp).find((c) => c.fourcc === 'XMP ')!.size % 2).toBe(1); // exercises the pad byte
    expect(webp.readUInt8(20) & 0x0c).toBe(0x0c);
    const out = clean(webp);
    expect(out).toMatchObject({ width: 24, height: 16 });
    expect(webpChunks(out.bytes).map((c) => c.fourcc)).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8 ']);
    expect(out.bytes.readUInt32LE(4)).toBe(out.bytes.length - 8);
    expect(out.bytes.readUInt8(20) & 0x0c).toBe(0); // EXIF (0x08) and XMP (0x04) flags cleared
    expect(out.bytes.readUInt8(20) & 0x30).toBe(webp.readUInt8(20) & 0x30); // ICC (0x20) and alpha (0x10) flags kept
    expect(out.bytes.includes(Buffer.from('WMSCam'))).toBe(false);
    expect(out.bytes.includes(Buffer.from('xmpmeta'))).toBe(false);
    // the kept chunks are byte-identical to the source
    expect(webp.includes(out.bytes.subarray(30))).toBe(true);
  });

  it('animated WebP (ANIM/ANMF) → 415', () => {
    expectUnsupported(fixture('animated.webp'), /Animated WebP/);
  });

  it('the VP8X animation flag alone → 415', () => {
    const webp = Buffer.from(fixture('alpha.webp'));
    webp.writeUInt8(webp.readUInt8(20) | 0x02, 20);
    expectUnsupported(webp, /Animated WebP/);
  });

  it('any other chunk → 422, before or after the image data', () => {
    const webp = fixture('alpha.webp');
    const extra = Buffer.concat([Buffer.from('ABCD', 'latin1'), Buffer.from([2, 0, 0, 0]), Buffer.from([1, 2])]);
    const riffOf = (body: Buffer): Buffer => {
      const riff = Buffer.alloc(12);
      riff.write('RIFF', 0, 'latin1');
      riff.writeUInt32LE(4 + body.length, 4);
      riff.write('WEBP', 8, 'latin1');
      return Buffer.concat([riff, body]);
    };
    // after the 18-byte VP8X chunk
    expectInvalid(riffOf(Buffer.concat([webp.subarray(12, 30), extra, webp.subarray(30)])), /"ABCD" is not allowed/);
    expectInvalid(riffOf(Buffer.concat([webp.subarray(12), extra])), /ABCD chunk after its image data/);
  });

  it('a polyglot tail after the RIFF end is dropped', () => {
    const webp = fixture('lossy.webp');
    expect(clean(Buffer.concat([webp, TAIL])).bytes.equals(webp)).toBe(true);
  });

  it('8,001 px → 422', () => {
    expectInvalid(fixture('wide-8001.webp'), /8001×1 px/);
  });

  it('truncated → 422', () => {
    const webp = fixture('alpha.webp');
    expectInvalid(webp.subarray(0, webp.length - 10), /truncated/);
    const fixedSize = Buffer.from(webp.subarray(0, 60));
    fixedSize.writeUInt32LE(52, 4); // RIFF size agrees, but the ALPH/VP8 chunk overruns it
    expectInvalid(fixedSize, /truncated/);
  });

  it('a bad VP8 start code → 422', () => {
    const webp = Buffer.from(fixture('lossy.webp'));
    webp.writeUInt8(0x00, 20 + 3);
    expectInvalid(webp, /bad start code/);
  });
});

describe('idempotence over every accepted fixture', () => {
  it.each([
    'baseline.jpg',
    'restart.jpg',
    'progressive-app13.jpg',
    'gps-exif-icc.jpg',
    'jfxx-thumbnail.jpg',
    'mpf.jpg',
    'wide-8000.jpg',
    'sips.png',
    'metadata.png',
    'lossy.webp',
    'lossless.webp',
    'alpha.webp',
    'metadata.webp',
  ])('%s re-sanitizes to identical bytes', (name) => {
    const once = sanitizeImage(fixture(name)).bytes;
    expect(sanitizeImage(once).bytes.equals(once)).toBe(true);
    expect(sanitizeImage(Buffer.concat([once, TAIL])).bytes.equals(once)).toBe(true);
  });
});
