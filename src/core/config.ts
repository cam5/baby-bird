import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import { formatIssues } from './schema.js';

// ---------------------------------------------------------------------------
// LLM presets
// ---------------------------------------------------------------------------

export type PromptVia = 'stdin' | 'arg';

export interface LlmPreset {
  /** argv; when promptVia is "arg", any "{prompt}" token is replaced with the prompt. */
  command: string[];
  promptVia?: PromptVia;
  description?: string;
}

/**
 * Claude Code in print mode, stripped down to behave like a plain completion:
 * no tools, no session persistence, and no settings/CLAUDE.md from the cwd.
 * (--bare would also skip keychain reads, which breaks keychain-based logins.)
 */
const CLAUDE_BASE = ['claude', '-p', '--no-session-persistence', '--setting-sources', '', '--tools', ''];

export const BUILTIN_PRESETS: Readonly<Record<string, LlmPreset>> = Object.freeze({
  claude: {
    command: [...CLAUDE_BASE],
    description: 'Claude Code CLI with its default model',
  },
  'claude-sonnet': {
    command: [...CLAUDE_BASE, '--model', 'sonnet', '--effort', 'high'],
    description: 'Claude Code CLI, Sonnet at high effort',
  },
  'claude-opus': {
    command: [...CLAUDE_BASE, '--model', 'opus', '--effort', 'high'],
    description: 'Claude Code CLI, Opus at high effort',
  },
  'claude-fable': {
    command: [...CLAUDE_BASE, '--model', 'fable', '--effort', 'high'],
    description: 'Claude Code CLI, Fable at high effort',
  },
  'claude-haiku': {
    command: [...CLAUDE_BASE, '--model', 'haiku'],
    description: 'Claude Code CLI, Haiku (fast and cheap)',
  },
  llm: {
    command: ['llm'],
    description: "Simon Willison's llm CLI with its default model",
  },
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PromptViaSchema = z.enum(['stdin', 'arg']);

export const LlmPresetSchema = z.object({
  command: z.array(z.string()).min(1),
  promptVia: PromptViaSchema.optional(),
  description: z.string().optional(),
});

export const ConfigSchema = z.object({
  llm: z.object({
    preset: z.string().min(1),
    presets: z.record(z.string(), LlmPresetSchema),
    args: z.array(z.string()),
    command: z.array(z.string()).min(1).nullable(),
    promptVia: PromptViaSchema.nullable(),
    timeoutMs: z.number().int().positive(),
    maxPromptBytes: z.number().int().positive(),
    env: z.record(z.string(), z.string()),
  }),
  codehost: z.object({
    provider: z.enum(['gh', 'none']),
  }),
  git: z.object({
    defaultBranch: z.string().nullable(),
    exclude: z.array(z.string()),
  }),
  render: z.object({
    color: z.enum(['auto', 'always', 'never']),
    pager: z.enum(['auto', 'always', 'never']),
    maxExcerptLines: z.number().int().positive(),
    width: z.number().int().positive().nullable(),
  }),
  cache: z.object({
    enabled: z.boolean(),
    dir: z.string().nullable(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const PartialConfigSchema = z.object({
  llm: ConfigSchema.shape.llm.partial().optional(),
  codehost: ConfigSchema.shape.codehost.partial().optional(),
  git: ConfigSchema.shape.git.partial().optional(),
  render: ConfigSchema.shape.render.partial().optional(),
  cache: ConfigSchema.shape.cache.partial().optional(),
});

export type PartialConfig = z.infer<typeof PartialConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  llm: {
    preset: 'claude',
    presets: {},
    args: [],
    command: null,
    promptVia: null,
    timeoutMs: 180_000,
    maxPromptBytes: 200_000,
    env: {},
  },
  codehost: { provider: 'gh' },
  git: {
    defaultBranch: null,
    exclude: [
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/Cargo.lock',
      '**/*.min.*',
      '**/dist/**',
      '**/*.snap',
      '**/*.map',
    ],
  },
  render: { color: 'auto', pager: 'auto', maxExcerptLines: 60, width: null },
  cache: { enabled: true, dir: null },
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'baby-bird', 'config.json');
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim() !== '' ? env.XDG_CACHE_HOME : join(homedir(), '.cache');
  return join(base, 'baby-bird');
}

export function projectConfigPath(gitRoot: string): string {
  return join(gitRoot, '.baby-bird', 'config.json');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type LayerName = 'defaults' | 'user' | 'project' | 'env' | 'flags';

export interface ConfigLayer {
  name: LayerName;
  /** File path for file-backed layers. */
  path?: string;
  /** Whether the layer contributed anything (file existed, env vars set, flags passed). */
  found: boolean;
  /** Short human description of what was applied (e.g. env var names). */
  detail?: string;
  data: PartialConfig;
}

export interface LoadConfigOptions {
  /** Git root for project-level config; null/undefined skips the project layer. */
  gitRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  /** CLI flag overrides, applied last. */
  overrides?: PartialConfig;
}

export interface LoadedConfig {
  config: Config;
  layers: ConfigLayer[];
  cacheDir: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge recursively; arrays and scalars replace. `undefined` never overrides. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out as T;
}

async function readFileLayer(name: LayerName, path: string): Promise<ConfigLayer> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { name, path, found: false, data: {} };
    }
    throw new ConfigError(`Could not read ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  const parsed = PartialConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config in ${path}: ${formatIssues(parsed.error)}`);
  }
  return { name, path, found: true, data: parsed.data };
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function envLayer(env: NodeJS.ProcessEnv): ConfigLayer {
  const data: PartialConfig = {};
  const applied: string[] = [];
  const llm: NonNullable<PartialConfig['llm']> = {};

  if (env.BB_PRESET) {
    llm.preset = env.BB_PRESET;
    applied.push('BB_PRESET');
  }
  if (env.BB_LLM_COMMAND) {
    const argv = shellSplit(env.BB_LLM_COMMAND);
    if (argv.length === 0) throw new ConfigError('BB_LLM_COMMAND is set but empty');
    llm.command = argv;
    applied.push('BB_LLM_COMMAND');
  }
  if (Object.keys(llm).length) data.llm = llm;

  if (env.BB_CODEHOST) {
    const provider = env.BB_CODEHOST as Config['codehost']['provider'];
    data.codehost = { provider };
    applied.push('BB_CODEHOST');
  }
  const cache: NonNullable<PartialConfig['cache']> = {};
  if (env.BB_CACHE_DIR) {
    cache.dir = env.BB_CACHE_DIR;
    applied.push('BB_CACHE_DIR');
  }
  if (env.BB_NO_CACHE !== undefined && TRUTHY.has(env.BB_NO_CACHE.toLowerCase())) {
    cache.enabled = false;
    applied.push('BB_NO_CACHE');
  }
  if (Object.keys(cache).length) data.cache = cache;

  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    data.render = { color: 'never' };
    applied.push('NO_COLOR');
  }

  return { name: 'env', found: applied.length > 0, detail: applied.join(', '), data };
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const layers: ConfigLayer[] = [{ name: 'defaults', found: true, data: DEFAULT_CONFIG }];

  layers.push(await readFileLayer('user', userConfigPath(env)));
  if (opts.gitRoot) {
    layers.push(await readFileLayer('project', projectConfigPath(opts.gitRoot)));
  }
  layers.push(envLayer(env));
  if (opts.overrides) {
    const found = Object.keys(opts.overrides).length > 0;
    layers.push({ name: 'flags', found, data: opts.overrides });
  }

  let merged: unknown = {};
  for (const layer of layers) merged = deepMerge(merged, layer.data);

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${formatIssues(parsed.error)}`);
  }
  const config = parsed.data;
  return { config, layers, cacheDir: config.cache.dir ?? defaultCacheDir(env) };
}

// ---------------------------------------------------------------------------
// LLM resolution
// ---------------------------------------------------------------------------

export interface ResolvedLlm {
  command: string[];
  promptVia: PromptVia;
  /** Preset name, or null when a custom command is in use. */
  preset: string | null;
  timeoutMs: number;
  maxPromptBytes: number;
  env: Record<string, string>;
}

export function allPresets(config: Config): Record<string, LlmPreset> {
  return { ...BUILTIN_PRESETS, ...config.llm.presets };
}

export function resolveLlm(config: Config): ResolvedLlm {
  const { llm } = config;
  const common = { timeoutMs: llm.timeoutMs, maxPromptBytes: llm.maxPromptBytes, env: llm.env };

  if (llm.command) {
    return { command: [...llm.command, ...llm.args], promptVia: llm.promptVia ?? 'stdin', preset: null, ...common };
  }

  const presets = allPresets(config);
  const preset = presets[llm.preset];
  if (!preset) {
    const names = Object.keys(presets).sort().join(', ');
    throw new ConfigError(`Unknown LLM preset "${llm.preset}"`, `Available presets: ${names}. Define your own under llm.presets, or set llm.command.`);
  }
  return {
    command: [...preset.command, ...llm.args],
    promptVia: llm.promptVia ?? preset.promptVia ?? 'stdin',
    preset: llm.preset,
    ...common,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Minimal POSIX-ish shell splitting: whitespace separated, single/double quotes, backslash escapes. */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) {
        out.push(cur);
        cur = '';
        inToken = false;
      }
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) throw new ConfigError(`Unterminated quote in command: ${input}`);
  if (inToken) out.push(cur);
  return out;
}
