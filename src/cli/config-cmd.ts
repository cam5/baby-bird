import pc from 'picocolors';
import { allPresets, resolveChat, resolveLlm } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { CommandProvider } from '../llm/command.js';
import { openSession, type GlobalFlags } from './shared.js';

export async function configCommand(flags: GlobalFlags & { json?: boolean }): Promise<void> {
  const session = await openSession(flags, { requireRepo: false });
  const { config, layers, cacheDir } = session.loaded;

  if (flags.json) {
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
    return;
  }

  const c = pc.createColors(session.colorEnabled);
  const out: string[] = [];
  out.push(c.bold('Layers') + c.dim('  (later layers win; objects merge, arrays replace)'));
  for (const layer of layers) {
    const status = layer.found ? c.green('applied') : c.dim('not found');
    const where = layer.path ?? (layer.detail || (layer.name === 'defaults' ? 'built-in' : layer.name === 'flags' ? 'command line' : ''));
    out.push(`  ${layer.name.padEnd(8)} ${status.padEnd(session.colorEnabled ? 18 : 9)} ${c.dim(where)}`);
  }
  out.push(`  cache dir: ${cacheDir}`);
  out.push('');

  out.push(c.bold('LLM'));
  try {
    const llm = resolveLlm(config);
    const provider = new CommandProvider({ command: llm.command, promptVia: llm.promptVia, timeoutMs: llm.timeoutMs });
    out.push(`  preset:   ${llm.preset ?? c.dim('(custom command)')}`);
    out.push(`  command:  ${provider.describe()}`);
    out.push(`  prompt:   via ${llm.promptVia}`);
  } catch (err) {
    out.push(`  ${c.red((err as ConfigError).message)}`);
  }
  try {
    const chat = resolveChat(config);
    const provider = new CommandProvider({ command: chat.command, promptVia: 'arg', timeoutMs: 1 });
    out.push(`  chat:     ${provider.describe()}${c.dim('  (bb ask)')}`);
  } catch (err) {
    out.push(`  chat:     ${c.dim(`none: ${(err as ConfigError).message}`)}`);
  }
  out.push('');

  out.push(c.bold('Presets'));
  const presets = allPresets(config);
  const width = Math.max(...Object.keys(presets).map((k) => k.length));
  for (const [name, preset] of Object.entries(presets).sort(([a], [b]) => a.localeCompare(b))) {
    const custom = name in config.llm.presets ? c.dim(' (yours)') : '';
    out.push(`  ${name.padEnd(width)}  ${preset.description ?? c.dim(preset.command.join(' '))}${custom}`);
  }
  out.push('');

  out.push(c.bold('Effective config'));
  out.push(JSON.stringify(config, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  process.stdout.write(out.join('\n') + '\n');
}
