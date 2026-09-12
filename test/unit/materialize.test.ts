import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeTour, OTHER_CHANGES_TITLE, sliceHunk } from '../../src/core/materialize.js';
import type { TourSource } from '../../src/core/types.js';
import { parseDiff } from '../../src/git/parse.js';

const source: TourSource = { kind: 'working', headSha: 'h', staged: false, resolvedBy: 'dirty-tree' };
const generator = { preset: 'claude', command: ['claude', '-p'] };

async function mixed() {
  return parseDiff(await readFile(join(__dirname, '..', 'fixtures', 'diffs', 'mixed.diff'), 'utf8'));
}

describe('materializeTour', () => {
  it('resolves references, computes stats, and adds an "Other changes" section', async () => {
    const diff = await mixed();
    const warnings: string[] = [];
    const tour = materializeTour({
      diff,
      source,
      generator,
      maxExcerptLines: 60,
      warn: (m) => warnings.push(m),
      now: () => new Date('2026-01-02T03:04:05Z'),
      pullRequest: { number: 3, title: 'PR', body: '', url: 'http://pr', baseRefName: 'main', headRefName: 'x' },
      output: {
        title: '  Do the thing ',
        summary: 'Summary.',
        sections: [
          {
            title: 'Imports',
            description: 'Adds imports.',
            files: ['src/app.ts', './src/new.ts', 'nope.ts'],
            excerpts: [
              { hunk: 'F1.H1', note: ' first hunk ' },
              { hunk: 'F9.H9' },
              { hunk: 'F4.H1', lines: [4, 4] },
            ],
          },
          { title: 'Cleanup', description: 'Removes gone.', excerpts: [{ hunk: 'F3.H1' }] },
        ],
      },
    });

    expect(tour.title).toBe('Do the thing');
    expect(tour.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(tour.pullRequest).toEqual({ number: 3, title: 'PR', url: 'http://pr' });
    expect(tour.stats).toEqual({ files: 8, additions: 9, deletions: 6 });
    expect(warnings).toEqual([
      'Section "Imports" references unknown file nope.ts; ignoring',
      'Section "Imports" references unknown hunk F9.H9; ignoring',
    ]);

    const [s1, s2, other] = tour.sections;
    expect(s1).toMatchObject({ id: 's1', files: ['src/app.ts', 'src/new.ts', 'lib/new-name.ts'], stats: { files: 3, additions: 8, deletions: 3 } });
    expect(s1!.excerpts).toHaveLength(2);
    expect(s1!.excerpts[0]).toMatchObject({ file: 'src/app.ts', hunkId: 'F1.H1', note: 'first hunk', oldStart: 1, newStart: 1 });
    expect(s1!.excerpts[0]!.lines).toHaveLength(7);
    // lines [4,4] on F4.H1 keeps the del/add pair at new line 4
    expect(s1!.excerpts[1]!.lines.map((l) => [l.type, l.text])).toEqual([
      ['del', '  return a;'],
      ['add', '  return a + 1;'],
    ]);
    expect(s1!.excerpts[1]).toMatchObject({ oldStart: 4, newStart: 4 });

    expect(s2).toMatchObject({ id: 's2', files: ['src/gone.ts'], stats: { files: 1, additions: 0, deletions: 2 } });

    expect(other).toMatchObject({
      id: 's3',
      title: OTHER_CHANGES_TITLE,
      files: ['docs/b.md', 'img/logo.png', 'my file.txt', 'scripts/run.sh'],
      excerpts: [],
      stats: { files: 4, additions: 1, deletions: 1 },
    });
  });

  it('omits the extra section when every file is claimed', async () => {
    const diff = await mixed();
    const tour = materializeTour({
      diff, source, generator, maxExcerptLines: 60,
      output: { title: 't', summary: 's', sections: [{ title: 'All', description: 'd', files: diff.files.map((f) => f.path) }] },
    });
    expect(tour.sections).toHaveLength(1);
    expect(tour.sections[0]!.stats).toEqual(tour.stats);
  });
});

describe('sliceHunk', () => {
  const hunk = {
    id: 'F1.H1', oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, header: '',
    lines: [
      { type: 'ctx' as const, oldNo: 10, newNo: 10, text: 'a' },
      { type: 'del' as const, oldNo: 11, text: 'b' },
      { type: 'add' as const, newNo: 11, text: 'B' },
      { type: 'add' as const, newNo: 12, text: 'C' },
      { type: 'ctx' as const, oldNo: 12, newNo: 13, text: 'd' },
    ],
  };
  it('keeps deletions positioned inside the requested range', () => {
    expect(sliceHunk(hunk, [11, 12], 60).map((l) => l.text)).toEqual(['b', 'B', 'C']);
    expect(sliceHunk(hunk, [13, 11], 60).map((l) => l.text)).toEqual(['b', 'B', 'C', 'd']);
  });
  it('falls back to the whole hunk for an empty range and caps length', () => {
    expect(sliceHunk(hunk, [90, 99], 60)).toHaveLength(5);
    expect(sliceHunk(hunk, undefined, 2)).toHaveLength(2);
  });
});
