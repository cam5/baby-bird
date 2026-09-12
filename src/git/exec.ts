import { execFile } from 'node:child_process';
import { GitError, NotARepoError } from '../core/errors.js';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  cwd: string;
  /** Resolve instead of throwing on a nonzero exit code. */
  allowFailure?: boolean;
}

const MAX_BUFFER = 512 * 1024 * 1024;

/** Run git with the given args; throws GitError on nonzero exit unless allowFailure. */
export function git(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      if (e && e.code === 'ENOENT') {
        reject(new GitError('git executable not found', { hint: 'Install git and make sure it is on your PATH.' }));
        return;
      }
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
      if (code !== 0 && !opts.allowFailure) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new GitError(`git ${args.slice(0, 2).join(' ')} failed: ${detail}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

export async function gitRoot(cwd: string): Promise<string> {
  const res = await git(['rev-parse', '--show-toplevel'], { cwd, allowFailure: true });
  if (res.code !== 0) throw new NotARepoError(cwd);
  return res.stdout.trim();
}

/** Resolve a ref to a full commit sha; null when it doesn't resolve. */
export async function revParse(ref: string, cwd: string): Promise<string | null> {
  const res = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function shortSha(sha: string, cwd: string): Promise<string> {
  const res = await git(['rev-parse', '--short', sha], { cwd, allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : sha.slice(0, 7);
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const res = await git(['symbolic-ref', '--short', '--quiet', 'HEAD'], { cwd, allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function mergeBase(a: string, b: string, cwd: string): Promise<string | null> {
  const res = await git(['merge-base', a, b], { cwd, allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function localBranches(cwd: string): Promise<string[]> {
  const res = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd });
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function excludePathspecs(exclude: string[]): string[] {
  return exclude.map((glob) => `:(exclude,glob)${glob}`);
}

/** True when the working tree (tracked or untracked, minus excludes) differs from HEAD. */
export async function isDirty(cwd: string, exclude: string[]): Promise<boolean> {
  const res = await git(['status', '--porcelain', '--untracked-files=all', '--', '.', ...excludePathspecs(exclude)], { cwd });
  return res.stdout.trim().length > 0;
}
