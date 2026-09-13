import pc from 'picocolors';
import { UsageError } from '../core/errors.js';
import type { Excerpt, Section, Tour, TourSource, TourStats } from '../core/types.js';
import { highlightCode, languageForPath, truncateAnsi } from './highlight.js';
import type { Renderer, RenderOptions } from './renderer.js';

type Colors = ReturnType<typeof pc.createColors>;

const MIN_WIDTH = 40;
const MAX_WIDTH = 120;

/** Static, pager-friendly rendering of a Tour for a terminal. */
export class CliRenderer implements Renderer {
  render(tour: Tour, opts: RenderOptions): string {
    const c = pc.createColors(opts.color);
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, opts.width));
    const style: ExcerptStyle = { highlight: Boolean(opts.color && opts.highlight) };
    const out: string[] = [];

    out.push(...renderHeader(tour, c, width, opts.fromCache ?? false));
    out.push('');

    if (opts.section !== undefined) {
      const section = tour.sections[opts.section - 1];
      if (!section) {
        throw new UsageError(`No section ${opts.section}; this tour has ${tour.sections.length} section${tour.sections.length === 1 ? '' : 's'}.`);
      }
      out.push(...renderSection(section, opts.section, tour.sections.length, c, width, style));
    } else {
      out.push(...renderToc(tour, c, width));
      out.push('');
      tour.sections.forEach((s, i) => {
        out.push(...renderSection(s, i + 1, tour.sections.length, c, width, style));
        out.push('');
      });
    }
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }
}

function renderHeader(tour: Tour, c: Colors, width: number, fromCache: boolean): string[] {
  const lines: string[] = [];
  lines.push(c.bold(`🐣 ${tour.title}`));
  lines.push(c.dim(describeSource(tour.source)));
  if (tour.pullRequest) {
    lines.push(c.dim(`PR #${tour.pullRequest.number}: ${tour.pullRequest.title}${tour.pullRequest.url ? '  ' + tour.pullRequest.url : ''}`));
  }
  const parts = [statsLine(tour.stats, c), `${tour.sections.length} section${tour.sections.length === 1 ? '' : 's'}`];
  const meta: string[] = [];
  if (tour.generator.preset) meta.push(tour.generator.preset);
  else if (tour.generator.command[0]) meta.push(tour.generator.command[0]);
  meta.push(fromCache ? `cached ${relativeTime(tour.generatedAt)}` : 'generated just now');
  lines.push(`${parts.join(c.dim(' · '))}${c.dim(' · ' + meta.join(', '))}`);
  if (tour.summary) {
    lines.push('');
    lines.push(...wrap(tour.summary, width));
  }
  return lines;
}

function renderToc(tour: Tour, c: Colors, width: number): string[] {
  const lines = [c.bold('Contents')];
  const numWidth = String(tour.sections.length).length;
  for (const [i, s] of tour.sections.entries()) {
    const n = String(i + 1).padStart(numWidth);
    const label = `  ${n}. ${s.title}`;
    const right = `${s.stats.files} file${s.stats.files === 1 ? '' : 's'} · ${statsLine(s.stats, c, true)}`;
    const rightPlain = `${s.stats.files} file${s.stats.files === 1 ? '' : 's'} · +${s.stats.additions} -${s.stats.deletions}`;
    const gap = Math.max(2, width - visibleLength(label) - rightPlain.length);
    lines.push(label + ' '.repeat(gap) + c.dim(right));
  }
  return lines;
}

interface ExcerptStyle {
  highlight: boolean;
}

function renderSection(s: Section, index: number, count: number, c: Colors, width: number, style: ExcerptStyle): string[] {
  const lines: string[] = [];
  lines.push(c.dim('─'.repeat(width)));
  lines.push(c.bold(`${index}. ${s.title}`) + c.dim(`   (${index}/${count})`));
  lines.push(`   ${c.dim(`${s.stats.files} file${s.stats.files === 1 ? '' : 's'} · `)}${statsLine(s.stats, c, true)}`);
  if (s.description) {
    lines.push('');
    lines.push(...wrap(s.description, width - 3).map((l) => (l ? '   ' + l : '')));
  }
  if (s.files.length) {
    lines.push('');
    for (const f of s.files) lines.push(`   ${c.cyan(f)}`);
  }
  for (const e of s.excerpts) {
    lines.push('');
    lines.push(...renderExcerpt(e, c, width, style));
  }
  return lines;
}

function renderExcerpt(e: Excerpt, c: Colors, width: number, style: ExcerptStyle): string[] {
  const lines: string[] = [];
  const title = `   ${c.cyan(e.file)}${c.dim(':' + e.newStart)}`;
  lines.push(e.note ? `${title}  ${c.italic(c.dim(e.note))}` : title);
  const maxNo = Math.max(...e.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)), 1);
  const w = String(maxNo).length;
  // gutter = 3 spaces + old + space + new + " │" ; body = sign + text
  const budget = Math.max(20, width - (3 + w * 2 + 3) - 1);
  const texts = e.lines.map((l) => expandTabs(l.text));

  const lang = style.highlight ? languageForPath(e.file) : null;
  const highlighted = lang ? highlightCode(texts.join('\n'), lang, c) : null;

  e.lines.forEach((l, i) => {
    const oldNo = l.oldNo === undefined ? ' '.repeat(w) : String(l.oldNo).padStart(w);
    const newNo = l.newNo === undefined ? ' '.repeat(w) : String(l.newNo).padStart(w);
    const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    const gutter = c.dim(`   ${oldNo} ${newNo} │`);
    const plain = texts[i]!;

    if (!highlighted) {
      const signStyled = l.type === 'add' ? c.green(sign) : l.type === 'del' ? c.red(sign) : sign;
      lines.push(`${gutter}${signStyled}${truncate(plain, budget)}`);
      return;
    }

    // Syntax colors on the text; add/del expressed by a colored sign, no row background.
    // Deliberately not bold: terminals often render bold + a base color via their "bright"
    // palette slot, and some themes leave that slot washed out.
    const text = truncateAnsi(highlighted[i]!, budget);
    if (l.type === 'ctx') {
      lines.push(`${gutter} ${text}`);
      return;
    }
    const signStyled = l.type === 'add' ? c.green('+') : c.red('-');
    lines.push(`${gutter}${signStyled}${text}`);
  });
  return lines;
}

function statsLine(stats: TourStats, c: Colors, omitFiles = false): string {
  const counts = `${c.green(`+${stats.additions}`)} ${c.red(`-${stats.deletions}`)}`;
  return omitFiles ? counts : `${stats.files} file${stats.files === 1 ? '' : 's'} · ${counts}`;
}

export function describeSource(source: TourSource): string {
  if (source.kind === 'working') {
    return source.staged ? 'Staged changes vs HEAD' : 'Working tree vs HEAD (uncommitted changes)';
  }
  const how =
    source.resolvedBy === 'pull-request' ? 'base from pull request'
      : source.resolvedBy === 'ancestor-branch' ? 'nearest ancestor branch'
        : source.resolvedBy === 'default-branch' ? 'default branch'
          : null;
  const mb = source.mergeBase ? ` (merge-base ${source.mergeBase.slice(0, 7)})` : '';
  return `${source.head} vs ${source.base}${mb}${how ? ` · ${how}` : ''}`;
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
    out.push('');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

function expandTabs(s: string): string {
  return s.replaceAll('\t', '    ');
}

function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}
