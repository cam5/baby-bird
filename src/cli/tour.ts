import { NotARepoError } from '../core/errors.js';
import { generateTour, prepareTour } from '../core/tour.js';
import { CliRenderer } from '../render/cli.js';
import { writeMaybePaged, writeStdout } from '../render/pager.js';
import { openSession, resolveHighlight, terminalWidth, type GlobalFlags } from './shared.js';

export interface TourFlags extends GlobalFlags {
  working?: boolean;
  staged?: boolean;
  section?: number;
  json?: boolean;
  dumpPrompt?: boolean;
  refresh?: boolean;
}

export async function tourCommand(rangeArg: string | undefined, flags: TourFlags): Promise<void> {
  const session = await openSession(flags, { requireRepo: true });
  if (!session.root) throw new NotARepoError(session.cwd);
  const { config } = session.loaded;

  const options = {
    cwd: session.root,
    config,
    cacheDir: session.loaded.cacheDir,
    range: { arg: rangeArg, working: flags.working, staged: flags.staged },
    refresh: flags.refresh,
    noCache: flags.cache === false,
    debug: session.debug,
    warn: session.warn,
  };

  const prepared = await prepareTour(options);
  if (flags.dumpPrompt) {
    await writeStdout(prepared.built.prompt.endsWith('\n') ? prepared.built.prompt : prepared.built.prompt + '\n');
    return;
  }

  const result = await generateTour(options, prepared);

  if (flags.json) {
    await writeStdout(JSON.stringify(result.tour, null, 2) + '\n');
    return;
  }

  const renderer = new CliRenderer();
  const output = renderer.render(result.tour, {
    color: session.colorEnabled,
    width: terminalWidth(config.render.width),
    section: flags.section,
    fromCache: result.fromCache,
    highlight: resolveHighlight(config.render.highlight, session.colorEnabled),
    theme: config.render.theme,
  });
  await writeMaybePaged(output, {
    mode: config.render.pager,
    isTTY: Boolean(process.stdout.isTTY),
    rows: process.stdout.rows ?? 24,
  });
}
