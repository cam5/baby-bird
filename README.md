# baby-bird 🐣

Guided **code tours** for git changes, on the command line.

`bb` looks at a change (a branch, a range, or your working tree), asks an LLM to organize it into an ordered set of sections, and renders the result in your terminal: each section has a title, a description of *why* and *what*, the files it touches with `+/-` counts, and excerpts pulled from the real diff. Tours are cached by content, so the model runs once per change.

```
🐣 Add a shell-command LLM provider with presets
feat/llm-presets vs main (merge-base 4e2a1c9) · base from pull request
PR #12: Add LLM presets  https://github.com/you/repo/pull/12
6 files · +412 -18 · 4 sections · claude-sonnet, generated just now

Presets let people pick a model and effort level without hand-writing a
command line, while still allowing a fully custom invocation ...

Contents
  1. The preset table and how it resolves        2 files · +96 -4
  2. Running any CLI as the model                 1 file · +93 -0
  3. Config cascade: user, project, env, flags    2 files · +120 -14
  4. Tests                                        1 file · +103 -0

────────────────────────────────────────────────────────────────────
1. The preset table and how it resolves   (1/4)
   2 files · +96 -4

   Presets are named argv templates. Resolution is: an explicit
   `llm.command` wins, otherwise the named preset (user-defined
   presets shadow built-ins), then `llm.args` are appended ...

   src/core/config.ts
   src/index.ts

   src/core/config.ts:24  The built-in presets, all targeting the Claude Code CLI
    22  24 │ const CLAUDE_BASE = ['claude', '-p', '--bare', ...
        25 │+export const BUILTIN_PRESETS = Object.freeze({
   ...
```

## Install

```sh
pnpm add -g @cam5/baby-bird     # or: npm i -g @cam5/baby-bird
bb --help
```

