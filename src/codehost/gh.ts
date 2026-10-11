import { execFile } from 'node:child_process';
import type { PullRequestInfo } from '../core/types.js';
import type { CodeHost, PullRequestLookup, PullRequestLookupFailure } from './provider.js';

const FIELDS = 'number,title,body,url,baseRefName,headRefName,state';
const LOOKUP_FIELDS = `${FIELDS},baseRefOid,headRefOid`;

export interface GhOptions {
  timeoutMs?: number;
  debug?: (msg: string) => void;
}

interface GhRun {
  stdout: string;
  stderr: string;
  /** Set when gh did not exit 0. */
  error?: NodeJS.ErrnoException & { killed?: boolean };
}

/**
 * Reads pull requests through the `gh` CLI, as whichever account gh is using (`GH_TOKEN` in the
 * environment wins over the logged-in account, which is gh's own rule). Never throws.
 */
export class GhCodeHost implements CodeHost {
  readonly name = 'gh';
  private readonly timeoutMs: number;
  private readonly debug: (msg: string) => void;

  constructor(opts: GhOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.debug = opts.debug ?? (() => {});
  }

  /** The current branch's PR. Any failure means "no PR". */
  async currentPullRequest(cwd: string): Promise<PullRequestInfo | null> {
    const run = await this.gh(['pr', 'view', '--json', FIELDS], cwd);
    if (run.error) {
      this.debug(run.error.code === 'ENOENT' ? 'gh is not installed; skipping pull request lookup' : `gh pr view failed: ${(run.stderr || run.error.message).trim()}`);
      return null;
    }
    try {
      return toPullRequest(JSON.parse(run.stdout) as Record<string, unknown>);
    } catch (parseErr) {
      this.debug(`gh returned unparseable JSON: ${(parseErr as Error).message}`);
      return null;
    }
  }

  async pullRequest(number: number, cwd: string, repo?: string): Promise<PullRequestLookup> {
    const args = ['pr', 'view', String(number), '--json', LOOKUP_FIELDS];
    if (repo) args.push('--repo', repo);
    const run = await this.gh(args, cwd);
    if (run.error) {
      const failure = classifyGhFailure(run, this.timeoutMs);
      this.debug(`gh ${args.slice(0, 3).join(' ')} failed (${failure.reason}): ${failure.detail}`);
      return { ok: false, ...failure };
    }
    try {
      return { ok: true, pr: toPullRequest(JSON.parse(run.stdout) as Record<string, unknown>) };
    } catch (parseErr) {
      return { ok: false, reason: 'other', detail: `gh returned unparseable JSON: ${(parseErr as Error).message}` };
    }
  }

  private gh(args: string[], cwd: string): Promise<GhRun> {
    return new Promise((resolve) => {
      execFile('gh', args, { cwd, timeout: this.timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve(err ? { stdout, stderr, error: err as GhRun['error'] } : { stdout, stderr });
      });
    });
  }
}

function toPullRequest(j: Record<string, unknown>): PullRequestInfo {
  const pr: PullRequestInfo = {
    number: Number(j.number),
    title: String(j.title ?? ''),
    body: String(j.body ?? ''),
    url: String(j.url ?? ''),
    baseRefName: String(j.baseRefName ?? ''),
    headRefName: String(j.headRefName ?? ''),
  };
  if (typeof j.state === 'string') pr.state = j.state;
  if (typeof j.baseRefOid === 'string') pr.baseRefOid = j.baseRefOid;
  if (typeof j.headRefOid === 'string') pr.headRefOid = j.headRefOid;
  return pr;
}

/** Turn a failed `gh pr view` into a reason bb can give advice about. Exported for tests. */
export function classifyGhFailure(run: GhRun, timeoutMs: number): { reason: PullRequestLookupFailure; detail: string } {
  if (run.error?.code === 'ENOENT') return { reason: 'not-installed', detail: 'gh is not installed' };
  if (run.error?.killed) return { reason: 'timeout', detail: `gh did not answer within ${Math.round(timeoutMs / 1000)}s` };
  const lines = run.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const detail = lines[0] ?? run.error?.message ?? 'gh failed';
  const text = run.stderr;
  let reason: PullRequestLookupFailure = 'other';
  if (/Could not resolve to a PullRequest/i.test(text)) reason = 'no-such-pr';
  else if (/Could not resolve to a Repository/i.test(text) || /HTTP 404/.test(text)) reason = 'no-access';
  else if (/gh auth login|HTTP 401|Bad credentials|not logged in|authentication/i.test(text)) reason = 'not-authenticated';
  return { reason, detail };
}
