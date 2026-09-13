import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmFailedError } from '../core/errors.js';

/** Tokens a chat command's argv may use. */
export const CONTEXT_FILE_TOKEN = '{context-file}';
export const CONTEXT_TOKEN = '{context}';
export const MESSAGE_TOKEN = '{message}';

export interface ChatArgvInput {
  command: string[];
  contextFile: string;
  context: string;
  message?: string;
}

/** Fill the tokens in a chat command. Entries that are exactly "{message}" are dropped when there is no message. */
export function chatArgv(input: ChatArgvInput): string[] {
  const message = input.message?.trim() ?? '';
  const out: string[] = [];
  for (const arg of input.command) {
    if (arg === MESSAGE_TOKEN && !message) continue;
    out.push(arg.replaceAll(CONTEXT_FILE_TOKEN, input.contextFile).replaceAll(CONTEXT_TOKEN, input.context).replaceAll(MESSAGE_TOKEN, message));
  }
  return out;
}

/** Which tokens a chat command uses, so the caller can warn about a message or context that would go nowhere. */
export function chatSlots(command: string[]): { context: boolean; message: boolean } {
  const joined = command.join('\0');
  return { context: joined.includes(CONTEXT_FILE_TOKEN) || joined.includes(CONTEXT_TOKEN), message: joined.includes(MESSAGE_TOKEN) };
}

export interface LaunchChatOptions {
  /** argv template; see chatArgv for the tokens. */
  command: string[];
  /** The system-prompt-like context, written to a temp file for "{context-file}". */
  context: string;
  /** Opening message, if any. */
  message?: string;
  cwd: string;
  env?: Record<string, string>;
  debug?: (msg: string) => void;
  /** Defaults to the terminal ("inherit"); tests use "ignore". */
  stdio?: 'inherit' | 'ignore';
}

export interface ChatOutcome {
  /** The command's exit code, or 128 + signal number when a signal ended it. */
  exitCode: number;
  signal: NodeJS.Signals | null;
}

/**
 * Run an interactive chat command in the foreground, attached to this terminal, and resolve when it
 * exits. Ctrl+C reaches the child through the terminal, so bb ignores SIGINT itself while the chat
 * runs; SIGTERM and SIGHUP are forwarded.
 */
export async function launchChat(opts: LaunchChatOptions): Promise<ChatOutcome> {
  const debug = opts.debug ?? (() => {});
  const dir = await mkdtemp(join(tmpdir(), 'bb-chat-'));
  const contextFile = join(dir, 'context.md');
  await writeFile(contextFile, opts.context, { encoding: 'utf8', mode: 0o600 });
  const [bin, ...args] = chatArgv({ command: opts.command, contextFile, context: opts.context, message: opts.message }) as [string, ...string[]];
  debug(`launching ${describeArgv([bin, ...args], opts.context)} (context ${Buffer.byteLength(opts.context)} bytes in ${contextFile})`);

  try {
    return await new Promise<ChatOutcome>((resolve, reject) => {
      const env = { ...process.env, ...opts.env };
      // Claude Code refuses to start nested inside another Claude Code session.
      delete env.CLAUDECODE;
      const child = spawn(bin, args, { cwd: opts.cwd, env, stdio: opts.stdio ?? 'inherit' });

      const onInt = () => {};
      const onTerm = () => child.kill('SIGTERM');
      const onHup = () => child.kill('SIGHUP');
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
      process.on('SIGHUP', onHup);
      const cleanup = () => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        process.off('SIGHUP', onHup);
      };

      child.on('error', (e: NodeJS.ErrnoException) => {
        cleanup();
        if (e.code === 'ENOENT') {
          reject(new LlmFailedError(`Chat command not found: ${bin}`, { hint: 'Install it, or choose another preset with --preset / llm.preset.', cause: e }));
        } else {
          reject(new LlmFailedError(`Could not run ${bin}: ${e.message}`, { cause: e }));
        }
      });
      child.on('close', (code, signal) => {
        cleanup();
        debug(`chat exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
        const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
        resolve({ exitCode, signal });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** argv for logs, with the inline context (if any) replaced by a placeholder. */
function describeArgv(argv: string[], context: string): string {
  return argv.map((a) => (context && a.includes(context) ? a.replace(context, '<context>') : a)).map(quote).join(' ');
}

function quote(arg: string): string {
  if (arg === '') return '""';
  return /^[\w@%+=:,./{}-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
