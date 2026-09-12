import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/core/prompt/build.js';
import type { TourSource } from '../../src/core/types.js';
import { parseDiff } from '../../src/git/parse.js';

const source: TourSource = { kind: 'range', base: 'main', head: 'feat/x', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBase: 'a'.repeat(40), resolvedBy: 'explicit' };

async function mixed() {
  return parseDiff(await readFile(join(__dirname, '..', 'fixtures', 'diffs', 'mixed.diff'), 'utf8'));
}

describe('buildPrompt', () => {
  it('includes rules, context, file table and hunk ids', async () => {
    const diff = await mixed();
    const { prompt, truncation } = buildPrompt({
      source,
      branch: 'feat/x',
      diff,
      commits: [{ sha: '2', subject: 'second' }, { sha: '1', subject: 'first' }],
      pullRequest: { number: 12, title: 'Add things', body: 'Because reasons.', url: 'u', baseRefName: 'main', headRefName: 'feat/x' },
      maxBytes: 1_000_000,
    });
    expect(truncation).toEqual({ truncated: [], omitted: [] });
    expect(prompt).toContain('Respond with ONLY a JSON object');
    expect(prompt).toContain('feat/x compared against main (at merge-base aaaaaaa)');
    expect(prompt).toContain('## Pull request #12: Add things\nBecause reasons.');
    expect(prompt).toContain('## Commits (oldest first)\n- first\n- second');
    expect(prompt).toContain('## Files (8 files, +9 -6)');
    expect(prompt).toContain('F4  renamed   lib/old-name.ts -> lib/new-name.ts  +1 -1');
    expect(prompt).toContain('### F1 src/app.ts (modified, +12 -3)'.replace('+12 -3', '+4 -2'));
    expect(prompt).toContain('[F1.H2] @@ -20,4 +21,5 @@ export function helper() {');
    expect(prompt).toContain("-import { b } from './b';\n+import { b, c } from './b';");
    expect(prompt).toContain('### F6 img/logo.png (binary)\n(binary file, no textual diff)');
    expect(prompt).not.toContain('Note: to fit the size budget');
  });

  it('describes working tree sources', async () => {
    const { prompt } = buildPrompt({ source: { kind: 'working', headSha: 'x', staged: true, resolvedBy: 'explicit' }, branch: null, diff: await mixed(), commits: [], maxBytes: 1e6 });
    expect(prompt).toContain('Staged (uncommitted) changes (detached HEAD).');
  });

  it('truncates the largest files first, then omits, to meet the budget', async () => {
    // A synthetic diff: one big file with three hunks plus the small mixed fixture.
    const big = ['diff --git a/big.ts b/big.ts', 'index 1..2 100644', '--- a/big.ts', '+++ b/big.ts'];
    for (let h = 0; h < 3; h++) {
      big.push(`@@ -${h * 100 + 1},50 +${h * 100 + 1},100 @@ chunk ${h}`);
      for (let i = 0; i < 50; i++) big.push(` context line number ${h}-${i} with some padding text`);
      for (let i = 0; i < 50; i++) big.push(`+added line number ${h}-${i} with some more padding text here`);
    }
    const diff = parseDiff(big.join('\n') + '\n' + (await readFile(join(__dirname, '..', 'fixtures', 'diffs', 'mixed.diff'), 'utf8')));
    const full = buildPrompt({ source, branch: null, diff, commits: [], maxBytes: 1e6 }).prompt;

    const budget = Buffer.byteLength(full) - 4000;
    const { prompt, truncation } = buildPrompt({ source, branch: null, diff, commits: [], maxBytes: budget });
    expect(truncation).toEqual({ truncated: ['big.ts'], omitted: [] });
    expect(prompt).toContain('Note: to fit the size budget');
    expect(prompt).toContain('- Truncated (only the shown hunk may be referenced): big.ts');
    expect(prompt).toContain('[F1.H1] @@ -1,50 +1,100 @@ chunk 0');
    expect(prompt).not.toContain('[F1.H2]');
    expect(prompt).toContain('... [truncated: 260 more lines across 3 hunks]');
    expect(prompt).toContain('[F2.H2]'); // small files untouched
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(budget);

    // A budget that only fits once big.ts is gone entirely (small files cannot shrink).
    const smallOnly = buildPrompt({ source, branch: null, diff: parseDiff(await readFile(join(__dirname, '..', 'fixtures', 'diffs', 'mixed.diff'), 'utf8')), commits: [], maxBytes: 1e6 });
    const tight = buildPrompt({ source, branch: null, diff, commits: [], maxBytes: Buffer.byteLength(smallOnly.prompt) + 300 });
    expect(tight.truncation.omitted).toContain('big.ts');
    expect(tight.prompt).toContain('### F1 big.ts (modified, +150 -0)\n(diff omitted for length)');

    const tiny = buildPrompt({ source, branch: null, diff, commits: [], maxBytes: 10 });
    expect(tiny.truncation.truncated).toEqual([]);
    expect(tiny.truncation.omitted.length).toBe(diff.files.filter((f) => f.hunks.length > 0).length);
  });
});
