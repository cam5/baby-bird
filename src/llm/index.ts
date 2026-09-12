import type { ResolvedLlm } from '../core/config.js';
import { TOUR_JSON_SCHEMA } from '../core/prompt/json-schema.js';
import { CommandProvider } from './command.js';
import type { LlmProvider } from './provider.js';

export type { CompleteOptions, LlmEvent, LlmProvider } from './provider.js';
export { CommandProvider, type CommandKind } from './command.js';
export { ClaudeStreamParser, type ClaudeStreamOutcome, type ClaudeStreamUsage } from './claude-stream.js';

export function createProvider(llm: ResolvedLlm, opts: { cwd?: string; debug?: (msg: string) => void } = {}): LlmProvider {
  return new CommandProvider({
    command: llm.command,
    promptVia: llm.promptVia,
    timeoutMs: llm.timeoutMs,
    kind: llm.kind,
    jsonSchema: llm.kind === 'claude' ? TOUR_JSON_SCHEMA : undefined,
    env: llm.env,
    cwd: opts.cwd,
    debug: opts.debug,
  });
}
