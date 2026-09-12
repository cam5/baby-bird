import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmFailedError } from '../../src/core/errors.js';
import { CommandProvider } from '../../src/llm/command.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-llm.mjs');

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

  it('describes the command with quoting', () => {
    const p = new CommandProvider({ command: ['claude', '-p', '--tools', '', 'two words'], promptVia: 'stdin', timeoutMs: 1 });
    expect(p.describe()).toBe(`claude -p --tools "" 'two words'`);
  });
});
