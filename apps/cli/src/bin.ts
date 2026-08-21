#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { renderConfig, renderEnvExample } from './commands/init.js';
import { runAudit, renderMarkdown, renderText } from './commands/audit.js';
import { renderSimulation, runSimulation, startSimulatedSeller } from './commands/simulate.js';
import { createProxy } from '@payguard/server';
import { createStore } from '@payguard/store';
import { toCsv, toJsonl, verifyChain } from '@payguard/core';

const program = new Command();

program
  .name('payguard')
  .description('Non-custodial agent payment guardrails for x402')
  .version('0.1.0');

program
  .command('init')
  .description('Scaffold payguard.config.ts and a .env.example with no secrets in either')
  .option('--rail <rail>', 'base or xrpl', 'base')
  .option('--pay-to <address>', 'the seller receiving address')
  .option('--dir <dir>', 'where to write', '.')
  .option('--force', 'overwrite existing files', false)
  .action((options: { rail: string; payTo?: string; dir: string; force: boolean }) => {
    const rail = options.rail === 'xrpl' ? 'xrpl' : 'base';
    const config = resolve(options.dir, 'payguard.config.ts');
    const env = resolve(options.dir, '.env.example');

    for (const [path, contents] of [
      [
        config,
        renderConfig({ rail, ...(options.payTo === undefined ? {} : { payTo: options.payTo }) }),
      ],
      [env, renderEnvExample({ rail })],
    ] as const) {
      if (existsSync(path) && !options.force) {
        console.error(`refusing to overwrite ${path}; pass --force if that is what you want`);
        process.exitCode = 1;
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      console.log(`wrote ${path}`);
    }

    console.log('');
    console.log('Next: fill in payTo and your RPC url, then run `payguard simulate` to see the');
    console.log('attack classes blocked without needing a wallet or a faucet.');
  });

program
  .command('simulate')
  .description('Run every documented attack class against a guarded endpoint, no wallet needed')
  .option('--json', 'emit the report as JSON', false)
  .action(async (options: { json: boolean }) => {
    const report = await runSimulation();
    console.log(options.json ? JSON.stringify(report, null, 2) : renderSimulation(report));
    process.exitCode = report.passed ? 0 : 1;
  });

program
  .command('audit')
  .description('Probe a live endpoint for the five attack classes, read only and unsigned')
  .addHelpText(
    'after',
    '\nExit codes: 0 every probe blocked, 1 something was found vulnerable,\n' +
      '2 nothing vulnerable but something was inconclusive, which is not a pass.',
  )
  .argument('<url>', 'the priced endpoint to probe')
  .option('--json', 'emit the report as JSON', false)
  .option('--markdown <path>', 'also write a markdown report to this path')
  .action(async (url: string, options: { json: boolean; markdown?: string }) => {
    const report = await runAudit({ url });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderText(report));
    if (options.markdown !== undefined) {
      writeFileSync(options.markdown, renderMarkdown(report));
      console.log(`\nwrote ${options.markdown}`);
    }
    // A run that could not reach the endpoint must not look like a clean bill of health in CI,
    // so inconclusive gets its own exit code rather than sharing zero with a genuine pass.
    process.exitCode = report.summary.vulnerable > 0 ? 1 : report.summary.inconclusive > 0 ? 2 : 0;
  });

program
  .command('export')
  .description('Export the audit log as JSONL or CSV, and verify the hash chain while doing it')
  .option('--store <kind>', 'sqlite or redis', 'sqlite')
  .option('--path <path>', 'sqlite file path', './payguard.sqlite')
  .option('--url <url>', 'redis connection url')
  .option('--format <format>', 'jsonl or csv', 'jsonl')
  .option('--out <path>', 'write to this file instead of stdout')
  .option('--from <seq>', 'start at this sequence number', '0')
  .action(
    async (options: {
      store: string;
      path: string;
      url?: string;
      format: string;
      out?: string;
      from: string;
    }) => {
      const store =
        options.store === 'redis'
          ? await createStore({
              kind: 'redis',
              url: options.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379',
              keyPrefix: 'payguard:',
            })
          : await createStore({ kind: 'sqlite', path: options.path });

      try {
        const entries = await store.readAudit({ fromSeq: Number(options.from) });

        // Verifying on the way out means an operator cannot hand an auditor a tampered export
        // without being told. A partial export (--from) cannot be verified from its own contents,
        // because the chain before it is missing, and the message says so rather than staying
        // silent.
        if (Number(options.from) === 0) {
          const verification = verifyChain(entries);
          if (!verification.ok) {
            console.error(
              `audit chain is broken at entry ${verification.brokenAt} (${verification.reason}); exporting anyway so you have the evidence`,
            );
            process.exitCode = 1;
          }
        } else {
          console.error(
            'note: a partial export starting mid-chain cannot be verified from its own contents',
          );
        }

        const rendered = options.format === 'csv' ? toCsv(entries) : toJsonl(entries);
        if (options.out === undefined) {
          process.stdout.write(rendered);
        } else {
          writeFileSync(options.out, rendered);
          console.error(`wrote ${entries.length} entries to ${options.out}`);
        }
      } finally {
        await store.close();
      }
    },
  );

program
  .command('protect')
  .description('Run PayGuard in reverse proxy mode in front of an existing service')
  .argument('[upstream]', 'the service to protect, for example http://localhost:3000')
  .option('--port <port>', 'port to listen on', '4402')
  .option('--config <path>', 'path to payguard.config.ts')
  .option('--demo', 'run the simulated seller instead of proxying, for a quick look', false)
  .action(
    async (
      upstream: string | undefined,
      options: { port: string; config?: string; demo: boolean },
    ) => {
      if (options.demo) {
        const { url } = await startSimulatedSeller(Number(options.port));
        console.log(`simulated guarded endpoint listening on ${url}/api/resource`);
        console.log('It answers 402 until a payment is presented, then confirms before releasing.');
        console.log('Point `payguard audit` at it, or press ctrl-c to stop.');
        return;
      }

      if (upstream === undefined) {
        console.error('protect needs an upstream url, or --demo to run the simulated seller');
        process.exitCode = 1;
        return;
      }

      if (options.config === undefined) {
        console.error('protect needs --config pointing at a payguard.config.ts');
        console.error(
          'Run `payguard init` to scaffold one, or `payguard protect --demo` for a look.',
        );
        process.exitCode = 1;
        return;
      }

      // The config exports rails and facilitators that need real adapters constructed from it. That
      // wiring lives in the config module itself so this command stays a thin entry point.
      const loaded = (await import(resolve(options.config))) as {
        default?: unknown;
        createProxyOptions?: () => Parameters<typeof createProxy>[0];
      };

      if (typeof loaded.createProxyOptions !== 'function') {
        console.error(
          `${options.config} does not export createProxyOptions(). See docs/quickstart.md for the`,
        );
        console.error(
          'four line export that turns a payguard.config.ts into a runnable proxy, which is kept',
        );
        console.error(
          'explicit so the CLI never has to guess how to reach your RPC or your wallet.',
        );
        process.exitCode = 1;
        return;
      }

      const server = createProxy({ ...loaded.createProxyOptions(), upstream });
      server.listen(Number(options.port), () => {
        console.log(`PayGuard proxying ${upstream} on port ${options.port}`);
      });
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
