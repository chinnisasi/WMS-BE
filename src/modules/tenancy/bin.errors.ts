import { ProblemException } from '../../shared/problem-details/problem.exception';

/**
 * The bin-command rejections and idempotency constraint name shared by the
 * bin administration commands (bin.command.ts) and the re-homed block
 * toggle (putaway/bin-state.command.ts) — one home, no verbatim copies.
 */

/** The unique-violation constraint name backing the idempotency de-dupe (AD-5). */
export const IDEMPOTENCY_TENANT_KEY = 'idempotency_keys_tenant_id_key_unique';

/** 404 `not-found` — the bin does not resolve in this warehouse. */
export function binNotFound(): ProblemException {
  return new ProblemException(
    'not-found',
    404,
    'Bin not found',
    'No bin with this id exists in this warehouse.',
  );
}

/** Re-operating a retired bin — retirement is terminal (409 `bin-retired`). */
export function binRetired409(binCode: string): ProblemException {
  return new ProblemException(
    'bin-retired',
    409,
    'Bin is retired',
    `Bin "${binCode}" is retired — retirement is terminal.`,
  );
}

/**
 * 409 `bin-merge-hold-open` — merge and retire both refuse a bin carrying an
 * open QC hold, naming the bin and the hold: the release must be able to
 * return the held stock to the origin bin it recorded.
 */
export function binHoldOpen(
  binCode: string,
  holdId: string,
  action: 'merging' | 'retiring',
): ProblemException {
  return new ProblemException(
    'bin-merge-hold-open',
    409,
    'Bin has an open QC hold',
    `Bin "${binCode}" has an open QC hold (${holdId}) — release the hold before ${action}.`,
  );
}