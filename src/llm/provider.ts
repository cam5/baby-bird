export interface LlmProvider {
  /** Human-readable description of how the model is invoked, for headers and debug output. */
  describe(): string;
  /** Send a prompt and return the raw text the model produced. */
  complete(prompt: string): Promise<string>;
}
