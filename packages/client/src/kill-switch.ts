import { existsSync } from 'node:fs';
import { systemClock, type Clock } from '@payguard/core';

export interface KillSwitchOptions {
  /** Presence of this file halts every payment. */
  file?: string;
  /** Setting this environment variable to "1" or "true" halts every payment. */
  envVar?: string;
  /** How often the file is re-checked. AT-7 requires a halt to take effect within one second. */
  pollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  /** Overridden in tests. Defaults to a filesystem check. */
  fileExists?: (path: string) => boolean;
}

/**
 * FR-3.3. Four ways to stop an agent spending: a file, an environment variable, an in-process
 * call, and whatever the operator wires into `engage`.
 *
 * The file check is cached for pollIntervalMs rather than being read on every payment, because a
 * synchronous stat in the hot path costs latency PayGuard has a budget for (NFR-2). The cache
 * window is capped at one second so AT-7 stays satisfiable.
 *
 * State is not cached across restarts by PayGuard itself: the file and the environment variable
 * are the persistence, which is why both survive a process dying.
 */
export class KillSwitch {
  private readonly file: string;
  private readonly envVar: string;
  private readonly pollIntervalMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: Clock;
  private readonly fileExists: (path: string) => boolean;

  private manual = false;
  private cachedFileState = false;
  private cachedAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: KillSwitchOptions = {}) {
    this.file = options.file ?? '.payguard-halt';
    this.envVar = options.envVar ?? 'PAYGUARD_HALT';
    this.pollIntervalMs = Math.min(options.pollIntervalMs ?? 250, 1000);
    this.env = options.env ?? process.env;
    this.clock = options.clock ?? systemClock;
    this.fileExists = options.fileExists ?? ((path) => existsSync(path));
  }

  /** Halts every payment from this process immediately. */
  engage(): void {
    this.manual = true;
  }

  /** Lifts an in-process halt. Has no effect on the file or the environment variable. */
  release(): void {
    this.manual = false;
    this.cachedAtMs = Number.NEGATIVE_INFINITY;
  }

  get engaged(): boolean {
    if (this.manual) return true;

    const flag = this.env[this.envVar];
    if (flag === '1' || flag === 'true') return true;

    const now = this.clock.now();
    if (now - this.cachedAtMs >= this.pollIntervalMs) {
      this.cachedFileState = this.fileExists(this.file);
      this.cachedAtMs = now;
    }
    return this.cachedFileState;
  }

  /** Why the switch is engaged, for the audit trail. Null when it is not. */
  get reason(): string | null {
    if (this.manual) return 'engaged in process';
    const flag = this.env[this.envVar];
    if (flag === '1' || flag === 'true') return `${this.envVar} is set`;
    if (this.engaged) return `${this.file} exists`;
    return null;
  }
}
