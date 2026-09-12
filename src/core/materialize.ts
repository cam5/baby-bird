import { diffStats } from '../git/parse.js';
import type { LlmTourOutput } from './schema.js';
import type { DiffFile, Excerpt, Hunk, HunkLine, ParsedDiff, Section, Tour, TourGenerator, TourSource, TourStats, PullRequestInfo } from './types.js';

export interface MaterializeInput {
  output: LlmTourOutput;
  diff: ParsedDiff;
  source: TourSource;
  generator: TourGenerator;
  pullRequest?: PullRequestInfo;
  maxExcerptLines: number;
  warn?: (msg: string) => void;
  now?: () => Date;
}

export const OTHER_CHANGES_TITLE = 'Other changes';

/**
 * Turn the model's section/reference output into a self-contained Tour by
 * slicing excerpts out of the real diff and computing all counts locally.
 */
export function materializeTour(input: MaterializeInput): Tour {
  const warn = input.warn ?? (() => {});
  const byPath = new Map<string, DiffFile>();
  const byOldPath = new Map<string, DiffFile>();
  const hunks = new Map<string, { file: DiffFile; hunk: Hunk }>();
  for (const f of input.diff.files) {
    byPath.set(f.path, f);
    if (f.oldPath) byOldPath.set(f.oldPath, f);
    for (const h of f.hunks) hunks.set(h.id, { file: f, hunk: h });
  }
  const lookupFile = (p: string) => byPath.get(p) ?? byPath.get(p.replace(/^\.\//, '')) ?? byOldPath.get(p);

  const claimed = new Set<string>();
  const sections: Section[] = [];

  for (const s of input.output.sections) {
    const files = new Set<string>();
    for (const p of s.files ?? []) {
      const f = lookupFile(p);
      if (f) files.add(f.path);
      else warn(`Section "${s.title}" references unknown file ${p}; ignoring`);
    }
    const excerpts: Excerpt[] = [];
    for (const ref of s.excerpts ?? []) {
      const hit = hunks.get(ref.hunk.trim());
      if (!hit) {
        warn(`Section "${s.title}" references unknown hunk ${ref.hunk}; ignoring`);
        continue;
      }
      files.add(hit.file.path);
      const range = ref.lines && ref.lines.length >= 2 ? ([ref.lines[0]!, ref.lines[1]!] as [number, number]) : undefined;
      const lines = sliceHunk(hit.hunk, range, input.maxExcerptLines);
      const excerpt: Excerpt = {
        file: hit.file.path,
        hunkId: hit.hunk.id,
        oldStart: lines[0]?.oldNo ?? firstOld(lines) ?? hit.hunk.oldStart,
        newStart: lines[0]?.newNo ?? firstNew(lines) ?? hit.hunk.newStart,
        lines,
      };
      if (ref.note?.trim()) excerpt.note = ref.note.trim();
      excerpts.push(excerpt);
    }
    const fileList = [...files];
    for (const p of fileList) claimed.add(p);
    sections.push({
      id: `s${sections.length + 1}`,
      title: s.title.trim(),
      description: s.description.trim(),
      files: fileList,
      stats: statsFor(fileList, byPath),
      excerpts,
    });
  }

  const unclaimed = input.diff.files.map((f) => f.path).filter((p) => !claimed.has(p));
  if (unclaimed.length) {
    sections.push({
      id: `s${sections.length + 1}`,
      title: OTHER_CHANGES_TITLE,
      description: 'Files in this change that the sections above do not cover.',
      files: unclaimed,
      stats: statsFor(unclaimed, byPath),
      excerpts: [],
    });
  }

  const tour: Tour = {
    version: 1,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    source: input.source,
    generator: input.generator,
    title: input.output.title.trim(),
    summary: input.output.summary.trim(),
    stats: diffStats(input.diff),
    sections,
  };
  if (input.pullRequest) {
    tour.pullRequest = { number: input.pullRequest.number, title: input.pullRequest.title, url: input.pullRequest.url };
  }
  return tour;
}

function statsFor(paths: string[], byPath: Map<string, DiffFile>): TourStats {
  let additions = 0;
  let deletions = 0;
  for (const p of paths) {
    const f = byPath.get(p);
    if (!f) continue;
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: paths.length, additions, deletions };
}

function firstOld(lines: HunkLine[]): number | undefined {
  return lines.find((l) => l.oldNo !== undefined)?.oldNo;
}
function firstNew(lines: HunkLine[]): number | undefined {
  return lines.find((l) => l.newNo !== undefined)?.newNo;
}

/**
 * Narrow a hunk to a [start, end] range of new-file line numbers. Deleted lines
 * are attributed to the new-file position where they would have been, so a
 * range keeps the removals that sit inside it.
 */
export function sliceHunk(hunk: Hunk, range: [number, number] | undefined, maxLines: number): HunkLine[] {
  let lines = hunk.lines;
  if (range) {
    const [a, b] = range;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    let cursor = hunk.newStart;
    const picked: HunkLine[] = [];
    for (const l of lines) {
      const pos = l.type === 'del' ? cursor : (l.newNo ?? cursor);
      if (l.type !== 'del') cursor = (l.newNo ?? cursor) + 1;
      if (pos >= start && pos <= end) picked.push(l);
    }
    if (picked.length > 0) lines = picked;
  }
  return lines.slice(0, maxLines);
}
