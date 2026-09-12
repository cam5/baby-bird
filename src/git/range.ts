import type { CodeHost } from '../codehost/provider.js';
import { NoChangesError, UsageError } from '../core/errors.js';
import type { PullRequestInfo, TourSource } from '../core/types.js';
import { currentBranch, git, isDirty, localBranches, mergeBase, revParse } from './exec.js';

export interface RangeRequest {
  /** Explicit range argument: "A..B", "A...B" or a single ref. */
  arg?: string;
  working?: boolean;
  staged?: boolean;
}

export interface ResolveOptions {
  cwd: string;
  exclude: string[];
  /** Configured default branch; null means auto-detect. */
  defaultBranch: string | null;
  codehost: CodeHost;
  debug?: (msg: string) => void;
}

export interface ResolvedRange {
  source: TourSource;
  branch: string | null;
  pullRequest?: PullRequestInfo;
}

const MAX_ANCESTOR_CANDIDATES = 100;

export async function resolveRange(req: RangeRequest, opts: ResolveOptions): Promise<ResolvedRange> {
  const debug = opts.debug ?? (() => {});
  const { cwd } = opts;
  const branch = await currentBranch(cwd);
  const headSha = await revParse('HEAD', cwd);
  if (!headSha) {
    throw new NoChangesError('This repository has no commits yet.', 'Make an initial commit first.');
  }
  debug(`repository ${cwd} on ${branch ?? 'detached HEAD'} at ${headSha.slice(0, 12)}`);

  if (req.working && req.staged) throw new UsageError('--working and --staged are mutually exclusive.');
  if ((req.working || req.staged) && req.arg) throw new UsageError(`A range argument cannot be combined with --${req.working ? 'working' : 'staged'}.`);

  if (req.staged) return { source: { kind: 'working', headSha, staged: true, resolvedBy: 'explicit' }, branch };
  if (req.working) return { source: { kind: 'working', headSha, staged: false, resolvedBy: 'explicit' }, branch };

  if (req.arg) {
    return { source: await explicitRange(req.arg, headSha, cwd), branch };
  }

  // 1. Dirty working tree.
  if (await isDirty(cwd, opts.exclude)) {
    debug('working tree is dirty; touring uncommitted changes');
    return { source: { kind: 'working', headSha, staged: false, resolvedBy: 'dirty-tree' }, branch };
  }

  const defaultBranch = await detectDefaultBranch(opts.defaultBranch, cwd);
  debug(`default branch: ${defaultBranch ?? '(none)'}`);

  // 2. Pull request base.
  const pr = await opts.codehost.currentPullRequest(cwd);
  if (pr?.baseRefName) {
    const baseRef = await firstExistingRef([`origin/${pr.baseRefName}`, pr.baseRefName], cwd);
    if (baseRef) {
      debug(`pull request #${pr.number} targets ${pr.baseRefName}; using ${baseRef}`);
      const source = await rangeAtMergeBase(baseRef, headSha, branch ?? 'HEAD', 'pull-request', cwd);
      return { source, branch, pullRequest: pr };
    }
    debug(`pull request #${pr.number} targets ${pr.baseRefName}, but that ref is not available locally`);
  }

  const onDefault = defaultBranch !== null && branch !== null && stripRemote(defaultBranch) === branch;

  // 3. Nearest ancestor branch.
  if (!onDefault) {
    const nearest = await nearestAncestorBranch(branch, headSha, defaultBranch, cwd, debug);
    if (nearest) {
      debug(`nearest ancestor branch: ${nearest}`);
      const source = await rangeAtMergeBase(nearest, headSha, branch ?? 'HEAD', 'ancestor-branch', cwd);
      return { source, branch };
    }
  }

  // 4. Default branch.
  if (defaultBranch && !onDefault) {
    const source = await rangeAtMergeBase(defaultBranch, headSha, branch ?? 'HEAD', 'default-branch', cwd);
    return { source, branch };
  }

  throw new NoChangesError(
    onDefault ? `You're on ${branch} in ${cwd} with a clean working tree; nothing to tour.` : 'Could not infer what to compare against.',
    'Pass a range explicitly, e.g. `bb HEAD~3`, `bb main..feature` or `bb --working`.',
  );
}

