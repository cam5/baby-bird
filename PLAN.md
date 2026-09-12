# baby-bird (`bb`) — CLI code tours

## Context

Graphite's "Code Tours" turn a PR into a guided walkthrough: the narrative lives alongside the diff so a reviewer can move through a change in sequence instead of hunting for the thread. `baby-bird` is the same idea as a local CLI: point it at a git range (or the working tree), have an LLM organize the change into ordered **sections** (title, description, file/±counts, excerpts), cache the result by content hash, and render it to the terminal. No inline comments, no required remote provider, LLM-agnostic (the prompt and the renderer are where the value is).

Greenfield project in an empty dir (`/Users/cameron/projects/baby-bird`, not yet a git repo). Node 26 + pnpm are available.

## Decisions (locked with user)

| Topic | Decision |
|---|---|
| Language | **TypeScript / Node ≥ 22** (Go only wins on single-binary distribution, which `npx`/`pnpm dlx` covers; TS keeps the core types reusable for an Ink/web renderer later). |
| LLM backend | **Shell-command provider only** in v1 (default `claude -p`). Provider interface stays so an SDK provider can be added later. |
| Code host | **Configurable, `gh` by default**, `none` to disable. Used for (a) inferring the PR base branch and (b) feeding PR title/body into the prompt. Implemented via the `gh` CLI, no API tokens handled by us. |
| Default range | Cascade: dirty working tree → PR base (via code host) → nearest ancestor branch → default branch. Explicit `bb HEAD~3`, `bb main..feat`, `bb --staged`, `bb --working` always win. |
| UI (v1) | **Static, pager-friendly** colored render. `--section N`, `--json`, `--no-color`. Renderer behind an interface. |
| Layout | **Single package**, layered `src/` (`core`, `git`, `llm`, `codehost`, `render`, `cli`). Exports `.` (core API) and bin `bb`. |
| Cache | Content-addressed JSON files under `$XDG_CACHE_HOME/baby-bird/` (default `~/.cache/baby-bird`). |
| Config | Cascade: defaults → `$XDG_CONFIG_HOME/baby-bird/config.json` → `<git-root>/.baby-bird/config.json` → `BB_*` env → flags. |

## Repo layout

```
baby-bird/
  package.json            name: baby-bird, bin: { bb: dist/cli.js }, exports: { ".": dist/index.js }
  tsconfig.json           strict, NodeNext, target ES2022
  tsup.config.ts          entries: src/index.ts, src/cli/main.ts (shebang banner)
  vitest.config.ts
  README.md
  src/
    index.ts              public core API re-exports (types, generateTour, loadConfig, renderers)
    core/
      types.ts            Tour, Section, Excerpt, TourSource, DiffFile, Hunk, HunkLine, PullRequestInfo
      schema.ts           zod schemas: TourSchema (persisted), LlmTourOutputSchema (what the model returns), ConfigSchema
      config.ts           XDG paths, cascade loader, env overrides, `explain()` for `bb config`
      cache.ts            key derivation, get/put/list/clear, atomic writes
      tour.ts             generateTour(): orchestrates git → prompt → llm → materialize → cache
      materialize.ts      LLM output + parsed diff → Tour (resolve excerpt refs, compute stats, "Other changes" section)
      prompt/
        template.md       the prompt (bundled as string import); PROMPT_VERSION constant beside it
        build.ts          assembles context: PR info, commits, file table, diff w/ hunk IDs; truncation policy
      json.ts             extractJson(text): whole / fenced / balanced-brace scan; repair-retry helper
      errors.ts           BbError subclasses w/ exit codes (NotARepo, NoChanges, LlmFailed, BadLlmOutput, …)
    git/
      exec.ts             run git (spawn, cwd, error mapping)
      range.ts            resolveRange(): the default cascade + explicit parsing
      diff.ts             collect unified diff + numstat + log; honors excludes via pathspec
      parse.ts            unified diff parser → DiffFile[] with hunks, line numbers, binary/rename flags
    llm/
      provider.ts         interface LlmProvider { complete(prompt, opts): Promise<string> }
      command.ts          CommandProvider: spawn configured argv, prompt via stdin or `{prompt}` arg, timeout, stderr capture
      index.ts            createProvider(config)
    codehost/
      provider.ts         interface CodeHost { currentPullRequest(): Promise<PullRequestInfo|null> }
      gh.ts               `gh pr view --json number,title,body,baseRefName,url,headRefName`; null if no PR / gh missing
      none.ts
      index.ts            createCodeHost(config)
    render/
      renderer.ts         interface Renderer { render(tour, opts): string }
      cli.ts              CliRenderer (color, wrapping, excerpt gutters); TOC + sections
      pager.ts            pipe to $PAGER / `less -R` when TTY and output > rows
    cli/
      main.ts             commander program; commands: (default) tour, cache, config, init
      tour.ts             default command handler
      cache-cmd.ts, config-cmd.ts, init-cmd.ts
  test/
    fixtures/diffs/*.diff
    unit/ (parse, json, materialize, config, range-parsing, renderer snapshots)
    integration/ (temp git repo → resolveRange + collectDiff; fake LLM command → end-to-end generateTour)
```

