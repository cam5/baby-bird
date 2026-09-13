import pc from 'picocolors';
import { resolve } from 'node:path';
import type { PartialConfig } from '../core/config.js';
import { loadConfig, type LoadedConfig } from '../core/config.js';
import { gitRoot } from '../git/exec.js';
import { supports256Colors } from '../render/highlight.js';

export interface GlobalFlags {
  cwd?: string;
  debug?: boolean;
  color?: boolean;
  preset?: string;
  cache?: boolean;
  pager?: boolean;
  highlight?: boolean;
  theme?: 'dark' | 'light';
}

export interface Session {
  /** Directory the user pointed at (resolved). */
  cwd: string;
  /** Git root, or null when not in a repository. */
  root: string | null;
  loaded: LoadedConfig;
  debug: (msg: string) => void;
  warn: (msg: string) => void;
  colorEnabled: boolean;
}

export function flagsToOverrides(flags: GlobalFlags): PartialConfig {
  const o: PartialConfig = {};
  if (flags.preset) o.llm = { preset: flags.preset };
  if (flags.color === true) o.render = { color: 'always' };
  else if (flags.color === false) o.render = { color: 'never' };
  if (flags.cache === false) o.cache = { enabled: false };
  if (flags.pager === false) o.render = { ...(o.render ?? {}), pager: 'never' };
  if (flags.highlight === false) o.render = { ...(o.render ?? {}), highlight: 'never' };
  if (flags.theme) o.render = { ...(o.render ?? {}), theme: flags.theme };
  return o;
}

export async function openSession(flags: GlobalFlags, opts: { requireRepo: boolean }): Promise<Session> {
  const cwd = resolve(flags.cwd ?? process.cwd());
  let root: string | null = null;
  try {
    root = await gitRoot(cwd);
  } catch (err) {
    if (opts.requireRepo) throw err;
  }
  const loaded = await loadConfig({ gitRoot: root, env: process.env, overrides: flagsToOverrides(flags) });
  const colorEnabled = resolveColor(loaded.config.render.color);
  const c = pc.createColors(colorEnabled);
  const debug = flags.debug ? (msg: string) => process.stderr.write(c.dim(`[bb] ${msg}\n`)) : () => {};
  const warn = (msg: string) => process.stderr.write(c.yellow(`warning: ${msg}\n`));
  return { cwd, root, loaded, debug, warn, colorEnabled };
}

export function resolveColor(mode: 'auto' | 'always' | 'never'): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
}

export function resolveHighlight(mode: 'auto' | 'always' | 'never', colorEnabled: boolean): boolean {
  if (!colorEnabled || mode === 'never') return false;
  if (mode === 'always') return true;
  return supports256Colors();
}

export function terminalWidth(configured: number | null, stream: { columns?: number } = process.stdout): number {
  return configured ?? (stream.columns || 80);
}
