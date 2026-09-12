import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { LlmFailedError } from '../core/errors.js';
import { ClaudeStreamParser } from './claude-stream.js';
import type { CompleteOptions, LlmProvider } from './provider.js';

export type CommandKind = 'plain' | 'claude';

export interface CommandProviderOptions {
  command: string[];
  promptVia: 'stdin' | 'arg';
  timeoutMs: number;
  /**
   * "plain": stdout is the answer. "claude": the command is the Claude Code CLI;
   * streaming flags (and --json-schema when a schema is given) are appended and
   * the stream-json output is parsed for live thinking/text events.
   */
  kind?: CommandKind;
  /** JSON Schema the answer must satisfy (Claude kind only). */
  jsonSchema?: object;
  env?: Record<string, string>;
  cwd?: string;
  debug?: (msg: string) => void;
}

const STDERR_TAIL_LINES = 20;
const CLAUDE_STREAM_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

/** Runs any CLI as the model: prompt in via stdin (or a {prompt} argv token), completion out via stdout. */
export class CommandProvider implements LlmProvider {
  constructor(private readonly opts: CommandProviderOptions) {
    if (opts.command.length === 0) throw new LlmFailedError('LLM command is empty.');
  }

  get kind(): CommandKind {
    return this.opts.kind ?? 'plain';
  }

  describe(): string {
    return this.opts.command.map(shellQuote).join(' ');
  }

  /** The full argv that will run, including any flags added for the command kind. */
  argv(prompt?: string): string[] {
    let argv = [...this.opts.command];
    if (this.kind === 'claude') {
      argv.push(...CLAUDE_STREAM_ARGS);
      if (this.opts.jsonSchema) argv.push('--json-schema', JSON.stringify(this.opts.jsonSchema));
    }
    if (prompt !== undefined && this.opts.promptVia === 'arg') argv = argv.map((a) => a.replaceAll('{prompt}', prompt));
    return argv;
  }

  complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const { promptVia, timeoutMs } = this.opts;
    const onEvent = opts.onEvent ?? (() => {});
    const [bin, ...args] = this.argv(prompt) as [string, ...string[]];
    const debug = this.opts.debug ?? (() => {});
    const started = Date.now();
    debug(`running ${this.describe()}${this.kind === 'claude' ? ' (+stream-json)' : ''} (prompt ${Buffer.byteLength(prompt)} bytes via ${promptVia})`);

    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.opts.env };
      // Claude Code refuses to start nested inside another Claude Code session.
      delete env.CLAUDECODE;
      const child = spawn(bin, args, { cwd: this.opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const parser = this.kind === 'claude' ? new ClaudeStreamParser(onEvent) : null;
      const decoder = new StringDecoder('utf8');
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new LlmFailedError(`LLM command timed out after ${Math.round(timeoutMs / 1000)}s: ${this.describe()}`, {
          hint: 'Raise llm.timeoutMs in your config, or pick a faster preset.',
        })));
      }, timeoutMs);

      onEvent({ type: 'started' });
      child.stdout.on('data', (b: Buffer) => {
        outBytes += b.length;
        if (parser) {
          parser.push(decoder.write(b));
        } else {
          out.push(b);
          onEvent({ type: 'output', bytes: outBytes });
        }
      });
      child.stderr.on('data', (b: Buffer) => err.push(b));
      child.on('error', (e: NodeJS.ErrnoException) => {
        finish(() => {
          if (e.code === 'ENOENT') {
            reject(new LlmFailedError(`LLM command not found: ${bin}`, { hint: 'Install it, or choose another preset with --preset / llm.preset.', cause: e }));
          } else {
            reject(new LlmFailedError(`Could not run ${this.describe()}: ${e.message}`, { cause: e }));
          }
        });
      });
      child.on('close', (code, signal) => {
        finish(() => {
          const stderr = Buffer.concat(err).toString('utf8');
          const tail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
          debug(`command exited with ${signal ? `signal ${signal}` : `code ${code}`} after ${Date.now() - started}ms; ${outBytes} bytes of stdout`);

          if (parser) {
            parser.push(decoder.end());
            const outcome = parser.finish();
            if (outcome.unparsedLines) debug(`${outcome.unparsedLines} non-JSON line(s) on stdout were ignored`);
            if (outcome.isError) {
              reject(new LlmFailedError(`Claude reported an error: ${outcome.errorMessage ?? 'unknown'}`, { hint: tail || undefined }));
              return;
            }
            if (code !== 0) {
              reject(new LlmFailedError(`LLM command failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${this.describe()}${tail ? '\n' + tail : ''}`));
              return;
            }
            if (!outcome.result) {
              reject(new LlmFailedError('Claude produced no result.', { hint: 'Run with --debug to see what came back.' }));
              return;
            }
            resolve(outcome.result);
            return;
          }

          if (code !== 0) {
            reject(new LlmFailedError(`LLM command failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${this.describe()}${tail ? '\n' + tail : ''}`));
            return;
          }
          resolve(Buffer.concat(out).toString('utf8'));
        });
      });

      if (promptVia === 'stdin') {
        child.stdin.on('error', () => {}); // EPIPE when the command exits early; the close handler reports it
        child.stdin.end(prompt);
      } else {
        child.stdin.end();
      }
    });
  }
}

function shellQuote(arg: string): string {
  if (arg === '') return '""';
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
