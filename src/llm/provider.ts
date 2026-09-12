/** Events a provider may emit while a completion is in flight. */
export type LlmEvent =
  | { type: 'started' }
  /** A chunk of the model's (summarized) reasoning. */
  | { type: 'thinking'; text: string }
  /** A chunk of the answer as it is produced. */
  | { type: 'text'; text: string }
  /** Opaque progress for commands we cannot parse: total stdout bytes so far. */
  | { type: 'output'; bytes: number }
  | { type: 'usage'; outputTokens?: number; thinkingTokens?: number; costUsd?: number; model?: string };

export interface CompleteOptions {
  onEvent?: (event: LlmEvent) => void;
}

export interface LlmProvider {
  /** Human-readable description of how the model is invoked, for headers and debug output. */
  describe(): string;
  /** Send a prompt and return the raw text the model produced. */
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
}
