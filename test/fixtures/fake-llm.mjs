#!/usr/bin/env node
// A stand-in LLM for tests. Reads the prompt on stdin (or argv[2] when FAKE_LLM_ARG=1),
// finds the hunk ids in it, and prints a tour that references them.
// Modes via FAKE_LLM_MODE: json (default) | fenced | prose-once | garbage | fail | envelope
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const mode = process.env.FAKE_LLM_MODE ?? 'json';
const prompt = process.env.FAKE_LLM_ARG === '1' ? process.argv[2] ?? '' : readFileSync(0, 'utf8');
if (process.env.FAKE_LLM_CAPTURE) writeFileSync(process.env.FAKE_LLM_CAPTURE, prompt);

if (mode === 'fail') {
  process.stderr.write('boom: model unavailable\n');
  process.exit(2);
}

const ids = [...prompt.matchAll(/^\[(F\d+\.H\d+)\]/gm)].map((m) => m[1]);
const files = [...prompt.matchAll(/^### F\d+ (\S+) /gm)].map((m) => m[1]);
const tour = {
  title: 'Fake tour',
  summary: 'A tour produced by the fake model.',
  sections: [
    {
      title: 'The main idea',
      description: 'Everything important happens here.',
      files: files.slice(0, 1),
      excerpts: ids.slice(0, 2).map((h, i) => ({ hunk: h, note: `look at ${i + 1}` })),
    },
  ],
};
if (prompt.includes('Your previous response could not be used')) tour.summary += ' (repaired)';

if (mode === 'garbage') {
  process.stdout.write('I am not JSON at all.');
} else if (mode === 'fenced') {
  process.stdout.write('Sure! Here is the tour:\n\n```json\n' + JSON.stringify(tour, null, 2) + '\n```\nLet me know if you need more.');
} else if (mode === 'envelope') {
  process.stdout.write(JSON.stringify({ type: 'result', result: '```json\n' + JSON.stringify(tour) + '\n```' }));
} else if (mode === 'prose-once') {
  const marker = process.env.FAKE_LLM_STATE;
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, '1');
    process.stdout.write('Here you go: title, summary, sections...');
  } else {
    process.stdout.write(JSON.stringify(tour));
  }
} else {
  process.stdout.write(JSON.stringify(tour));
}
