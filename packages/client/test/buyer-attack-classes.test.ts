import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, verifyChain } from '@payguard/core';
import { MemoryStore } from '@payguard/store';
import { KillSwitch, PayGuardClient, PolicyDenied } from '@payguard/client';
import {
  RLUSD,
  SELLER_BASE,
  SELLER_XRPL,
  TestFacilitator,
  TestRail,
  USDC,
  baseObservation,
  baseRequirements,
  startSeller,
  testSigner,
  xrplObservation,
  xrplRequirements,
  type SellerHandle,
} from './harness.js';

const sellers: SellerHandle[] = [];

afterEach(async () => {
  await Promise.all(sellers.splice(0).map((s) => s.close()));
});

async function seller(options: { xrpl?: boolean; facilitators?: TestFacilitator[] } = {}) {
  const rails = [
    {
      rail: new TestRail('base:usdc', baseObservation),
      requirements: baseRequirements(),
    },
  ];
  if (options.xrpl === true) {
    rails.push({
      rail: new TestRail('xrpl:rlusd', xrplObservation),
      requirements: xrplRequirements(),
    });
  }
  const facilitators =
    options.facilitators ??
    (options.xrpl === true
      ? [
          new TestFacilitator('coinbase', ['base:usdc'], 'base-sepolia'),
          new TestFacilitator('xrpl-t54', ['xrpl:rlusd'], 'xrpl-testnet'),
        ]
      : [new TestFacilitator('coinbase', ['base:usdc'], 'base-sepolia')]);

  const handle = await startSeller(rails, facilitators);
  sellers.push(handle);
  return handle;
}

describe('the happy path over a real 402 exchange', () => {
  it('pays and receives the resource', async () => {
    const s = await seller();
    const client = new PayGuardClient({ signer: testSigner(), agentId: 'agent-1' });
    const result = await client.pay(`${s.base}/api/report`);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ report: 'generated' });
    expect(result.payment).toMatchObject({
      rail: 'base:usdc',
      amount: '10000',
      counterparty: SELLER_BASE,
    });
    expect(s.hits()).toBe(1);
  });

  it('does not pay for a resource the seller serves for free', async () => {
    const s = await seller();
    const client = new PayGuardClient({ signer: testSigner(), agentId: 'agent-1' });
    const result = await client.pay(`${s.base}/nothing-here`);
    expect(result.payment).toBeUndefined();
  });

  it('never asks the signer for anything but a signed payload', async () => {
    const s = await seller();
    const signer = testSigner();
    const spy = vi.spyOn(signer, 'signPayment');
    const client = new PayGuardClient({ signer, agentId: 'agent-1' });
    await client.pay(`${s.base}/api/report`);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(Object.keys(signer)).not.toContain('privateKey');
  });
});

describe('AT-5 facilitator outage triggers failover with a single settlement', () => {
  it('falls over to the XRPL rail when the Base facilitator is down', async () => {
    const base = new TestFacilitator('coinbase', ['base:usdc'], 'base-sepolia');
    const xrpl = new TestFacilitator('xrpl-t54', ['xrpl:rlusd'], 'xrpl-testnet');
    base.down = true;
    const s = await seller({ xrpl: true, facilitators: [base, xrpl] });

    const client = new PayGuardClient({ signer: testSigner(), agentId: 'agent-1' });
    const result = await client.pay(`${s.base}/api/report`);

    expect(result.response.status).toBe(200);
    expect(result.payment?.rail).toBe('xrpl:rlusd');
    expect(result.payment?.counterparty).toBe(SELLER_XRPL);
    expect(result.payment?.attempts).toEqual(['base:usdc', 'xrpl:rlusd']);
  });

  it('settles exactly once across the failover, so nothing is double charged', async () => {
    const base = new TestFacilitator('coinbase', ['base:usdc'], 'base-sepolia');
    const xrpl = new TestFacilitator('xrpl-t54', ['xrpl:rlusd'], 'xrpl-testnet');
    base.down = true;
    const s = await seller({ xrpl: true, facilitators: [base, xrpl] });

    const client = new PayGuardClient({ signer: testSigner(), agentId: 'agent-1' });
    await client.pay(`${s.base}/api/report`);

    expect(base.settleCalls).toBe(0);
    expect(xrpl.settleCalls).toBe(1);
    expect(s.hits()).toBe(1);
  });

  it('honours the buyer preference order rather than the seller advertisement order', async () => {
    const s = await seller({ xrpl: true });
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      allowRails: ['xrpl:rlusd', 'base:usdc'],
    });
    const result = await client.pay(`${s.base}/api/report`);
    expect(result.payment?.rail).toBe('xrpl:rlusd');
  });

  it('refuses when the seller accepts no rail this agent is allowed to pay on', async () => {
    const s = await seller();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      allowRails: ['xrpl:xrp'],
    });
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'rail_not_allowlisted',
    });
  });

  it('gives up rather than looping once every acceptable rail has been refused', async () => {
    const base = new TestFacilitator('coinbase', ['base:usdc'], 'base-sepolia');
    const xrpl = new TestFacilitator('xrpl-t54', ['xrpl:rlusd'], 'xrpl-testnet');
    base.down = true;
    xrpl.down = true;
    const s = await seller({ xrpl: true, facilitators: [base, xrpl] });
    const client = new PayGuardClient({ signer: testSigner(), agentId: 'agent-1' });
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'rail_not_allowlisted',
    });
    expect(s.hits()).toBe(0);
  });
});

