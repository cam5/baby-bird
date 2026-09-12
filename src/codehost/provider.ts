import type { PullRequestInfo } from '../core/types.js';

export interface CodeHost {
  readonly name: string;
  /** The pull request for the current branch, or null when there is none (or the host is unavailable). */
  currentPullRequest(cwd: string): Promise<PullRequestInfo | null>;
}
