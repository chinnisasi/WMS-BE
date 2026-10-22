/**
 * Story 6-2a — graceful shutdown (amendment A1).
 *
 * Nest's real hook order on `app.close()` / a shutdown signal
 * (`@nestjs/core` `nest-application-context.js` `close`):
 *
 *   prepareClose      the express adapter flags itself shutting down — with
 *                     `return503OnClosing`, a NEW request on a kept-alive
 *                     connection answers 503 + `Connection: close`
 *   onModuleDestroy   `HttpDrain` stops the listener accepting connections
 *   beforeApplicationShutdown
 *                     every worker clears its timer and awaits its in-flight
 *                     tick; `HttpDrain` waits for the in-flight requests —
 *                     both bounded by the one shared drain deadline below
 *   dispose           the HTTP server closes; `forceCloseConnections`
 *                     destroys whatever socket is still open (idle keep-alive
 *                     or a request past the deadline)
 *   onApplicationShutdown
 *                     the pools close (`DatabaseLifecycle`: Postgres
 *                     `end({timeout})`; `ValkeyClient`: `quit`)
 *
 * The whole sequence is bounded by `armForceExit`: a 25 s unref'd timer
 * armed on the first signal, under the orchestrator's 30 s stop timeout.
 */

/** The force-exit bound, armed on the first shutdown signal (A1). */
export const SHUTDOWN_FORCE_EXIT_MS = 25_000;

/**
 * How long the drain phase (workers' ticks, in-flight requests) may take in
 * total, measured from the first drain that starts. It leaves the remainder
 * of the 25 s bound for the pools to close.
 */
export const SHUTDOWN_DRAIN_MS = 20_000;

let drainDeadline: number | undefined;

/**
 * The one drain deadline every waiter shares: set by the first caller,
 * returned unchanged afterwards — so a worker and the HTTP drain waiting in
 * sequence never add up past the bound.
 */
export function shutdownDrainDeadline(now: number = Date.now()): number {
  drainDeadline ??= now + SHUTDOWN_DRAIN_MS;
  return drainDeadline;
}

/** Test seam: forget the deadline so the next shutdown starts a fresh one. */
export function resetShutdownDrainDeadline(): void {
  drainDeadline = undefined;
}

/**
 * Resolves `true` when `work` settles (fulfilled or rejected) before
 * `deadline`, `false` when the deadline passes first. Never rejects; the
 * timer is unref'd and cleared.
 */
export async function settleBefore(work: Promise<unknown>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), remaining);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A worker's in-flight tick (A1, design review D1): the interval callback
 * starts a tick through `start`, which remembers its promise, and shutdown
 * awaits it through `settle`. A tick that is still running when the next
 * interval fires is not doubled — the same single-flight the workers'
 * `running` flags give.
 */
export class InFlightTick {
  private current: Promise<unknown> | undefined;
  private stopped = false;

  /** Starts `run` unless a tracked tick is still in flight or shutdown began. */
  start(run: () => Promise<unknown>): void {
    if (this.stopped || this.current !== undefined) return;
    const tick = run()
      .catch(() => undefined)
      .finally(() => {
        if (this.current === tick) this.current = undefined;
      });
    this.current = tick;
  }

  /** True while a tracked tick runs. */
  get inFlight(): boolean {
    return this.current !== undefined;
  }

  /**
   * Stops new ticks and waits for the in-flight one, up to `deadline`.
   * Resolves `true` when nothing was left running.
   */
  async settle(deadline: number = shutdownDrainDeadline()): Promise<boolean> {
    this.stopped = true;
    const tick = this.current;
    if (tick === undefined) return true;
    return settleBefore(tick, deadline);
  }
}

/**
 * Arms the force exit on the first SIGTERM / SIGINT: if the graceful
 * sequence has not ended the process within `ms`, exit 1 (a hung pool, a
 * request that ignores its socket being destroyed). The timer is unref'd, so
 * it never itself holds the process open. Returns a disarm function (tests).
 */
export function armForceExit(
  ms: number = SHUTDOWN_FORCE_EXIT_MS,
  exit: (code: number) => void = (code) => process.exit(code),
  signals: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      console.error(`Graceful shutdown (${signal}) did not finish within ${ms}ms — forcing exit`);
      exit(1);
    }, ms);
    timer.unref?.();
  };
  for (const signal of signals) process.once(signal, onSignal);
  return () => {
    for (const signal of signals) process.removeListener(signal, onSignal);
    if (timer !== undefined) clearTimeout(timer);
  };
}
