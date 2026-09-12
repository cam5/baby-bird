import { createCodeHost, type CodeHost } from '../codehost/index.js';
import { collectCommits, collectDiff } from '../git/diff.js';
import { resolveRange, type RangeRequest } from '../git/range.js';
import { createProvider, type LlmProvider } from '../llm/index.js';
import { TourCache } from './cache.js';
import { resolveLlm, type Config } from './config.js';
import { BadLlmOutputError, NoChangesError } from './errors.js';
import { extractJson } from './json.js';
import { materializeTour } from './materialize.js';
import { buildPrompt, type BuiltPrompt } from './prompt/build.js';
import { PROMPT_VERSION, REPAIR_SUFFIX } from './prompt/template.js';
import { formatIssues, LlmTourOutputSchema, type LlmTourOutput } from './schema.js';
import type { Tour, TourContext } from './types.js';

export interface TourOptions {
  /** Git root (or any directory inside the repository). */
  cwd: string;
  config: Config;
  cacheDir: string;
  range?: RangeRequest;
  /** Ignore a cached tour but still store the new one. */
  refresh?: boolean;
  /** Neither read nor write the cache. */
  noCache?: boolean;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Injectable for tests. */
  provider?: LlmProvider;
  codehost?: CodeHost;
}

export interface PreparedTour {
  context: TourContext;
  built: BuiltPrompt;
  command: string[];
  preset: string | null;
  cacheKey: string;
}

export interface TourResult {
  tour: Tour;
  fromCache: boolean;
  cacheKey: string | null;
  cachePath: string | null;
  prompt: string;
}

/** Everything up to (but not including) the model call: git, code host, prompt, cache key. */
export async function prepareTour(opts: TourOptions): Promise<PreparedTour> {
  const debug = opts.debug ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const { config } = opts;
  const llm = resolveLlm(config);
  const codehost = opts.codehost ?? createCodeHost(config, { debug });

  const resolved = await resolveRange(opts.range ?? {}, {
    cwd: opts.cwd,
    exclude: config.git.exclude,
    defaultBranch: config.git.defaultBranch,
    codehost,
    debug,
  });
  debug(`source: ${JSON.stringify(resolved.source)}`);

  const diff = await collectDiff(resolved.source, { cwd: opts.cwd, exclude: config.git.exclude, warn });
  if (diff.files.length === 0) {
    throw new NoChangesError('The selected range has no changes (after excludes).', 'Check git.exclude in your config, or pass a different range.');
  }
  const commits = await collectCommits(resolved.source, opts.cwd);

  const context: TourContext = { source: resolved.source, branch: resolved.branch, diff, commits };
  if (resolved.pullRequest) context.pullRequest = resolved.pullRequest;

  const built = buildPrompt({ ...context, maxBytes: llm.maxPromptBytes });
  if (built.truncation.truncated.length || built.truncation.omitted.length) {
    warn(`Prompt exceeded ${llm.maxPromptBytes} bytes; truncated ${built.truncation.truncated.length} and omitted ${built.truncation.omitted.length} file diff(s).`);
  }
  const cacheKey = TourCache.keyFor(`v${PROMPT_VERSION}\n${built.prompt}`, llm.command);
  debug(`prompt ${Buffer.byteLength(built.prompt)} bytes, cache key ${cacheKey.slice(0, 12)}`);

  return { context, built, command: llm.command, preset: llm.preset, cacheKey };
}

export async function generateTour(opts: TourOptions, prepared?: PreparedTour): Promise<TourResult> {
  const debug = opts.debug ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const { config } = opts;
  const prep = prepared ?? (await prepareTour(opts));
  const useCache = config.cache.enabled && !opts.noCache;
  const cache = useCache ? new TourCache(opts.cacheDir) : null;

  if (cache && !opts.refresh) {
    const hit = await cache.get(prep.cacheKey);
    if (hit) {
      debug(`cache hit: ${cache.pathFor(prep.cacheKey)}`);
      return { tour: hit, fromCache: true, cacheKey: prep.cacheKey, cachePath: cache.pathFor(prep.cacheKey), prompt: prep.built.prompt };
    }
    debug('cache miss');
  }

  const llm = resolveLlm(config);
  const provider = opts.provider ?? createProvider(llm, { cwd: opts.cwd, debug });
  const output = await completeWithRepair(provider, prep.built.prompt, debug);

  const tour = materializeTour({
    output,
    diff: prep.context.diff,
    source: prep.context.source,
    generator: { preset: prep.preset, command: prep.command },
    pullRequest: prep.context.pullRequest,
    maxExcerptLines: config.render.maxExcerptLines,
    warn,
  });

  let cachePath: string | null = null;
  if (cache) {
    cachePath = await cache.put(prep.cacheKey, tour);
    debug(`cached: ${cachePath}`);
  }
  return { tour, fromCache: false, cacheKey: cache ? prep.cacheKey : null, cachePath, prompt: prep.built.prompt };
}

/** Ask once; if the answer isn't usable JSON matching the schema, ask once more with the reason. */
async function completeWithRepair(provider: LlmProvider, prompt: string, debug: (msg: string) => void): Promise<LlmTourOutput> {
  let raw = await provider.complete(prompt);
  debug(`raw model output (attempt 1):\n${raw}`);
  const first = parseOutput(raw);
  if (first.ok) return first.value;

  debug(`attempt 1 unusable: ${first.reason}; retrying with repair prompt`);
  raw = await provider.complete(prompt + REPAIR_SUFFIX(first.reason));
  debug(`raw model output (attempt 2):\n${raw}`);
  const second = parseOutput(raw);
  if (second.ok) return second.value;
  throw new BadLlmOutputError(`The model did not return a usable tour: ${second.reason}`, raw, 'Run with --debug to see the raw output, or try another preset.');
}

function parseOutput(raw: string): { ok: true; value: LlmTourOutput } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const parsed = LlmTourOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `JSON did not match the schema (${formatIssues(parsed.error)})` };
  return { ok: true, value: parsed.data };
}
