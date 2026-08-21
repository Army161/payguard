import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildReport,
  forgePayload,
  renderConfig,
  renderEnvExample,
  renderMarkdown,
  renderSimulation,
  renderText,
  runAudit,
  runSimulation,
  startSimulatedSeller,
} from '../src/index.js';
import type { PaymentRequirements } from '@payguard/core';

const dir = mkdtempSync(join(tmpdir(), 'payguard-cli-'));
const servers: { close(): void }[] = [];

afterAll(() => {
  for (const server of servers) server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('payguard simulate', () => {
  it('blocks every documented attack class', async () => {
    const report = await runSimulation();
    expect(report.total).toBe(5);
    expect(report.blocked).toBe(5);
    expect(report.passed).toBe(true);
  });

  it('names each attack class it covers', async () => {
    const report = await runSimulation();
    expect(report.cases.map((c) => c.id).sort()).toEqual([
      'asset-theft',
      'duplication',
      'free-shopping',
      'replay',
      'short-payment',
    ]);
  });

  it('reports exactly one delivery and one settlement out of fifty concurrent requests', async () => {
    const report = await runSimulation();
    const duplication = report.cases.find((c) => c.id === 'duplication');
    expect(duplication?.detail).toMatch(/1 of 50 delivered, 1 settlement/);
  });

  it('renders a readable summary', async () => {
    const rendered = renderSimulation(await runSimulation());
    expect(rendered).toMatch(/5 of 5 attack classes blocked/);
    expect(rendered).toMatch(/\[BLOCKED\]/);
  });
});

describe('payguard audit against a live guarded endpoint', () => {
  it('finds nothing vulnerable when the endpoint is guarded', async () => {
    const { url, server } = await startSimulatedSeller();
    servers.push(server);
    const report = await runAudit({ url: `${url}/api/resource`, startedAt: 'FIXED' });
    expect(report.passed).toBe(true);
    expect(report.summary.vulnerable).toBe(0);
    expect(report.entries).toHaveLength(5);
  });

  it('flags an unguarded endpoint as vulnerable to free shopping', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ secret: 'served for free' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const report = await runAudit({
      url: 'https://unguarded.example/api/resource',
      fetchImpl,
      startedAt: 'FIXED',
    });
    expect(report.passed).toBe(false);
    const freeShopping = report.entries.find((e) => e.id === 'free-shopping');
    expect(freeShopping?.verdict).toBe('vulnerable');
    expect(freeShopping?.detail).toMatch(/served without payment/);
  });

  it('flags an endpoint that accepts an unsigned payload', async () => {
    let call = 0;
    const quote = {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'base-sepolia',
          maxAmountRequired: '10000',
          resource: 'https://weak.example/api/resource',
          description: 'r',
          mimeType: 'application/json',
          payTo: '0x1111111111111111111111111111111111111111',
          maxTimeoutSeconds: 300,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        },
      ],
      error: 'payload_missing',
    };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      call += 1;
      const headers = new Headers(init?.headers);
      if (headers.get('x-payment') === null) {
        return new Response(JSON.stringify(quote), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Accepts any payload at all, which is the grant-before-settle vulnerability.
      return new Response('{"secret":"leaked"}', { status: 200 });
    }) as unknown as typeof fetch;

    const report = await runAudit({
      url: 'https://weak.example/api/resource',
      fetchImpl,
      startedAt: 'FIXED',
    });
    expect(report.entries.find((e) => e.id === 'unsigned-payload')?.verdict).toBe('vulnerable');
    expect(report.entries.find((e) => e.id === 'duplication')?.verdict).toBe('vulnerable');
    expect(call).toBeGreaterThan(50);
  });

  it('reports inconclusive rather than passing when the endpoint is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const report = await runAudit({
      url: 'https://nowhere.example/api',
      fetchImpl,
      startedAt: 'FIXED',
    });
    expect(report.summary.inconclusive).toBe(5);
    expect(report.summary.vulnerable).toBe(0);
    // No vulnerability found is not the same as safe, and the report says so.
    expect(report.caveats.join(' ')).toMatch(/inconclusive result is not a pass/);
  });

  it('states its own limits in every report', () => {
    const report = buildReport('https://x.example', 'FIXED', []);
    expect(report.caveats.join(' ')).toMatch(/cannot move money/);
    expect(report.caveats.join(' ')).toMatch(/does not replace/);
  });
});

