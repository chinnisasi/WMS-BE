import type { Response } from 'express';
import { ProblemException } from '../shared/problem-details/problem.exception';
import type { RecallReportSink } from '../modules/reporting/reporting.facade';

/**
 * Story 3-7a (A10) — the recall report's response sink, shared by the staff
 * and portal routes. `begin` runs the caller's pre-byte work (the download's
 * audit row, its own transaction) and only then writes the status and
 * headers — so every refusal up to that point is still a thrown problem the
 * filter renders. `write` honours backpressure (it resolves on `drain`) and
 * refuses once the client has gone, which stops the walk and ends the read
 * transaction.
 *
 * The one named exception to guide §6 (A10): the CSV streams, so a failure
 * AFTER the first byte cannot become problem+json — `finishRecallReport`
 * destroys the socket instead, and the file then lacks its final
 * `section=end` row (which carries the row count): a truncated file is
 * recognisable, never silently short.
 */
/** How long one socket write may wait for the client to read on (A10's deadline covers the reads, not a stalled reader). */
export const RECALL_DRAIN_TIMEOUT_MS = 30_000;

export function recallReportSink(res: Response, beforeHeaders: (rowCount: number | null) => Promise<void>): RecallReportSink {
  return {
    async begin(file) {
      await beforeHeaders(file.rowCount);
      res.status(200);
      res.setHeader('Content-Type', file.contentType);
      if (file.length !== null) res.setHeader('Content-Length', String(file.length));
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.flushHeaders();
    },
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (res.destroyed || res.writableEnded) {
          reject(new Error('the client closed the recall report download'));
          return;
        }
        if (res.write(chunk)) {
          resolve();
          return;
        }
        // A client that stops reading but keeps the socket open must not hold
        // the report slot and the read transaction forever.
        const timer = setTimeout(() => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          reject(new Error(`the client stopped reading the recall report for ${RECALL_DRAIN_TIMEOUT_MS / 1000} s`));
        }, RECALL_DRAIN_TIMEOUT_MS);
        const onDrain = (): void => {
          clearTimeout(timer);
          res.off('close', onClose);
          resolve();
        };
        const onClose = (): void => {
          clearTimeout(timer);
          res.off('drain', onDrain);
          reject(new Error('the client closed the recall report download'));
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
      });
    },
  };
}

/**
 * Run the report into the response: on success end it; on a failure BEFORE
 * the headers rethrow (problem+json — a 503 also carries `Retry-After: 5`);
 * on a failure AFTER them destroy the socket (the file lacks its `end` row).
 */
export async function finishRecallReport(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (err instanceof ProblemException && err.getStatus() === 503) res.setHeader('Retry-After', '5');
    throw err;
  }
  res.end();
}
