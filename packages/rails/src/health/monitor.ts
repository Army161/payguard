import { systemClock, type Clock, type RailId } from '@payguard/core';
import {
  CircuitBreaker,
  type BreakerState,
  type CircuitBreakerOptions,
} from './circuit-breaker.js';
import { FacilitatorError, type Facilitator, type Health } from '../facilitators/interface.js';

export interface MonitoredFacilitator {
  facilitator: Facilitator;
  breaker: CircuitBreaker;
}

export interface FacilitatorStatus {
  id: string;
  rails: readonly RailId[];
  state: BreakerState;
  available: boolean;
  lastHealth: Health | null;
}

export interface HealthMonitorOptions extends CircuitBreakerOptions {
  clock?: Clock;
}

/**
 * Tracks which facilitators are usable. The monitor never chooses a facilitator; it reports what
 * is available and the router decides. Keeping the two apart means the failover policy can change
 * without touching the breaker logic.
 */
export class HealthMonitor {
  private readonly entries = new Map<string, MonitoredFacilitator>();
  private readonly lastHealth = new Map<string, Health>();
  private readonly options: HealthMonitorOptions;
  private readonly clock: Clock;

  constructor(facilitators: readonly Facilitator[], options: HealthMonitorOptions = {}) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    for (const facilitator of facilitators) {
      this.entries.set(facilitator.id, {
        facilitator,
        breaker: new CircuitBreaker({ ...options, clock: this.clock }),
      });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: string): MonitoredFacilitator | undefined {
    return this.entries.get(id);
  }

  /** Facilitators that serve this rail and whose breaker currently admits traffic. */
  available(rail: RailId): Facilitator[] {
    const out: Facilitator[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.facilitator.rails.includes(rail)) continue;
      if (!entry.breaker.allows()) continue;
      out.push(entry.facilitator);
    }
    return out;
  }

  /** Every facilitator serving this rail, whatever its breaker says. Used for reporting. */
  serving(rail: RailId): Facilitator[] {
    return [...this.entries.values()]
      .filter((entry) => entry.facilitator.rails.includes(rail))
      .map((entry) => entry.facilitator);
  }

  recordSuccess(id: string): void {
    this.entries.get(id)?.breaker.recordSuccess();
  }

  recordFailure(id: string, error?: unknown): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    // A rejection the facilitator is entitled to make, such as a malformed payload, says nothing
    // about the facilitator's health. Counting it would open the breaker on a buyer's mistake.
    if (error instanceof FacilitatorError && !error.isRetryableElsewhere) return;
    entry.breaker.recordFailure();
  }

  /** Probes every facilitator and updates the breakers from the result. */
  async probeAll(): Promise<FacilitatorStatus[]> {
    const results = await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        const health = await entry.facilitator.health();
        this.lastHealth.set(entry.facilitator.id, health);
        if (health.healthy) {
          entry.breaker.recordSuccess();
        } else {
          entry.breaker.recordFailure();
        }
        return entry;
      }),
    );
    return results.map((entry) => this.statusOf(entry));
  }

  statuses(): FacilitatorStatus[] {
    return [...this.entries.values()].map((entry) => this.statusOf(entry));
  }

  private statusOf(entry: MonitoredFacilitator): FacilitatorStatus {
    return {
      id: entry.facilitator.id,
      rails: entry.facilitator.rails,
      state: entry.breaker.state,
      available: entry.breaker.state !== 'open',
      lastHealth: this.lastHealth.get(entry.facilitator.id) ?? null,
    };
  }
}
