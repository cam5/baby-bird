import type { CodeHost, PullRequestLookup } from '../codehost/provider.js';
import { GitError, PullRequestError, UsageError } from '../core/errors.js';
import type { PullRequestInfo } from '../core/types.js';
import { git } from './exec.js';

/** A pull request as the user named it: a number, optionally with the repository a URL spelled out. */
export interface PullRequestRef {
  number: number;
  host?: string;
  owner?: string;
  repo?: string;
}

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
}

export interface ResolvedPullRequest {
  number: number;
  /** Name of the git remote both ends were read from. */
  remote: string;
  /** Tip of the base branch (not yet the merge-base). */
  baseSha: string;
  headSha: string;
  baseLabel: string;
  headLabel: string;
  resolvedBy: 'pull-request-remote' | 'pull-request-test-merge';
  /** Present when the code host answered. */
  pullRequest?: PullRequestInfo;
}

export interface ResolvePullRequestOptions {
  cwd: string;
  codehost: CodeHost;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
}

const PR_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)(?:[/?#]\S*)?$/;

/** `12`, `#12`, or a pull request URL (anything after the number, such as `/files`, is ignored). */
export function parsePullRequestArg(arg: string): PullRequestRef | null {
  const plain = /^#?([1-9]\d*)$/.exec(arg);
  if (plain) return { number: Number(plain[1]) };
  const url = PR_URL.exec(arg);
  if (url) return { number: Number(url[4]), host: url[1]!.toLowerCase(), owner: url[2]!, repo: url[3]!.replace(/\.git$/, '') };
  return null;
}

/** True for a bare number such as `12`: the one spelling that could also be a ref name. */
export function isBareNumber(arg: string): boolean {
  return /^[1-9]\d*$/.test(arg);
}

/** A local branch or tag named exactly `name`, which is what a bare number has always meant to bb. */
export async function localRefNamed(name: string, cwd: string): Promise<'branch' | 'tag' | null> {
  for (const [kind, prefix] of [['branch', 'refs/heads/'], ['tag', 'refs/tags/']] as const) {
    const res = await git(['show-ref', '--verify', '--quiet', `${prefix}${name}`], { cwd, allowFailure: true });
    if (res.code === 0) return kind;
  }
  return null;
}

/** Host, owner and repository of a remote URL (https, ssh or scp-like); null for anything else, such as a local path. */
export function parseRemoteUrl(url: string): RemoteRepo | null {
  const trimmed = url.trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed) ?? /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  if (!m) return null;
  const parts = m[2]!.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return { host: m[1]!.toLowerCase(), owner: parts[0]!, repo: parts[1]! };
}

interface Remote {
  name: string;
  url: string;
  repo: RemoteRepo | null;
}

async function listRemotes(cwd: string): Promise<Remote[]> {
  const names = (await git(['remote'], { cwd })).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const remotes: Remote[] = [];
  for (const name of names) {
    const res = await git(['remote', 'get-url', name], { cwd, allowFailure: true });
    const url = res.code === 0 ? res.stdout.trim() : '';
    remotes.push({ name, url, repo: parseRemoteUrl(url) });
  }
  return remotes;
}

/**
 * Which remote a pull request lives on. A URL names its repository, so the remote pointing there is used.
 * A number means `origin`, or else the only remote, or else `upstream`.
 */
async function pickRemote(ref: PullRequestRef, cwd: string): Promise<Remote> {
  const remotes = await listRemotes(cwd);
  if (remotes.length === 0) {
    throw new PullRequestError('This repository has no remotes, so there is nowhere to read a pull request from.', 'Pull requests are fetched from the remote; add one with `git remote add origin <url>`.');
  }
  if (ref.owner && ref.repo) {
    const same = (r: Remote) => r.repo !== null && r.repo.owner.toLowerCase() === ref.owner!.toLowerCase() && r.repo.repo.toLowerCase() === ref.repo!.toLowerCase();
    const match = remotes.find((r) => same(r) && r.repo!.host === ref.host) ?? remotes.find(same);
    if (!match) {
      throw new PullRequestError(
        `No remote of this repository points at ${ref.owner}/${ref.repo}.`,
        `Its remotes: ${remotes.map((r) => `${r.name} (${r.url})`).join(', ')}. Run bb inside a clone of ${ref.owner}/${ref.repo}, or pass -C <dir>.`,
      );
    }
    return match;
  }
  const pick = remotes.find((r) => r.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : remotes.find((r) => r.name === 'upstream'));
  if (!pick) {
    throw new PullRequestError(
      `Can't tell which remote pull request #${ref.number} is on: there is no \`origin\` among ${remotes.map((r) => r.name).join(', ')}.`,
      'Pass the pull request URL instead of its number.',
    );
  }
  return pick;
}

// Network calls must fail instead of waiting on a credential prompt nobody can see.
const NETWORK_ENV = { GIT_TERMINAL_PROMPT: '0' };
const LS_REMOTE_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;

function firstLines(text: string, n = 3): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).join(' / ');
}

