import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffStats, parseDiff } from '../../src/git/parse.js';

const fixture = (name: string) => readFile(join(__dirname, '..', 'fixtures', 'diffs', name), 'utf8');

describe('parseDiff', () => {
  it('parses a mixed diff into files, hunks and numbered lines', async () => {
    const diff = parseDiff(await fixture('mixed.diff'));
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));

    expect(diff.files.map((f) => f.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']);

    const app = byPath['src/app.ts']!;
    expect(app.status).toBe('modified');
    expect(app.hunks).toHaveLength(2);
    expect(app.hunks.map((h) => h.id)).toEqual(['F1.H1', 'F1.H2']);
    expect(app.additions).toBe(4);
    expect(app.deletions).toBe(2);
    expect(app.hunks[1]!.header).toBe('export function helper() {');
    // line numbering
    const h1 = app.hunks[0]!;
    expect(h1.lines[0]).toEqual({ type: 'ctx', oldNo: 1, newNo: 1, text: "import { a } from './a';" });
    expect(h1.lines[1]).toEqual({ type: 'del', oldNo: 2, text: "import { b } from './b';" });
    expect(h1.lines[2]).toEqual({ type: 'add', newNo: 2, text: "import { b, c } from './b';" });
    expect(h1.lines[3]).toEqual({ type: 'add', newNo: 3, text: "import { d } from './d';" });
    expect(h1.lines[4]).toEqual({ type: 'ctx', oldNo: 3, newNo: 4, text: '' });

    expect(byPath['src/new.ts']).toMatchObject({ status: 'added', additions: 3, deletions: 0 });
    expect(byPath['src/gone.ts']).toMatchObject({ status: 'deleted', additions: 0, deletions: 2 });
    expect(byPath['lib/new-name.ts']).toMatchObject({ status: 'renamed', oldPath: 'lib/old-name.ts', additions: 1, deletions: 1 });
    expect(byPath['docs/b.md']).toMatchObject({ status: 'renamed', oldPath: 'docs/a.md', hunks: [] });
    expect(byPath['img/logo.png']).toMatchObject({ binary: true, hunks: [], additions: 0 });
    expect(byPath['my file.txt']).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(byPath['my file.txt']!.hunks[0]!.lines).toHaveLength(2);
    expect(byPath['scripts/run.sh']).toMatchObject({ status: 'modified', hunks: [] });

    expect(diffStats(diff)).toEqual({ files: 8, additions: 9, deletions: 6 });
  });

  it('handles an empty diff', () => {
    expect(parseDiff('')).toEqual({ files: [] });
  });

  it('unquotes special paths', () => {
    const raw = [
      'diff --git "a/we\\tird.txt" "b/we\\tird.txt"',
      'index 1..2 100644',
      '--- "a/we\\tird.txt"',
      '+++ "b/we\\tird.txt"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    expect(parseDiff(raw).files[0]!.path).toBe('we\tird.txt');
  });
});
