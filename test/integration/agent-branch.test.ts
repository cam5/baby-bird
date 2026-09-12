import { describe, expect, it } from 'vitest';
import { NoCodeHost } from '../../src/codehost/none.js';
import type { CodeHost } from '../../src/codehost/provider.js';
import { resolveRange } from '../../src/git/range.js';
import { TempRepo } from '../helpers/repo.js';

const AGENT = 'agent/task-1214247319460438-33535288546';

const opts = (repo: TempRepo) => ({
  cwd: repo.dir,
  exclude: [] as string[],
  defaultBranch: null,
  codehost: new NoCodeHost() as CodeHost,
});

// Mirrors a repo whose default branch is `master` (there is no `main` at all) and
// whose checked-out branch is a slash-named agent/task-* branch with a clean tree.
async function agentRepo(): Promise<{ repo: TempRepo; masterSha: string; agentSha: string }> {
  const repo = await TempRepo.create();
  await repo.commit('init', { 'a.txt': 'one\n' });
  const masterSha = await repo.commit('second', { 'a.txt': 'one\ntwo\n' });
  repo.git('branch', '-m', 'main', 'master');
  repo.git('checkout', '-q', '-b', AGENT);
  await repo.commit('agent 1', { 'c.txt': 'c\n' });
  const agentSha = await repo.commit('agent 2', { 'a.txt': 'one\ntwo\nthree\n' });
  return { repo, masterSha, agentSha };
}

describe('resolveRange on a master-default repo with a slash-named branch', () => {
  it('infers master as the base with no arguments', async () => {
    const { repo, masterSha, agentSha } = await agentRepo();
    const r = await resolveRange({}, opts(repo));
    expect(r.branch).toBe(AGENT);
    expect(r.source).toMatchObject({ kind: 'range', base: 'master', baseSha: masterSha, headSha: agentSha, resolvedBy: 'ancestor-branch' });
  });

  it('falls back to the default branch when it is the only other branch', async () => {
    const { repo, masterSha, agentSha } = await agentRepo();
    repo.git('update-ref', 'refs/remotes/origin/master', masterSha);
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    repo.git('branch', '-D', 'master');
    const r = await resolveRange({}, opts(repo));
    expect(r.source).toMatchObject({ kind: 'range', base: 'origin/master', baseSha: masterSha, headSha: agentSha, resolvedBy: 'default-branch' });
  });

  it('accepts the slash-named branch in an explicit range', async () => {
    const { repo, masterSha, agentSha } = await agentRepo();
    const r = await resolveRange({ arg: `master..${AGENT}` }, opts(repo));
    expect(r.source).toMatchObject({ kind: 'range', baseSha: masterSha, headSha: agentSha, resolvedBy: 'explicit' });
  });

  it('reports the base as unknown before the head when `main` does not exist', async () => {
    const { repo } = await agentRepo();
    await expect(resolveRange({ arg: `main..${AGENT}` }, opts(repo))).rejects.toThrow(/Unknown git ref: main$/);
  });

  it('names the repository when the default branch has nothing to tour', async () => {
    const { repo } = await agentRepo();
    repo.git('checkout', '-q', 'master');
    await expect(resolveRange({}, opts(repo))).rejects.toThrow(new RegExp(`on master in ${repo.dir} with a clean working tree`));
  });
});
