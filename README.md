# baby-bird 🐣

Guided **code tours** for git changes, on the command line.

`bb` looks at a change (a branch, a range, a pull request by number, or your working tree), asks an LLM to organize it into an ordered set of sections, and renders the result in your terminal: each section has a title, a description of *why* and *what*, the files it touches with `+/-` counts, and excerpts pulled from the real diff. Tours are cached by content, so the model runs once per change.

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

Upgrading is the same command. Tab completion for zsh and bash is optional and one line to set up: see [Shell completion](#shell-completion).

Requirements: Node 22+, git, and some CLI that can answer a prompt (by default the [Claude Code](https://claude.com/claude-code) CLI, `claude`).

## Usage

```
bb                     tour the current branch
bb --base main         what this branch adds on top of main
bb --base main --head feature
                       what feature adds on top of main, without checking it out
bb main...feature      the same comparison in git's range syntax
bb main..feature       feature against main exactly as main is now (see below)
bb HEAD~3              tour the last three commits
bb release/2.0         what HEAD adds on top of release/2.0; same as --base release/2.0
bb 12                  pull request #12: its base against its head, as they are on the remote
bb --pr 12             the same, spelled so it can never be taken for a ref
bb 12 --base main      pull request #12 against main instead of its own base
bb --working           uncommitted changes (tracked + untracked)
bb --staged            what you are about to commit
bb --section 2         render only the second section
bb --json | jq         machine-readable tour
bb --dump-prompt       print the prompt instead of calling the model
bb --refresh           regenerate even if a cached tour exists
bb --preset claude-sonnet
bb --no-progress       no live status block
bb completion zsh      print a tab-completion script (see Shell completion)
bb ask "why is the cache keyed by command?"      chat about the current branch's tour
bb ask HEAD~1 "what is going on in progress.ts?" chat about a specific range
```

### What does bare `bb` tour?

1. If the working tree has uncommitted changes: those.
2. Else, if the code host knows a pull request for this branch (`gh pr view`): the branch against the PR's base, and the PR title/body are fed to the model.
3. Else, the branch against its nearest ancestor branch (the local branch whose merge-base is closest to `HEAD`).
4. Else, the branch against the default branch (`origin/HEAD`, or `main`/`master`/`trunk`).

The header of every tour says which one was used.

### What exactly gets compared

Every tour is a diff from an old side to a new side. There are three comparisons, and each can be written with flags or with git's range syntax:

| you want | flags | range syntax | old side | new side |
|---|---|---|---|---|
| what did this branch add on top of `A`? | `bb --base A` | `bb A` or `bb A...` | the commit where `HEAD` forked from `A` | `HEAD` |
| what would a pull request of `B` into `A` show? | `bb --base A --head B` | `bb A...B` | the commit where `B` forked from `A` | `B` |
| how does `B` differ from `A` as `A` is right now? | `bb --base A --head B --direct` | `bb A..B` | `A` | `B` |

The first two are the same comparison; the first just has `HEAD` as the new side. The difference between three dots and two only shows when `A` has moved on since `B` forked from it:

```
          o---o---o   feature
         /
o---o---F---o---o     main
```

- `bb --base main --head feature` (`bb main...feature`) compares `F` with `feature`: the three commits made on `feature`, nothing else. This is what a pull request shows, and almost always what you want to review.
- `bb --base main --head feature --direct` (`bb main..feature`) compares the tip of `main` with `feature`. You get the three `feature` commits, and also the two newer `main` commits backwards, as if `feature` had removed them. Useful for "what will the tree look like if I switch from `main` to `feature`?".

If `main` has not moved since `feature` forked, the two are identical.

Other things worth knowing:

- An empty side means `HEAD`: `bb main..` is `bb main..HEAD`.
- `bb --head feature` with no `--base` compares against the default branch (`origin/HEAD`, or `main`/`master`/`trunk`, or `git.defaultBranch`).
- `--base`/`--head` take anything git resolves to a commit: branches, `origin/main`, tags, `HEAD~3`, shas. They cannot be mixed with a range argument, `--working` or `--staged`.
- With a pull request, `--base` replaces the PR's own base and `--head` is refused, since the pull request is the head: `bb 12 --base main` tours everything between `main` and PR 12, which for a stack is every PR up to and including it. The name is looked up as a branch on the remote first (read fresh, like the PR), then as a local ref.
- The dots follow `git diff`. `git log A..B` means something different again (the commits in `B` that are not in `A`), which is where much of the confusion comes from.
- The first line of every tour says what was compared: `feature vs main (merge-base 4e2a1c9)` when the old side is the fork point, plain `feature vs main` when it is `main` itself.

### Touring a pull request by number

```
bb 12                                          pull request #12
bb '#12'                                       the same (quote it: an unquoted # starts a comment in most shells)
bb https://github.com/you/repo/pull/12         the same; anything after the number (/files, #diff-...) is ignored
bb --pr 12                                     the same, never mistaken for a ref
bb ask 12 "what should I look at first?"       chat about it
```

This diffs the PR's **base branch against its head, both as they are on the remote right now**, starting from where the two diverged, which is what the PR page on GitHub shows. You need neither branch checked out or up to date, and the base comes from the pull request itself, so a stacked PR (PR 13 opened against PR 12's branch) shows only its own changes. Nothing is checked out and no branch is created; the commits are fetched into the object store, and fetching the base branch can move its remote-tracking ref (`origin/<base>`) forward, as any `git fetch` of that branch would.

How it finds the two ends:

- **Head**: plain git. `git ls-remote` and `git fetch` read `refs/pull/12/head` from the repository's own remote, with whatever credentials git already uses there. The remote is `origin` (or the only remote, or else `upstream`); a PR URL picks the remote that points at that repository.
- **Base**: the name of the base branch is only known to GitHub's API, so this is the one thing `gh` is asked for (`gh pr view 12`), along with the title and description for the prompt. The branch itself is then read from the remote with git. For a merged or closed PR the base is the commit GitHub recorded for it, since the branch as it is today may already contain the PR.
- **When `gh` cannot answer** (not installed, not logged in, or logged in as an account that cannot see the repository), `bb` reads the base off GitHub's test merge instead: `refs/pull/12/merge` is a merge commit whose first parent is the base branch, and it is used only when its second parent is the PR's current head. The tour then says `base read from GitHub's test merge`, a warning explains why, and the prompt goes without the PR's title and description. If there is no usable test merge either (the PR is closed or has conflicts), `bb` stops and tells you which account or token to fix. You can also name the base yourself, which needs no API at all: `bb 12 --base <branch>`.

`gh` runs as whichever account it is using. To use another one for a single run, set `GH_TOKEN`, which `gh` honors over the logged-in account: `GH_TOKEN=$(gh auth token --user other-account) bb 12`.

**A bare number that is also a ref name.** `bb 12` is a pull request unless a local branch or tag is named exactly `12`. In that case the ref wins, because that is what `bb 12` meant before and the name is one you made, and a warning points you at `bb --pr 12` and `bb '#12'`, which always mean the pull request. An abbreviated commit sha made only of digits does not count as a name: `bb 1234567` is pull request 1234567. To compare against that commit, write `bb --base 1234567`.

### Shell completion

`bb completion zsh` (or `bash`) prints a completion script. It installs nothing by itself and never touches your shell's startup files; pick one of these:

```sh
# zsh, with Homebrew set up the usual way (brew shellenv puts this directory on fpath)
bb completion zsh > "$(brew --prefix)/share/zsh/site-functions/_bb"

# zsh, anywhere: any directory that ~/.zshrc adds to fpath before compinit runs
bb completion zsh > ~/.zfunc/_bb          # with  fpath=(~/.zfunc $fpath)  in ~/.zshrc

# zsh or bash, one line in ~/.zshrc (after compinit) or ~/.bashrc; starts bb with every new shell
source <(bb completion zsh)
source <(bb completion bash)              # eval "$(bb completion bash)" on macOS's bash 3.2

# bash with bash-completion 2
bb completion bash > ~/.local/share/bash-completion/completions/bb
```

Open a new shell afterwards (for zsh, delete `~/.zcompdump*` if nothing happens), and write the file again after upgrading `bb`: the script lists the flags of the version that printed it.

What Tab completes:

- subcommands and flags, with descriptions in zsh;
- branches, remote branches, tags and any other ref, wherever a range goes and after `--base`/`--head`, including the second half of `main..` and `main...`;
- open pull request numbers with their titles (zsh) wherever a range goes and after `--pr`, also after a `#`;
- built-in preset names after `--preset`, directories after `-C`, and all of the above for the repository `-C <dir>` points at.

Completion is a shell function that runs `git for-each-ref` and reads a file; it never starts `bb` or node. Pull request numbers come from `gh pr list`, and Tab does not wait for it: the list is cached per repository under `$XDG_CACHE_HOME/baby-bird/completion/`, a cache older than a minute is still used and is refreshed in the background, and that background `gh` is stopped after ten seconds. The one wait is the first Tab ever pressed in a repository, which gives `gh` up to a second so the numbers can appear right away. If `gh` is missing, logged out, cannot see the repository or is slow, you get refs and no numbers, with no message; a failure is cached too, so `gh` is retried once a minute rather than on every Tab. `BB_COMPLETION_PRS=0` turns the `gh` part off.

Limits: user-defined presets are not completed, bash shows pull request numbers without titles, and bash leaves out ref names containing characters the shell would act on (it inserts candidates unquoted). There is no fish script.

### Asking questions about a tour

`bb ask` opens an interactive chat with the same LLM CLI, primed with the tour:

```
bb ask                                       the tour bare `bb` would show
bb ask "where is the retry handled?"         with an opening question
bb ask HEAD~1 "what is going on in progress.ts?"
bb ask main..feature --preset claude-opus
bb ask --base main --head feature "is the migration reversible?"
bb ask --staged "is this safe to commit?"
bb ask --dump-context                        print what the chat would be given, and exit
```

It takes the same range arguments and flags as `bb`, then an opening message. The first word is treated as a range only when git can resolve it (`HEAD~3`, `main..feature`) or it is a pull request (`12`, `#12`, a PR URL); anything else is part of the message, so quoting is optional for plain questions. A question that starts with a bare number (`bb ask 3 things confuse me`) needs quotes around the whole question. With `--base`, `--head` or `--pr`, every word is the message.

The tour is generated first, or taken from the cache: run `bb HEAD~1` in one window, and `bb ask HEAD~1 ...` in another reuses that tour and opens the chat straight away. The chat gets, as a system prompt: a short framing, the whole tour (sections, descriptions, excerpts with line numbers, the base and head SHAs), and then the same labeled diff the tour was built from, shortened to `llm.maxPromptBytes` like the prompt. With the Claude presets the chat is a normal interactive Claude Code session in the repository, so it can also open files and run git. `bb ask` exits with the chat's exit code.

The command that opens the chat is the preset's `chatCommand` (see [LLM presets](#llm-presets)); presets without one cannot be asked.

## Configuration

Config is JSON, merged in this order (later wins; objects merge, arrays replace):

1. built-in defaults
2. `$XDG_CONFIG_HOME/baby-bird/config.json` (default `~/.config/baby-bird/config.json`)
3. `<repo>/.baby-bird/config.json` (create one with `bb init`)
4. environment: `BB_PRESET`, `BB_LLM_COMMAND`, `BB_CODEHOST`, `BB_CACHE_DIR`, `BB_NO_CACHE`, `NO_COLOR`
5. flags: `--preset`, `--color/--no-color`, `--no-cache`, `--no-pager` (before or after a subcommand name)

`bb config` shows every layer, what it contributed, the resolved LLM command, and all presets.

All keys, with defaults:

```jsonc
{
  "llm": {
    "preset": "claude",        // which preset to run (built-in or from "presets")
    "presets": {},             // your own presets; same names shadow built-ins
    "args": [],                // extra argv appended to the preset's command
    "command": null,           // a whole custom invocation; when set, "preset" is ignored
    "chatCommand": null,       // what `bb ask` runs; replaces the preset's (see below)
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
  "render": {
    "color": "auto", "pager": "auto", "maxExcerptLines": 60, "width": null,
    "highlight": "auto"        // syntax colors in excerpts; "always" | "never"
  },
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

Each preset also has a `chatCommand`, which is what `bb ask` runs. For the Claude presets it is `claude [model and effort flags] --append-system-prompt-file {context-file} -- {message}`: a regular interactive session (your settings and CLAUDE.md apply) with the tour appended to the system prompt and the question as the first message. The `llm` preset uses `llm chat -s {context}`; `llm chat` cannot take an opening message, so `bb` says so and you type the question into the chat. In a chat command, `{context-file}` is replaced by the path of a temporary file holding the context, `{context}` by the text itself (mind your OS's argument size limits with big diffs), and `{message}` by the opening message; an argv entry that is only `{message}` is dropped when there is none.

Add flags to a preset, define your own, or replace the command entirely:

```jsonc
{
  "llm": {
    "preset": "claude-sonnet",
    "args": ["--fallback-model", "haiku"],
    "presets": {
      "local": { "command": ["ollama", "run", "qwen2.5-coder:14b"] },
      "gemini": {
        "command": ["gemini", "-p", "{prompt}"],
        "promptVia": "arg",
        "chatCommand": ["gemini", "-i", "{message}"]
      }
    }
  }
}
```

`llm.args` only applies to the tour command. A custom `llm.command` has no chat command of its own; set `llm.chatCommand` next to it if you want `bb ask` to work.

```sh
bb --preset local
BB_LLM_COMMAND='llm -m gpt-4.1' bb
```

Presets have a `kind`. The built-in Claude presets are `"claude"`: `bb` appends `--output-format stream-json --verbose --include-partial-messages` so the status block can show reasoning heartbeats and section titles as they stream; the answer text is then extracted like any other (fences, prose, and the odd unescaped quote are tolerated, with one repair round-trip if needed). Everything else is `"plain"`: stdout is the answer. Set `"kind": "claude"` on your own preset when it wraps the Claude Code CLI, or `llm.kind` to override for a run.

`llm.jsonSchema: true` additionally passes `--json-schema` so the CLI validates the answer itself. It is off by default: on Claude Code 2.1.270 the model's first structured call is rejected about five times in six (it emits tool-call placeholders such as `$PARAMETER_NAME` as top-level keys), and although the CLI makes it retry, every rejection costs a full extra answer. Worth re-checking on newer versions.

The effective command is part of the cache key, so switching presets regenerates the tour instead of reusing another model's.

### Excerpt highlighting

Excerpts get language-aware token colors (keywords, strings, comments) chosen by file extension, and added/removed lines are always marked by a green/red `+`/`-` sign — no row background and no bold (some terminal themes render bold color via a washed-out "bright" palette slot), so it reads well on any terminal theme. The token palette never uses green or red, so the sign stays unambiguous. Turn syntax coloring off with `--no-highlight` or `render.highlight: "never"`; files with no known language keep the same green/red sign with plain text.

### Code host

With `codehost.provider` set to `gh` (the default), `bb` uses the `gh` CLI to find the current branch's pull request, or the one you named by number. Its base branch decides what to compare against and its title and body are included in the prompt. Nothing else is read, and no tokens are handled by `bb`. For bare `bb`, the lookup is silently skipped if `gh` is missing or not logged in. For `bb 12`, see [Touring a pull request by number](#touring-a-pull-request-by-number) for what happens then. Set the provider to `none` to turn it off; `bb 12` then relies on the test merge alone.

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

The CLI is one consumer of a small core. `import { generateTour, CliRenderer, type Tour } from '@cam5/baby-bird'` gives you the same pipeline for a TUI, a web view, or a bot; a `Tour` is plain JSON (sections, stats, excerpts) with no git or LLM dependencies. `buildChatContext` produces the text `bb ask` hands to a chat, and `launchChat` runs a chat command with it.

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
| 3 | not a git repository, nothing to tour, or a pull request that could not be read |
| 4 | the LLM command failed to run |
| 5 | the model's output was unusable even after a repair attempt |

`bb ask` exits with the chat command's own exit code once the chat ends.

## License

MIT
