import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitAskArgs } from '../../src/cli/ask-cmd.js';
import { NoCodeHost } from '../../src/codehost/none.js';
import type { CodeHost, PullRequestLookup } from '../../src/codehost/provider.js';
import { NoChangesError, PullRequestError, UsageError } from '../../src/core/errors.js';
import type { PullRequestInfo } from '../../src/core/types.js';
import { collectCommits, collectDiff } from '../../src/git/diff.js';
import { resolveRange } from '../../src/git/range.js';
import { TempRepo } from '../helpers/repo.js';

/**
 * A "GitHub" with a stack: main <- part-1 (PR #1) <- part-2 (PR #2), published the way GitHub does it
 * (refs/pull/N/head, and refs/pull/N/merge whose parents are the base and the head), plus a clone
 * that has only ever seen main.
 */
async function stack() {
  const remote = await TempRepo.create();
  const mainSha = await remote.commit('init', { 'a.txt': 'one\n' });
  remote.git('checkout', '-q', '-b', 'part-1');
  const part1 = await remote.commit('part 1', { 'p1.txt': 'p1\n' });
  remote.git('checkout', '-q', '-b', 'part-2');
  const part2 = await remote.commit('part 2', { 'p2.txt': 'p2\n' });
  remote.git('checkout', '-q', 'main');
  remote.git('update-ref', 'refs/pull/1/head', part1);
  remote.git('update-ref', 'refs/pull/2/head', part2);
  const testMerge = (base: string, head: string) => remote.git('commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'test merge').trim();
  remote.git('update-ref', 'refs/pull/1/merge', testMerge(mainSha, part1));
  remote.git('update-ref', 'refs/pull/2/merge', testMerge(part1, part2));

  const dir = await mkdtemp(join(tmpdir(), 'bb-clone-'));
  remote.git('clone', '-q', '--single-branch', '--branch', 'main', remote.dir, dir);
  const clone = TempRepo.at(dir);
  return { remote, clone, mainSha, part1, part2, testMerge };
}

const pr2 = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 2,
  title: 'Part 2',
  body: 'Stack 2 of 2',
  url: 'https://example.test/o/r/pull/2',
  baseRefName: 'part-1',
  headRefName: 'part-2',
  state: 'OPEN',
  ...over,
});

function host(lookup: PullRequestLookup, calls: Array<{ number: number; repo?: string }> = []): CodeHost {
  return {
    name: 'fake',
    currentPullRequest: async () => null,
    pullRequest: async (number, _cwd, repo) => {
      calls.push({ number, repo });
      return lookup;
    },
  };
}

const noAccess: PullRequestLookup = { ok: false, reason: 'no-access', detail: "GraphQL: Could not resolve to a Repository with the name 'o/r'." };

function opts(repo: TempRepo, codehost: CodeHost, sink: { warnings?: string[]; debug?: string[] } = {}) {
  return {
    cwd: repo.dir,
    exclude: [],
    defaultBranch: null,
    codehost,
    warn: (m: string) => sink.warnings?.push(m),
    debug: (m: string) => sink.debug?.push(m),
  };
}

