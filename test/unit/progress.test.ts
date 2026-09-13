import { describe, expect, it } from 'vitest';
import { LiveProgress, extractTitles } from '../../src/cli/progress.js';

class FakeStream {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get all(): string {
    return this.chunks.join('');
  }
}

function make(width = 60) {
  let t = 1000;
  const stream = new FakeStream();
  const p = new LiveProgress(stream, { color: false, width, windowLines: 3, now: () => t, verb: 'Hatching' });
  return { p, stream, tick: (ms: number) => (t += ms) };
}

describe('LiveProgress', () => {
  it('shows the phase while preparing', () => {
    const { p, tick } = make();
    p.phase('Collecting the diff');
    tick(2500);
    expect(p.frame()).toEqual(['✢ Collecting the diff… 3s']);
  });

  it('shows a window of the latest thinking while the model reasons', () => {
    const { p, tick } = make(40);
    p.phase('Asking claude-sonnet');
    tick(12_000);
    p.llm({ type: 'thinking', text: 'First I will look at the diff.\n\nThen ' });
    p.llm({ type: 'thinking', text: 'I will group the files by concept and pick the best hunks for each section.' });
    const f = p.frame();
    expect(f[0]).toBe('✢ Hatching… 12s · claude-sonnet');
    expect(f.length).toBe(4); // status + 3 window lines
    expect(f.slice(1).every((l) => l.startsWith('  │ ') && l.length <= 40)).toBe(true);
    expect(f.at(-1)).toContain('section.');
  });

  it('shows a growing pulse trail when reasoning heartbeats carry no text', () => {
    const { p, tick } = make(40);
    p.phase('Asking claude');
    tick(3000);
    for (let i = 0; i < 5; i++) p.llm({ type: 'thinking-pulse' });
    expect(p.frame()).toEqual(['✢ Hatching… 3s · claude', '  │ reasoning ·····']);
    for (let i = 0; i < 30; i++) p.llm({ type: 'thinking-pulse' });
    expect(p.frame()[1]).toBe('  │ reasoning ' + '·'.repeat(35 % 25));
    p.llm({ type: 'thinking', text: 'real text wins' });
    expect(p.frame()[1]).toBe('  │ real text wins');
  });

  it('switches to section titles once the answer streams', () => {
    const { p } = make(80);
    p.phase('Asking claude');
    p.llm({ type: 'text', text: '{"title": "Add widgets", "summary": "s", "sections": [{"title": "The \\"widget\\" type"' });
    p.llm({ type: 'text', text: ', "description": "d"}, {"title": "Wiring"' });
    const f = p.frame();
    expect(f[0]).toBe('✢ Writing the tour… 0s · 2 sections so far');
    expect(f.slice(1)).toEqual(['  🐣 Add widgets', '  ✓ The "widget" type', '  ✓ Wiring']);
  });

  it('resets titles on a new answer, shows notices, and returns to the thinking view for late reasoning', () => {
    const { p } = make(80);
    p.phase('Asking claude');
    p.llm({ type: 'answer-start' });
    p.llm({ type: 'text', text: '{"sections": {"title": "wrong"' });
    expect(p.frame()[0]).toContain('Writing the tour');
    p.llm({ type: 'notice', text: 'Answer rejected (schema: /sections: must be array); the model is retrying' });
    p.llm({ type: 'thinking', text: 'Oops, the shape was wrong. Let me resubmit.' });
    let f = p.frame();
    expect(f[0]).toContain('Hatching');
    expect(f[1]).toBe('  ↻ Answer rejected (schema: /sections: must be array); the model is retrying');
    expect(f[2]).toContain('resubmit');
    p.llm({ type: 'answer-start' });
    p.llm({ type: 'text', text: '{"title": "Right", "sections": [{"title": "One"}]}' });
    f = p.frame();
    expect(f[0]).toBe('✢ Writing the tour… 0s · 1 section so far');
    expect(f.slice(1)).toEqual(['  ↻ Answer rejected (schema: /sections: must be array); the model is retrying', '  🐣 Right', '  ✓ One']);
  });

  it('rotates the verb on an interval', () => {
    let t = 0;
    const p = new LiveProgress(new FakeStream(), { color: false, width: 60, now: () => t, verbs: ['Hatching', 'Pecking', 'Nesting'], verbIntervalMs: 7500 });
    p.phase('Asking claude');
    const verb = () => p.frame()[0]!.split(' ')[1];
    expect(verb()).toBe('Hatching…');
    t = 7_400;
    expect(verb()).toBe('Hatching…');
    t = 7_600;
    expect(verb()).toBe('Pecking…');
    t = 15_100;
    expect(verb()).toBe('Nesting…');
    t = 22_600;
    expect(verb()).toBe('Hatching…');
  });

  it('shows byte progress for opaque commands', () => {
    const { p } = make();
    p.phase('Asking llm');
    p.llm({ type: 'output', bytes: 2048 });
    expect(p.frame()).toEqual(['✢ Hatching… 0s · 2.0 KB received']);
  });

  it('erases its block on redraw and on stop, and summarizes usage', () => {
    const { p, stream, tick } = make();
    p.phase('Asking claude');
    p.render();
    p.render();
    expect(stream.chunks[1]).toMatch(/^\x1b\[1A\x1b\[0J/);
    p.llm({ type: 'usage', outputTokens: 1500, thinkingTokens: 400, model: 'claude-sonnet-5' });
    tick(65_000);
    expect(p.summary()).toBe('✻ Hatched in 1m 5s · 1.5k tokens (400 thinking) · claude-sonnet-5');
    p.stop('done');
    expect(stream.chunks.at(-1)).toBe('\x1b[1A\x1b[0Jdone\n\x1b[?25h');
    p.render();
    expect(stream.chunks.at(-1)).toBe('\x1b[1A\x1b[0Jdone\n\x1b[?25h'); // no output after stop
  });
});

describe('extractTitles', () => {
  it('finds title values in partial JSON and unescapes them', () => {
    expect(extractTitles('{"title": "A \\"b\\" \\\\ c", "x": {"title":"d"}, "title": "e')).toEqual(['A "b" \\ c', 'd']);
    expect(extractTitles('nothing')).toEqual([]);
  });
});