async function hasCommit(sha: string, cwd: string): Promise<boolean> {
  return (await git(['cat-file', '-e', `${sha}^{commit}`], { cwd, allowFailure: true })).code === 0;
}

/** A commit bb needs, and what to ask the remote for (a ref name, or the sha itself) to get it. */
interface Wanted {
  sha: string;
  from: string;
}

/** Fetch whichever of the wanted commits are not here yet; no network at all when they all are. */
async function ensureCommits(remote: Remote, wanted: Wanted[], cwd: string, debug: (msg: string) => void): Promise<void> {
  const missing: Wanted[] = [];
  for (const w of wanted) if (!(await hasCommit(w.sha, cwd))) missing.push(w);
  if (missing.length === 0) {
    debug(`already have ${wanted.map((w) => w.sha.slice(0, 7)).join(', ')}; no fetch needed`);
    return;
  }
  const what = missing.map((w) => w.from);
  debug(`git fetch ${remote.name} ${what.join(' ')}`);
  const res = await git(['fetch', '--quiet', '--no-tags', remote.name, ...what], { cwd, allowFailure: true, env: NETWORK_ENV, timeoutMs: FETCH_TIMEOUT_MS });
  if (res.code !== 0) throw new GitError(`Could not fetch ${what.join(' ')} from ${remote.name}: ${firstLines(res.stderr) || `exit code ${res.code}`}`);
  for (const w of missing) {
    if (!(await hasCommit(w.sha, cwd))) {
      throw new GitError(`Fetched ${what.join(' ')} from ${remote.name}, but commit ${w.sha.slice(0, 12)} is still missing.`, { hint: 'The pull request may have been pushed to while bb was reading it; try again.' });
    }
  }
}

function describeFailure(lookup: Extract<PullRequestLookup, { ok: false }>, slug: string | undefined): string {
  switch (lookup.reason) {
    case 'disabled':
      return lookup.detail;
    case 'not-installed':
      return 'the gh CLI is not installed';
    case 'not-authenticated':
      return `gh is not logged in (${lookup.detail})`;
    case 'no-access':
      return `the account gh is using cannot see ${slug ?? 'this repository'} (${lookup.detail})`;
    case 'no-such-pr':
      return `gh found no such pull request (${lookup.detail})`;
    case 'timeout':
      return lookup.detail;
    case 'other':
      return `gh failed (${lookup.detail})`;
  }
}

function adviceFor(lookup: Extract<PullRequestLookup, { ok: false }>, number: number): string {
  switch (lookup.reason) {
    case 'disabled':
      return 'Set codehost.provider to "gh" (config, or BB_CODEHOST=gh for one run) so bb can ask GitHub.';
    case 'not-installed':
      return 'Install gh (https://cli.github.com) and run `gh auth login`.';
    case 'timeout':
      return 'Try again, or check `gh auth status`.';
    default:
      return `Run \`gh auth status\` to see which account gh is using. If it is the wrong one, pass a token for this run: GH_TOKEN=$(gh auth token --user <account>) bb ${number}`;
  }
}

