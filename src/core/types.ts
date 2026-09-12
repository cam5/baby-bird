/**
 * Core data model for baby-bird. Everything here is plain, serializable data so
 * that any renderer (CLI today, curses/web later) can consume a Tour without
 * touching git or an LLM.
 */

export type LineType = 'add' | 'del' | 'ctx';

export interface HunkLine {
  type: LineType;
  /** Line number in the old file (absent for added lines). */
  oldNo?: number;
  /** Line number in the new file (absent for deleted lines). */
  newNo?: number;
  /** Line content without the leading +/-/space. */
  text: string;
}

export interface Hunk {
  /** Stable id used in prompts, e.g. "F3.H2". */
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second @@ (function context), may be empty. */
  header: string;
  lines: HunkLine[];
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** Stable id used in prompts, e.g. "F3". */
  id: string;
  /** New path (or old path for deletions). */
  path: string;
  /** Old path when renamed. */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

export interface CommitInfo {
  sha: string;
  subject: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

export type RangeResolvedBy = 'explicit' | 'pull-request' | 'ancestor-branch' | 'default-branch';
export type WorkingResolvedBy = 'explicit' | 'dirty-tree';

export type TourSource =
  | {
      kind: 'range';
      /** Human label for the base, e.g. "main" or "origin/main". */
      base: string;
      /** Human label for the head, e.g. "feat/x" or "HEAD". */
      head: string;
      baseSha: string;
      headSha: string;
      /** Set when the base was taken at the merge-base (three-dot semantics). */
      mergeBase?: string;
      resolvedBy: RangeResolvedBy;
    }
  | {
      kind: 'working';
      headSha: string;
      staged: boolean;
      resolvedBy: WorkingResolvedBy;
    };

export interface TourStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface Excerpt {
  file: string;
  /** The hunk this excerpt was sliced from. */
  hunkId: string;
  /** One-line caption from the model. */
  note?: string;
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
}

export interface Section {
  id: string;
  title: string;
  description: string;
  /** Paths this section is about. Sections may share files. */
  files: string[];
  stats: TourStats;
  excerpts: Excerpt[];
}

export interface TourGenerator {
  preset: string | null;
  command: string[];
}

export interface Tour {
  version: 1;
  generatedAt: string;
  source: TourSource;
  generator: TourGenerator;
  pullRequest?: { number: number; title: string; url: string };
  title: string;
  summary: string;
  stats: TourStats;
  sections: Section[];
}

/** Everything gathered from git/code host before we talk to the model. */
export interface TourContext {
  source: TourSource;
  branch: string | null;
  diff: ParsedDiff;
  commits: CommitInfo[];
  pullRequest?: PullRequestInfo;
}