describe('audit report rendering', () => {
  it('renders markdown with a verdict table and the caveats', async () => {
    const { url, server } = await startSimulatedSeller();
    servers.push(server);
    const markdown = renderMarkdown(
      await runAudit({ url: `${url}/api/resource`, startedAt: 'FIXED' }),
    );
    expect(markdown).toMatch(/^# PayGuard endpoint audit/);
    expect(markdown).toMatch(/\| Attack class \| Verdict \| Detail \|/);
    expect(markdown).toMatch(/## Limits of this report/);
    expect(markdown).toMatch(/PASS/);
  });

  it('renders text that warns when anything was inconclusive', () => {
    const report = buildReport('https://x.example', 'FIXED', [
      {
        id: 'p',
        title: 'A probe',
        expectation: 'something',
        verdict: 'inconclusive',
        detail: 'could not tell',
        durationMs: 1,
      },
    ]);
    expect(renderText(report)).toMatch(/An inconclusive result is not a pass/);
  });
});

describe('the forged audit payload', () => {
  const requirements = (network: PaymentRequirements['network']): PaymentRequirements => ({
    scheme: 'exact',
    network,
    maxAmountRequired: '10000',
    resource: 'https://x.example',
    description: 'r',
    mimeType: 'application/json',
    payTo: network.startsWith('xrpl') ? 'rSeller' : '0x1111111111111111111111111111111111111111',
    maxTimeoutSeconds: 300,
    asset: 'x',
  });

  it('carries an obviously invalid signature, so it cannot be mistaken for a real payment', () => {
    const payload = forgePayload(requirements('base-sepolia'));
    expect(payload.payload).toMatchObject({ signature: `0x${'00'.repeat(65)}` });
  });

  it('is recognisable in a seller log as coming from the audit command', () => {
    const payload = forgePayload(requirements('xrpl-testnet'));
    const transaction = (payload.payload as { transaction: string }).transaction;
    expect(Buffer.from(transaction, 'hex').toString('utf8')).toBe('payguardaudit');
  });

  it('produces a transaction shaped payload for XRPL and an authorization for EVM', () => {
    expect(forgePayload(requirements('xrpl-testnet')).payload).toHaveProperty('transaction');
    expect(forgePayload(requirements('base-sepolia')).payload).toHaveProperty('authorization');
  });
});

describe('payguard init', () => {
  it('scaffolds a config that reads secrets from the environment', () => {
    const config = renderConfig({ rail: 'base' });
    expect(config).toMatch(/defineConfig/);
    expect(config).toMatch(/process\.env\.BASE_RPC_URL/);
    expect(config).toMatch(/mode: 'strict'/);
    expect(config).toMatch(/requireTestnet: true/);
  });

  it('contains nothing that looks like a secret', () => {
    const config = renderConfig({ rail: 'base' });
    expect(config).not.toMatch(/PRIVATE_KEY|SECRET_KEY|0x[0-9a-f]{64}/i);
  });

  it('scaffolds the XRPL variant with an issuer qualified asset', () => {
    const config = renderConfig({ rail: 'xrpl' });
    expect(config).toMatch(/RLUSD\.rYOUR_TESTNET_ISSUER/);
    expect(config).toMatch(/different issuer is a different asset/);
  });

  it('uses the supplied receiving address', () => {
    expect(renderConfig({ rail: 'base', payTo: '0xabc' })).toMatch(/payTo: '0xabc'/);
  });

  it('writes an env example that refuses to hold a private key', () => {
    const env = renderEnvExample({ rail: 'base' });
    expect(env).toMatch(/NEVER put a private key here/);
    expect(env).toMatch(/PAYGUARD_ALLOW_MAINNET/);
  });
});

describe('the payguard binary', () => {
  const bin = new URL('../dist/bin.js', import.meta.url).pathname;

  it('runs simulate and exits zero when every class is blocked', () => {
    const output = execFileSync(process.execPath, [bin, 'simulate'], { encoding: 'utf8' });
    expect(output).toMatch(/5 of 5 attack classes blocked/);
  });

  it('emits JSON on request', () => {
    const output = execFileSync(process.execPath, [bin, 'simulate', '--json'], {
      encoding: 'utf8',
    });
    expect(JSON.parse(output)).toMatchObject({ passed: true, total: 5 });
  });

  it('scaffolds config files and refuses to overwrite them', () => {
    execFileSync(process.execPath, [bin, 'init', '--dir', dir, '--pay-to', '0xfeed'], {
      encoding: 'utf8',
    });
    expect(readFileSync(join(dir, 'payguard.config.ts'), 'utf8')).toMatch(/payTo: '0xfeed'/);

    // A second run must refuse rather than clobber a config the operator has edited, and must
    // exit non-zero so a script notices.
    expect(() =>
      execFileSync(process.execPath, [bin, 'init', '--dir', dir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(/refusing to overwrite/);

    execFileSync(process.execPath, [bin, 'init', '--dir', dir, '--force'], { encoding: 'utf8' });
  });

  it('exits 2 when a probe was inconclusive, so CI does not read it as a pass', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [bin, 'audit', 'http://127.0.0.1:1/nothing'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });

  it('refuses to proxy without an upstream or --demo', () => {
    expect(() =>
      execFileSync(process.execPath, [bin, 'protect'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(/needs an upstream url/);
  });

  it('prints its version', () => {
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(
      '0.1.0',
    );
  });

  it('lists every command in its help', () => {
    const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    for (const command of ['init', 'protect', 'simulate', 'audit']) {
      expect(help).toMatch(new RegExp(`\\b${command}\\b`));
    }
  });
});
