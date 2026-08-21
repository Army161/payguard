/**
 * Every time-dependent decision takes a Clock, so tests can drive expiry, velocity windows, and
 * spend caps without sleeping and without a global stub.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock the caller advances by hand. Test only, but exported so adapters can reuse it. */
export function fixedClock(
  startMs: number,
): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
