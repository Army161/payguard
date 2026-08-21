import type { ProbeResult, ProbeVerdict } from './probes.js';

export interface ProbeReportEntry {
  id: string;
  title: string;
  expectation: string;
  verdict: ProbeVerdict;
  detail: string;
  evidence?: Record<string, unknown>;
  durationMs: number;
}

export interface AuditReport {
  target: string;
  startedAt: string;
  mode: 'unsigned';
  summary: Record<ProbeVerdict, number>;
  entries: ProbeReportEntry[];
  /** True when nothing was found vulnerable. Not the same as "this endpoint is safe". */
  passed: boolean;
  caveats: string[];
}

export function buildReport(
  target: string,
  startedAt: string,
  entries: ProbeReportEntry[],
): AuditReport {
  const summary: Record<ProbeVerdict, number> = { blocked: 0, vulnerable: 0, inconclusive: 0 };
  for (const entry of entries) summary[entry.verdict] += 1;

  return {
    target,
    startedAt,
    mode: 'unsigned',
    summary,
    entries,
    passed: summary.vulnerable === 0,
    caveats: [
      'Every probe is unsigned and read-only, so this run cannot move money and cannot prove that settlement is verified correctly. It can only show that the endpoint refuses what it should refuse.',
      'An inconclusive result is not a pass. It means the endpoint answered in a way this probe cannot interpret.',
      'A clean report is evidence, not a guarantee. It does not replace the attack class test suite running against your own build, or a third party audit.',
    ],
  };
}

const ICON: Record<ProbeVerdict, string> = {
  blocked: 'PASS',
  vulnerable: 'FAIL',
  inconclusive: 'UNKNOWN',
};

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# PayGuard endpoint audit`);
  lines.push('');
  lines.push(`- Target: \`${report.target}\``);
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Mode: ${report.mode} probes, read only`);
  lines.push(
    `- Result: ${report.summary.vulnerable} vulnerable, ${report.summary.blocked} blocked, ${report.summary.inconclusive} inconclusive`,
  );
  lines.push('');
  lines.push('| Attack class | Verdict | Detail |');
  lines.push('| --- | --- | --- |');
  for (const entry of report.entries) {
    lines.push(`| ${entry.title} | ${ICON[entry.verdict]} | ${entry.detail} |`);
  }
  lines.push('');
  lines.push('## What each probe expected');
  lines.push('');
  for (const entry of report.entries) {
    lines.push(`### ${entry.title}`);
    lines.push('');
    lines.push(`Expected: ${entry.expectation}`);
    lines.push('');
    lines.push(`Observed: ${entry.detail}`);
    if (entry.evidence !== undefined) {
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(entry.evidence, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('## Limits of this report');
  lines.push('');
  for (const caveat of report.caveats) {
    lines.push(`- ${caveat}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderText(report: AuditReport): string {
  const lines = [`PayGuard audit of ${report.target}`, ''];
  for (const entry of report.entries) {
    lines.push(`  [${ICON[entry.verdict].padEnd(7)}] ${entry.title}`);
    lines.push(`            ${entry.detail}`);
  }
  lines.push('');
  lines.push(
    `  ${report.summary.vulnerable} vulnerable, ${report.summary.blocked} blocked, ${report.summary.inconclusive} inconclusive`,
  );
  if (report.summary.inconclusive > 0) {
    lines.push('  An inconclusive result is not a pass.');
  }
  return lines.join('\n');
}

export function resultToEntry(
  probe: { id: string; title: string; expectation: string },
  result: ProbeResult,
  durationMs: number,
): ProbeReportEntry {
  return {
    id: probe.id,
    title: probe.title,
    expectation: probe.expectation,
    verdict: result.verdict,
    detail: result.detail,
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    durationMs,
  };
}
