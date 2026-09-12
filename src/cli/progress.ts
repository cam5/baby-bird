import pc from 'picocolors';
import type { ProgressSink } from '../core/progress.js';
import type { LlmEvent } from '../llm/provider.js';
import { wrap } from '../render/cli.js';

const SPINNER = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳'];
const VERBS = ['Hatching', 'Pecking', 'Nesting', 'Chirping', 'Preening', 'Fledging', 'Brooding', 'Warbling', 'Peeping'];
const THINKING_TAIL_CHARS = 2000;

export interface LiveProgressOptions {
  color: boolean;
  width: number;
  /** How many lines of thinking / section titles to show under the status line. */
  windowLines?: number;
  now?: () => number;
  verb?: string;
  frameMs?: number;
}

interface Usage {
  outputTokens?: number;
  thinkingTokens?: number;
  model?: string;
}

type Stage = 'prep' | 'thinking' | 'writing' | 'output';

/**
 * In-place status block on a TTY: a spinner line plus a small window showing
 * the model's reasoning as it streams, then section titles as the answer forms.
 */
export class LiveProgress implements ProgressSink {
  private phaseLabel = '';
  private stage: Stage = 'prep';
  private thinking = '';
  private answer = '';
  private titles: string[] = [];
  private notices: string[] = [];
  private outputBytes = 0;
  private usage: Usage = {};
  private readonly startedAt: number;
  private frameIndex = 0;
  private lastLines = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly verb: string;
  private readonly now: () => number;
  private readonly windowLines: number;
  private readonly onSigint = () => {
    this.stop();
    process.exit(130);
  };

  constructor(
    private readonly stream: { write(chunk: string): boolean },
    private readonly opts: LiveProgressOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.verb = opts.verb ?? VERBS[Math.floor(Math.random() * VERBS.length)]!;
    this.windowLines = opts.windowLines ?? 5;
  }

  start(): void {
    this.stream.write('\x1b[?25l');
    process.once('SIGINT', this.onSigint);
    this.timer = setInterval(() => {
      this.frameIndex++;
      this.render();
    }, this.opts.frameMs ?? 80);
    this.timer.unref?.();
    this.render();
  }

  phase(label: string): void {
    this.phaseLabel = label;
    if (/^asking/i.test(label)) {
      this.stage = 'thinking';
      this.thinking = '';
      this.answer = '';
      this.titles = [];
      this.notices = [];
      this.outputBytes = 0;
    } else if (this.stage !== 'prep') {
      this.stage = 'prep';
    }
    this.render();
  }

  llm(event: LlmEvent): void {
    switch (event.type) {
      case 'thinking':
        this.thinking += event.text;
        this.stage = 'thinking'; // thinking after a rejected answer comes back into view
        break;
      case 'answer-start':
        this.answer = '';
        this.titles = [];
        break;
      case 'notice':
        this.notices.push(event.text);
        break;
      case 'text':
        this.answer += event.text;
        this.titles = extractTitles(this.answer);
        this.stage = 'writing';
        break;
      case 'output':
        this.outputBytes = event.bytes;
        this.stage = 'output';
        break;
      case 'usage':
        if (event.outputTokens !== undefined) this.usage.outputTokens = event.outputTokens;
        if (event.thinkingTokens !== undefined) this.usage.thinkingTokens = event.thinkingTokens;
        if (event.model !== undefined) this.usage.model = event.model;
        break;
      default:
        break;
    }
  }

  /** The lines that make up the current status block. */
  frame(): string[] {
    const c = pc.createColors(this.opts.color);
    const width = Math.max(30, this.opts.width);
    const spin = c.magenta(SPINNER[this.frameIndex % SPINNER.length]!);
    const elapsed = this.elapsed();
    const fit = (s: string) => (s.length > width - 1 ? s.slice(0, width - 2) + '…' : s);
    const lines: string[] = [];

    switch (this.stage) {
      case 'prep':
        lines.push(`${spin} ${fit(this.phaseLabel || 'Starting')}… ${c.dim(elapsed)}`);
        break;
      case 'thinking': {
        const meta = [elapsed, this.phaseLabel.replace(/^asking\s+/i, '')].filter(Boolean).join(' · ');
        lines.push(`${spin} ${this.verb}… ${c.dim(meta)}`);
        for (const n of this.notices.slice(-1)) lines.push(`  ${c.yellow('↻')} ${c.yellow(fit(n).slice(0, width - 4))}`);
        if (this.thinking) {
          const tail = this.thinking.slice(-THINKING_TAIL_CHARS).replace(/\s+/g, ' ').trim();
          const wrapped = wrap(tail, width - 4).slice(-this.windowLines);
          for (const l of wrapped) lines.push(`  ${c.dim('│')} ${c.dim(l)}`);
        }
        break;
      }
      case 'writing': {
        const n = Math.max(0, this.titles.length - 1);
        lines.push(`${spin} Writing the tour… ${c.dim(`${elapsed} · ${n} section${n === 1 ? '' : 's'} so far`)}`);
        for (const note of this.notices.slice(-1)) lines.push(`  ${c.yellow('↻')} ${c.yellow(fit(note).slice(0, width - 4))}`);
        const [tourTitle, ...sections] = this.titles;
        const items: string[] = [];
        if (tourTitle) items.push(`  🐣 ${c.bold(fit(tourTitle).slice(0, width - 6))}`);
        sections.forEach((t) => items.push(`  ${c.green('✓')} ${fit(t).slice(0, width - 5)}`));
        for (const l of items.slice(-this.windowLines)) lines.push(l);
        break;
      }
      case 'output':
        lines.push(`${spin} ${this.verb}… ${c.dim(`${elapsed} · ${formatBytes(this.outputBytes)} received`)}`);
        break;
    }
    return lines;
  }

  render(): void {
    if (this.stopped) return;
    const lines = this.frame();
    this.stream.write(this.erase() + lines.join('\n') + '\n');
    this.lastLines = lines.length;
  }

  /** Clear the block, restore the cursor, and optionally leave a final line behind. */
  stop(finalLine?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    process.removeListener('SIGINT', this.onSigint);
    this.stream.write(this.erase() + (finalLine ? finalLine + '\n' : '') + '\x1b[?25h');
    this.lastLines = 0;
  }

  /** A one-line summary of the model call, for the final line. */
  summary(): string {
    const c = pc.createColors(this.opts.color);
    const parts = [`Hatched in ${this.elapsed()}`];
    if (this.usage.outputTokens) {
      parts.push(`${formatCount(this.usage.outputTokens)} tokens${this.usage.thinkingTokens ? ` (${formatCount(this.usage.thinkingTokens)} thinking)` : ''}`);
    }
    if (this.usage.model) parts.push(this.usage.model);
    return c.dim(`✻ ${parts.join(' · ')}`);
  }

  private elapsed(): string {
    const s = Math.max(0, Math.round((this.now() - this.startedAt) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }

  private erase(): string {
    return this.lastLines ? `\x1b[${this.lastLines}A\x1b[0J` : '';
  }
}

/** Every "title" string value in a (possibly partial) JSON document, in order. */
export function extractTitles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    out.push(m[1]!.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_, esc: string) => {
      switch (esc[0]) {
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        case 'n': return '\n';
        case 't': return '\t';
        case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
        default: return '';
      }
    }));
  }
  return out;
}

/** A sink that logs phases as plain lines (used with --debug or without a TTY). */
export function loggingProgress(log: (msg: string) => void): ProgressSink {
  return {
    phase: (label) => log(label),
    llm: () => {},
  };
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
