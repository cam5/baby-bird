import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from '../../src/llm/claude-stream.js';
import type { LlmEvent } from '../../src/llm/provider.js';

const line = (o: object) => JSON.stringify(o) + '\n';
const ev = (event: object) => line({ type: 'stream_event', event });

describe('ClaudeStreamParser', () => {
  it('emits thinking and text deltas across chunk boundaries and returns the structured result', () => {
    const events: LlmEvent[] = [];
    const p = new ClaudeStreamParser((e) => events.push(e));
    const stream =
      line({ type: 'system', subtype: 'init' }) +
      ev({ type: 'message_start', message: { model: 'claude-x' } }) +
      ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm ' } }) +
      ev({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }) +
      ev({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'StructuredOutput' } }) +
      ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":' } }) +
      ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"t"}' } }) +
      ev({ type: 'message_delta', usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } } }) +
      'garbage line\n' +
      line({ type: 'result', subtype: 'success', result: 'prose', structured_output: { title: 't' }, total_cost_usd: 0.5 });
    // feed in awkward chunks
    for (let i = 0; i < stream.length; i += 7) p.push(stream.slice(i, i + 7));
    const out = p.finish();
    expect(events.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'hmm ' }]);
    expect(events.filter((e) => e.type === 'answer-start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('{"title":"t"}');
    expect(events.some((e) => e.type === 'usage' && e.model === 'claude-x')).toBe(true);
    expect(out).toMatchObject({ result: '{"title":"t"}', isError: false, unparsedLines: 1, usage: { outputTokens: 9, thinkingTokens: 4, costUsd: 0.5, model: 'claude-x' } });
  });

  it('falls back to the assistant tool input, then partial json, then text', () => {
    const a = new ClaudeStreamParser();
    a.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { title: 'from-message' } }] } }));
    a.push(ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":"partial"}' } }));
    expect(a.finish().result).toBe('{"title":"from-message"}');

    const b = new ClaudeStreamParser();
    b.push(ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":"partial"}' } }));
    expect(b.finish().result).toBe('{"title":"partial"}');

    const c = new ClaudeStreamParser();
    c.push(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'plain answer' } }));
    expect(c.finish().result).toBe('plain answer');

    expect(new ClaudeStreamParser().finish().result).toBeNull();
  });

  it('announces a fresh answer after a schema rejection and drops the rejected text', () => {
    const events: LlmEvent[] = [];
    const p = new ClaudeStreamParser((e) => events.push(e));
    p.push(ev({ type: 'content_block_start', content_block: { type: 'tool_use' } }));
    p.push(ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"sections":{}}' } }));
    p.push(line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Output does not match required schema: /sections: must be array' }] } }));
    p.push(ev({ type: 'content_block_start', content_block: { type: 'tool_use' } }));
    p.push(ev({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title":"ok"}' } }));
    expect(events.filter((e) => e.type === 'answer-start')).toHaveLength(2);
    expect(events.find((e) => e.type === 'notice')).toEqual({ type: 'notice', text: 'Answer rejected (schema: /sections: must be array); the model is retrying' });
    expect(p.finish().result).toBe('{"title":"ok"}');
  });

  it('reports errors from the result event', () => {
    const p = new ClaudeStreamParser();
    p.push(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', errors: ['rate limited'] }));
    expect(p.finish()).toMatchObject({ isError: true, errorMessage: 'rate limited', result: 'boom' });
  });
});
