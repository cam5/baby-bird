import pc from 'picocolors';
import { TourCache } from '../core/cache.js';
import { describeSource, relativeTime } from '../render/cli.js';
import { openSession, type GlobalFlags } from './shared.js';

export async function cacheLsCommand(flags: GlobalFlags): Promise<void> {
  const session = await openSession(flags, { requireRepo: false });
  const c = pc.createColors(session.colorEnabled);
  const cache = new TourCache(session.loaded.cacheDir);
  const entries = await cache.list();
  if (entries.length === 0) {
    process.stdout.write(`No cached tours in ${cache.toursDir}\n`);
    return;
  }
  for (const e of entries) {
    const t = e.tour;
    process.stdout.write(
      `${c.dim(e.key.slice(0, 12))}  ${relativeTime(t.generatedAt).padEnd(12)}  ${c.bold(t.title)}\n` +
        `${' '.repeat(14)}${c.dim(describeSource(t.source))}${t.generator.preset ? c.dim(` · ${t.generator.preset}`) : ''}\n`,
    );
  }
}

export async function cacheClearCommand(flags: GlobalFlags): Promise<void> {
  const session = await openSession(flags, { requireRepo: false });
  const cache = new TourCache(session.loaded.cacheDir);
  const n = await cache.clear();
  process.stdout.write(`Removed ${n} cached tour${n === 1 ? '' : 's'} from ${cache.toursDir}\n`);
}

export async function cachePathCommand(flags: GlobalFlags): Promise<void> {
  const session = await openSession(flags, { requireRepo: false });
  process.stdout.write(new TourCache(session.loaded.cacheDir).toursDir + '\n');
}
