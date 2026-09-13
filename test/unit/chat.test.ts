import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChatContext } from '../../src/core/chat.js';
import { LlmFailedError } from '../../src/core/errors.js';
import type { Tour, TourSource } from '../../src/core/types.js';
import { parseDiff } from '../../src/git/parse.js';
import { chatArgv, chatSlots, launchChat } from '../../src/llm/chat.js';

const FAKE_CHAT = join(__dirname, '..', 'fixtures', 'fake-chat.mjs');

describe('chatArgv', () => {
  it('fills the context, context-file and message tokens', () => {
    const argv = chatArgv({ command: ['tool', '--sys', '{context}', '--file', '{context-file}', 'say: {message}'], contextFile: '/tmp/ctx', context: 'CTX', message: 'hi' });
    expect(argv).toEqual(['tool', '--sys', 'CTX', '--file', '/tmp/ctx', 'say: hi']);
  });

  it('drops bare {message} entries when there is no message', () => {
    expect(chatArgv({ command: ['claude', '{message}'], contextFile: 'f', context: 'c' })).toEqual(['claude']);
    expect(chatArgv({ command: ['claude', '{message}'], contextFile: 'f', context: 'c', message: '   ' })).toEqual(['claude']);
    expect(chatArgv({ command: ['claude', '{message}'], contextFile: 'f', context: 'c', message: 'q' })).toEqual(['claude', 'q']);
  });

  it('reports which slots a command has', () => {
    expect(chatSlots(['claude', '--append-system-prompt-file', '{context-file}', '{message}'])).toEqual({ context: true, message: true });
    expect(chatSlots(['llm', 'chat', '-s', '{context}'])).toEqual({ context: true, message: false });
    expect(chatSlots(['bare'])).toEqual({ context: false, message: false });
  });
});

describe('launchChat', () => {
  it('writes the context to a temp file, fills argv, runs in cwd, and reports the exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bb-chat-test-'));
    const capture = join(dir, 'capture.json');
    const outcome = await launchChat({
      command: ['node', FAKE_CHAT, '--file', '{context-file}', '{message}'],
      context: '# hello context',
      message: 'what is this?',
      cwd: dir,
      env: { FAKE_CHAT_CAPTURE: capture, FAKE_CHAT_EXIT: '3', CLAUDECODE: '1' },
      stdio: 'ignore',
    });
    expect(outcome).toEqual({ exitCode: 3, signal: null });
    const rec = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[]; cwd: string; files: Record<string, string>; claudecode: string | null };
    expect(rec.argv.slice(0, 2)).toEqual(['--file', expect.stringMatching(/bb-chat-.*context\.md$/)]);
    expect(rec.argv[2]).toBe('what is this?');
    expect(rec.files[rec.argv[1]!]).toBe('# hello context');
    expect(rec.cwd).toBe(await realpath(dir)); // macOS: /var is a symlink to /private/var
    expect(rec.claudecode).toBeNull();
    // The temp file is gone once the chat ends.
    await expect(readFile(rec.argv[1]!, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('reports a missing executable', async () => {
    await expect(launchChat({ command: ['definitely-not-a-real-chat-bb'], context: 'c', cwd: tmpdir(), stdio: 'ignore' })).rejects.toThrow(LlmFailedError);
  });
});

const source: TourSource = { kind: 'range', base: 'main', head: 'feat/x', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBase: 'a'.repeat(40), resolvedBy: 'explicit' };

function tour(): Tour {
  return {
    version: 1,
    generatedAt: '2026-09-12T10:00:00.000Z',
    source,
    generator: { preset: 'claude', command: ['claude'] },
    pullRequest: { number: 12, title: 'Add things', url: 'https://example/pr/12' },
    title: 'Add things',
    summary: 'Things were added.',
    stats: { files: 2, additions: 5, deletions: 1 },
    sections: [
      {
        id: 's1',
        title: 'The main idea',
        description: 'Why and what.',
        files: ['src/app.ts'],
        stats: { files: 1, additions: 4, deletions: 1 },
        excerpts: [
          {
            file: 'src/app.ts',
            hunkId: 'F1.H1',
            note: 'look here',
            oldStart: 1,
            newStart: 1,
            lines: [
              { type: 'ctx', oldNo: 1, newNo: 1, text: 'import a;' },
              { type: 'del', oldNo: 2, text: 'old();' },
              { type: 'add', newNo: 2, text: 'new();' },
            ],
          },
        ],
      },
    ],
  };
}

describe('buildChatContext', () => {
  it('renders the framing, the tour, and the change with its diff', async () => {
    const diff = parseDiff(await readFile(join(__dirname, '..', 'fixtures', 'diffs', 'mixed.diff'), 'utf8'));
    const { text, truncation } = buildChatContext({
      tour: tour(),
      change: { source, branch: 'feat/x', diff, commits: [{ sha: '1', subject: 'first' }] },
      maxBytes: 1_000_000,
      tourPath: '/cache/tours/abc.json',
    });
    expect(truncation).toEqual({ truncated: [], omitted: [] });
    expect(text).toMatch(/^# About this conversation/);
    expect(text).toContain('# The code tour: Add things');
    expect(text).toContain('- Change: feat/x compared against main (at merge-base aaaaaaa).');
    expect(text).toContain('- Revisions: base aaaaaaaaaaaa, head bbbbbbbbbbbb; `git diff aaaaaaaaaaaa bbbbbbbbbbbb` reproduces the diff');
    expect(text).toContain('- Pull request #12: Add things (https://example/pr/12)');
    expect(text).toContain('- Tour JSON: /cache/tours/abc.json');
    expect(text).toContain('## 1. The main idea\n\n1 file, +4 -1\n\nWhy and what.\n\nFiles:\n- src/app.ts');
    expect(text).toContain('Excerpt `src/app.ts:1` (hunk F1.H1) — look here\n\n```\n1 1 │ import a;\n2   │-old();\n  2 │+new();\n```');
    // The change section is the same rendering the tour prompt uses.
    expect(text).toContain('# The change\n\n## Source\nfeat/x compared against main (at merge-base aaaaaaa).');
    expect(text).toContain('## Commits (oldest first)\n- first');
    expect(text).toContain('[F1.H2] @@ -20,4 +21,5 @@ export function helper() {');
  });

  it('keeps the tour and shortens the diff to fit the budget', async () => {
    const diff = parseDiff(await readFile(join(__dirname, '..', 'fixtures', 'diffs', 'mixed.diff'), 'utf8'));
    const { text, truncation } = buildChatContext({ tour: tour(), change: { source, branch: null, diff, commits: [] }, maxBytes: 1_800 });
    expect(text).toContain('# The code tour: Add things');
    expect(text).toContain('Excerpt `src/app.ts:1`');
    expect(truncation.truncated.length + truncation.omitted.length).toBeGreaterThan(0);
    expect(text).toContain('Note: to fit the size budget');
  });

  it('describes working-tree sources with the head sha', () => {
    const working: TourSource = { kind: 'working', headSha: 'c'.repeat(40), staged: true, resolvedBy: 'explicit' };
    const { text } = buildChatContext({ tour: { ...tour(), source: working }, change: { source: working, branch: 'main', diff: { files: [] }, commits: [] }, maxBytes: 1e6 });
    expect(text).toContain('- Change: Staged (uncommitted) changes on branch main.');
    expect(text).toContain('- Revisions: HEAD is cccccccccccc');
    // The change section phrases it the same way.
    expect(text).toContain('## Source\nStaged (uncommitted) changes on branch main.');
  });
});
