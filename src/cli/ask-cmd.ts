import pc from 'picocolors';
import { buildChatContext } from '../core/chat.js';
import { resolveChat, resolveLlm } from '../core/config.js';
import { ConfigError, NotARepoError } from '../core/errors.js';
import { generateTour, prepareTour } from '../core/tour.js';
import { git } from '../git/exec.js';
import { chatSlots, launchChat } from '../llm/chat.js';
import { describeSource, relativeTime } from '../render/cli.js';
import { writeStdout } from '../render/pager.js';
import { LiveProgress, loggingProgress } from './progress.js';
import { openSession, terminalWidth, type GlobalFlags } from './shared.js';

export interface AskFlags extends GlobalFlags {
  working?: boolean;
  staged?: boolean;
  refresh?: boolean;
  progress?: boolean;
  dumpContext?: boolean;
}

export interface AskArgs {
  range?: string;
  message?: string;
}

/**
 * `bb ask [range] [message...]`: the first word is a range only when git can resolve it
 * (`HEAD~1`, `main..feat`); otherwise every word is part of the opening message.
 */
export async function splitAskArgs(words: string[], opts: { cwd: string; rangeAllowed: boolean }): Promise<AskArgs> {
  const [first, ...rest] = words;
  if (first !== undefined && opts.rangeAllowed && (await isRange(first, opts.cwd))) {
    return { range: first, message: joinMessage(rest) };
  }
  return { message: joinMessage(words) };
}

async function isRange(word: string, cwd: string): Promise<boolean> {
  if (!word || /\s/.test(word)) return false;
  const res = await git(['rev-parse', '--quiet', '--end-of-options', word], { cwd, allowFailure: true });
  return res.code === 0;
}

function joinMessage(words: string[]): string | undefined {
  const text = words.join(' ').trim();
  return text ? text : undefined;
}

export async function askCommand(words: string[], flags: AskFlags): Promise<void> {
  const session = await openSession(flags, { requireRepo: true });
  if (!session.root) throw new NotARepoError(session.cwd);
  const { config } = session.loaded;
  const c = pc.createColors(session.colorEnabled);

  // Fail before any git or model work when there is nothing to chat with.
  const chat = resolveChat(config);
  const slots = chatSlots(chat.command);
  if (!slots.context) {
    throw new ConfigError('The chat command has no {context-file} or {context} token, so the tour cannot be handed to it.', 'Add one of them to the chatCommand; see the README.');
  }
  const llm = resolveLlm(config);

  const { range, message } = await splitAskArgs(words, { cwd: session.root, rangeAllowed: !flags.working && !flags.staged });
  session.debug(range ? `range: ${range}` : 'no range argument');
  session.debug(message ? `opening message: ${JSON.stringify(message)}` : 'no opening message');

  const live = flags.progress !== false && !flags.debug && Boolean(process.stderr.isTTY) && !flags.dumpContext;
  const progress = live
    ? new LiveProgress(process.stderr, { color: session.colorEnabled, width: terminalWidth(null, process.stderr) })
    : loggingProgress(session.debug);

  const options = {
    cwd: session.root,
    config,
    cacheDir: session.loaded.cacheDir,
    range: { arg: range, working: flags.working, staged: flags.staged },
    refresh: flags.refresh,
    noCache: flags.cache === false,
    debug: session.debug,
    warn: session.warn,
    progress,
  };

  if (progress instanceof LiveProgress) progress.start();
  let prepared: Awaited<ReturnType<typeof prepareTour>>;
  let result: Awaited<ReturnType<typeof generateTour>>;
  try {
    prepared = await prepareTour(options);
    result = await generateTour(options, prepared);
  } catch (err) {
    if (progress instanceof LiveProgress) progress.stop();
    throw err;
  }
  if (progress instanceof LiveProgress) progress.stop(result.fromCache ? undefined : progress.summary());

  const context = buildChatContext({ tour: result.tour, change: prepared.context, maxBytes: llm.maxPromptBytes, tourPath: result.cachePath });
  if (context.truncation.truncated.length || context.truncation.omitted.length) {
    session.warn(`Chat context exceeded ${llm.maxPromptBytes} bytes; truncated ${context.truncation.truncated.length} and omitted ${context.truncation.omitted.length} file diff(s).`);
  }
  if (flags.dumpContext) {
    await writeStdout(context.text.endsWith('\n') ? context.text : context.text + '\n');
    return;
  }

  const tour = result.tour;
  const when = result.fromCache ? `cached ${relativeTime(tour.generatedAt)}` : 'generated just now';
  process.stderr.write(`${c.bold(`🐣 ${tour.title}`)}${c.dim(` · ${describeSource(tour.source)} · ${when}`)}\n`);
  if (message && !slots.message) {
    session.warn('This chat command has no {message} slot; type your question into the chat once it opens.');
  }
  process.stderr.write(c.dim(`Opening ${chat.preset ?? chat.command[0]} with the tour as context…\n`));

  const outcome = await launchChat({ command: chat.command, context: context.text, message, cwd: session.root, env: chat.env, debug: session.debug });
  process.exitCode = outcome.exitCode;
}
