import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoCodeHost } from '../../src/codehost/none.js';
import { DEFAULT_CONFIG, deepMerge, type Config } from '../../src/core/config.js';
import { BadLlmOutputError, LlmFailedError, NoChangesError } from '../../src/core/errors.js';
import { generateTour, prepareTour } from '../../src/core/tour.js';
import { TempRepo } from '../helpers/repo.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-llm.mjs');

function config(env: Record<string, string> = {}, extra: object = {}): Config {
  return deepMerge(DEFAULT_CONFIG, { llm: { command: ['node', FAKE], env }, codehost: { provider: 'none' }, ...extra });
}

async function setup() {
  const repo = await TempRepo.create();
  await repo.commit('init', { 'a.txt': 'one\n', 'b.txt': 'b\n' });
  repo.git('checkout', '-q', '-b', 'feat');
  await repo.commit('feature', { 'a.txt': 'one\ntwo\n', 'c.txt': 'c\n' });
  const cacheDir = await mkdtemp(join(tmpdir(), 'bb-cache-'));
  return { repo, cacheDir };
}

describe('generateTour', () => {
  it('generates, materializes, caches, and honors refresh/noCache', async () => {
    const { repo, cacheDir } = await setup();
    const warnings: string[] = [];
    const base = { cwd: repo.dir, config: config(), cacheDir, codehost: new NoCodeHost(), warn: (m: string) => warnings.push(m) };

    const first = await generateTour(base);
    expect(first.fromCache).toBe(false);
    expect(first.tour.title).toBe('Fake tour');
    expect(first.tour.source).toMatchObject({ kind: 'range', base: 'main', head: 'feat', resolvedBy: 'ancestor-branch' });
    expect(first.tour.stats).toEqual({ files: 2, additions: 2, deletions: 0 });
    expect(first.tour.generator).toEqual({ preset: null, command: ['node', FAKE] });
    expect(first.tour.sections.map((s) => s.title)).toEqual(['The main idea']);
    expect(first.tour.sections[0]!.excerpts.map((e) => e.hunkId)).toEqual(['F1.H1', 'F2.H1']);
    expect(first.tour.sections[0]!.files).toEqual(['a.txt', 'c.txt']);
    expect(first.cachePath).toBeTruthy();
    expect(JSON.parse(await readFile(first.cachePath!, 'utf8')).title).toBe('Fake tour');
    expect(warnings).toEqual([]);

    const second = await generateTour(base);
    expect(second.fromCache).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.tour).toEqual(first.tour);

    const refreshed = await generateTour({ ...base, refresh: true });
    expect(refreshed.fromCache).toBe(false);

    const uncached = await generateTour({ ...base, noCache: true });
    expect(uncached.fromCache).toBe(false);
    expect(uncached.cacheKey).toBeNull();
  });

  it('keys the cache by prompt content and command', async () => {
    const { repo, cacheDir } = await setup();
    const a = await prepareTour({ cwd: repo.dir, config: config(), cacheDir, codehost: new NoCodeHost() });
    const b = await prepareTour({ cwd: repo.dir, config: config({}, { llm: { args: ['--other'] } }), cacheDir, codehost: new NoCodeHost() });
    expect(a.cacheKey).not.toBe(b.cacheKey);
    await repo.write('a.txt', 'dirty\n');
    const c = await prepareTour({ cwd: repo.dir, config: config(), cacheDir, codehost: new NoCodeHost() });
    expect(c.context.source.kind).toBe('working');
    expect(c.cacheKey).not.toBe(a.cacheKey);
  });

  it('accepts fenced and enveloped output', async () => {
    const { repo, cacheDir } = await setup();
    for (const mode of ['fenced', 'envelope']) {
      const r = await generateTour({ cwd: repo.dir, config: config({ FAKE_LLM_MODE: mode }), cacheDir, noCache: true, codehost: new NoCodeHost() });
      expect(r.tour.title).toBe('Fake tour');
    }
  });

  it('repairs once when the first answer is unusable', async () => {
    const { repo, cacheDir } = await setup();
    const state = join(await mkdtemp(join(tmpdir(), 'bb-state-')), 'seen');
    const r = await generateTour({
      cwd: repo.dir, cacheDir, noCache: true, codehost: new NoCodeHost(),
      config: config({ FAKE_LLM_MODE: 'prose-once', FAKE_LLM_STATE: state }),
    });
    expect(r.tour.summary).toContain('(repaired)');
  });

  it('fails cleanly on garbage output and on a failing command', async () => {
    const { repo, cacheDir } = await setup();
    await expect(
      generateTour({ cwd: repo.dir, cacheDir, noCache: true, codehost: new NoCodeHost(), config: config({ FAKE_LLM_MODE: 'garbage' }) }),
    ).rejects.toThrow(BadLlmOutputError);
    await expect(
      generateTour({ cwd: repo.dir, cacheDir, noCache: true, codehost: new NoCodeHost(), config: config({ FAKE_LLM_MODE: 'fail' }) }),
    ).rejects.toThrow(LlmFailedError);
  });

  it('reports when excludes leave nothing to tour', async () => {
    const { repo, cacheDir } = await setup();
    await expect(
      generateTour({ cwd: repo.dir, cacheDir, codehost: new NoCodeHost(), config: config({}, { git: { exclude: ['**/*.txt'] } }), range: { arg: 'main..feat' } }),
    ).rejects.toThrow(NoChangesError);
  });
});
