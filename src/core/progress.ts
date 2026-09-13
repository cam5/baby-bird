import type { LlmEvent } from '../llm/provider.js';

/** Where the pipeline reports what it is doing. The CLI renders this live; other consumers may ignore it. */
export interface ProgressSink {
  /** A new stage began (e.g. "Collecting the diff"). */
  phase(label: string): void;
  /** Something happened inside the model call. */
  llm(event: LlmEvent): void;
}

export const noProgress: ProgressSink = { phase() {}, llm() {} };
