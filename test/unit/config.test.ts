import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DEFAULT_CONFIG,
  deepMerge,
  loadConfig,
  resolveLlm,
  shellSplit,
  userConfigPath,
  defaultCacheDir,
} from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bb-config-'));
}

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays', () => {
    const out = deepMerge({ a: { x: 1, y: [1, 2] }, b: 1 }, { a: { y: [3] }, c: 2 });
    expect(out).toEqual({ a: { x: 1, y: [3] }, b: 1, c: 2 });
  });
  it('ignores undefined patch values', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });
});

describe('shellSplit', () => {
  it('splits on whitespace honoring quotes and escapes', () => {
    expect(shellSplit(`claude -p --tools "" --model 'sonnet 5' a\\ b`)).toEqual([
      'claude', '-p', '--tools', '', '--model', 'sonnet 5', 'a b',
    ]);
  });
  it('rejects unterminated quotes', () => {
    expect(() => shellSplit(`llm "oops`)).toThrow(ConfigError);
  });
});

describe('paths', () => {
  it('honors XDG variables', () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: '/x/cfg' })).toBe('/x/cfg/baby-bird/config.json');
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache/baby-bird');
  });
});

describe('loadConfig', () => {
  it('returns defaults when nothing is configured', async () => {
    const dir = await scratch();
    const loaded = await loadConfig({ env: { XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir } });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.cacheDir).toBe(join(dir, 'baby-bird'));
    expect(loaded.layers.find((l) => l.name === 'user')?.found).toBe(false);
  });

  it('cascades user -> project -> env -> flags with arrays replacing', async () => {
    const dir = await scratch();
    const root = join(dir, 'repo');
    await mkdir(join(dir, 'baby-bird'), { recursive: true });
    await mkdir(join(root, '.baby-bird'), { recursive: true });
    await writeFile(
      join(dir, 'baby-bird', 'config.json'),
      JSON.stringify({ llm: { preset: 'claude-opus', presets: { mine: { command: ['my-llm'] } } }, git: { exclude: ['**/a'] } }),
    );
    await writeFile(
      join(root, '.baby-bird', 'config.json'),
      JSON.stringify({ llm: { presets: { proj: { command: ['proj-llm'] } } }, git: { exclude: ['**/b'] }, render: { width: 100 } }),
    );
    const loaded = await loadConfig({
      gitRoot: root,
      env: { XDG_CONFIG_HOME: dir, BB_PRESET: 'mine', BB_NO_CACHE: '1', NO_COLOR: '1' },
      overrides: { render: { color: 'always' } },
    });
    const c = loaded.config;
    expect(c.llm.preset).toBe('mine');
    expect(Object.keys(c.llm.presets).sort()).toEqual(['mine', 'proj']);
    expect(c.git.exclude).toEqual(['**/b']);
    expect(c.render.width).toBe(100);
    expect(c.cache.enabled).toBe(false);
    expect(c.render.color).toBe('always');
    const env = loaded.layers.find((l) => l.name === 'env');
    expect(env?.detail).toBe('BB_PRESET, BB_NO_CACHE, NO_COLOR');
  });

  it('rejects invalid JSON and invalid shapes', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'baby-bird'), { recursive: true });
    await writeFile(join(dir, 'baby-bird', 'config.json'), '{ nope');
    await expect(loadConfig({ env: { XDG_CONFIG_HOME: dir } })).rejects.toThrow(/Invalid JSON/);
    await writeFile(join(dir, 'baby-bird', 'config.json'), JSON.stringify({ llm: { timeoutMs: 'soon' } }));
    await expect(loadConfig({ env: { XDG_CONFIG_HOME: dir } })).rejects.toThrow(/Invalid config/);
  });

  it('accepts BB_LLM_COMMAND as a custom invocation', async () => {
    const dir = await scratch();
    const loaded = await loadConfig({ env: { XDG_CONFIG_HOME: dir, BB_LLM_COMMAND: 'ollama run "llama 3"' } });
    expect(loaded.config.llm.command).toEqual(['ollama', 'run', 'llama 3']);
  });
});

describe('resolveLlm', () => {
  it('uses the default preset', () => {
    const r = resolveLlm(DEFAULT_CONFIG);
    expect(r.preset).toBe('claude');
    expect(r.command).toEqual(BUILTIN_PRESETS.claude!.command);
    expect(r.promptVia).toBe('stdin');
    expect(r.kind).toBe('claude');
    expect(r.jsonSchema).toBe(false);
    expect(resolveLlm(deepMerge(DEFAULT_CONFIG, { llm: { jsonSchema: true } })).jsonSchema).toBe(true);
  });

  it('defaults custom commands to the plain kind unless told otherwise', () => {
    expect(resolveLlm(deepMerge(DEFAULT_CONFIG, { llm: { command: ['my-llm'] } })).kind).toBe('plain');
    expect(resolveLlm(deepMerge(DEFAULT_CONFIG, { llm: { command: ['my-claude'], kind: 'claude' } })).kind).toBe('claude');
    expect(resolveLlm(deepMerge(DEFAULT_CONFIG, { llm: { preset: 'claude-sonnet', kind: 'plain' } })).kind).toBe('plain');
  });

  it('appends args to a built-in preset', () => {
    const r = resolveLlm(deepMerge(DEFAULT_CONFIG, { llm: { preset: 'claude-sonnet', args: ['--verbose'] } }));
    expect(r.command).toEqual([...BUILTIN_PRESETS['claude-sonnet']!.command, '--verbose']);
  });

  it('lets user presets override built-ins and carry promptVia', () => {
    const cfg = deepMerge(DEFAULT_CONFIG, {
      llm: { preset: 'claude', presets: { claude: { command: ['my-claude', '{prompt}'], promptVia: 'arg' } } },
    });
    const r = resolveLlm(cfg);
    expect(r.command).toEqual(['my-claude', '{prompt}']);
    expect(r.promptVia).toBe('arg');
  });

  it('prefers a custom command over any preset', () => {
    const cfg = deepMerge(DEFAULT_CONFIG, { llm: { preset: 'does-not-exist', command: ['x'], args: ['-y'] } });
    const r = resolveLlm(cfg);
    expect(r).toMatchObject({ preset: null, command: ['x', '-y'] });
  });

  it('errors on an unknown preset with the available names', () => {
    const cfg = deepMerge(DEFAULT_CONFIG, { llm: { preset: 'nope' } });
    expect(() => resolveLlm(cfg)).toThrow(/Unknown LLM preset "nope"/);
    try {
      resolveLlm(cfg);
    } catch (err) {
      expect((err as ConfigError).hint).toMatch(/claude-sonnet/);
    }
  });
});
