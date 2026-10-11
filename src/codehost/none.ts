import type { CodeHost, PullRequestLookup } from './provider.js';

export class NoCodeHost implements CodeHost {
  readonly name = 'none';
  async currentPullRequest(): Promise<null> {
    return null;
  }
  async pullRequest(): Promise<PullRequestLookup> {
    return { ok: false, reason: 'disabled', detail: 'the code host is turned off (codehost.provider is "none")' };
  }
}
