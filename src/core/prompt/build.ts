import type { CommitInfo, DiffFile, Hunk, ParsedDiff, PullRequestInfo, TourSource } from '../types.js';
import { diffStats } from '../../git/parse.js';
import { promptHeader } from './template.js';

/** The change as gathered from git and the code host. */
export interface ChangeInput {
  source: TourSource;
  branch: string | null;
  diff: ParsedDiff;
  commits: CommitInfo[];
  pullRequest?: PullRequestInfo;
}

export interface PromptInput extends ChangeInput {
  /** Soft budget for the whole prompt, in bytes. */
  maxBytes: number;
  /** The runner enforces the JSON schema itself (e.g. claude --json-schema); adjusts the output instruction. */
  structured?: boolean;
}

export interface TruncationReport {
  /** Files whose diff was cut down to the start of their first hunk. */
  truncated: string[];
  /** Files whose diff was left out entirely (names and stats only). */
  omitted: string[];
}

export interface BuiltPrompt {
  prompt: string;
  truncation: TruncationReport;
}

const KEEP_LINES = 40;
const MAX_PR_BODY_BYTES = 12_000;

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const header = promptHeader(Boolean(input.structured));
  const change = renderChange(input, input.maxBytes - bytes(header) - 8);
  return { prompt: [header, change.text].join('\n'), truncation: change.truncation };
}

/**
 * The change itself: source, PR text, commit subjects, the file table, and the diff with every
 * hunk labeled by id. Diffs are shortened biggest-file-first to fit `maxBytes`.
 */
export function renderChange(input: ChangeInput, maxBytes: number): { text: string; truncation: TruncationReport } {
  const context = renderContext(input);
  const truncation: TruncationReport = { truncated: [], omitted: [] };
  const blocks = input.diff.files.map((file) => {
    const full = renderFile(file);
    const truncated = file.hunks.length ? renderTruncated(file) : null;
    return {
      file,
      full,
      // Only worth truncating when it actually saves space.
      truncated: truncated && bytes(truncated) < bytes(full) ? truncated : null,
      omitted: renderOmitted(file),
      mode: 'full' as 'full' | 'truncated' | 'omitted',
    };
  });
  const text = (b: (typeof blocks)[number]) => (b.mode === 'full' ? b.full : b.mode === 'truncated' ? b.truncated! : b.omitted);
  const total = () => bytes(diffPreamble(truncation)) + blocks.reduce((n, b) => n + bytes(text(b)), 0);
  const budget = maxBytes - bytes(context);

  if (total() > budget) {
    const bySize = [...blocks].sort((a, b) => bytes(b.full) - bytes(a.full));
    for (const block of bySize) {
      if (total() <= budget) break;
      if (!block.truncated) continue;
      block.mode = 'truncated';
      truncation.truncated.push(block.file.path);
    }
    for (const block of bySize) {
      if (total() <= budget) break;
      if (block.file.hunks.length === 0) continue;
      if (block.mode === 'truncated') truncation.truncated = truncation.truncated.filter((p) => p !== block.file.path);
      block.mode = 'omitted';
      truncation.omitted.push(block.file.path);
    }
  }

  return { text: [context, diffPreamble(truncation), ...blocks.map(text)].join('\n'), truncation };
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function renderContext(input: ChangeInput): string {
  const parts: string[] = ['# The change', ''];

  parts.push('## Source');
  parts.push(describeSource(input.source, input.branch));
  parts.push('');

  if (input.pullRequest) {
    const pr = input.pullRequest;
    parts.push(`## Pull request #${pr.number}: ${pr.title.trim() || '(untitled)'}`);
    const body = pr.body.trim();
    parts.push(body ? clip(body, MAX_PR_BODY_BYTES) : '(no description)');
    parts.push('');
  }

  if (input.commits.length) {
    parts.push('## Commits (oldest first)');
    for (const c of [...input.commits].reverse()) parts.push(`- ${c.subject}`);
    parts.push('');
  }

  const stats = diffStats(input.diff);
  parts.push(`## Files (${stats.files} ${stats.files === 1 ? 'file' : 'files'}, +${stats.additions} -${stats.deletions})`);
  const idWidth = Math.max(...input.diff.files.map((f) => f.id.length), 2);
  for (const f of input.diff.files) {
    const status = f.binary ? 'binary' : f.status;
    const name = f.status === 'renamed' && f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path;
    const counts = f.binary ? '' : `  +${f.additions} -${f.deletions}`;
    parts.push(`${f.id.padEnd(idWidth)}  ${status.padEnd(8)}  ${name}${counts}`);
  }
  parts.push('');
  return parts.join('\n');
}

export function describeSource(source: TourSource, branch: string | null): string {
  if (source.kind === 'working') {
    const what = source.staged ? 'Staged (uncommitted) changes' : 'Uncommitted changes in the working tree';
    return branch ? `${what} on branch ${branch}.` : `${what} (detached HEAD).`;
  }
  const mb = source.mergeBase ? ` (at merge-base ${source.mergeBase.slice(0, 7)})` : '';
  return `${source.head} compared against ${source.base}${mb}.`;
}

function diffPreamble(t: TruncationReport): string {
  const lines = ['## Diff', ''];
  if (t.truncated.length || t.omitted.length) {
    lines.push('Note: to fit the size budget, some diffs below were shortened.');
    if (t.truncated.length) lines.push(`- Truncated (only the shown hunk may be referenced): ${t.truncated.join(', ')}`);
    if (t.omitted.length) lines.push(`- Omitted entirely (assign by name and stats): ${t.omitted.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function fileHeading(file: DiffFile): string {
  const status = file.binary ? 'binary' : file.status;
  const rename = file.status === 'renamed' && file.oldPath ? `, from ${file.oldPath}` : '';
  const counts = file.binary ? '' : `, +${file.additions} -${file.deletions}`;
  return `### ${file.id} ${file.path} (${status}${rename}${counts})`;
}

function renderHunk(hunk: Hunk, limit?: number): string[] {
  const out = [`[${hunk.id}] @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ' ' + hunk.header : ''}`];
  const lines = limit === undefined ? hunk.lines : hunk.lines.slice(0, limit);
  for (const l of lines) out.push((l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text);
  return out;
}

function renderFile(file: DiffFile): string {
  const out = [fileHeading(file)];
  if (file.binary) out.push('(binary file, no textual diff)');
  else if (file.hunks.length === 0) out.push('(no content changes)');
  else for (const h of file.hunks) out.push(...renderHunk(h));
  out.push('');
  return out.join('\n');
}

function renderTruncated(file: DiffFile): string {
  const first = file.hunks[0]!;
  const shown = Math.min(KEEP_LINES, first.lines.length);
  const totalLines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const out = [fileHeading(file), ...renderHunk(first, shown)];
  out.push(`... [truncated: ${totalLines - shown} more lines across ${file.hunks.length} hunk${file.hunks.length === 1 ? '' : 's'}]`);
  out.push('');
  return out.join('\n');
}

function renderOmitted(file: DiffFile): string {
  return [fileHeading(file), '(diff omitted for length)', ''].join('\n');
}

function clip(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  let cut = text.slice(0, maxBytes);
  while (bytes(cut) > maxBytes) cut = cut.slice(0, -100);
  return cut + '\n... [description truncated]';
}
