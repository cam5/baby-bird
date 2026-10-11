#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import pkg from '../../package.json' with { type: 'json' };
import { BadLlmOutputError, BbError } from '../core/errors.js';
import { cacheClearCommand, cacheLsCommand, cachePathCommand } from './cache-cmd.js';
import { COMPLETION_HELP, COMPLETION_SHELLS, completionCommand } from './completion/index.js';
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

/** The one place that spells out what each range form compares; shown by `bb --help` and `bb ask --help`. */
const COMPARISON_HELP = `
What gets compared (every tour is a diff from an old side to a new side):

  bb --base A                     HEAD against the commit where it forked from A:
  bb A                            "what did I add on top of A?"

  bb --base A --head B            B against the commit where it forked from A:
  bb A...B                        "what would a pull request of B into A show?"

  bb --base A --head B --direct   B against A exactly as A is now; commits A gained since B
  bb A..B                         forked show up too, backwards, as if B had removed them

  bb 12                           pull request #12: its head against where it forked from its
                                  base branch, both read from the remote

  Each pair is two spellings of the same comparison. A..B and A...B only differ when A
  has moved on since B forked from it. An empty side means HEAD (A.. is A..HEAD).
  This follows \`git diff\`; in \`git log\` the dots mean something else.
`;

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
  .argument('[range]', 'what to tour: a ref, A...B, A..B, or a pull request (12, #12, or its URL); see "What gets compared" below')
  .option('--base <ref>', 'what to compare against: tour what --head (default HEAD) added since it forked from <ref>')
  .option('--head <ref>', 'the commit to tour instead of HEAD; without --base it is compared against the default branch')
  .option('--direct', 'with --base/--head: compare the two exactly as they are now, not from where they forked')
  .option('--pr <number|url>', 'tour a pull request, base and head as they are on the remote; unlike a bare number, never taken for a ref')
  .option('-w, --working', 'tour uncommitted changes in the working tree (tracked and untracked)')
  .option('-s, --staged', 'tour staged changes only')
  .option('--section <n>', 'render only section <n>', positiveInt)
  .option('--json', 'print the tour as JSON instead of rendering it')
  .option('--dump-prompt', 'print the prompt that would be sent to the model and exit')
  .option('--refresh', 'ignore a cached tour and regenerate it')
  .option('--no-cache', 'neither read nor write the tour cache')
  .option('--no-pager', 'never pipe output through a pager')
  .option('--no-highlight', 'plain excerpts with green/red +/- signs instead of syntax colors')
  .option('--no-progress', 'do not show the live status block while generating')
  .addHelpText(
    'after',
    `
${COMPARISON_HELP}
Examples:
  bb                     tour the current branch (dirty tree, PR base, nearest branch, or default branch)
  bb --base main         what this branch adds on top of main
  bb --base main --head feature
                         what feature adds on top of main, without checking it out
  bb HEAD~3              tour the last three commits
  bb 12                  tour pull request #12: its base against its head, both fetched from the remote
  bb 12 --base main      pull request #12 against main instead of its own base (a whole stack at once)
  bb --pr 12             pull request #12 even if a local branch or tag is named 12
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
  .option('--base <ref>', 'what to compare against: tour what --head (default HEAD) added since it forked from <ref>')
  .option('--head <ref>', 'the commit to tour instead of HEAD; without --base it is compared against the default branch')
  .option('--direct', 'with --base/--head: compare the two exactly as they are now, not from where they forked')
  .option('--pr <number|url>', 'tour a pull request, base and head as they are on the remote')
  .option('-w, --working', 'tour uncommitted changes in the working tree (tracked and untracked)')
  .option('-s, --staged', 'tour staged changes only')
  .option('--refresh', 'ignore a cached tour and regenerate it')
  .option('--no-cache', 'neither read nor write the tour cache')
  .option('--no-progress', 'do not show the live status block while generating')
  .option('--dump-context', 'print the context that would be handed to the chat and exit')
  .addHelpText(
    'after',
    `
The first word is taken as a range only when git can resolve it (HEAD~3, main..feature) or it is a
pull request (12, #12, a PR URL); everything else is the opening message. With --base, --head or --pr
every word is the message. The chat command comes from the preset (see \`bb config\`).
${COMPARISON_HELP}
Examples:
  bb ask                                     chat about the current branch's tour
  bb ask "why does the cache key include the command?"
  bb ask HEAD~1 "what is going on in progress.ts?"
  bb ask 12 "what should I look at first?"   chat about pull request #12
  bb ask --base main --head feature "is the migration reversible?"
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

program
  .command('completion')
  .description('print a shell completion script (zsh or bash) to install yourself')
  .argument('[shell]', `${COMPLETION_SHELLS.join(' or ')}; defaults to the shell named by $SHELL`)
  .addHelpText('after', COMPLETION_HELP)
  .action((shell: string | undefined) => completionCommand(shell, program, pkg.version));

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
