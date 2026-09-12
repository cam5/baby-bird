import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitInfo, ParsedDiff, TourSource } from '../core/types.js';
import { excludePathspecs, git } from './exec.js';
import { parseDiff } from './parse.js';

const DIFF_BASE_ARGS = ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', '-U3'];
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

export interface CollectOptions {
  cwd: string;
  exclude: string[];
  warn?: (msg: string) => void;
}

/** Collect and parse the diff for a resolved source. */
export async function collectDiff(source: TourSource, opts: CollectOptions): Promise<ParsedDiff> {
  const pathspec = ['--', '.', ...excludePathspecs(opts.exclude)];
  let raw: string;

  if (source.kind === 'range') {
    raw = (await git([...DIFF_BASE_ARGS, source.baseSha, source.headSha, ...pathspec], { cwd: opts.cwd })).stdout;
  } else if (source.staged) {
    raw = (await git([...DIFF_BASE_ARGS, '--cached', ...pathspec], { cwd: opts.cwd })).stdout;
  } else {
    raw = (await git([...DIFF_BASE_ARGS, 'HEAD', ...pathspec], { cwd: opts.cwd })).stdout;
    raw += await untrackedDiff(opts, pathspec);
  }
  return parseDiff(raw);
}

/** Untracked files rendered as "new file" diffs so they take part in the tour. */
async function untrackedDiff(opts: CollectOptions, pathspec: string[]): Promise<string> {
  const list = await git(['ls-files', '--others', '--exclude-standard', '-z', ...pathspec], { cwd: opts.cwd });
  const paths = list.stdout.split('\0').filter(Boolean);
  let out = '';
  for (const rel of paths) {
    const abs = join(opts.cwd, rel);
    try {
      const s = await stat(abs);
      if (!s.isFile()) continue;
      if (s.size > MAX_UNTRACKED_BYTES) {
        opts.warn?.(`Skipping large untracked file ${rel} (${Math.round(s.size / 1024)} KB)`);
        continue;
      }
    } catch {
      continue;
    }
    const res = await git(
      [...DIFF_BASE_ARGS, '--no-index', '--', '/dev/null', rel],
      { cwd: opts.cwd, allowFailure: true },
    );
    // --no-index exits 1 when files differ, which is the expected case.
    if (res.code > 1) {
      opts.warn?.(`Could not diff untracked file ${rel}: ${res.stderr.trim()}`);
      continue;
    }
    out += res.stdout;
  }
  return out;
}

export async function collectCommits(source: TourSource, cwd: string, limit = 50): Promise<CommitInfo[]> {
  if (source.kind !== 'range') return [];
  const res = await git(
    ['log', '--no-merges', `--max-count=${limit}`, '--format=%h%x09%s', `${source.baseSha}..${source.headSha}`],
    { cwd, allowFailure: true },
  );
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}
