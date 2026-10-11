import type { Command } from 'commander';
import { BUILTIN_PRESETS } from '../../core/config.js';
import { UsageError } from '../../core/errors.js';
import { BASH, COMMON, ZSH } from './scripts.js';

export const COMPLETION_SHELLS = ['zsh', 'bash'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export interface CompletionOption {
  /** Every spelling, e.g. ["-C", "--cwd"]. */
  names: string[];
  description: string;
  /** True when the next word is this option's value. */
  takesValue: boolean;
}

export interface CompletionCommand {
  /** Space-separated path below `bb`; "" is `bb` itself. */
  path: string;
  options: CompletionOption[];
  subcommands: Array<{ name: string; description: string }>;
}

/** Read every command, option and description out of the commander program. */
export function describeProgram(program: Command): CompletionCommand[] {
  const out: CompletionCommand[] = [];
  const walk = (cmd: Command, path: string): void => {
    const options: CompletionOption[] = cmd.options
      .filter((o) => !o.hidden)
      .map((o) => ({
        names: [o.short, o.long].filter((n): n is string => Boolean(n)),
        description: o.description,
        takesValue: o.required || o.optional,
      }));
    options.push({ names: ['-h', '--help'], description: 'display help for command', takesValue: false });
    const subs = cmd.commands.filter((c) => !c.name().startsWith('_'));
    out.push({ path, options, subcommands: subs.map((c) => ({ name: c.name(), description: c.description() })) });
    for (const sub of subs) walk(sub, path ? `${path} ${sub.name()}` : sub.name());
  };
  walk(program, '');
  return out;
}

/** A single-quoted shell word. */
function sq(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** One `name:description` entry for zsh's _describe, where a literal colon must be escaped. */
function described(name: string, description: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  return sq(`${name.replace(/:/g, '\\:')}:${oneLine.replace(/:/g, '\\:')}`);
}

function caseArms(commands: CompletionCommand[], body: (c: CompletionCommand) => string | null): string {
  const arms: string[] = [];
  for (const c of commands) {
    const b = body(c);
    if (b !== null) arms.push(`    ${sq(c.path)}) ${b} ;;`);
  }
  return arms.join('\n');
}

export interface CompletionInput {
  commands: CompletionCommand[];
  version: string;
  presets: string[];
}

/** The completion script for a shell: static text plus tables generated from the CLI definition. */
export function completionScript(shell: CompletionShell, input: CompletionInput): string {
  const { commands } = input;
  const valueFlags = [...new Set(commands.flatMap((c) => c.options.filter((o) => o.takesValue).flatMap((o) => o.names)))];
  const subsCase = caseArms(commands, (c) => (c.subcommands.length ? `__bb_sub_names=${sq(c.subcommands.map((s) => s.name).join(' '))}` : null));
  // Function replacers throughout: a `$` in a description must not be read as a replacement pattern.
  const common = COMMON.replace('@@SUBS_CASE@@', () => subsCase);
  const fill: Record<string, string> = {
    '@@VERSION@@': input.version,
    '@@COMMON@@': common,
    '@@VALUE_FLAGS@@': valueFlags.join(' '),
    '@@PRESETS@@': input.presets.map(sq).join(' '),
    '@@SHELLS@@': COMPLETION_SHELLS.join(' '),
    '@@ZSH_OPTS_CASE@@': caseArms(commands, (c) => `opts=(${c.options.flatMap((o) => o.names.map((n) => described(n, o.description))).join(' ')})`),
    '@@ZSH_SUBS_CASE@@': caseArms(commands, (c) => (c.subcommands.length ? `subs=(${c.subcommands.map((s) => described(s.name, s.description)).join(' ')})` : null)),
    '@@BASH_OPTS_CASE@@': caseArms(commands, (c) => `__bb_opt_names=${sq(c.options.flatMap((o) => o.names).join(' '))}`),
  };
  const template = shell === 'zsh' ? ZSH : BASH;
  return template.replace(/@@[A-Z_]+@@/g, (marker: string) => fill[marker] ?? marker);
}

export function parseShell(value: string | undefined, env: NodeJS.ProcessEnv = process.env): CompletionShell {
  const name = value ?? (env.SHELL ?? '').split('/').pop() ?? '';
  if ((COMPLETION_SHELLS as readonly string[]).includes(name)) return name as CompletionShell;
  throw new UsageError(
    value ? `No completion script for ${value}.` : 'Say which shell to print a completion script for.',
    `Supported: ${COMPLETION_SHELLS.join(', ')}. For example: bb completion zsh`,
  );
}

export const COMPLETION_HELP = `
Prints a completion script and changes nothing on its own; installing it is one of the lines below.
It completes subcommands and flags, branch, remote-branch, tag and other ref names (from git), the
second half of A..B and A...B, and open pull request numbers (from gh, when it is installed and can
see the repository). Completion never starts bb itself.

zsh, pick one:
  bb completion zsh > "$(brew --prefix)/share/zsh/site-functions/_bb"
                                    with Homebrew set up the usual way, that directory is on fpath
  bb completion zsh > ~/.zfunc/_bb  any directory works if ~/.zshrc has, before compinit:
                                    fpath=(~/.zfunc $fpath)
  source <(bb completion zsh)       or this line in ~/.zshrc, after compinit. Always current, but
                                    it starts bb with every new shell.
  Then open a new shell. If nothing completes, delete ~/.zcompdump* and try again. Rewrite the
  file after upgrading bb.

bash, pick one:
  bb completion bash > ~/.local/share/bash-completion/completions/bb    with bash-completion 2
  source <(bb completion bash)      or this line in ~/.bashrc (bash 4 or newer)
  eval "$(bb completion bash)"      the same for the bash 3.2 that ships with macOS

Pull request numbers come from \`gh pr list\`, cached per repository under
$XDG_CACHE_HOME/baby-bird/completion (default ~/.cache). Tab never waits for gh, except for up to
one second the first time in a repository; after that a cache older than a minute is still used
and refreshed in the background. Without gh, or when it fails, you just get no numbers.
Set BB_COMPLETION_PRS=0 to never run gh from completion.
`;

export function completionCommand(shell: string | undefined, program: Command, version: string): void {
  const script = completionScript(parseShell(shell), { commands: describeProgram(program), version, presets: Object.keys(BUILTIN_PRESETS) });
  process.stdout.write(script);
}
