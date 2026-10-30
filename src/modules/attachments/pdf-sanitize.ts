import { createHash } from 'node:crypto';
import { EncryptedPDFError, PDFDocument, PDFName } from 'pdf-lib';
import { ProblemException } from '../../shared/problem-details/problem.exception';
import { MAX_IMAGE_BYTES, sanitizeImage, sniffImageType } from './image-sanitize';

/**
 * Story 4-4a (A15, A34, D9) — the PDF arm of the attachments foundation: a
 * client's label, an invoice scan, a signed sheet saved as PDF. Pure over
 * pdf-lib (already a dependency). The file is RE-SERIALISED, never stored as
 * uploaded: every page is copied into a fresh `PDFDocument`, then each copied
 * page's `/Annots` (link and widget annotations, which can carry `/JS`) and
 * `/AA` (page-level actions) are deleted — `copyPages` copies page
 * dictionaries whole. The source's catalogue (JavaScript, OpenAction,
 * AcroForm, embedded files, outlines, names, XMP metadata) is never copied.
 * Each page keeps its MediaBox, so a 4×6 label prints at size.
 *
 * Refusals: not a PDF → 415 `attachment-type-unsupported`; encrypted
 * (including an empty user password with owner restrictions only — pdf-lib
 * cannot decrypt, and copying encrypted streams would print garbage),
 * unparseable, or past the time budget → 422 `pdf-unreadable`; 0 or > 50
 * pages → 422 `pdf-too-many-pages`; the result over 10 MiB → 422
 * `attachment-too-large` (2-5a's status).
 *
 * The output is deterministic for one input (fixed producer, creator and
 * dates), so a same-key retry re-puts identical bytes under the reserved key.
 */

export const PDF_CONTENT_TYPE = 'application/pdf';
export const MAX_PDF_PAGES = 50;
export const MAX_PDF_BYTES = MAX_IMAGE_BYTES;
/** A34 — one sanitise may take at most this long (measured; a parse past it is refused). */
export const PDF_SANITIZE_BUDGET_MS = 5_000;
/** The page-size columns are clamped to the object CHECK's 1..8000. */
const MAX_SIDE = 8000;
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1));

export interface SanitizedPdf {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly contentType: typeof PDF_CONTENT_TYPE;
  readonly pageCount: number;
  /** The first page's width and height in points, rounded and clamped to 1..8000. */
  readonly width: number;
  readonly height: number;
}

/** What a stored shipping file is, after its sanitiser (an image or a PDF). */
export interface SanitizedFile {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  /** Null for an image. */
  readonly pageCount: number | null;
}

export async function sanitizePdf(raw: Uint8Array, budgetMs: number = PDF_SANITIZE_BUDGET_MS): Promise<SanitizedPdf> {
  if (raw.byteLength > MAX_PDF_BYTES) {
    throw tooLarge(raw.byteLength);
  }
  if (sniffImageType(raw) !== 'pdf') {
    throw new ProblemException('attachment-type-unsupported', 415, 'Unsupported attachment type', 'This file is not a PDF — upload the label as a PDF.');
  }
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(unreadable('The PDF took too long to read — save it again (Print to PDF) and upload it.')), budgetMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([rewrite(raw), deadline]);
    if (Date.now() - started > budgetMs) {
      throw unreadable('The PDF took too long to read — save it again (Print to PDF) and upload it.');
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function rewrite(raw: Uint8Array): Promise<SanitizedPdf> {
  try {
    return await rewriteUnchecked(raw);
  } catch (err) {
    if (err instanceof ProblemException) throw err;
    if (err instanceof EncryptedPDFError || mentionsEncrypt(raw)) throw encrypted();
    throw unreadable('The PDF could not be read — save it again (Print to PDF) and upload it.');
  }
}

async function rewriteUnchecked(raw: Uint8Array): Promise<SanitizedPdf> {
  const source = await PDFDocument.load(raw, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
  if (source.isEncrypted) throw encrypted();
  const count = source.getPageCount();
  if (count < 1 || count > MAX_PDF_PAGES) {
    throw new ProblemException(
      'pdf-too-many-pages',
      422,
      'PDF has too many pages',
      count < 1 ? 'The PDF has no pages.' : `The PDF has ${count} pages — at most ${MAX_PDF_PAGES}.`,
    );
  }
  // The active page keys are removed from the SOURCE pages before the copy,
  // so the objects they point at (a link's /JS, an /AA action) are never
  // copied into the new document at all — and again from the copies, as
  // the belt to that brace.
  for (const page of source.getPages()) {
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('AA'));
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(source, source.getPageIndices());
  for (const page of pages) {
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('AA'));
    out.addPage(page);
  }
  out.setProducer('wms');
  out.setCreator('wms');
  out.setCreationDate(FIXED_DATE);
  out.setModificationDate(FIXED_DATE);
  const first = out.getPage(0).getSize();
  const bytes = await out.save({ useObjectStreams: false });
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw tooLarge(bytes.byteLength);
  }
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: PDF_CONTENT_TYPE,
    pageCount: count,
    width: clampSide(first.width),
    height: clampSide(first.height),
  };
}

/** A trailer naming `/Encrypt` (pdf-lib may fail to parse a security handler before it reports one). */
function mentionsEncrypt(raw: Uint8Array): boolean {
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).includes('/Encrypt');
}

function encrypted(): ProblemException {
  return unreadable('The PDF is password-protected or print-restricted — remove the password or print restriction and upload it again.');
}

/**
 * Story 4-4a (A14) — a shipping document or a sheet page: an image through
 * 2-5a's `sanitizeImage`, or a PDF through `sanitizePdf`.
 */
export async function sanitizeShippingFile(raw: Uint8Array): Promise<SanitizedFile> {
  if (sniffImageType(raw) === 'pdf') {
    const pdf = await sanitizePdf(raw);
    return { bytes: pdf.bytes, sha256: pdf.sha256, contentType: pdf.contentType, width: pdf.width, height: pdf.height, pageCount: pdf.pageCount };
  }
  const image = sanitizeImage(raw);
  return {
    bytes: image.bytes,
    sha256: createHash('sha256').update(image.bytes).digest('hex'),
    contentType: image.contentType,
    width: image.width,
    height: image.height,
    pageCount: null,
  };
}

function clampSide(points: number): number {
  return Math.min(MAX_SIDE, Math.max(1, Math.round(points)));
}

function unreadable(detail: string): ProblemException {
  return new ProblemException('pdf-unreadable', 422, 'PDF unreadable', detail);
}

function tooLarge(bytes: number): ProblemException {
  return new ProblemException('attachment-too-large', 422, 'Attachment too large', `The file is ${bytes} bytes; the limit is ${MAX_PDF_BYTES} bytes (10 MiB).`);
}
