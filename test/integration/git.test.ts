import { describe, expect, it } from 'vitest';
import { NoCodeHost } from '../../src/codehost/none.js';
import type { CodeHost } from '../../src/codehost/provider.js';
import { NoChangesError, UsageError } from '../../src/core/errors.js';
import type { PullRequestInfo } from '../../src/core/types.js';
import { collectCommits, collectDiff } from '../../src/git/diff.js';
import { gitRoot } from '../../src/git/exec.js';
import { resolveRange } from '../../src/git/range.js';
import { TempRepo } from '../helpers/repo.js';

const none = new NoCodeHost();
const opts = (repo: TempRepo, extra: Partial<Parameters<typeof resolveRange>[1]> = {}) => ({
  cwd: repo.dir,
  exclude: ['**/*.lock'],
  defaultBranch: null,
  codehost: none as CodeHost,
  ...extra,
});

async function featureRepo(): Promise<{ repo: TempRepo; mainSha: string; featSha: string }> {
  const repo = await TempRepo.create();
  await repo.commit('init', { 'a.txt': 'one\n', 'b.txt': 'b\n' });
  const mainSha = await repo.commit('main second', { 'a.txt': 'one\ntwo\n' });
  repo.git('checkout', '-q', '-b', 'feat/x');
  await repo.commit('feat 1', { 'c.txt': 'c\n' });
  const featSha = await repo.commit('feat 2', { 'a.txt': 'one\ntwo\nthree\n' });
  return { repo, mainSha, featSha };
}

describe('gitRoot', () => {
  it('throws outside a repo', async () => {
    await expect(gitRoot('/')).rejects.toThrow(/Not a git repository/);
  });
});

describe('resolveRange explicit forms', () => {
  it('A..B is a plain two-commit range', async () => {
    const { repo, mainSha, featSha } = await featureRepo();
    const r = await resolveRange({ arg: 'main..feat/x' }, opts(repo));
    expect(r.source).toEqual({ kind: 'range', base: 'main', head: 'feat/x', baseSha: mainSha, headSha: featSha, resolvedBy: 'explicit' });
    expect(r.branch).toBe('feat/x');
  });

  it('A...B and bare refs use the merge-base', async () => {
    const { repo, mainSha, featSha } = await featureRepo();
    repo.git('checkout', '-q', 'main');
    await repo.commit('main third', { 'b.txt': 'bb\n' });
    repo.git('checkout', '-q', 'feat/x');
    const three = await resolveRange({ arg: 'main...HEAD' }, opts(repo));
    expect(three.source).toMatchObject({ kind: 'range', baseSha: mainSha, headSha: featSha, mergeBase: mainSha });
    const bare = await resolveRange({ arg: 'main' }, opts(repo));
    expect(bare.source).toMatchObject({ kind: 'range', base: 'main', head: 'HEAD', baseSha: mainSha, mergeBase: mainSha });
    const rel = await resolveRange({ arg: 'HEAD~1' }, opts(repo));
    expect(rel.source).toMatchObject({ kind: 'range', base: 'HEAD~1', headSha: featSha });
  });

  it('--working / --staged and conflicts', async () => {
    const { repo, featSha } = await featureRepo();
    expect((await resolveRange({ working: true }, opts(repo))).source).toEqual({ kind: 'working', headSha: featSha, staged: false, resolvedBy: 'explicit' });
    expect((await resolveRange({ staged: true }, opts(repo))).source).toMatchObject({ kind: 'working', staged: true });
    await expect(resolveRange({ working: true, staged: true }, opts(repo))).rejects.toThrow(UsageError);
    await expect(resolveRange({ arg: 'main', working: true }, opts(repo))).rejects.toThrow(UsageError);
    await expect(resolveRange({ arg: 'nope..HEAD' }, opts(repo))).rejects.toThrow(/Unknown git ref: nope/);
  });

  it('rejects an empty range', async () => {
    const { repo } = await featureRepo();
    await expect(resolveRange({ arg: 'HEAD..HEAD' }, opts(repo))).rejects.toThrow(NoChangesError);
    await expect(resolveRange({ arg: 'feat/x' }, opts(repo))).rejects.toThrow(/no commits on top of/);
  });
});

