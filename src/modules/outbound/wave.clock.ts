/**
 * The wave module's clock seam (Story 4.2).
 *
 * A wave policy's `cutoff_local_time` is a wall-clock `HH:MM` that recurs
 * every Kolkata-local day, so release is the one command in the outbound
 * module whose OUTCOME depends on what time it is. That makes "now" an
 * input, and an input has to be injectable — both sides of a cutoff boundary
 * must be assertable without sleeping until 16:30 IST.
 *
 * Production wiring is the system clock (`outbound.module.ts`); the e2e suite
 * resolves this token and stubs `now()`.
 */
export const WAVE_CLOCK = 'WAVE_CLOCK' as const;

export interface WaveClock {
  /** The current instant. */
  now(): Date;
}

export class SystemWaveClock implements WaveClock {
  now(): Date {
    return new Date();
  }
}