## Core data model (`src/core/types.ts`)

```ts
type TourSource =
  | { kind: 'range'; base: string; head: string; baseSha: string; headSha: string; mergeBase?: string }
  | { kind: 'working'; headSha: string; staged: boolean };

interface Tour {
  version: 1;
  generatedAt: string;
  source: TourSource;
  pullRequest?: { number: number; title: string; url: string };
  title: string;                 // one-line name for the whole change
  summary: string;               // 2–4 sentences
  stats: { files: number; additions: number; deletions: number };
  sections: Section[];
}

interface Section {
  id: string;                    // "s1", "s2", …
  title: string;
  description: string;           // high-level, why + what
  files: string[];               // paths this section is about (non-exclusive across sections)
  stats: { files: number; additions: number; deletions: number };  // computed from `files`
  excerpts: Excerpt[];
}

interface Excerpt {
  file: string;
  note?: string;                 // one-line caption from the model
  oldStart: number; newStart: number;
  lines: HunkLine[];             // { type: 'add'|'del'|'ctx'; oldNo?: number; newNo?: number; text: string }
}
```

**Key design point:** the model never reproduces code. Every hunk in the prompt carries an ID (`[F3.H2]`); the model returns *references* (`{ file, hunk: "F3.H2", lines?: [from,to], note? }`) and `materialize.ts` slices the real diff. This kills hallucinated excerpts and shrinks output tokens.

LLM output schema (`LlmTourOutputSchema`): `{ title, summary, sections: [{ title, description, files: string[], excerpts: [{ hunk, lines?, note? }] }] }`. Unknown hunk IDs / files are dropped with a warning, not fatal. Files in the diff not claimed by any section go into an auto-generated final section **"Other changes"** (no description, files + stats only) so the tour is always complete.

## Range resolution (`src/git/range.ts`)

Explicit arg wins:
- `A..B` → range(A, B); `A...B` → range(merge-base(A,B), B); bare `X` → range(X, HEAD).
- `--working` → working tree vs HEAD (tracked + untracked, via `git add -N`-free approach: `git diff HEAD` plus `git diff --no-index /dev/null <untracked>` for each untracked file); `--staged` → `git diff --cached`.

Otherwise the cascade:
1. `git status --porcelain` non-empty → **working**.
2. Code host enabled and `currentPullRequest()` returns a PR → range(`origin/<baseRefName>`, HEAD) using three-dot semantics; attach PR info.
3. **Nearest ancestor branch**: for each local branch ≠ current, `merge-base <br> HEAD`; discard branches whose merge-base == HEAD (descendants/same); pick the one minimizing `rev-list --count <mb>..HEAD`; ties → prefer default branch.
4. **Default branch**: `git symbolic-ref refs/remotes/origin/HEAD` → else first existing of `main`, `master`, `trunk`.
5. If the resolved diff is empty → `NoChanges` error with a hint.

The renderer header always states what was resolved: `feat/x vs main (merge-base a1b2c3d) · 12 files · +340 −88`.

## Diff collection & parsing (`src/git/diff.ts`, `parse.ts`)

- `git diff --no-color --no-ext-diff -M -U3 <spec> -- . ':(exclude)<glob>'…` using config `git.exclude` (defaults: lockfiles, `dist/**`, `*.min.*`, `*.snap`, `*.map`). Excludes are passed as git pathspecs — no glob dep.
- `git diff --numstat` for per-file ±; `git log --format=%h%x09%s <base>..<head>` for commit subjects (range mode only).
- Own small unified-diff parser: files (old/new path, rename, binary, new/deleted), hunks with headers, lines with old/new numbers. Fixture-tested.

