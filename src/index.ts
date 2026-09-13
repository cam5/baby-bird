// Public API: everything a non-CLI consumer (a TUI, a web UI, a script) needs.
export type * from './core/types.js';
export { LlmTourOutputSchema, TourSchema, formatIssues, type LlmTourOutput } from './core/schema.js';
export {
  BUILTIN_PRESETS,
  ConfigSchema,
  DEFAULT_CONFIG,
  PartialConfigSchema,
  allPresets,
  deepMerge,
  defaultCacheDir,
  loadConfig,
  projectConfigPath,
  resolveChat,
  resolveLlm,
  shellSplit,
  userConfigPath,
  type Config,
  type ConfigLayer,
  type LlmKind,
  type LlmPreset,
  type LoadedConfig,
  type PartialConfig,
  type ResolvedChat,
  type ResolvedLlm,
} from './core/config.js';
export * from './core/errors.js';
export { TourCache, type CacheEntry } from './core/cache.js';
export { extractJson } from './core/json.js';
export { materializeTour, sliceHunk, OTHER_CHANGES_TITLE } from './core/materialize.js';
export { buildPrompt, describeSource, renderChange, type BuiltPrompt, type ChangeInput, type PromptInput, type TruncationReport } from './core/prompt/build.js';
export { PROMPT_VERSION, promptHeader } from './core/prompt/template.js';
export { generateTour, prepareTour, type PreparedTour, type TourOptions, type TourResult } from './core/tour.js';
export { buildChatContext, type ChatContext, type ChatContextInput } from './core/chat.js';
export { collectCommits, collectDiff } from './git/diff.js';
export { currentBranch, gitRoot, revParse } from './git/exec.js';
export { diffStats, parseDiff } from './git/parse.js';
export { detectDefaultBranch, resolveRange, type RangeRequest, type ResolveOptions, type ResolvedRange } from './git/range.js';
export { ClaudeStreamParser, CommandProvider, createProvider, type CommandKind, type CompleteOptions, type LlmEvent, type LlmProvider } from './llm/index.js';
export { chatArgv, chatSlots, launchChat, type ChatOutcome, type LaunchChatOptions } from './llm/chat.js';
export { TOUR_JSON_SCHEMA } from './core/prompt/json-schema.js';
export { noProgress, type ProgressSink } from './core/progress.js';
export { GhCodeHost, NoCodeHost, createCodeHost, type CodeHost } from './codehost/index.js';
export { CliRenderer, writeMaybePaged, relativeTime, wrap, type Renderer, type RenderOptions } from './render/index.js';
