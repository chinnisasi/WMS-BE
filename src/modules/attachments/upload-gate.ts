import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * Story 2-5a (A16) — the process-wide back-pressure around sanitize + put:
 * at most `UPLOAD_GATE_SLOTS` uploads sanitize and put at once (their raw
 * plus sanitized bytes — about 4 × 20 MB). A request that finds no slot free
 * is refused at once with 503 `file-storage-busy` — never queued (the device
 * keeps the op and retries; the web says "try again"). It does NOT bound
 * multer's buffering: the whole file (≤ 10 MB) is already in memory before
 * the handler runs, so N concurrent uploads hold N × 10 MB until they are
 * refused or served — the infra memory budget counts that separately
 * (spec Design Notes, "Memory").
 */
export const UPLOAD_GATE_SLOTS = 4;

export class UploadGate {
  private inFlight = 0;

  constructor(readonly slots: number = UPLOAD_GATE_SLOTS) {}

  /** The slots in use (tests). */
  get used(): number {
    return this.inFlight;
  }

  /** Takes a slot or refuses 503; the returned release is idempotent. */
  acquire(): () => void {
    if (this.inFlight >= this.slots) {
      throw new ProblemException(
        'file-storage-busy',
        503,
        'File storage busy',
        'Too many photo uploads are in progress — try again in a moment.',
      );
    }
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }
}
