/** Events a provider may emit while a completion is in flight. */
export type LlmEvent =
  | { type: 'started' }
  /** A chunk of the model's (summarized) reasoning. */
  | { type: 'thinking'; text: string }
  /** A chunk of the answer as it is produced. */
  | { type: 'text'; text: string }
  /** The model started a (new) answer; any previously streamed answer text is superseded. */
  | { type: 'answer-start' }
  /** Something worth telling the user, e.g. the CLI rejected an answer and the model is retrying. */
  | { type: 'notice'; text: string }
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
