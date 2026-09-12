import { execFile } from 'node:child_process';
import type { PullRequestInfo } from '../core/types.js';
import type { CodeHost } from './provider.js';

const FIELDS = 'number,title,body,url,baseRefName,headRefName,state';

export interface GhOptions {
  timeoutMs?: number;
  debug?: (msg: string) => void;
}

/** Reads the current branch's PR through the `gh` CLI. Never throws: any failure means "no PR". */
export class GhCodeHost implements CodeHost {
  readonly name = 'gh';
  private readonly timeoutMs: number;
  private readonly debug: (msg: string) => void;

  constructor(opts: GhOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.debug = opts.debug ?? (() => {});
  }

  currentPullRequest(cwd: string): Promise<PullRequestInfo | null> {
    return new Promise((resolve) => {
      execFile(
        'gh',
        ['pr', 'view', '--json', FIELDS],
        { cwd, timeout: this.timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            this.debug(
              code === 'ENOENT' ? 'gh is not installed; skipping pull request lookup' : `gh pr view failed: ${(stderr || err.message).trim()}`,
            );
            resolve(null);
            return;
          }
          try {
            const j = JSON.parse(stdout) as Record<string, unknown>;
            resolve({
              number: Number(j.number),
              title: String(j.title ?? ''),
              body: String(j.body ?? ''),
              url: String(j.url ?? ''),
              baseRefName: String(j.baseRefName ?? ''),
              headRefName: String(j.headRefName ?? ''),
            });
          } catch (parseErr) {
            this.debug(`gh returned unparseable JSON: ${(parseErr as Error).message}`);
            resolve(null);
          }
        },
      );
    });
  }
}
