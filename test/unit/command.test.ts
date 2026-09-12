import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmFailedError } from '../../src/core/errors.js';
import { CommandProvider } from '../../src/llm/command.js';
import type { LlmEvent } from '../../src/llm/provider.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-llm.mjs');
const FAKE_CLAUDE = join(__dirname, '..', 'fixtures', 'fake-claude-stream.mjs');

describe('CommandProvider', () => {
  it('pipes the prompt through stdin and returns stdout', async () => {
    const p = new CommandProvider({ command: ['node', FAKE], promptVia: 'stdin', timeoutMs: 10_000 });
    const out = await p.complete('[F1.H1] @@\n### F1 a.ts (x)');
    expect(JSON.parse(out).sections[0].excerpts[0].hunk).toBe('F1.H1');
  });

  it('substitutes {prompt} in arg mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bb-cmd-'));
    const capture = join(dir, 'prompt.txt');
    const p = new CommandProvider({ command: ['node', FAKE, '{prompt}'], promptVia: 'arg', timeoutMs: 10_000, env: { FAKE_LLM_ARG: '1', FAKE_LLM_CAPTURE: capture } });
    await p.complete('hello prompt');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(capture, 'utf8')).toBe('hello prompt');
  });

  it('reports nonzero exits with the stderr tail', async () => {
    const p = new CommandProvider({ command: ['node', FAKE], promptVia: 'stdin', timeoutMs: 10_000, env: { FAKE_LLM_MODE: 'fail' } });
    await expect(p.complete('x')).rejects.toThrow(/exit 2.*\n.*boom: model unavailable/s);
  });

  it('reports a missing executable', async () => {
    const p = new CommandProvider({ command: ['definitely-not-a-real-binary-bb'], promptVia: 'stdin', timeoutMs: 10_000 });
    await expect(p.complete('x')).rejects.toThrow(LlmFailedError);
    await expect(p.complete('x')).rejects.toThrow(/not found/);
  });

  it('times out', async () => {
    const p = new CommandProvider({ command: ['node', '-e', 'setTimeout(()=>{}, 5000)'], promptVia: 'stdin', timeoutMs: 200 });
    await expect(p.complete('x')).rejects.toThrow(/timed out/);
  });

  it('emits thinking/text events and returns structured output for the claude kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bb-cmd-'));
    const argsFile = join(dir, 'args.json');
    const p = new CommandProvider({
      command: ['node', FAKE_CLAUDE, '--model', 'x'], promptVia: 'stdin', timeoutMs: 10_000, kind: 'claude',
      jsonSchema: { type: 'object' }, env: { FAKE_CLAUDE_ARGS: argsFile },
    });
    const events: LlmEvent[] = [];
    const out = await p.complete('[F1.H1] @@', { onEvent: (e) => events.push(e) });
    expect(JSON.parse(out)).toMatchObject({ title: 'Streamed tour' });
    expect(events[0]).toEqual({ type: 'started' });
    expect(events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text).join('')).toBe(
      'Let me look at the diff. There is one hunk that matters; the tour needs one section.',
    );
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ type: 'usage', outputTokens: 120, thinkingTokens: 33, costUsd: 0.02, model: 'claude-fake-1' });
    const { readFile } = await import('node:fs/promises');
    const argv = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    expect(argv).toEqual(['--model', 'x', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', '{"type":"object"}']);
    expect(p.describe()).toBe(`node ${FAKE_CLAUDE} --model x`);
  });

  it('handles text-only answers, result errors, and missing results for the claude kind', async () => {
    const mk = (mode: string) => new CommandProvider({ command: ['node', FAKE_CLAUDE], promptVia: 'stdin', timeoutMs: 10_000, kind: 'claude', env: { FAKE_CLAUDE_MODE: mode } });
    expect(JSON.parse(await mk('text-only').complete('x'))).toMatchObject({ title: 'Streamed tour' });
    await expect(mk('error').complete('x')).rejects.toThrow(/Claude reported an error: API overloaded/);
    await expect(mk('no-result').complete('x')).rejects.toThrow(/no result/);
  });

  it('reports byte progress for plain commands', async () => {
    const p = new CommandProvider({ command: ['node', FAKE], promptVia: 'stdin', timeoutMs: 10_000 });
    const events: LlmEvent[] = [];
    await p.complete('[F1.H1] @@', { onEvent: (e) => events.push(e) });
    expect(events[0]).toEqual({ type: 'started' });
    const last = events.at(-1) as { type: string; bytes: number };
    expect(last.type).toBe('output');
    expect(last.bytes).toBeGreaterThan(10);
  });

  it('describes the command with quoting', () => {
    const p = new CommandProvider({ command: ['claude', '-p', '--tools', '', 'two words'], promptVia: 'stdin', timeoutMs: 1 });
    expect(p.describe()).toBe(`claude -p --tools "" 'two words'`);
  });
});