## Prompt (`src/core/prompt/`)

`template.md` sections, in order: role + goal ("write a guided tour for a reviewer; sections in the order a reader should encounter them; group by concept not by file; lead with the change that makes the rest make sense"), rules (3–8 sections, non-exclusive files, 1–3 excerpts per section, reference hunks by ID, never invent code, description explains *why* then *what*, mention risky bits), the exact JSON output contract, then context blocks: PR title/body (if any), commit subjects, file table (path, ±, status), and the diff with `[F#.H#]` markers.

Truncation policy (`build.ts`): budget `llm.maxPromptBytes` (default ~200 KB). Order of sacrifice: excluded globs are already gone → collapse the largest files' hunks to headers + first N lines with `… [truncated]` → if still over, list remaining files as names+stats only. Header tells the model what was truncated so it can still assign them to sections.

`PROMPT_VERSION` bumps whenever `template.md` or `build.ts` changes materially; it is part of the cache key.

`bb --dump-prompt` prints the assembled prompt and exits without calling the LLM — this is the primary prompt-tuning loop.

## LLM provider (`src/llm/command.ts`)

Config `llm.command: string[]` (default `["claude", "-p"]`), `llm.promptVia: "stdin" | "arg"` (arg mode substitutes `{prompt}` in argv), `llm.timeoutMs` (default 180 000), `llm.env` (extra env). Spawn, capture stdout/stderr, nonzero exit → `LlmFailed` with stderr tail.

Output handling (`json.ts`): `extractJson()` tries whole-stdout parse → fenced ```json block → first balanced `{…}`; then zod-validate. On failure, **one repair retry**: re-run the command with the original prompt + "Your previous output failed validation: <zod issues>. Return only the JSON object." Both raw outputs go to stderr under `--debug`.

## Cache (`src/core/cache.ts`)

- Key = `sha256(sha256(prompt) | effective llm command)`. The assembled prompt already encodes `PROMPT_VERSION`, the diff content, PR title/body, commit subjects, and truncation, so hashing it is stable for a given range's shas *and* works uniformly for working-tree diffs. `TourSource` shas are stored inside the entry for display/listing.
- Path: `<cacheDir>/tours/<key>.json`; write via temp file + rename. `cache.enabled`, `cache.dir` configurable; `--refresh` bypasses read, `--no-cache` bypasses both.
- `bb cache ls` (key, source, title, age), `bb cache clear`, `bb cache path`.

## Config (`src/core/config.ts`)

```jsonc
{
  "llm": {
    "preset": "claude",                // which preset to use (built-in or from `presets` below)
    "presets": {                       // user-defined presets, merged over the built-ins
      "fast": { "command": ["claude", "-p", "--bare", "--tools", "", "--model", "haiku"] }
    },
    "args": [],                        // extra argv appended to the chosen preset's command
    "command": null,                   // a whole custom invocation; when set, `preset` is ignored
    "promptVia": null,                 // "stdin" (default) | "arg" (substitutes {prompt} in argv)
    "timeoutMs": 180000,
    "maxPromptBytes": 200000,
    "env": {}
  },
  "codehost": { "provider": "gh" },    // "gh" | "none"
  "git":      { "defaultBranch": null, "exclude": ["**/pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock", "**/*.min.*", "**/dist/**", "**/*.snap", "**/*.map"] },
  "render":   { "color": "auto", "pager": "auto", "maxExcerptLines": 60, "width": null },
  "cache":    { "enabled": true, "dir": null }
}
```

**Presets.** Built-ins target the Claude Code CLI in print mode with hooks/tools/session persistence off so it behaves like a pure completion:

| preset | command |
|---|---|
| `claude` (default) | `claude -p --no-session-persistence --setting-sources "" --tools ""` (its default model) |
| `claude-sonnet` | … `--model sonnet --effort high` |
| `claude-opus` | … `--model opus --effort high` |
| `claude-fable` | … `--model fable --effort high` |
| `claude-haiku` | … `--model haiku` |
| `llm` | `llm` (Simon Willison's CLI, its default model) |

Resolution: `llm.command` if set → else `presets[llm.preset]` (user-defined wins over built-in) → append `llm.args`. `--preset <name>` flag and `BB_PRESET` env select a preset per run; `BB_LLM_COMMAND` (shell-split) sets a custom command. The effective command is part of the cache key, so switching presets regenerates rather than reusing another model's tour.

Loaded with zod; objects deep-merge across layers, arrays and scalars replace; env overrides: `BB_PRESET`, `BB_LLM_COMMAND`, `BB_CODEHOST`, `BB_CACHE_DIR`, `BB_NO_CACHE`, `NO_COLOR`. `bb config` prints the effective config with a per-layer source annotation plus the resolved LLM command. `bb init` writes `<git-root>/.baby-bird/config.json` with a minimal starter.

## Renderer (`src/render/cli.ts`)

Static layout: header (title, resolved range line, PR link if any, totals) → summary paragraph → TOC (`1. Title  · 3 files · +40 −12`) → each section: rule, numbered title, stats line, wrapped description, file list, excerpts as `path:newStart` blocks with a dual line-number gutter and `+`/`-` coloring, `note` as an italic caption. `--section N` renders only that section (still with header). Wrapping uses terminal columns (or `render.width`). Color via `picocolors`, honoring `NO_COLOR`, `--no-color`, non-TTY. Pager: when TTY and lines > rows and `render.pager != "never"`, pipe through `$PAGER` or `less -R`.

`Renderer` interface + `Tour` JSON are the seam for a future Ink/curses or web UI; `--json` emits the `Tour` object verbatim.

## CLI surface (`src/cli/main.ts`, commander)

```
bb [range]            generate (or load cached) and render the tour
  --working | --staged
  --section <n>       --json      --dump-prompt     --refresh    --no-cache
  --no-color          --no-pager  --debug           --cwd <dir>