/**
 * Turn "pull request N" into two commits, both as they are on the remote right now.
 *
 * Plain git over the repository's own remote does everything it can: `git ls-remote` finds the head
 * (`refs/pull/N/head`) and the branch tips, and `git fetch` brings in whatever is not here yet. Only the
 * name of the base branch needs the code host. When the code host cannot answer, the base is read off
 * GitHub's test merge (`refs/pull/N/merge`, whose first parent is the base) if there is an up-to-date one.
 *
 * Nothing is checked out and no branch is created. Fetching the base branch can move its
 * remote-tracking ref (`origin/<base>`) forward, as any `git fetch` of that branch would.
 */
export async function resolvePullRequest(ref: PullRequestRef, opts: ResolvePullRequestOptions): Promise<ResolvedPullRequest> {
  const debug = opts.debug ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const { cwd } = opts;
  const n = ref.number;
  const remote = await pickRemote(ref, cwd);
  debug(`pull request #${n}: reading from remote ${remote.name} (${remote.url})`);

  // A dotted host is a real one gh can be told about; anything else (an ssh alias, a local path) is left to gh to work out.
  const known = ref.owner && ref.repo && ref.host ? { host: ref.host, owner: ref.owner, repo: ref.repo } : remote.repo;
  const slug = known && known.host.includes('.') ? `${known.host}/${known.owner}/${known.repo}` : undefined;
  const shortSlug = known ? `${known.owner}/${known.repo}` : undefined;

  const headRef = `refs/pull/${n}/head`;
  const mergeRef = `refs/pull/${n}/merge`;
  const [lookupRaw, ls] = await Promise.all([
    opts.codehost.pullRequest
      ? opts.codehost.pullRequest(n, cwd, slug)
      : Promise.resolve<PullRequestLookup>({ ok: false, reason: 'disabled', detail: `the ${opts.codehost.name} code host cannot look pull requests up by number` }),
    git(['ls-remote', remote.name, headRef, mergeRef, 'refs/heads/*'], { cwd, allowFailure: true, env: NETWORK_ENV, timeoutMs: LS_REMOTE_TIMEOUT_MS }),
  ]);
  if (ls.code !== 0) {
    throw new GitError(`Could not read ${remote.name} (${remote.url}): ${firstLines(ls.stderr) || `exit code ${ls.code}`}`, {
      hint: `bb reads pull requests with plain git over this remote; check that \`git ls-remote ${remote.name}\` works.`,
    });
  }
  const refs = new Map<string, string>();
  for (const line of ls.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) refs.set(line.slice(tab + 1).trim(), line.slice(0, tab));
  }
  const headSha = refs.get(headRef);
  if (!headSha) {
    throw new PullRequestError(
      `There is no pull request #${n} on ${remote.name} (${remote.url}).`,
      `bb looked for ${headRef}, which GitHub publishes for every pull request.`,
    );
  }

  let lookup = lookupRaw;
  if (lookup.ok && lookup.pr.headRefOid && lookup.pr.headRefOid !== headSha) {
    lookup = {
      ok: false,
      reason: 'other',
      detail: `it describes a pull request whose head is ${lookup.pr.headRefOid.slice(0, 7)}, but ${remote.name} has ${headSha.slice(0, 7)} at ${headRef}; gh may be looking at a different repository`,
    };
  }

  const headLabel = `PR #${n}`;

  if (lookup.ok) {
    const pr = lookup.pr;
    if (!pr.baseRefName) throw new PullRequestError(`gh did not say which branch pull request #${n} targets.`);
    const baseRef = `refs/heads/${pr.baseRefName}`;
    const branchTip = refs.get(baseRef);
    const open = pr.state === undefined || pr.state === 'OPEN';
    const baseLabel = `${remote.name}/${pr.baseRefName}`;
    let baseSha: string;
    let baseFetch: string;
    if (branchTip && (open || !pr.baseRefOid)) {
      baseSha = branchTip;
      baseFetch = baseRef;
    } else if (pr.baseRefOid) {
      // Merged or closed (or the base branch is gone): the branch as it is now may already contain the PR,
      // so use the base GitHub recorded for it.
      debug(`pull request #${n} is ${pr.state ?? 'open'}${branchTip ? '' : ` and ${baseLabel} no longer exists`}; using the base commit GitHub recorded (${pr.baseRefOid.slice(0, 7)})`);
      baseSha = pr.baseRefOid;
      baseFetch = pr.baseRefOid;
    } else {
      throw new PullRequestError(`Pull request #${n} targets ${pr.baseRefName}, but ${remote.name} has no such branch.`);
    }
    debug(`pull request #${n} (${pr.state ?? 'state unknown'}): ${pr.headRefName || headRef} ${headSha.slice(0, 7)} into ${pr.baseRefName} ${baseSha.slice(0, 7)}`);
    await ensureCommits(remote, [{ sha: headSha, from: headRef }, { sha: baseSha, from: baseFetch }], cwd, debug);
    return { number: n, remote: remote.name, baseSha, headSha, baseLabel, headLabel, resolvedBy: 'pull-request-remote', pullRequest: pr };
  }

  // The code host could not answer. The head is still plain git; try to read the base off the test merge.
  const problem = describeFailure(lookup, shortSlug);
  debug(`no pull request details: ${problem}`);
  await ensureCommits(remote, [{ sha: headSha, from: headRef }], cwd, debug);

  const mergeSha = refs.get(mergeRef);
  if (mergeSha) {
    await ensureCommits(remote, [{ sha: mergeSha, from: mergeRef }], cwd, debug);
    const parents = await git(['rev-parse', '--quiet', `${mergeSha}^1`, `${mergeSha}^2`], { cwd, allowFailure: true });
    const [first, second] = parents.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (parents.code === 0 && first && second === headSha) {
      const branches = [...refs].filter(([name, sha]) => name.startsWith('refs/heads/') && sha === first).map(([name]) => name.slice('refs/heads/'.length));
      const baseLabel = branches.length > 0 ? `${remote.name}/${branches[0]}` : first.slice(0, 7);
      debug(`test merge ${mergeSha.slice(0, 7)} joins ${first.slice(0, 7)} (${branches.join(', ') || 'no branch is at this commit now'}) and ${headSha.slice(0, 7)}`);
      const note = `the base (${baseLabel}) was read from GitHub's test merge instead, and the PR's title and description are not in the prompt.`;
      if (lookup.reason === 'disabled') debug(`${problem}; ${note}`);
      else warn(`Could not ask GitHub about pull request #${n}: ${problem}. So ${note}`);
      return { number: n, remote: remote.name, baseSha: first, headSha, baseLabel, headLabel, resolvedBy: 'pull-request-test-merge' };
    }
    debug(`test merge ${mergeSha.slice(0, 7)} is not a merge of the current head ${headSha.slice(0, 7)}; ignoring it`);
  } else {
    debug(`${remote.name} has no ${mergeRef} (the pull request is closed, conflicted, or not on GitHub)`);
  }

  throw new PullRequestError(
    `Could not work out which branch pull request #${n} targets: ${problem}.`,
    [
      `Its commits came from ${remote.name} over plain git, but the base branch is only known to GitHub's API.`,
      adviceFor(lookup, n),
      `Or name the base yourself with a range: bb <base-branch>...${headSha.slice(0, 7)}`,
    ].join('\n'),
  );
}

/** Reject `--pr` values that are not a number or a URL. */
export function requirePullRequestArg(value: string): PullRequestRef {
  const ref = parsePullRequestArg(value);
  if (!ref) throw new UsageError(`Not a pull request: ${value}`, 'Give a number (12), #12, or a pull request URL.');
  return ref;
}
