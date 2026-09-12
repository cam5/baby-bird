import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TourCache } from '../../src/core/cache.js';
import type { Tour } from '../../src/core/types.js';

const tour = (title: string, at: string): Tour => ({
  version: 1, generatedAt: at, title, summary: '', stats: { files: 0, additions: 0, deletions: 0 }, sections: [],
  source: { kind: 'working', headSha: 'h', staged: false, resolvedBy: 'explicit' }, generator: { preset: null, command: ['x'] },
});

describe('TourCache', () => {
  it('derives stable keys from prompt and command', () => {
    expect(TourCache.keyFor('p', ['a'])).toBe(TourCache.keyFor('p', ['a']));
    expect(TourCache.keyFor('p', ['a'])).not.toBe(TourCache.keyFor('p', ['b']));
    expect(TourCache.keyFor('p', ['a'])).not.toBe(TourCache.keyFor('q', ['a']));
  });

  it('round-trips, lists newest first, ignores junk, and clears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bb-cache-'));
    const cache = new TourCache(dir);
    expect(await cache.get('missing')).toBeNull();
    expect(await cache.list()).toEqual([]);

    await cache.put('k1', tour('one', '2026-01-01T00:00:00.000Z'));
    await cache.put('k2', tour('two', '2026-02-01T00:00:00.000Z'));
    await mkdir(cache.toursDir, { recursive: true });
    await writeFile(join(cache.toursDir, 'junk.json'), '{"nope":true}');
    await writeFile(join(cache.toursDir, 'broken.json'), '{');

    expect((await cache.get('k1'))?.title).toBe('one');
    expect((await cache.list()).map((e) => e.tour.title)).toEqual(['two', 'one']);
    expect(await cache.clear()).toBe(2);
    expect(await cache.list()).toEqual([]);
  });
});
