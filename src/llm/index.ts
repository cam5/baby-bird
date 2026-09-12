import type { ResolvedLlm } from '../core/config.js';
import { CommandProvider } from './command.js';
import type { LlmProvider } from './provider.js';

export type { LlmProvider } from './provider.js';
export { CommandProvider } from './command.js';

export function createProvider(llm: ResolvedLlm, opts: { cwd?: string; debug?: (msg: string) => void } = {}): LlmProvider {
  return new CommandProvider({
    command: llm.command,
    promptVia: llm.promptVia,
    timeoutMs: llm.timeoutMs,
    env: llm.env,
    cwd: opts.cwd,
    debug: opts.debug,
  });
}