describe('AT-6 a spend cap blocks a payment with a reason', () => {
  it('allows payments up to the daily cap and refuses the one that would cross it', async () => {
    const s = await seller();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      policy: { dailyCap: '20000' },
    });

    await client.pay(`${s.base}/api/report`);
    await client.pay(`${s.base}/api/report`);

    const denied = await client.pay(`${s.base}/api/report`).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(PolicyDenied);
    expect((denied as PolicyDenied).reason).toBe('spend_cap_exceeded');
    expect((denied as PolicyDenied).decision.rule).toBe('spend-cap');
    expect(s.hits()).toBe(2);
  });

  it('refuses a payment above the per-transaction maximum before signing anything', async () => {
    const s = await seller();
    const signer = testSigner();
    const spy = vi.spyOn(signer, 'signPayment');
    const client = new PayGuardClient({
      signer,
      agentId: 'agent-1',
      policy: { maxPerTransaction: '9999' },
    });
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'max_per_transaction_exceeded',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a counterparty that is not on the allow list', async () => {
    const s = await seller();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      policy: { allowCounterparties: ['0xsomeone-else'] },
    });
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'counterparty_not_allowlisted',
    });
  });

  it('refuses a rate of payments above the velocity limit', async () => {
    const s = await seller();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      policy: { maxTransactionsPerMinute: 1 },
    });
    await client.pay(`${s.base}/api/report`);
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'velocity_exceeded',
    });
  });

  it('escalates to a human above the approval threshold and pays when approved', async () => {
    const s = await seller();
    const asked: string[] = [];
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      policy: { humanApprovalThreshold: '10000' },
      onHumanApproval: async (request) => {
        asked.push(request.requirements.payTo);
        return true;
      },
    });
    const result = await client.pay(`${s.base}/api/report`);
    expect(result.response.status).toBe(200);
    expect(asked).toEqual([SELLER_BASE]);
  });

  it('refuses when the human declines', async () => {
    const s = await seller();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      policy: { humanApprovalThreshold: '10000' },
      onHumanApproval: async () => false,
    });
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'human_approval_required',
    });
    expect(s.hits()).toBe(0);
  });

  it('refuses when no approval handler is configured at all, rather than paying anyway', async () => {
    const s = await seller();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      policy: { humanApprovalThreshold: '10000' },
    });
    await expect(client.pay(`${s.base}/api/report`)).rejects.toBeInstanceOf(PolicyDenied);
  });

  it('refuses a mainnet rail by default', async () => {
    const rail = new TestRail('base:usdc', { ...baseObservation, network: 'base' });
    const handle = await startSeller(
      [{ rail, requirements: baseRequirements({ network: 'base' }) }],
      [new TestFacilitator('coinbase', ['base:usdc'], 'base')],
    );
    sellers.push(handle);
    const client = new PayGuardClient({ signer: testSigner(), agentId: 'agent-1' });
    await expect(client.pay(`${handle.base}/api/report`)).rejects.toMatchObject({
      reason: 'mainnet_disabled',
    });
  });
});