describe('resolveRange for a pull request number', () => {
  it('diffs the PR base against its head as they are on the remote, with neither branch local', async () => {
    const { clone, part1, part2 } = await stack();
    expect(clone.git('branch', '--format=%(refname:short)').trim()).toBe('main');
    const calls: Array<{ number: number; repo?: string }> = [];
    const pr = pr2({ headRefOid: part2 });

    const r = await resolveRange({ arg: '2' }, opts(clone, host({ ok: true, pr }, calls)));
    expect(r.source).toEqual({ kind: 'range', base: 'origin/part-1', head: 'PR #2', baseSha: part1, headSha: part2, resolvedBy: 'pull-request-remote' });
    expect(r.pullRequest).toBe(pr);
    // A local-path remote has no owner/repo to hand the code host.
    expect(calls).toEqual([{ number: 2, repo: undefined }]);

    // Only the stacked PR's own change, not the one below it.
    const diff = await collectDiff(r.source, { cwd: clone.dir, exclude: [] });
    expect(diff.files.map((f) => f.path)).toEqual(['p2.txt']);
    expect((await collectCommits(r.source, clone.dir)).map((c) => c.subject)).toEqual(['part 2']);

    // Nothing was checked out and no local branch appeared.
    expect(clone.git('branch', '--format=%(refname:short)').trim()).toBe('main');
    expect(clone.git('status', '--porcelain')).toBe('');
  });

  it('takes #N and --pr the same way, and uses the remote base tip rather than a stale local one', async () => {
    const { remote, clone, part1, part2 } = await stack();
    // The base moves on the remote; this clone has never fetched part-1 at all.
    remote.git('checkout', '-q', 'part-1');
    const moved = await remote.commit('part 1, amended upstream', { 'p1.txt': 'p1 again\n' });
    remote.git('checkout', '-q', 'main');

    const h = host({ ok: true, pr: pr2() });
    const hash = await resolveRange({ arg: '#2' }, opts(clone, h));
    // part-2 forked from the old part-1, so the diff starts at their merge-base, as on the PR page.
    expect(hash.source).toEqual({ kind: 'range', base: 'origin/part-1', head: 'PR #2', baseSha: part1, headSha: part2, mergeBase: part1, resolvedBy: 'pull-request-remote' });
    // The remote's current tip was what got fetched and compared.
    expect(clone.git('cat-file', '-t', moved).trim()).toBe('commit');
    expect((await resolveRange({ pr: '2' }, opts(clone, h))).source).toEqual(hash.source);
  });

  it('needs a remote that points at the repository a PR URL names', async () => {
    const { clone } = await stack();
    const calls: Array<{ number: number; repo?: string }> = [];
    const err = await resolveRange({ arg: 'https://github.com/o/r/pull/2/files' }, opts(clone, host({ ok: true, pr: pr2() }, calls))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRequestError);
    expect((err as PullRequestError).message).toBe('No remote of this repository points at o/r.');
    expect((err as PullRequestError).hint).toMatch(/Its remotes: origin \(/);
    expect(calls).toEqual([]);
  });

  it("reads the base off GitHub's test merge when the code host cannot answer", async () => {
    const { clone, part1, part2 } = await stack();
    const sink = { warnings: [] as string[] };
    const r = await resolveRange({ arg: '2' }, opts(clone, host(noAccess), sink));
    expect(r.source).toEqual({ kind: 'range', base: 'origin/part-1', head: 'PR #2', baseSha: part1, headSha: part2, resolvedBy: 'pull-request-test-merge' });
    expect(r.pullRequest).toBeUndefined();
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toMatch(/Could not ask GitHub about pull request #2: the account gh is using cannot see this repository/);
    expect(sink.warnings[0]).toMatch(/base \(origin\/part-1\) was read from GitHub's test merge/);

    // With the code host turned off this is the expected path, so it is not worth a warning.
    const quiet = { warnings: [] as string[] };
    const off = await resolveRange({ arg: '2' }, opts(clone, new NoCodeHost(), quiet));
    expect(off.source).toEqual(r.source);
    expect(quiet.warnings).toEqual([]);
  });

  it('says what to do when neither the code host nor a test merge gives the base', async () => {
    const { remote, clone, part2 } = await stack();
    remote.git('update-ref', '-d', 'refs/pull/2/merge');
    const err = await resolveRange({ arg: '2' }, opts(clone, host(noAccess))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRequestError);
    const e = err as PullRequestError;
    expect(e.exitCode).toBe(3);
    expect(e.message).toMatch(/Could not work out which branch pull request #2 targets: the account gh is using cannot see/);
    expect(e.hint).toMatch(/gh auth status/);
    expect(e.hint).toMatch(/GH_TOKEN=\$\(gh auth token --user <account>\) bb 2/);
    expect(e.hint).toContain('Or name the base yourself: bb 2 --base <branch>');
    // The head was still fetched, so that needs no second trip for it.
    expect(clone.git('cat-file', '-t', part2).trim()).toBe('commit');

    const missing = await resolveRange({ arg: '2' }, opts(clone, host({ ok: false, reason: 'not-installed', detail: 'gh is not installed' }))).catch((x: unknown) => x);
    expect((missing as PullRequestError).hint).toMatch(/Install gh/);
  });

  it('ignores a test merge that is not of the current head', async () => {
    const { remote, clone, mainSha, part1, testMerge } = await stack();
    remote.git('update-ref', 'refs/pull/2/merge', testMerge(mainSha, part1));
    await expect(resolveRange({ arg: '2' }, opts(clone, host(noAccess)))).rejects.toThrow(/Could not work out which branch/);
  });

  it('distrusts a code host that describes a different head commit', async () => {
    const { clone, part1 } = await stack();
    const sink = { warnings: [] as string[] };
    const r = await resolveRange({ arg: '2' }, opts(clone, host({ ok: true, pr: pr2({ baseRefName: 'main', headRefOid: part1 }) }), sink));
    expect(r.source).toMatchObject({ base: 'origin/part-1', resolvedBy: 'pull-request-test-merge' });
    expect(sink.warnings[0]).toMatch(/gh may be looking at a different repository/);
  });

  it('uses the recorded base for a merged pull request', async () => {
    const { remote, clone, mainSha, part1 } = await stack();
    // PR #1 is merged into main and its branch deleted; main now contains the head.
    remote.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'part-1');
    remote.git('update-ref', '-d', 'refs/pull/1/merge');
    const pr: PullRequestInfo = { number: 1, title: 'Part 1', body: '', url: 'u', baseRefName: 'main', headRefName: 'part-1', state: 'MERGED', baseRefOid: mainSha, headRefOid: part1 };
    const r = await resolveRange({ arg: '1' }, opts(clone, host({ ok: true, pr })));
    expect(r.source).toEqual({ kind: 'range', base: 'origin/main', head: 'PR #1', baseSha: mainSha, headSha: part1, resolvedBy: 'pull-request-remote' });

    // Without the recorded base, the branch as it is now already contains the PR.
    const { baseRefOid: _dropped, ...withoutOid } = pr;
    await expect(resolveRange({ arg: '1' }, opts(clone, host({ ok: true, pr: withoutOid })))).rejects.toThrow(NoChangesError);
  });

  it('reports a number that is not a pull request, and a repository with no remote', async () => {
    const { clone } = await stack();
    await expect(resolveRange({ arg: '9' }, opts(clone, host(noAccess)))).rejects.toThrow(/There is no pull request #9 on origin/);
    const lone = await TempRepo.create();
    await lone.commit('init', { 'a.txt': 'one\n' });
    await expect(resolveRange({ arg: '9' }, opts(lone, host(noAccess)))).rejects.toThrow(/has no remotes/);
  });

  it('lets a local branch or tag with that exact name win over a bare number, and says so', async () => {
    const { clone, mainSha, part1, part2 } = await stack();
    clone.git('checkout', '-q', '-b', 'work');
    const work = await clone.commit('work', { 'w.txt': 'w\n' });
    clone.git('branch', '2', mainSha);
    const sink = { warnings: [] as string[] };
    const h = host({ ok: true, pr: pr2() });

    const asRef = await resolveRange({ arg: '2' }, opts(clone, h, sink));
    expect(asRef.source).toMatchObject({ kind: 'range', base: '2', head: 'HEAD', baseSha: mainSha, headSha: work, resolvedBy: 'explicit' });
    expect(sink.warnings).toEqual(["2 is a local branch here, so that is what is being toured. For pull request #2, use `bb --pr 2` or `bb '#2'`."]);

    for (const req of [{ arg: '#2' }, { pr: '2' }, { pr: '#2' }]) {
      expect((await resolveRange(req, opts(clone, h))).source).toMatchObject({ base: 'origin/part-1', baseSha: part1, headSha: part2, resolvedBy: 'pull-request-remote' });
    }

    clone.git('branch', '-D', '2');
    clone.git('tag', '2', mainSha);
    sink.warnings.length = 0;
    expect((await resolveRange({ arg: '2' }, opts(clone, h, sink))).source).toMatchObject({ base: '2', resolvedBy: 'explicit' });
    expect(sink.warnings[0]).toMatch(/^2 is a local tag here/);
  });

  it('--base replaces the pull request\'s own base, read fresh from the remote', async () => {
    const { remote, clone, mainSha, part1, part2 } = await stack();
    const sink = { warnings: [] as string[] };
    const own = pr2({ headRefOid: part2 });

    // The whole stack up to PR #2, against main. The PR's own description would no longer fit.
    const whole = await resolveRange({ arg: '2', base: 'main' }, opts(clone, host({ ok: true, pr: own }), sink));
    expect(whole.source).toEqual({ kind: 'range', base: 'origin/main', head: 'PR #2', baseSha: mainSha, headSha: part2, resolvedBy: 'pull-request-remote' });
    expect(whole.pullRequest).toBeUndefined();
    const diff = await collectDiff(whole.source, { cwd: clone.dir, exclude: [] });
    expect(diff.files.map((f) => f.path)).toEqual(['p1.txt', 'p2.txt']);

    // Naming the PR's real base keeps its title and description; origin/<name> means the same branch.
    const same = await resolveRange({ pr: '2', base: 'origin/part-1' }, opts(clone, host({ ok: true, pr: own }), sink));
    expect(same.source).toMatchObject({ base: 'origin/part-1', baseSha: part1, resolvedBy: 'pull-request-remote' });
    expect(same.pullRequest).toBe(own);

    // The way out when the code host cannot say what the base is: no warning, no test merge needed.
    remote.git('update-ref', '-d', 'refs/pull/2/merge');
    const manual = await resolveRange({ arg: '2', base: 'part-1' }, opts(clone, host(noAccess), sink));
    expect(manual.source).toEqual({ kind: 'range', base: 'origin/part-1', head: 'PR #2', baseSha: part1, headSha: part2, resolvedBy: 'pull-request-remote' });
    expect(sink.warnings).toEqual([]);

    // Not a branch on the remote: any local ref will do.
    clone.git('tag', 'v0', mainSha);
    const local = await resolveRange({ arg: '2', base: 'v0' }, opts(clone, host(noAccess)));
    expect(local.source).toEqual({ kind: 'range', base: 'v0', head: 'PR #2', baseSha: mainSha, headSha: part2, resolvedBy: 'explicit' });
    await expect(resolveRange({ arg: '2', base: 'nope' }, opts(clone, host(noAccess)))).rejects.toThrow(/Unknown base: nope is neither a branch on origin nor a ref in this repository/);
  });

  it('--direct compares a pull request with the base tip as it is, and --head is refused', async () => {
    const { remote, clone, part2 } = await stack();
    remote.git('checkout', '-q', 'part-1');
    const moved = await remote.commit('part 1 moves on', { 'p1.txt': 'p1 again\n' });
    remote.git('checkout', '-q', 'main');
    const h = host({ ok: true, pr: pr2() });
    const direct = await resolveRange({ arg: '2', direct: true, base: 'part-1' }, opts(clone, h));
    expect(direct.source).toEqual({ kind: 'range', base: 'origin/part-1', head: 'PR #2', baseSha: moved, headSha: part2, resolvedBy: 'pull-request-remote' });
    await expect(resolveRange({ arg: '2', head: 'main' }, opts(clone, h))).rejects.toThrow(/--head cannot be combined with a pull request/);
    await expect(resolveRange({ pr: '2', head: 'main' }, opts(clone, h))).rejects.toThrow(UsageError);
  });

  it('rejects contradictory requests', async () => {
    const { clone } = await stack();
    const o = opts(clone, host(noAccess));
    await expect(resolveRange({ pr: '2', arg: 'main' }, o)).rejects.toThrow(UsageError);
    await expect(resolveRange({ pr: '2', staged: true }, o)).rejects.toThrow(/--pr cannot be combined with --staged/);
    await expect(resolveRange({ pr: 'main' }, o)).rejects.toThrow(/Not a pull request: main/);
  });
});

describe('splitAskArgs with pull requests', () => {
  it('takes a leading number, #number or PR URL as the range', async () => {
    const { clone } = await stack();
    const o = { cwd: clone.dir, rangeAllowed: true };
    expect(await splitAskArgs(['2', 'what', 'changed?'], o)).toEqual({ range: '2', message: 'what changed?' });
    expect(await splitAskArgs(['#2'], o)).toEqual({ range: '#2', message: undefined });
    expect(await splitAskArgs(['https://github.com/o/r/pull/2', 'why?'], o)).toEqual({ range: 'https://github.com/o/r/pull/2', message: 'why?' });
    expect(await splitAskArgs(['2nd', 'question'], o)).toEqual({ message: '2nd question' });
    expect(await splitAskArgs(['2', 'things'], { ...o, rangeAllowed: false })).toEqual({ message: '2 things' });
  });
});
