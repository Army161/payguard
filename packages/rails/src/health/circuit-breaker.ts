import { systemClock, type Clock } from '@payguard/core';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the breaker. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing one trial call. */
  resetTimeoutMs?: number;
  /** Consecutive successes in half-open state before the breaker closes again. */
  successThreshold?: number;
  clock?: Clock;
}

/**
 * FR-4.1. A facilitator that is failing should stop receiving traffic, and it should get exactly
 * one trial request when the cooldown expires rather than a thundering herd.
 *
 * Half-open admits one call at a time. Without that, every request queued during the outage fires
 * the moment the timer expires and re-opens the breaker on a facilitator that was recovering.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly clock: Clock;

  private failures = 0;
  private successes = 0;
  private openedAtMs = 0;
  private trialInFlight = false;
  private current: BreakerState = 'closed';

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
    this.clock = options.clock ?? systemClock;
  }

  get state(): BreakerState {
    if (this.current === 'open' && this.clock.now() - this.openedAtMs >= this.resetTimeoutMs) {
      this.current = 'half_open';
      this.trialInFlight = false;
      this.successes = 0;
    }
    return this.current;
  }

  /** True when a caller may attempt the guarded operation right now. */
  allows(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.successes += 1;
      this.trialInFlight = false;
      if (this.successes >= this.successThreshold) {
        this.current = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.current = 'open';
    this.openedAtMs = this.clock.now();
    this.trialInFlight = false;
    this.successes = 0;
  }

  /** Forces the breaker closed. Used by an operator who has fixed the underlying problem. */
  reset(): void {
    this.current = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.trialInFlight = false;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