describe('AT-7 the kill switch halts every payment within a second', () => {
  it('refuses immediately once engaged in process', async () => {
    const s = await seller();
    const halt = new KillSwitch();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      killSwitch: halt,
    });

    await client.pay(`${s.base}/api/report`);
    halt.engage();

    const started = Date.now();
    const denied = await client.pay(`${s.base}/api/report`).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect((denied as PolicyDenied).reason).toBe('kill_switch_engaged');
    expect(s.hits()).toBe(1);
  });

  it('halts on the environment variable, which survives a restart', async () => {
    const s = await seller();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      killSwitch: { env: { PAYGUARD_HALT: '1' } },
    });
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'kill_switch_engaged',
    });
  });

  it('halts on the presence of the halt file, and lifts when it is removed', async () => {
    const s = await seller();
    const clock = fixedClock(0);
    let present = false;
    const halt = new KillSwitch({
      clock,
      env: {},
      pollIntervalMs: 100,
      fileExists: () => present,
    });
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      killSwitch: halt,
      clock,
    });

    await client.pay(`${s.base}/api/report`);

    present = true;
    clock.advance(101);
    await expect(client.pay(`${s.base}/api/report`)).rejects.toMatchObject({
      reason: 'kill_switch_engaged',
    });

    present = false;
    clock.advance(101);
    const result = await client.pay(`${s.base}/api/report`);
    expect(result.response.status).toBe(200);
  });

  it('takes effect within one second even at the maximum poll interval', async () => {
    const clock = fixedClock(0);
    let present = false;
    const halt = new KillSwitch({
      clock,
      env: {},
      // Anything above a second is clamped, which is what keeps AT-7 satisfiable.
      pollIntervalMs: 60_000,
      fileExists: () => present,
    });
    expect(halt.engaged).toBe(false);
    present = true;
    clock.advance(1000);
    expect(halt.engaged).toBe(true);
  });

  it('reports why it is engaged, for the audit trail', () => {
    const manual = new KillSwitch({ env: {}, fileExists: () => false });
    expect(manual.reason).toBeNull();
    manual.engage();
    expect(manual.reason).toBe('engaged in process');
    manual.release();
    expect(manual.reason).toBeNull();

    expect(new KillSwitch({ env: { PAYGUARD_HALT: 'true' } }).reason).toBe('PAYGUARD_HALT is set');
    expect(new KillSwitch({ env: {}, file: '.halt', fileExists: () => true }).reason).toBe(
      '.halt exists',
    );
  });

  it('does not lift an environment halt when release is called', async () => {
    const halt = new KillSwitch({ env: { PAYGUARD_HALT: '1' }, fileExists: () => false });
    halt.release();
    expect(halt.engaged).toBe(true);
  });
});

describe('the buyer audit trail', () => {
  it('records every decision into a verifiable chain', async () => {
    const s = await seller();
    const store = new MemoryStore();
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      policy: { dailyCap: '10000' },
      store,
    });

    await client.pay(`${s.base}/api/report`);
    await client.pay(`${s.base}/api/report`).catch(() => undefined);

    const entries = await store.readAudit();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      agentId: 'agent-1',
      counterparty: SELLER_BASE,
      rail: 'base:usdc',
      asset: USDC,
      outcome: 'allowed',
    });
    expect(entries[1]).toMatchObject({ outcome: 'denied', reason: 'spend_cap_exceeded' });
    expect(verifyChain(entries).ok).toBe(true);
  });

  it('delivers decisions to a webhook without letting a broken one stop the agent', async () => {
    const s = await seller();
    const seen: string[] = [];
    const client = new PayGuardClient({
      signer: testSigner(),
      agentId: 'agent-1',
      onAudit: (entry) => {
        seen.push(entry.outcome);
        throw new Error('webhook is down');
      },
    });
    const result = await client.pay(`${s.base}/api/report`);
    expect(result.response.status).toBe(200);
    expect(seen).toEqual(['allowed']);
  });

  it('records the rail that was actually paid on after a failover', async () => {
    const base = new TestFacilitator('coinbase', ['base:usdc'], 'base-sepolia');
    const xrpl = new TestFacilitator('xrpl-t54', ['xrpl:rlusd'], 'xrpl-testnet');
    base.down = true;
    const s = await seller({ xrpl: true, facilitators: [base, xrpl] });
    const store = new MemoryStore();
    const client = new PayGuardClient({ signer: testSigner(), agentId: 'agent-1', store });
    await client.pay(`${s.base}/api/report`);
    const entries = await store.readAudit();
    expect(entries.at(-1)).toMatchObject({ rail: 'xrpl:rlusd', asset: RLUSD, outcome: 'allowed' });
  });
});
