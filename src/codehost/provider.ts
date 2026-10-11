import type { PullRequestInfo } from '../core/types.js';

/** Why a pull request could not be looked up by number. */
export type PullRequestLookupFailure =
  /** The code host is turned off (`codehost.provider: "none"`) or cannot look PRs up by number. */
  | 'disabled'
  | 'not-installed'
  | 'not-authenticated'
  /** Authenticated, but this account cannot see the repository. */
  | 'no-access'
  | 'no-such-pr'
  | 'timeout'
  | 'other';

export type PullRequestLookup =
  | { ok: true; pr: PullRequestInfo }
  | { ok: false; reason: PullRequestLookupFailure; detail: string };

export interface CodeHost {
  readonly name: string;
  /** The pull request for the current branch, or null when there is none (or the host is unavailable). */
  currentPullRequest(cwd: string): Promise<PullRequestInfo | null>;
  /**
   * A pull request by number. `repo` is `[HOST/]OWNER/REPO` when the caller knows which repository it means;
   * without it the host decides from `cwd`. Never throws: failures come back as `{ ok: false }`.
   */
  pullRequest?(number: number, cwd: string, repo?: string): Promise<PullRequestLookup>;
}
