import { describe, expect, it } from 'vitest';
import { splitAskArgs } from '../../src/cli/ask-cmd.js';
import { TempRepo } from '../helpers/repo.js';

async function setup() {
  const repo = await TempRepo.create();
  await repo.commit('init', { 'a.txt': 'one\n' });
  await repo.commit('second', { 'a.txt': 'one\ntwo\n' });
  return repo;
}

describe('splitAskArgs', () => {
  it('takes the first word as a range only when git resolves it', async () => {
    const repo = await setup();
    const opts = { cwd: repo.dir, rangeAllowed: true };
    expect(await splitAskArgs(['HEAD~1', 'what', 'changed?'], opts)).toEqual({ range: 'HEAD~1', message: 'what changed?' });
    expect(await splitAskArgs(['HEAD~1..HEAD'], opts)).toEqual({ range: 'HEAD~1..HEAD', message: undefined });
    expect(await splitAskArgs(['main...HEAD', 'explain the tests'], opts)).toEqual({ range: 'main...HEAD', message: 'explain the tests' });
    expect(await splitAskArgs(['what is going on in a.txt?'], opts)).toEqual({ message: 'what is going on in a.txt?' });
    expect(await splitAskArgs(['what', 'is', 'going', 'on'], opts)).toEqual({ message: 'what is going on' });
    expect(await splitAskArgs(['wait...', 'really?'], opts)).toEqual({ message: 'wait... really?' });
    expect(await splitAskArgs(['nope..HEAD', 'hi'], opts)).toEqual({ message: 'nope..HEAD hi' });
    expect(await splitAskArgs([], opts)).toEqual({ message: undefined });
  });

  it('never takes a range when --working or --staged is in effect', async () => {
    const repo = await setup();
    expect(await splitAskArgs(['HEAD~1', 'safe to commit?'], { cwd: repo.dir, rangeAllowed: false })).toEqual({ message: 'HEAD~1 safe to commit?' });
  });
});
