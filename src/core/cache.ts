import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TourSchema } from './schema.js';
import type { Tour } from './types.js';

export interface CacheEntry {
  key: string;
  path: string;
  tour: Tour;
}

/** Content-addressed store of generated tours: <dir>/tours/<sha256>.json */
export class TourCache {
  readonly toursDir: string;

  constructor(readonly dir: string) {
    this.toursDir = join(dir, 'tours');
  }

  static keyFor(prompt: string, command: string[]): string {
    return createHash('sha256')
      .update(createHash('sha256').update(prompt).digest('hex'))
      .update('\0')
      .update(JSON.stringify(command))
      .digest('hex');
  }

  pathFor(key: string): string {
    return join(this.toursDir, `${key}.json`);
  }

  async get(key: string): Promise<Tour | null> {
    let text: string;
    try {
      text = await readFile(this.pathFor(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = TourSchema.safeParse(JSON.parse(text));
      return parsed.success ? (parsed.data as Tour) : null;
    } catch {
      return null;
    }
  }

  async put(key: string, tour: Tour): Promise<string> {
    await mkdir(this.toursDir, { recursive: true });
    const final = this.pathFor(key);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(tour, null, 2) + '\n', 'utf8');
    await rename(tmp, final);
    return final;
  }

  async list(): Promise<CacheEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.toursDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries: CacheEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      const tour = await this.get(key);
      if (tour) entries.push({ key, path: this.pathFor(key), tour });
    }
    entries.sort((a, b) => b.tour.generatedAt.localeCompare(a.tour.generatedAt));
    return entries;
  }

  async clear(): Promise<number> {
    const entries = await this.list();
    await rm(this.toursDir, { recursive: true, force: true });
    return entries.length;
  }
}