describe('resolveRange cascade', () => {
  it('prefers a dirty working tree', async () => {
    const { repo, featSha } = await featureRepo();
    await repo.write('scratch.txt', 'wip\n');
    const r = await resolveRange({}, opts(repo));
    expect(r.source).toEqual({ kind: 'working', headSha: featSha, staged: false, resolvedBy: 'dirty-tree' });
  });

  it('ignores excluded files when deciding dirtiness', async () => {
    const { repo, mainSha } = await featureRepo();
    await repo.write('x.lock', 'lock\n');
    const r = await resolveRange({}, opts(repo));
    expect(r.source).toMatchObject({ kind: 'range', baseSha: mainSha, resolvedBy: 'ancestor-branch' });
  });

  it('uses the pull request base when the code host knows one', async () => {
    const { repo, mainSha, featSha } = await featureRepo();
    repo.git('checkout', '-q', '-b', 'release');
    repo.git('checkout', '-q', 'feat/x');
    const pr: PullRequestInfo = { number: 7, title: 'PR', body: 'body', url: 'u', baseRefName: 'main', headRefName: 'feat/x' };
    const host: CodeHost = { name: 'fake', currentPullRequest: async () => pr };
    const r = await resolveRange({}, opts(repo, { codehost: host }));
    expect(r.source).toMatchObject({ kind: 'range', base: 'main', head: 'feat/x', baseSha: mainSha, headSha: featSha, resolvedBy: 'pull-request' });
    expect(r.pullRequest).toBe(pr);
  });

  it('falls back to the nearest ancestor branch, then the default branch', async () => {
    const { repo, mainSha } = await featureRepo();
    // A stacked branch on top of feat/x: nearest ancestor should be feat/x, not main.
    const featSha = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '-q', '-b', 'feat/x-part2');
    await repo.commit('part 2', { 'd.txt': 'd\n' });
    const stacked = await resolveRange({}, opts(repo));
    expect(stacked.source).toMatchObject({ kind: 'range', base: 'feat/x', baseSha: featSha, resolvedBy: 'ancestor-branch' });

    // A descendant branch must not be picked as an ancestor.
    repo.git('checkout', '-q', 'feat/x');
    const back = await resolveRange({}, opts(repo));
    expect(back.source).toMatchObject({ base: 'main', baseSha: mainSha, resolvedBy: 'ancestor-branch' });

    // With no other branches, use the default branch.
    repo.git('branch', '-D', 'feat/x-part2');
    repo.git('branch', '-D', 'main');
    repo.git('checkout', '-q', '-b', 'master', mainSha);
    repo.git('checkout', '-q', 'feat/x');
    repo.git('branch', '-D', 'master');
    repo.git('update-ref', 'refs/remotes/origin/main', mainSha);
    const viaRemote = await resolveRange({}, opts(repo));
    expect(viaRemote.source).toMatchObject({ base: 'origin/main', baseSha: mainSha, resolvedBy: 'default-branch' });
  });

  it('errors on the default branch with a clean tree', async () => {
    const { repo } = await featureRepo();
    repo.git('checkout', '-q', 'main');
    await expect(resolveRange({}, opts(repo))).rejects.toThrow(/nothing to tour/);
  });
});

describe('collectDiff', () => {
  it('collects a range diff and commits', async () => {
    const { repo, mainSha, featSha } = await featureRepo();
    const source = { kind: 'range' as const, base: 'main', head: 'feat/x', baseSha: mainSha, headSha: featSha, resolvedBy: 'explicit' as const };
    const diff = await collectDiff(source, { cwd: repo.dir, exclude: [] });
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([['a.txt', 'modified'], ['c.txt', 'added']]);
    const commits = await collectCommits(source, repo.dir);
    expect(commits.map((c) => c.subject)).toEqual(['feat 2', 'feat 1']);
  });

  it('includes untracked files and honors excludes for the working tree', async () => {
    const { repo, featSha } = await featureRepo();
    await repo.write('a.txt', 'changed\n');
    await repo.write('new/untracked.ts', 'export {};\n');
    await repo.write('pnpm-lock.yaml', 'lock\n');
    const diff = await collectDiff(
      { kind: 'working', headSha: featSha, staged: false, resolvedBy: 'explicit' },
      { cwd: repo.dir, exclude: ['**/pnpm-lock.yaml'] },
    );
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([['a.txt', 'modified'], ['new/untracked.ts', 'added']]);
  });

  it('collects only staged changes with staged=true', async () => {
    const { repo, featSha } = await featureRepo();
    await repo.write('a.txt', 'staged\n');
    repo.git('add', 'a.txt');
    await repo.write('b.txt', 'unstaged\n');
    const diff = await collectDiff({ kind: 'working', headSha: featSha, staged: true, resolvedBy: 'explicit' }, { cwd: repo.dir, exclude: [] });
    expect(diff.files.map((f) => f.path)).toEqual(['a.txt']);
  });
});
