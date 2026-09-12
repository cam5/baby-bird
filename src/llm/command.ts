import { spawn } from 'node:child_process';
import { LlmFailedError } from '../core/errors.js';
import type { LlmProvider } from './provider.js';

export interface CommandProviderOptions {
  command: string[];
  promptVia: 'stdin' | 'arg';
  timeoutMs: number;
  env?: Record<string, string>;
  cwd?: string;
  debug?: (msg: string) => void;
}

const STDERR_TAIL_LINES = 20;

/** Runs any CLI as the model: prompt in via stdin (or a {prompt} argv token), completion out via stdout. */
export class CommandProvider implements LlmProvider {
  constructor(private readonly opts: CommandProviderOptions) {
    if (opts.command.length === 0) throw new LlmFailedError('LLM command is empty.');
  }

  describe(): string {
    return this.opts.command.map(shellQuote).join(' ');
  }

  complete(prompt: string): Promise<string> {
    const { promptVia, timeoutMs } = this.opts;
    const argv = promptVia === 'arg' ? this.opts.command.map((a) => a.replaceAll('{prompt}', prompt)) : this.opts.command;
    const [bin, ...args] = argv as [string, ...string[]];
    const debug = this.opts.debug ?? (() => {});
    const started = Date.now();
    debug(`running ${this.describe()} (prompt ${Buffer.byteLength(prompt)} bytes via ${promptVia})`);

    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.opts.env };
      // Claude Code refuses to start nested inside another Claude Code session.
      delete env.CLAUDECODE;
      const child = spawn(bin, args, { cwd: this.opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
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

      child.stdout.on('data', (b: Buffer) => out.push(b));
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
          const stdout = Buffer.concat(out).toString('utf8');
          const stderr = Buffer.concat(err).toString('utf8');
          debug(`command exited with ${signal ? `signal ${signal}` : `code ${code}`} after ${Date.now() - started}ms; ${stdout.length} bytes of stdout`);
          if (code !== 0) {
            const tail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
            reject(new LlmFailedError(`LLM command failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${this.describe()}${tail ? '\n' + tail : ''}`));
            return;
          }
          resolve(stdout);
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
