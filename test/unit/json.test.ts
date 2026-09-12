import { describe, expect, it } from 'vitest';
import { BadLlmOutputError } from '../../src/core/errors.js';
import { extractJson } from '../../src/core/json.js';

const tour = { title: 't', summary: 's', sections: [] };

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson(JSON.stringify(tour))).toEqual(tour);
  });
  it('parses fenced JSON inside prose', () => {
    expect(extractJson('Sure!\n```json\n' + JSON.stringify(tour) + '\n```\nDone.')).toEqual(tour);
  });
  it('parses the first balanced object in prose', () => {
    expect(extractJson('Here: ' + JSON.stringify(tour) + ' and that is all')).toEqual(tour);
  });
  it('unwraps CLI envelopes', () => {
    expect(extractJson(JSON.stringify({ type: 'result', result: JSON.stringify(tour) }))).toEqual(tour);
    expect(extractJson(JSON.stringify({ result: '```json\n' + JSON.stringify(tour) + '\n```' }))).toEqual(tour);
  });
  it('handles braces inside strings', () => {
    const t = { ...tour, summary: 'has } and { inside "quotes"' };
    expect(extractJson('x ' + JSON.stringify(t) + ' y')).toEqual(t);
  });
  it('throws on garbage and empty output', () => {
    expect(() => extractJson('nothing here')).toThrow(BadLlmOutputError);
    expect(() => extractJson('   ')).toThrow(/empty/);
  });
});
