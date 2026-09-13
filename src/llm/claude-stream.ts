import type { LlmEvent } from './provider.js';

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose
 * --include-partial-messages`. Emits thinking/text events as deltas arrive and
 * collects the final result (structured output when --json-schema is in use).
 */
export interface ClaudeStreamUsage {
  outputTokens?: number;
  thinkingTokens?: number;
  costUsd?: number;
  model?: string;
}

export interface ClaudeStreamOutcome {
  /** Final answer text; structured output is serialized as JSON. */
  result: string | null;
  isError: boolean;
  errorMessage?: string;
  usage: ClaudeStreamUsage;
  /** Lines on stdout that were not JSON (for debugging). */
  unparsedLines: number;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ClaudeStreamParser {
  private buffer = '';
  private text = '';
  private partialJson = '';
  private messageStructured: string | null = null;
  private resultStructured: string | null = null;
  private resultText: string | null = null;
  private isError = false;
  private errorMessage: string | undefined;
  private usage: ClaudeStreamUsage = {};
  private unparsed = 0;

  constructor(private readonly onEvent: (event: LlmEvent) => void = () => {}) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
  }

  finish(): ClaudeStreamOutcome {
    if (this.buffer.trim()) this.handleLine(this.buffer);
    this.buffer = '';
    const result =
      this.resultStructured ?? this.messageStructured ?? (this.partialJson.trim() || null) ?? (this.resultText?.trim() || null) ?? (this.text.trim() || null);
    const outcome: ClaudeStreamOutcome = { result, isError: this.isError, usage: this.usage, unparsedLines: this.unparsed };
    if (this.errorMessage) outcome.errorMessage = this.errorMessage;
    return outcome;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      this.unparsed++;
      return;
    }
    if (!isObject(ev)) return;
    switch (ev.type) {
      case 'stream_event':
        if (isObject(ev.event)) this.handleStreamEvent(ev.event);
        break;
      case 'assistant':
        if (isObject(ev.message)) this.handleAssistant(ev.message);
        break;
      case 'user':
        if (isObject(ev.message)) this.handleUser(ev.message);
        break;
      case 'result':
        this.handleResult(ev);
        break;
      default:
        break;
    }
  }

  private handleStreamEvent(event: Json): void {
    switch (event.type) {
      case 'message_start': {
        const model = isObject(event.message) && typeof event.message.model === 'string' ? event.message.model : undefined;
        if (model) {
          this.usage.model = model;
          this.onEvent({ type: 'usage', model });
        }
        break;
      }
      case 'content_block_start': {
        const block = isObject(event.content_block) ? event.content_block : {};
        if (block.type === 'text' || block.type === 'tool_use') {
          // A fresh answer supersedes anything streamed before (e.g. after a schema rejection).
          this.text = '';
          this.partialJson = '';
          this.onEvent({ type: 'answer-start' });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = isObject(event.delta) ? event.delta : {};
        if (delta.type === 'thinking_delta') {
          const text = typeof delta.thinking === 'string' ? delta.thinking : '';
          this.onEvent(text ? { type: 'thinking', text } : { type: 'thinking-pulse' });
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          this.text += delta.text;
          this.onEvent({ type: 'text', text: delta.text });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json) {
          this.partialJson += delta.partial_json;
          this.onEvent({ type: 'text', text: delta.partial_json });
        }
        break;
      }
      case 'message_delta': {
        if (isObject(event.usage)) this.recordUsage(event.usage);
        break;
      }
      default:
        break;
    }
  }

  private handleAssistant(message: Json): void {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (isObject(block) && block.type === 'tool_use' && isObject(block.input)) {
        this.messageStructured = JSON.stringify(block.input);
      }
    }
  }

  /** Tool results the CLI feeds back, e.g. a structured-output validation failure. */
  private handleUser(message: Json): void {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== 'tool_result' || block.is_error !== true) continue;
      const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      this.onEvent({ type: 'notice', text: `Answer rejected (${content.replace(/^Output does not match required schema:\s*/i, 'schema: ').slice(0, 300)}); the model is retrying` });
    }
  }

  private handleResult(ev: Json): void {
    if (isObject(ev.structured_output)) this.resultStructured = JSON.stringify(ev.structured_output);
    if (typeof ev.result === 'string') this.resultText = ev.result;
    const subtype = typeof ev.subtype === 'string' ? ev.subtype : '';
    if (ev.is_error === true || subtype.startsWith('error')) {
      this.isError = true;
      const errors = Array.isArray(ev.errors) ? ev.errors.filter((e) => typeof e === 'string').join('; ') : '';
      this.errorMessage = errors || (typeof ev.result === 'string' && ev.result) || subtype || 'unknown error';
    }
    if (isObject(ev.usage)) this.recordUsage(ev.usage);
    if (typeof ev.total_cost_usd === 'number') this.usage.costUsd = ev.total_cost_usd;
    this.onEvent({ type: 'usage', ...this.usage });
  }

  private recordUsage(usage: Json): void {
    if (typeof usage.output_tokens === 'number') this.usage.outputTokens = usage.output_tokens;
    const details = usage.output_tokens_details;
    if (isObject(details) && typeof details.thinking_tokens === 'number') this.usage.thinkingTokens = details.thinking_tokens;
    this.onEvent({ type: 'usage', ...this.usage });
  }
}