bb cache ls | clear | path
bb config [--json]
bb init
```
Exit codes: 0 ok · 2 usage · 3 not a repo / no changes · 4 LLM failed · 5 bad LLM output after retry.

## Dependencies

Runtime: `commander`, `zod`, `picocolors`. Everything else is `node:` (child_process, crypto, fs, os, path). Dev: `typescript`, `tsup`, `tsx`, `vitest`, `@types/node`. Dev loop runs TS directly via `tsx` (`pnpm dev`); `pnpm build` → `dist/` via tsup.

## Implementation order

1. **Scaffold**: `git init`, package.json (pnpm, `bb` bin, exports), tsconfig, tsup, vitest, README stub. Core `types.ts`, `schema.ts`, `errors.ts`, `config.ts` (+ tests for cascade).
2. **Git layer**: `exec.ts`, `parse.ts` (+ fixture tests), `diff.ts`, `range.ts` (+ temp-repo integration tests covering each cascade step).
3. **Prompt + LLM**: `template.md`, `build.ts` (+ truncation tests), `json.ts` (+ tests), `command.ts` (+ test using a fake `node -e` command that echoes canned JSON), `materialize.ts` (+ tests incl. bad refs and "Other changes").
4. **Orchestration + cache**: `tour.ts`, `cache.ts` (+ tests); `--dump-prompt`, `--refresh`, `--no-cache`.
5. **Render + CLI**: `cli.ts` renderer (+ no-color snapshot tests), `pager.ts`, `main.ts` wiring, `cache`/`config`/`init` commands.
6. **Code host**: `gh.ts` (graceful when `gh` is absent or unauthenticated → behave as `none` with a `--debug` note), wire into range cascade and prompt.
7. **Polish**: README (config reference, provider recipes for `claude -p`, `llm`, `ollama run`), prompt tuning pass using `--dump-prompt` on real diffs.

## Verification

- `pnpm test` — unit + integration suites green (diff parser fixtures, JSON extraction, materialize, config cascade, range cascade on a temp repo, end-to-end `generateTour` with a fake LLM command).
- In this repo once it has a few commits on a branch: `pnpm dev -- --dump-prompt` shows a sane prompt with hunk IDs; `pnpm dev` runs `claude -p`, renders a tour; second run is instant and `bb cache ls` shows the entry; `pnpm dev -- --json | jq .sections[0]` is valid; `--section 2` and `--no-color | cat` behave; `NO_COLOR=1` respected.
- Cascade checks: dirty tree → working; on a branch with an open PR (`gh pr view` works) → base branch inferred and PR title appears in header; `codehost.provider: "none"` → falls to nearest-ancestor/default.
- Failure paths: bogus `llm.command` → exit 4 with stderr tail; LLM returning prose → repair retry, then exit 5 with `--debug` showing raw output; run outside a repo → exit 3.
- `pnpm build && node dist/cli.js --help` works; `pnpm pack` contains only `dist/` + README.
