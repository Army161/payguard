import { describe, expect, it } from 'vitest';
import { fixedClock, type RailId } from '@payguard/core';
import {
  CircuitBreaker,
  FacilitatorError,
  HealthMonitor,
  stripeFacilitator,
  type Facilitator,
  type Health,
} from '@payguard/rails';

function stubFacilitator(id: string, rails: RailId[], healthy = true): Facilitator {
  return {
    id,
    rails,
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: '0x1', network: 'base-sepolia' as const }),
    health: async (): Promise<Health> => ({
      healthy,
      latencyMs: 5,
      lastSuccessMs: healthy ? 1 : null,
      consecutiveFailures: healthy ? 0 : 3,
    }),
  };
}

describe('circuit breaker', () => {
  it('starts closed and admits traffic', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.state).toBe('closed');
    expect(breaker.allows()).toBe(true);
  });

  it('opens after the configured number of consecutive failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.allows()).toBe(false);
  });

  it('a success resets the failure count before the threshold is reached', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.consecutiveFailures).toBe(0);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });

  it('moves to half open once the reset timeout expires', () => {
    const clock = fixedClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, clock });
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    clock.advance(999);
    expect(breaker.state).toBe('open');
    clock.advance(1);
    expect(breaker.state).toBe('half_open');
  });

  it('admits exactly one trial call in half open, so a recovering facilitator is not stampeded', () => {
    const clock = fixedClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, clock });
    breaker.recordFailure();
    clock.advance(1000);
    expect(breaker.allows()).toBe(true);
    expect(breaker.allows()).toBe(false);
    expect(breaker.allows()).toBe(false);
  });

  it('closes again once the trial call succeeds', () => {
    const clock = fixedClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, clock });
    breaker.recordFailure();
    clock.advance(1000);
    breaker.allows();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.allows()).toBe(true);
  });

  it('requires several trial successes when configured to', () => {
    const clock = fixedClock(0);
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      successThreshold: 2,
      clock,
    });
    breaker.recordFailure();
    clock.advance(1000);
    breaker.allows();
    breaker.recordSuccess();
    expect(breaker.state).toBe('half_open');
    breaker.allows();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
  });

  it('reopens immediately when the trial call fails, restarting the cooldown', () => {
    const clock = fixedClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, clock });
    breaker.recordFailure();
    clock.advance(1000);
    breaker.allows();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    clock.advance(999);
    expect(breaker.state).toBe('open');
  });

  it('an operator can force it closed after fixing the cause', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    breaker.reset();
    expect(breaker.state).toBe('closed');
    expect(breaker.allows()).toBe(true);
  });
});

describe('health monitor', () => {
  const base = stubFacilitator('a', ['base:usdc']);
  const xrpl = stubFacilitator('b', ['xrpl:rlusd', 'xrpl:xrp']);

  it('reports which facilitators serve a rail', () => {
    const monitor = new HealthMonitor([base, xrpl]);
    expect(monitor.size).toBe(2);
    expect(monitor.serving('base:usdc').map((f) => f.id)).toEqual(['a']);
    expect(monitor.serving('xrpl:xrp').map((f) => f.id)).toEqual(['b']);
  });

  it('excludes a facilitator whose breaker is open from the available set', () => {
    const monitor = new HealthMonitor([base, xrpl], { failureThreshold: 1 });
    expect(monitor.available('base:usdc').map((f) => f.id)).toEqual(['a']);
    monitor.recordFailure('a');
    expect(monitor.available('base:usdc')).toEqual([]);
    expect(monitor.serving('base:usdc')).toHaveLength(1);
  });

  it('does not count a rejection the facilitator was entitled to make', () => {
    const monitor = new HealthMonitor([base], { failureThreshold: 1 });
    monitor.recordFailure('a', new FacilitatorError('bad_request', 'a', 'malformed payload'));
    expect(monitor.available('base:usdc')).toHaveLength(1);
  });

  it('counts a failure that says something about the facilitator itself', () => {
    const monitor = new HealthMonitor([base], { failureThreshold: 1 });
    monitor.recordFailure('a', new FacilitatorError('server_error', 'a', 'boom', 500));
    expect(monitor.available('base:usdc')).toHaveLength(0);
  });

  it('ignores success and failure reports for an unknown facilitator', () => {
    const monitor = new HealthMonitor([base]);
    expect(() => monitor.recordFailure('nope')).not.toThrow();
    expect(() => monitor.recordSuccess('nope')).not.toThrow();
    expect(monitor.get('nope')).toBeUndefined();
  });

  it('probes every facilitator and reflects the result in the breakers', async () => {
    const failing = stubFacilitator('c', ['base:usdc'], false);
    const monitor = new HealthMonitor([base, failing], { failureThreshold: 1 });
    const statuses = await monitor.probeAll();
    expect(statuses.map((s) => s.id).sort()).toEqual(['a', 'c']);
    expect(statuses.find((s) => s.id === 'a')?.available).toBe(true);
    expect(statuses.find((s) => s.id === 'c')?.available).toBe(false);
    expect(monitor.available('base:usdc').map((f) => f.id)).toEqual(['a']);
  });

  it('carries the last probe result into the status report', async () => {
    const monitor = new HealthMonitor([base]);
    expect(monitor.statuses()[0]?.lastHealth).toBeNull();
    await monitor.probeAll();
    expect(monitor.statuses()[0]?.lastHealth?.healthy).toBe(true);
  });

  it('recovers a facilitator once its breaker cools down and it answers again', async () => {
    const clock = fixedClock(0);
    const monitor = new HealthMonitor([base], {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      clock,
    });
    monitor.recordFailure('a', new FacilitatorError('server_error', 'a', 'boom', 500));
    expect(monitor.available('base:usdc')).toHaveLength(0);
    clock.advance(1000);
    expect(monitor.available('base:usdc')).toHaveLength(1);
    monitor.recordSuccess('a');
    expect(monitor.statuses()[0]?.state).toBe('closed');
  });

  it('marks a facilitator that is not implemented in v1 as unavailable after a probe', async () => {
    const monitor = new HealthMonitor([stripeFacilitator()], { failureThreshold: 1 });
    const [status] = await monitor.probeAll();
    expect(status?.available).toBe(false);
  });
});
