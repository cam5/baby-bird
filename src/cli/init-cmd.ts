import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { projectConfigPath } from '../core/config.js';
import { NotARepoError, UsageError } from '../core/errors.js';
import { openSession, type GlobalFlags } from './shared.js';

const STARTER = {
  llm: { preset: 'claude' },
  codehost: { provider: 'gh' },
};

export async function initCommand(flags: GlobalFlags & { force?: boolean }): Promise<void> {
  const session = await openSession(flags, { requireRepo: true });
  if (!session.root) throw new NotARepoError(session.cwd);
  const path = projectConfigPath(session.root);
  const existing = session.loaded.layers.find((l) => l.name === 'project');
  if (existing?.found && !flags.force) {
    throw new UsageError(`${path} already exists.`, 'Pass --force to overwrite it.');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(STARTER, null, 2) + '\n', 'utf8');
  process.stdout.write(`Wrote ${path}\nRun \`bb config\` to see the effective configuration and available presets.\n`);
}
