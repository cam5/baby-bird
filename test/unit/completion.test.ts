import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { completionScript, describeProgram, parseShell } from '../../src/cli/completion/index.js';
import { UsageError } from '../../src/core/errors.js';

function program(): Command {
  const p = new Command().name('bb');
  p.option('-C, --cwd <dir>', 'run as if started in <dir>').option('--no-color', "don't color: ever").option('--json', 'costs $& nothing');
  p.command('ask').description('chat about a tour').option('--pr <number|url>', 'a pull request').argument('[range]');
  const cache = p.command('cache').description('manage cached tours');
  cache.command('ls').description('list cached tours');
  cache.command('clear').description('delete all cached tours');
  return p;
}

describe('describeProgram', () => {
  it('reads commands, options and whether an option takes a value from commander', () => {
    const commands = describeProgram(program());
    expect(commands.map((c) => c.path)).toEqual(['', 'ask', 'cache', 'cache ls', 'cache clear']);
    const root = commands[0]!;
    expect(root.subcommands).toEqual([
      { name: 'ask', description: 'chat about a tour' },
      { name: 'cache', description: 'manage cached tours' },
    ]);
    expect(root.options).toEqual([
      { names: ['-C', '--cwd'], description: 'run as if started in <dir>', takesValue: true },
      { names: ['--no-color'], description: "don't color: ever", takesValue: false },
      { names: ['--json'], description: 'costs $& nothing', takesValue: false },
      { names: ['-h', '--help'], description: 'display help for command', takesValue: false },
    ]);
    expect(commands[1]!.options.map((o) => o.names.join(','))).toEqual(['--pr', '-h,--help']);
  });
});

describe('completionScript', () => {
  const input = { commands: describeProgram(program()), version: '9.9.9', presets: ['claude', 'claude-sonnet'] };

  it('fills every marker for both shells', () => {
    for (const shell of ['zsh', 'bash'] as const) {
      const script = completionScript(shell, input);
      expect(script, shell).not.toMatch(/@@[A-Z_]+@@/);
      expect(script, shell).toContain('baby-bird 9.9.9');
      expect(script, shell).toContain(`'') __bb_sub_names='ask cache' ;;`);
      expect(script, shell).toContain(`'cache') __bb_sub_names='ls clear' ;;`);
      // Flags whose next word is a value, so the walk over the command line can skip that word.
      expect(script, shell).toContain('" -C --cwd --pr "');
      expect(script, shell).toContain("'claude' 'claude-sonnet'");
    }
    expect(completionScript('zsh', input).startsWith('#compdef bb baby-bird\n')).toBe(true);
    expect(completionScript('bash', input)).toContain('complete -F _bb bb baby-bird');
    expect(completionScript('bash', input)).toContain(`'ask') __bb_opt_names='--pr -h --help' ;;`);
  });

  it('quotes descriptions for the shell and for _describe', () => {
    const zsh = completionScript('zsh', input);
    // A single quote ends and reopens the string; a colon would otherwise end the candidate name.
    expect(zsh).toContain(`'--no-color:don'\\''t color\\: ever'`);
    // `$&` in a description is text, not a replacement pattern.
    expect(zsh).toContain(`'--json:costs $& nothing'`);
    expect(zsh).toContain(`'cache') subs=('ls:list cached tours' 'clear:delete all cached tours') ;;`);
  });
});

describe('parseShell', () => {
  it('takes the argument, or else $SHELL, and refuses anything else', () => {
    expect(parseShell('zsh', {})).toBe('zsh');
    expect(parseShell('bash', { SHELL: '/bin/zsh' })).toBe('bash');
    expect(parseShell(undefined, { SHELL: '/opt/homebrew/bin/bash' })).toBe('bash');
    expect(() => parseShell('fish', {})).toThrow(UsageError);
    expect(() => parseShell('fish', {})).toThrow(/No completion script for fish/);
    expect(() => parseShell(undefined, { SHELL: '/usr/bin/fish' })).toThrow(/Say which shell/);
    expect(() => parseShell(undefined, {})).toThrow(UsageError);
  });
});
