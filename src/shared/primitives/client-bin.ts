/**
 * Dedicated client bins (story 1-5b): the ONE predicate behind every gate
 * that places stock into a bin — putaway placement, the putaway suggestion
 * and task derivation (`candidateFitsSku`), bin merge and transfer receive —
 * plus the two refusal factories those gates and the bin edit guard throw.
 *
 * **The rule** (1-5b decision 4): a bin accepts a SKU when the bin has no
 * dedicated client (`bins.dedicated_client_id IS NULL` — a shared bin, the
 * default), or the bin's client equals the SKU's client (`skus.client_id`,
 * NOT NULL). A client's goods may still go into shared bins (decision 2 —
 * preference, not exclusivity); the suggestion prefers the client's own bins
 * (`pickPutawayCandidate` in the putaway module).
 *
 * Encoded ONCE, here — the `storage-class.ts` pattern. Like the class gate it
 * is a pure predicate on the locked bin row and the SKU row already in hand.
 *
 * **Named bypasses** (decision 9, recorded in PENDING): stock adjustments and
 * the count corrections that post through them check no client. A QC release
 * back to its origin bin is ungated too — the bin edit guard counts the bin's
 * open QC holds (decision 3), so a dedication can never be set while another
 * client's hold would return there. System-bin receipts (Receiving, QC-HOLD,
 * In-Transit, Returns) are ungated — a system bin can never be dedicated.
 */

import { ProblemException } from '../problem-details/problem.exception';

/** Does this BIN (its dedicated client, or null = shared) accept this SKU's client? */
export function binClientAccepts(binClientId: string | null, skuClientId: string): boolean {
  return binClientId === null || binClientId === skuClientId;
}

/**
 * `bin-client-mismatch` — a placement, merge or transfer intake of another
 * client's stock into a dedicated bin. Names the bin, its client, and the
 * SKU's code and client. The status is per surface (decision 5): 400 from
 * putaway placement and merge (their other gates' status), 409 from transfer
 * receive (its gate runner's).
 */
export function binClientMismatch(
  status: 400 | 409,
  binCode: string,
  binClientLabel: string,
  skuCode: string,
  skuClientLabel: string,
): ProblemException {
  return new ProblemException(
    'bin-client-mismatch',
    status,
    'Bin is dedicated to another client',
    `Bin "${binCode}" is dedicated to ${binClientLabel}; SKU "${skuCode}" belongs to ${skuClientLabel} — ` +
      'a dedicated bin holds only its own client\'s stock. Choose another bin.',
  );
}

/**
 * 409 `bin-client-conflict` — a dedication that would leave another client's
 * stock (on hand, or on an open QC hold that returns to this bin) inside a
 * bin dedicated to someone else. The 12-1 `storage-class-conflict` shape.
 */
export function binClientConflict(detail: string): ProblemException {
  return new ProblemException(
    'bin-client-conflict',
    409,
    'Bin holds another client\'s stock',
    detail,
  );
}
