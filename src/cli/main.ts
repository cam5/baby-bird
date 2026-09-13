#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import pkg from '../../package.json' with { type: 'json' };
import { BadLlmOutputError, BbError } from '../core/errors.js';
import { cacheClearCommand, cacheLsCommand, cachePathCommand } from './cache-cmd.js';
import { configCommand } from './config-cmd.js';
import { askCommand } from './ask-cmd.js';
import { initCommand } from './init-cmd.js';
import { tourCommand } from './tour.js';

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

/** A subcommand's options plus any global flags given before its name (`bb -C dir cache ls`). */
function optsWithGlobals<T>(cmd: Command): T {
  return cmd.optsWithGlobals() as T;
}

function addGlobalFlags(cmd: Command): Command {
  return cmd
    .option('-C, --cwd <dir>', 'run as if started in <dir>')
    .option('--preset <name>', 'LLM preset to use (see `bb config`)')
    .option('--color', 'force colored output')
    .option('--no-color', 'disable colored output')
    .option('--debug', 'print diagnostics (resolved range, prompt size, raw model output) to stderr');
}

// A reader that quits early (`bb | head`) is a normal end, not a crash.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const program = new Command();

program
  .name('bb')
  .description('Guided code tours for git changes, on the command line.')
  .version(pkg.version, '-V, --version')
  // Options after a subcommand name belong to the subcommand; `bb ask --preset x` must not be eaten by the root.
  .enablePositionalOptions()
  .configureOutput({ outputError: (str, write) => write(pc.red(str)) })
  .showHelpAfterError('(run with --help for usage)');

addGlobalFlags(program)
  .argument('[range]', 'what to tour: A..B, A...B, or a single ref (compared at its merge-base with HEAD)')
  .option('-w, --working', 'tour uncommitted changes in the working tree (tracked and untracked)')
  .option('-s, --staged', 'tour staged changes only')
  .option('--section <n>', 'render only section <n>', positiveInt)
  .option('--json', 'print the tour as JSON instead of rendering it')
  .option('--dump-prompt', 'print the prompt that would be sent to the model and exit')
  .option('--refresh', 'ignore a cached tour and regenerate it')
  .option('--no-cache', 'neither read nor write the tour cache')
  .option('--no-pager', 'never pipe output through a pager')
  .option('--no-highlight', 'plain green/red excerpts instead of syntax colors with tinted rows')
  .option('--theme <name>', 'background tint palette for added/removed lines: dark or light', (v: string) => {
    if (v !== 'dark' && v !== 'light') throw new InvalidArgumentError('must be dark or light');
    return v;
  })
  .option('--no-progress', 'do not show the live status block while generating')
  .addHelpText(
    'after',
    `
Examples:
  bb                     tour the current branch (dirty tree, PR base, nearest branch, or default branch)
  bb main..feature       tour an explicit range
  bb HEAD~3              tour the last three commits
  bb --staged            tour what you are about to commit
  bb --section 2         show only the second section
  bb --json | jq         machine-readable output
  bb --preset claude-sonnet --refresh
  bb ask HEAD~1 "what changed in progress.ts?"   chat about a tour (see bb ask --help)
`,
  )
  .action(async (range: string | undefined, flags) => {
    await tourCommand(range, flags);
  });

addGlobalFlags(program.command('ask').description('chat with the LLM about a tour (the tour is generated or taken from the cache first)'))
  .argument('[range]', 'what to tour, as for `bb`; omit it to tour the same thing bare `bb` would')
  .argument('[message...]', 'opening message for the chat')
  .option('-w, --working', 'tour uncommitted changes in the working tree (tracked and untracked)')
  .option('-s, --staged', 'tour staged changes only')
  .option('--refresh', 'ignore a cached tour and regenerate it')
  .option('--no-cache', 'neither read nor write the tour cache')
  .option('--no-progress', 'do not show the live status block while generating')
  .option('--dump-context', 'print the context that would be handed to the chat and exit')
  .addHelpText(
    'after',
    `
The first word is taken as a range only when git can resolve it (HEAD~3, main..feature);
everything else is the opening message. The chat command comes from the preset (see \`bb config\`).

Examples:
  bb ask                                     chat about the current branch's tour
  bb ask "why does the cache key include the command?"
  bb ask HEAD~1 "what is going on in progress.ts?"
  bb ask main..feature --preset claude-opus
  bb ask --staged "is this safe to commit?"
`,
  )
  .action(async (range: string | undefined, message: string[], _flags, cmd: Command) => {
    await askCommand([range, ...message].filter((w): w is string => w !== undefined), optsWithGlobals(cmd));
  });

const cache = program.command('cache').description('manage cached tours');
addGlobalFlags(cache.command('ls').description('list cached tours')).action((_flags, cmd: Command) => cacheLsCommand(optsWithGlobals(cmd)));
addGlobalFlags(cache.command('clear').description('delete all cached tours')).action((_flags, cmd: Command) => cacheClearCommand(optsWithGlobals(cmd)));
addGlobalFlags(cache.command('path').description('print the cache directory')).action((_flags, cmd: Command) => cachePathCommand(optsWithGlobals(cmd)));

addGlobalFlags(program.command('config').description('show the effective configuration, its sources, and available presets'))
  .option('--json', 'print only the effective config as JSON')
  .action((_flags, cmd: Command) => configCommand(optsWithGlobals(cmd)));

addGlobalFlags(program.command('init').description('write a starter .baby-bird/config.json in this repository'))
  .option('--force', 'overwrite an existing project config')
  .action((_flags, cmd: Command) => initCommand(optsWithGlobals(cmd)));

program.parseAsync(process.argv).catch((err: unknown) => {
  const debug = process.argv.includes('--debug');
  if (err instanceof BbError) {
    process.stderr.write(pc.red(`error: ${err.message}\n`));
    if (err.hint) process.stderr.write(pc.dim(`${err.hint}\n`));
    if (debug && err instanceof BadLlmOutputError) process.stderr.write(pc.dim(`--- raw model output ---\n${err.raw}\n`));
    if (debug && err.cause) process.stderr.write(pc.dim(`${String((err.cause as Error).stack ?? err.cause)}\n`));
    process.exitCode = err.exitCode;
    return;
  }
  process.stderr.write(pc.red(`error: ${(err as Error).message ?? String(err)}\n`));
  if (debug && (err as Error).stack) process.stderr.write(pc.dim(`${(err as Error).stack}\n`));
  process.exitCode = 1;
});
