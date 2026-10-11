import type { CodeHost } from '../codehost/provider.js';
import { NoChangesError, UsageError } from '../core/errors.js';
import type { PullRequestInfo, RangeResolvedBy, TourSource } from '../core/types.js';
import { currentBranch, git, isDirty, localBranches, mergeBase, revParse } from './exec.js';
import { isBareNumber, localRefNamed, parsePullRequestArg, requirePullRequestArg, resolvePullRequest, type PullRequestRef } from './pr.js';

export interface RangeRequest {
  /**
   * Explicit range argument: "A..B", "A...B", a single ref, or a pull request ("12", "#12", a PR URL).
   * A bare number is a pull request unless a local branch or tag has exactly that name.
   */
  arg?: string;
  /** A pull request by number or URL, with no ref-name ambiguity (`--pr`). */
  pr?: string;
  /**
   * `--base`: what to compare against. With `head` (default HEAD) this is the flag spelling of
   * `base...head`. With a pull request it replaces the PR's own base.
   */
  base?: string;
  /** `--head`: the commit being toured (default HEAD). Alone, it is compared against the default branch. */
  head?: string;
  /** `--direct`: compare base and head exactly as they are (`base..head`) instead of from where they forked. */
  direct?: boolean;
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
  warn?: (msg: string) => void;
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
  if ((req.working || req.staged) && req.pr !== undefined) throw new UsageError(`--pr cannot be combined with --${req.working ? 'working' : 'staged'}.`);
  if (req.pr !== undefined && req.arg) throw new UsageError(`--pr cannot be combined with a range argument (${req.arg}).`);
  const flagged = req.base !== undefined || req.head !== undefined;
  if ((req.working || req.staged) && flagged) throw new UsageError(`--base and --head cannot be combined with --${req.working ? 'working' : 'staged'}.`);
  if (req.direct && !flagged) throw new UsageError('--direct needs --base or --head: it compares those two commits exactly as they are.');

  if (req.staged) return { source: { kind: 'working', headSha, staged: true, resolvedBy: 'explicit' }, branch };
  if (req.working) return { source: { kind: 'working', headSha, staged: false, resolvedBy: 'explicit' }, branch };

  const named = req.pr !== undefined ? requirePullRequestArg(req.pr) : req.arg ? await pullRequestForArg(req.arg, opts) : null;
  if (named) {
    if (req.head !== undefined) {
      throw new UsageError('--head cannot be combined with a pull request: the pull request is the head.', 'Use --base to compare the pull request against something other than its own base.');
    }
    return pullRequestRange(named, branch, req, opts);
  }

  if (flagged) {
    if (req.arg) throw new UsageError(`Give either a range (${req.arg}) or --base/--head, not both.`);
    return { source: await flaggedRange(req, opts), branch };
  }

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

/**
 * Whether a range argument names a pull request. `#12` and PR URLs always do. A bare `12` does too,
 * unless a local branch or tag is called exactly `12`: that name is something the user made here and it
 * is what `bb 12` meant before pull requests could be named, so it wins, with a note on how to get the PR.
 * (An all-digit abbreviated commit sha is not a name and does not win; `--base 1234567` reaches it.)
 */
export async function pullRequestForArg(arg: string, opts: Pick<ResolveOptions, 'cwd' | 'warn'>): Promise<PullRequestRef | null> {
  const pr = parsePullRequestArg(arg);
  if (!pr || !isBareNumber(arg)) return pr;
  const shadow = await localRefNamed(arg, opts.cwd);
  if (!shadow) return pr;
  opts.warn?.(`${arg} is a local ${shadow} here, so that is what is being toured. For pull request #${arg}, use \`bb --pr ${arg}\` or \`bb '#${arg}'\`.`);
  return null;
}

async function pullRequestRange(ref: PullRequestRef, branch: string | null, req: RangeRequest, opts: ResolveOptions): Promise<ResolvedRange> {
  const pr = await resolvePullRequest(ref, { cwd: opts.cwd, codehost: opts.codehost, base: req.base, debug: opts.debug, warn: opts.warn });
  const source = req.direct
    ? directRange(pr.baseSha, pr.baseLabel, pr.headSha, pr.headLabel, pr.resolvedBy)
    : await rangeAtMergeBase(pr.baseSha, pr.headSha, pr.headLabel, pr.resolvedBy, opts.cwd, pr.baseLabel);
  const resolved: ResolvedRange = { source, branch };
  if (pr.pullRequest) resolved.pullRequest = pr.pullRequest;
  return resolved;
}

/** `--base A [--head B] [--direct]`: the same comparisons as `A...B` and `A..B`, without the dots. */
async function flaggedRange(req: RangeRequest, opts: ResolveOptions): Promise<TourSource> {
  const { cwd } = opts;
  const head = req.head ?? 'HEAD';
  const headSha = await requireRef(head, cwd);
  let base = req.base;
  let resolvedBy: RangeResolvedBy = 'explicit';
  if (base === undefined) {
    const detected = await detectDefaultBranch(opts.defaultBranch, cwd);
    if (!detected) throw new UsageError(`Could not find a default branch to compare ${head} against.`, 'Say what to compare against with --base <ref>.');
    opts.debug?.(`--head without --base: comparing against the default branch ${detected}`);
    base = detected;
    resolvedBy = 'default-branch';
  }
  if (req.direct) return directRange(await requireRef(base, cwd), base, headSha, head, resolvedBy);
  try {
    return await rangeAtMergeBase(base, headSha, head, resolvedBy, cwd);
  } catch (err) {
    // The dotted "did you mean" would send someone who chose flags back to range syntax.
    if (err instanceof NoChangesError && req.base !== undefined) {
      throw new NoChangesError(err.message, `Every commit of ${head} is already in ${base}. If they are the wrong way round, try \`--base ${head} --head ${base}\`.`);
    }
    throw err;
  }
}

/** Two commits compared exactly as they are (two-dot semantics). */
function directRange(baseSha: string, base: string, headSha: string, head: string, resolvedBy: RangeResolvedBy): TourSource {
  if (baseSha === headSha) throw new NoChangesError(`${base} and ${head} point at the same commit.`);
  return { kind: 'range', base, head, baseSha, headSha, resolvedBy };
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
    return directRange(await requireRef(base, cwd), base, await requireRef(head, cwd), head, 'explicit');
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
  resolvedBy: RangeResolvedBy,
  cwd: string,
  /** What to call the base when `base` is a sha rather than something the user typed. */
  baseLabel: string = base,
): Promise<TourSource> {
  const baseTip = await requireRef(base, cwd);
  const mb = (await mergeBase(baseTip, headSha, cwd)) ?? baseTip;
  if (mb === headSha) {
    // The "did you mean" only helps when both labels are refs the user could type back.
    const typed = baseLabel === base && base !== headLabel;
    throw new NoChangesError(`${headLabel} has no commits on top of ${baseLabel}.`, typed ? `Did you mean \`bb ${base}..${headLabel}\`?` : undefined);
  }
  const source: TourSource = { kind: 'range', base: baseLabel, head: headLabel, baseSha: mb, headSha, resolvedBy };
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