async function explicitRange(arg: string, headSha: string, cwd: string): Promise<TourSource> {
  const three = arg.indexOf('...');
  const two = three === -1 ? arg.indexOf('..') : -1;

  if (three !== -1) {
    const base = arg.slice(0, three) || 'HEAD';
    const head = arg.slice(three + 3) || 'HEAD';
    const headResolved = await requireRef(head, cwd);
    return rangeAtMergeBase(base, headResolved, head, 'explicit', cwd);
  }
  if (two !== -1) {
    const base = arg.slice(0, two) || 'HEAD';
    const head = arg.slice(two + 2) || 'HEAD';
    const baseSha = await requireRef(base, cwd);
    const headResolved = await requireRef(head, cwd);
    if (baseSha === headResolved) throw new NoChangesError(`${base} and ${head} point at the same commit.`);
    return { kind: 'range', base, head, baseSha, headSha: headResolved, resolvedBy: 'explicit' };
  }
  // Bare ref: "what did HEAD add on top of <ref>" (three-dot semantics).
  return rangeAtMergeBase(arg, headSha, 'HEAD', 'explicit', cwd);
}

async function requireRef(ref: string, cwd: string): Promise<string> {
  const sha = await revParse(ref, cwd);
  if (!sha) throw new UsageError(`Unknown git ref: ${ref}`);
  return sha;
}

async function rangeAtMergeBase(
  base: string,
  headSha: string,
  headLabel: string,
  resolvedBy: Extract<TourSource, { kind: 'range' }>['resolvedBy'],
  cwd: string,
): Promise<TourSource> {
  const baseTip = await requireRef(base, cwd);
  const mb = (await mergeBase(baseTip, headSha, cwd)) ?? baseTip;
  if (mb === headSha) {
    throw new NoChangesError(
      `${headLabel} has no commits on top of ${base}.`,
      base === headLabel ? undefined : `Did you mean \`bb ${base}..${headLabel}\`?`,
    );
  }
  const source: TourSource = { kind: 'range', base, head: headLabel, baseSha: mb, headSha, resolvedBy };
  if (mb !== baseTip) source.mergeBase = mb;
  return source;
}

async function firstExistingRef(candidates: string[], cwd: string): Promise<string | null> {
  for (const ref of candidates) {
    if (await revParse(ref, cwd)) return ref;
  }
  return null;
}

function stripRemote(ref: string): string {
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
}

export async function detectDefaultBranch(configured: string | null, cwd: string): Promise<string | null> {
  if (configured) return (await revParse(configured, cwd)) ? configured : null;
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, allowFailure: true });
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
  return firstExistingRef(['main', 'master', 'trunk', 'origin/main', 'origin/master'], cwd);
}

async function nearestAncestorBranch(
  branch: string | null,
  headSha: string,
  defaultBranch: string | null,
  cwd: string,
  debug: (msg: string) => void,
): Promise<string | null> {
  const branches = (await localBranches(cwd)).filter((b) => b !== branch);
  if (branches.length === 0) return null;
  if (branches.length > MAX_ANCESTOR_CANDIDATES) {
    debug(`skipping ancestor search: ${branches.length} local branches`);
    return null;
  }
  let best: { name: string; distance: number } | null = null;
  for (const name of branches) {
    const mb = await mergeBase(name, headSha, cwd);
    if (!mb || mb === headSha) continue; // unrelated, identical, or a descendant of HEAD
    const count = await git(['rev-list', '--count', `${mb}..${headSha}`], { cwd, allowFailure: true });
    const distance = count.code === 0 ? Number(count.stdout.trim()) : Number.POSITIVE_INFINITY;
    const isDefault = defaultBranch !== null && stripRemote(defaultBranch) === name;
    if (!best || distance < best.distance || (distance === best.distance && isDefault)) {
      best = { name, distance };
    }
  }
  return best?.name ?? null;
}