Requirements: Node 22+, git, and some CLI that can answer a prompt (by default the [Claude Code](https://claude.com/claude-code) CLI, `claude`).

## Usage

```
bb                     tour the current branch
bb main..feature       tour an explicit range
bb main...feature      same, from the merge-base
bb HEAD~3              tour the last three commits
bb release/2.0         what HEAD adds on top of release/2.0 (merge-base semantics)
bb --working           uncommitted changes (tracked + untracked)
bb --staged            what you are about to commit
bb --section 2         render only the second section
bb --json | jq         machine-readable tour
bb --dump-prompt       print the prompt instead of calling the model
bb --refresh           regenerate even if a cached tour exists
bb --preset claude-sonnet
bb --no-progress       no live status block
```

### What does bare `bb` tour?

1. If the working tree has uncommitted changes: those.
2. Else, if the code host knows a pull request for this branch (`gh pr view`): the branch against the PR's base, and the PR title/body are fed to the model.
3. Else, the branch against its nearest ancestor branch (the local branch whose merge-base is closest to `HEAD`).
4. Else, the branch against the default branch (`origin/HEAD`, or `main`/`master`/`trunk`).

The header of every tour says which one was used.

## Configuration

Config is JSON, merged in this order (later wins; objects merge, arrays replace):

1. built-in defaults
2. `$XDG_CONFIG_HOME/baby-bird/config.json` (default `~/.config/baby-bird/config.json`)
3. `<repo>/.baby-bird/config.json` (create one with `bb init`)
4. environment: `BB_PRESET`, `BB_LLM_COMMAND`, `BB_CODEHOST`, `BB_CACHE_DIR`, `BB_NO_CACHE`, `NO_COLOR`
5. flags: `--preset`, `--color/--no-color`, `--no-cache`, `--no-pager`

`bb config` shows every layer, what it contributed, the resolved LLM command, and all presets.

All keys, with defaults:

```jsonc
{
  "llm": {
    "preset": "claude",        // which preset to run (built-in or from "presets")
    "presets": {},             // your own presets; same names shadow built-ins
    "args": [],                // extra argv appended to the preset's command
    "command": null,           // a whole custom invocation; when set, "preset" is ignored
    "promptVia": null,         // "stdin" (default) or "arg" (replace {prompt} in argv)
    "kind": null,              // "claude" (streams progress from the Claude Code CLI) or "plain"; default from the preset
    "jsonSchema": false,       // Claude kind: also pass --json-schema so the CLI validates the answer (see below)
    "timeoutMs": 180000,
    "maxPromptBytes": 200000,  // larger diffs are truncated, biggest files first
    "env": {}                  // extra environment for the command
  },
  "codehost": { "provider": "gh" },          // "gh" or "none"
  "git": {
    "defaultBranch": null,                   // auto-detect
    "exclude": ["**/pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock", "**/Cargo.lock",
                "**/*.min.*", "**/dist/**", "**/*.snap", "**/*.map"]
  },
  "render": { "color": "auto", "pager": "auto", "maxExcerptLines": 60, "width": null },
  "cache":  { "enabled": true, "dir": null }  // default $XDG_CACHE_HOME/baby-bird
}
```

### While it generates

On a terminal, `bb` shows a small live status block on stderr (stdout stays clean for piping): a spinner with the current stage and elapsed time, then, for Claude presets, a reasoning indicator, and finally each section title as the answer takes shape. If the CLI rejects an answer against the schema you see that too, and the section list starts over when the model resubmits. When the tour lands the block is replaced by one dim summary line (time, tokens, model). Turn it off with `--no-progress`; it is also off when stderr is not a TTY or `--debug` is on.

About that reasoning indicator: Claude Code's print mode (2.1.x) streams thinking *heartbeats* roughly every second but with empty text, both in the deltas and in the final message, so `bb` shows a pulse trail that grows with each heartbeat rather than the words. The rolling text window is implemented and takes over automatically whenever a runner does include reasoning text.

### LLM presets

The model is just a command: the prompt goes in on stdin, the answer comes out on stdout. Built-in presets:

| preset | runs |
|---|---|
| `claude` (default) | `claude -p --no-session-persistence --setting-sources "" --tools ""` |
| `claude-sonnet` | the above plus `--model sonnet --effort high` |
| `claude-opus` | the above plus `--model opus --effort high` |
| `claude-fable` | the above plus `--model fable --effort high` |
| `claude-haiku` | the above plus `--model haiku` |
| `llm` | `llm` ([Simon Willison's CLI](https://llm.datasette.io/)) |

Add flags to a preset, define your own, or replace the command entirely:

```jsonc
{
  "llm": {
    "preset": "claude-sonnet",
    "args": ["--fallback-model", "haiku"],
    "presets": {
      "local": { "command": ["ollama", "run", "qwen2.5-coder:14b"] },
      "gemini": { "command": ["gemini", "-p", "{prompt}"], "promptVia": "arg" }
    }
  }
}
```

```sh
bb --preset local
BB_LLM_COMMAND='llm -m gpt-4.1' bb
```

Presets have a `kind`. The built-in Claude presets are `"claude"`: `bb` appends `--output-format stream-json --verbose --include-partial-messages` so the status block can show reasoning heartbeats and section titles as they stream; the answer text is then extracted like any other (fences, prose, and the odd unescaped quote are tolerated, with one repair round-trip if needed). Everything else is `"plain"`: stdout is the answer. Set `"kind": "claude"` on your own preset when it wraps the Claude Code CLI, or `llm.kind` to override for a run.

`llm.jsonSchema: true` additionally passes `--json-schema` so the CLI validates the answer itself. It is off by default: on Claude Code 2.1.270 the model's first structured call is rejected about five times in six (it emits tool-call placeholders such as `$PARAMETER_NAME` as top-level keys), and although the CLI makes it retry, every rejection costs a full extra answer. Worth re-checking on newer versions.

The effective command is part of the cache key, so switching presets regenerates the tour instead of reusing another model's.

### Code host

With `codehost.provider` set to `gh` (the default), `bb` uses the `gh` CLI to find the current branch's pull request. Its base branch decides what to compare against and its title and body are included in the prompt. Nothing else is read, and no tokens are handled by `bb`. If `gh` is missing or not logged in, the lookup is silently skipped. Set the provider to `none` to turn it off.

### Cache

Tours are stored as JSON under `$XDG_CACHE_HOME/baby-bird/tours/` (default `~/.cache/baby-bird/tours/`), keyed by a hash of the exact prompt (which encodes the diff content, PR text, commit subjects, and prompt version) plus the LLM command.

```
bb cache ls       # what is cached
bb cache clear
bb cache path
```

## How a tour is built

1. Resolve what to compare (see above) and collect the unified diff, commit subjects, and PR text.
2. Assemble the prompt: rules, the output contract, a file table, and the diff with every hunk labeled `[F3.H2]`. Over-budget prompts are shortened biggest-file-first.
3. Run the LLM command. The model returns sections that *reference* hunks by id; it never reproduces code. If the reply isn't valid JSON for the schema, one repair round-trip is attempted.
4. Materialize: excerpts are sliced from the real diff, counts are computed locally, and any file the model did not mention lands in a final "Other changes" section.
5. Cache and render.

`bb --dump-prompt` prints step 2's output, which is the fastest way to iterate on the prompt (`src/core/prompt/template.ts`).

## Using it as a library

The CLI is one consumer of a small core. `import { generateTour, CliRenderer, type Tour } from '@cam5/baby-bird'` gives you the same pipeline for a TUI, a web view, or a bot; a `Tour` is plain JSON (sections, stats, excerpts) with no git or LLM dependencies.

## Development

```sh
pnpm install
pnpm dev -- --help     # run from source
pnpm test              # vitest: unit + integration (uses temp git repos and a fake LLM)
pnpm typecheck
pnpm build             # dist/ via tsup
```

## Releasing

Releases are cut by pushing a version tag. The `release` workflow checks that the tag matches `package.json`, runs typecheck, tests and build, publishes to npm with provenance (via npm trusted publishing, so no token is stored), and creates a GitHub Release with generated notes.

```sh
npm version patch        # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 2 | usage or configuration error |
| 3 | not a git repository, or nothing to tour |
| 4 | the LLM command failed to run |
| 5 | the model's output was unusable even after a repair attempt |

## License

MIT
