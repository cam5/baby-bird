import type { CodeHost } from './provider.js';

export class NoCodeHost implements CodeHost {
  readonly name = 'none';
  async currentPullRequest(): Promise<null> {
    return null;
  }
}
