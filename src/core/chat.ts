import { describeSource, renderChange, type ChangeInput, type TruncationReport } from './prompt/build.js';
import type { Excerpt, Section, Tour, TourSource } from './types.js';

export interface ChatContextInput {
  tour: Tour;
  /** The change the tour was built from, as gathered by prepareTour. */
  change: ChangeInput;
  /** Soft budget for the whole context, in bytes; the tour is always kept and the diff is shortened to fit. */
  maxBytes: number;
  /** Where the tour JSON lives on disk, when cached, so a tool-using assistant can open it. */
  tourPath?: string | null;
}

export interface ChatContext {
  /** Markdown meant for a system prompt: framing, the tour, then the change and its diff. */
  text: string;
  truncation: TruncationReport;
}

const FRAMING = `# About this conversation

You are chatting with a developer about one specific change in the git repository you are running in. \`bb\` (the baby-bird CLI) generated the guided code tour below for that change; the developer has it open next to this chat, so treat it as shared context. Answer questions about the change using the tour, the diff after it, and the repository's files whenever you can read them. Refer to tour sections by number and title, and to code by file path and line number. If the diff below was shortened to fit, say so instead of guessing at what was left out.`;

/** The text `bb ask` hands to the chat command as context. */
export function buildChatContext(input: ChatContextInput): ChatContext {
  const head = [FRAMING, '', ...renderTour(input.tour, input.change, input.tourPath ?? null), ''].join('\n');
  const change = renderChange(input.change, Math.max(0, input.maxBytes - Buffer.byteLength(head, 'utf8') - 1));
  return { text: head + change.text, truncation: change.truncation };
}

function renderTour(tour: Tour, change: ChangeInput, tourPath: string | null): string[] {
  const lines: string[] = [`# The code tour: ${tour.title}`, ''];
  // Same sentence the change section below uses, so the two never disagree.
  lines.push(`- Change: ${describeSource(change.source, change.branch)}`);
  lines.push(`- Revisions: ${describeRevisions(change.source)}`);
  if (tour.pullRequest) lines.push(`- Pull request #${tour.pullRequest.number}: ${tour.pullRequest.title}${tour.pullRequest.url ? ` (${tour.pullRequest.url})` : ''}`);
  lines.push(`- Size: ${tour.stats.files} file${tour.stats.files === 1 ? '' : 's'}, +${tour.stats.additions} -${tour.stats.deletions}, ${tour.sections.length} section${tour.sections.length === 1 ? '' : 's'}`);
  lines.push(`- Generated: ${tour.generatedAt} by ${tour.generator.preset ?? tour.generator.command[0] ?? 'unknown'}`);
  if (tourPath) lines.push(`- Tour JSON: ${tourPath}`);
  if (tour.summary.trim()) lines.push('', tour.summary.trim());
  tour.sections.forEach((s, i) => lines.push('', ...renderSection(s, i + 1)));
  return lines;
}

/** The SHAs behind the change, with the git command that reproduces the diff. */
function describeRevisions(source: TourSource): string {
  const head = source.headSha.slice(0, 12);
  if (source.kind === 'working') return `HEAD is ${head}`;
  const base = (source.mergeBase ?? source.baseSha).slice(0, 12);
  return `base ${base}, head ${head}; \`git diff ${base} ${head}\` reproduces the diff`;
}

function renderSection(s: Section, n: number): string[] {
  const lines = [`## ${n}. ${s.title}`, '', `${s.stats.files} file${s.stats.files === 1 ? '' : 's'}, +${s.stats.additions} -${s.stats.deletions}`];
  if (s.description.trim()) lines.push('', s.description.trim());
  if (s.files.length) lines.push('', 'Files:', ...s.files.map((f) => `- ${f}`));
  for (const e of s.excerpts) lines.push('', ...renderExcerpt(e));
  return lines;
}

function renderExcerpt(e: Excerpt): string[] {
  const note = e.note ? ` — ${e.note}` : '';
  const lines = [`Excerpt \`${e.file}:${e.newStart}\` (hunk ${e.hunkId})${note}`, '', '```'];
  const maxNo = Math.max(...e.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)), 1);
  const w = String(maxNo).length;
  for (const l of e.lines) {
    const oldNo = l.oldNo === undefined ? ' '.repeat(w) : String(l.oldNo).padStart(w);
    const newNo = l.newNo === undefined ? ' '.repeat(w) : String(l.newNo).padStart(w);
    const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    lines.push(`${oldNo} ${newNo} │${sign}${l.text}`);
  }
  lines.push('```');
  return lines;
}
