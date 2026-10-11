import { describe, expect, it } from 'vitest';
import { classifyGhFailure } from '../../src/codehost/gh.js';
import { isBareNumber, parsePullRequestArg, parseRemoteUrl } from '../../src/git/pr.js';

describe('parsePullRequestArg', () => {
  it('reads numbers, #numbers and pull request URLs', () => {
    expect(parsePullRequestArg('12')).toEqual({ number: 12 });
    expect(parsePullRequestArg('#12')).toEqual({ number: 12 });
    expect(parsePullRequestArg('https://github.com/cam5/baby-bird/pull/3')).toEqual({ number: 3, host: 'github.com', owner: 'cam5', repo: 'baby-bird' });
    expect(parsePullRequestArg('https://GitHub.com/cam5/baby-bird/pull/3/files#diff-abc')).toEqual({ number: 3, host: 'github.com', owner: 'cam5', repo: 'baby-bird' });
    expect(parsePullRequestArg('https://ghe.example.com/o/r/pull/41?w=1')).toMatchObject({ number: 41, host: 'ghe.example.com' });
  });

  it('leaves everything that is a ref, a range or prose alone', () => {
    for (const arg of ['main', 'HEAD~3', '12..15', '12...', '0', '012', '#', '#x', 'v12', '1a2b3c4', 'pr/12', 'https://github.com/cam5/baby-bird/issues/3', 'https://github.com/cam5/baby-bird/pull/abc', '12 things']) {
      expect(parsePullRequestArg(arg), arg).toBeNull();
    }
  });

  it('knows which spelling is ambiguous with a ref name', () => {
    expect(isBareNumber('12')).toBe(true);
    expect(isBareNumber('#12')).toBe(false);
    expect(isBareNumber('https://github.com/o/r/pull/12')).toBe(false);
  });
});

describe('parseRemoteUrl', () => {
  it('reads https, ssh and scp-like remotes', () => {
    const want = { host: 'github.com', owner: 'cam5', repo: 'baby-bird' };
    expect(parseRemoteUrl('https://github.com/cam5/baby-bird.git')).toEqual(want);
    expect(parseRemoteUrl('https://github.com/cam5/baby-bird')).toEqual(want);
    expect(parseRemoteUrl('https://token@github.com/cam5/baby-bird.git/')).toEqual(want);
    expect(parseRemoteUrl('git@github.com:cam5/baby-bird.git')).toEqual(want);
    expect(parseRemoteUrl('ssh://git@github.com:22/cam5/baby-bird.git')).toEqual(want);
    expect(parseRemoteUrl('git@github-work:cam5/baby-bird.git')).toEqual({ ...want, host: 'github-work' });
  });

  it('returns null for local paths and anything that is not owner/repo', () => {
    for (const url of ['/tmp/remote.git', '../remote', 'file:///tmp/remote.git', 'https://gitlab.com/group/sub/project.git', '']) {
      expect(parseRemoteUrl(url), url).toBeNull();
    }
  });
});

describe('classifyGhFailure', () => {
  const failed = (stderr: string, error: object = {}) => ({ stdout: '', stderr, error: Object.assign(new Error('Command failed'), error) });

  it('names the reason gh could not answer', () => {
    expect(classifyGhFailure(failed('', { code: 'ENOENT' }), 15_000).reason).toBe('not-installed');
    expect(classifyGhFailure(failed('', { killed: true }), 15_000)).toEqual({ reason: 'timeout', detail: 'gh did not answer within 15s' });
    expect(classifyGhFailure(failed("GraphQL: Could not resolve to a Repository with the name 'cam5/retab'. (repository)\n"), 1)).toEqual({
      reason: 'no-access',
      detail: "GraphQL: Could not resolve to a Repository with the name 'cam5/retab'. (repository)",
    });
    expect(classifyGhFailure(failed('GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)\n'), 1).reason).toBe('no-such-pr');
    expect(classifyGhFailure(failed('HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com\n'), 1).reason).toBe('not-authenticated');
    expect(classifyGhFailure(failed('To get started with GitHub CLI, please run:  gh auth login\n'), 1).reason).toBe('not-authenticated');
    expect(classifyGhFailure(failed('something else broke\n'), 1)).toEqual({ reason: 'other', detail: 'something else broke' });
  });
});
