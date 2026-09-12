import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/core/errors.js';
import type { Tour } from '../../src/core/types.js';
import { CliRenderer, relativeTime, wrap } from '../../src/render/cli.js';

const tour: Tour = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: { kind: 'range', base: 'main', head: 'feat/x', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBase: 'abcdef0123', resolvedBy: 'pull-request' },
  generator: { preset: 'claude-sonnet', command: ['claude', '-p'] },
  pullRequest: { number: 12, title: 'Add widgets', url: 'https://example.com/pr/12' },
  title: 'Add widgets',
  summary: 'This change adds widgets. It is long enough that it should wrap when the terminal is narrow, which we test below.',
  stats: { files: 2, additions: 10, deletions: 3 },
  sections: [
    {
      id: 's1', title: 'The widget type', description: 'Defines the widget.\n\nSecond paragraph.', files: ['src/widget.ts'],
      stats: { files: 1, additions: 8, deletions: 1 },
      excerpts: [
        {
          file: 'src/widget.ts', hunkId: 'F1.H1', note: 'the interface', oldStart: 9, newStart: 10,
          lines: [
            { type: 'ctx', oldNo: 9, newNo: 10, text: 'export interface Widget {' },
            { type: 'del', oldNo: 10, text: '  name: string' },
            { type: 'add', newNo: 11, text: '  name: string;' },
            { type: 'add', newNo: 12, text: '\tsize: number;' },
          ],
        },
      ],
    },
    { id: 's2', title: 'Other changes', description: '', files: ['README.md'], stats: { files: 1, additions: 2, deletions: 2 }, excerpts: [] },
  ],
};

describe('CliRenderer', () => {
  it('renders header, contents, sections and excerpts without color', () => {
    const out = new CliRenderer().render(tour, { color: false, width: 80, fromCache: true });
    expect(out).not.toMatch(/\x1b\[/);
    expect(out).toContain('🐣 Add widgets');
    expect(out).toContain('feat/x vs main (merge-base abcdef0) · base from pull request');
    expect(out).toContain('PR #12: Add widgets  https://example.com/pr/12');
    expect(out).toContain('2 files · +10 -3 · 2 sections · claude-sonnet, cached');
    expect(out).toContain('Contents\n  1. The widget type');
    expect(out).toMatch(/1\. The widget type\s+1 file · \+8 -1\n/);
    expect(out).toContain('1. The widget type   (1/2)');
    expect(out).toContain('   Defines the widget.\n\n   Second paragraph.');
    expect(out).toContain('   src/widget.ts:10  the interface');
    expect(out).toContain('    9 10 │ export interface Widget {');
    expect(out).toContain('   10    │-  name: string\n');
    expect(out).toContain('      11 │+  name: string;');
    expect(out).toContain('      12 │+    size: number;');
    expect(out).toContain('2. Other changes   (2/2)');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('colors output when asked', () => {
    const out = new CliRenderer().render(tour, { color: true, width: 80 });
    expect(out).toMatch(/\x1b\[/);
  });

  it('renders a single section and rejects a bad index', () => {
    const r = new CliRenderer();
    const out = r.render(tour, { color: false, width: 80, section: 2 });
    expect(out).toContain('2. Other changes');
    expect(out).not.toContain('Contents');
    expect(out).not.toContain('The widget type   (1/2)');
    expect(() => r.render(tour, { color: false, width: 80, section: 3 })).toThrow(UsageError);
  });

  it('wraps the summary to the width', () => {
    const out = new CliRenderer().render(tour, { color: false, width: 40 });
    const summaryLines = out.split('\n').filter((l) => l.startsWith('This change') || l.startsWith('wrap when'));
    expect(summaryLines.length).toBeGreaterThan(0);
    for (const line of out.split('\n')) if (!line.includes('│')) expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe('wrap', () => {
  it('wraps words and keeps paragraph breaks', () => {
    expect(wrap('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd']);
    expect(wrap('one\n\ntwo', 10)).toEqual(['one', '', 'two']);
    expect(wrap('', 10)).toEqual([]);
  });
});

describe('relativeTime', () => {
  it('formats coarse ages', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    expect(relativeTime('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-01-01T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-01-01T02:00:00Z', now)).toBe('10 h ago');
    expect(relativeTime('2025-12-20T12:00:00Z', now)).toBe('12 days ago');
  });
});
