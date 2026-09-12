#!/usr/bin/env node
// Pretends to be `claude -p --output-format stream-json --verbose --include-partial-messages`.
// Reads the prompt on stdin, streams thinking + a StructuredOutput tool call, then a result event.
// FAKE_CLAUDE_MODE: ok (default) | error | text-only | no-result
// FAKE_CLAUDE_ARGS: file path to record argv into
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
if (process.env.FAKE_CLAUDE_ARGS) writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));
const prompt = readFileSync(0, 'utf8');
const ids = [...prompt.matchAll(/^\[(F\d+\.H\d+)\]/gm)].map((m) => m[1]);
const tour = {
  title: 'Streamed tour',
  summary: 'Made by the fake claude stream.',
  sections: [{ title: 'First section', description: 'd', files: [], excerpts: ids.slice(0, 1).map((h) => ({ hunk: h, lines: [], note: 'n' })) }],
};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ev = (event) => emit({ type: 'stream_event', event, session_id: 's' });

emit({ type: 'system', subtype: 'init', session_id: 's', tools: ['StructuredOutput'] });
ev({ type: 'message_start', message: { model: 'claude-fake-1', role: 'assistant', content: [] } });
ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
for (const t of ['Let me look at the diff. ', 'There is one hunk that matters; ', 'the tour needs one section.']) {
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
}
ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
ev({ type: 'content_block_stop', index: 0 });
if (mode === 'no-result') process.exit(0);

if (mode === 'text-only') {
  ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  const text = JSON.stringify(tour);
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, 20) } });
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(20) } });
  ev({ type: 'content_block_stop', index: 1 });
  ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 12 } } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { output_tokens: 50 }, total_cost_usd: 0.01 });
  process.exit(0);
}

ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'StructuredOutput', input: {} } });
const json = JSON.stringify(tour);
const third = Math.ceil(json.length / 3);
for (let i = 0; i < json.length; i += third) {
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + third) } });
}
ev({ type: 'content_block_stop', index: 1 });
ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 120, output_tokens_details: { thinking_tokens: 33 } } });
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: tour }] } });

if (mode === 'error') {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API overloaded', errors: ['API overloaded'], usage: {} });
  process.exit(0);
}
process.stdout.write('some stray non-json line\n');
emit({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: tour, usage: { output_tokens: 120, output_tokens_details: { thinking_tokens: 33 } }, total_cost_usd: 0.02 });
