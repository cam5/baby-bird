import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TempRepo } from '../helpers/repo.js';

/**
 * These run the generated scripts in real shells. bash is driven by calling the completion function
 * with the variables readline sets; zsh by an interactive shell on a pseudo-terminal with the real
 * completion system (see test/helpers/zsh-complete.zsh). `gh` is always a stub on PATH.
 */

const ROOT = join(__dirname, '..', '..');
const HELPERS = join(__dirname, '..', 'helpers');

function which(tool: string): string | null {
  const res = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

const BASH = which('bash');
const ZSH = which('zsh');
const ZSH_PTY = ZSH !== null && spawnSync(ZSH, ['-f', '-c', 'zmodload zsh/zpty'], { encoding: 'utf8' }).status === 0;

const scripts: Record<'zsh' | 'bash', string> = { zsh: '', bash: '' };

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-completion-'));
  for (const shell of ['zsh', 'bash'] as const) {
    const text = execFileSync(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'cli', 'main.ts'), 'completion', shell], { encoding: 'utf8' });
    scripts[shell] = join(dir, shell === 'zsh' ? '_bb' : 'bb.bash');
    writeFileSync(scripts[shell], text);
  }
});

const PRS = ['12\tAdd widgets (feat/widgets)', '9\tfix: don\'t "break" the cache (fix/cache)', '7\tOlder one (old)'].join('\n');

interface World {
  repo: TempRepo;
  /** Environment for the shell: stub gh first on PATH, a private cache and home. */
  env: NodeJS.ProcessEnv;
  cacheDir: string;
  ghLog: string;
  /** Replace the gh stub with a shell script body. */
  gh(body: string): void;
  ghCalls(): number;
}

async function world(): Promise<World> {
  const repo = await TempRepo.create();
  await repo.commit('init', { 'a.txt': 'one\n' });
  repo.git('branch', 'feature/login');
  repo.git('branch', 'fix-typo');
  repo.git('tag', 'v1.0');
  repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  repo.git('update-ref', 'refs/remotes/origin/feature/login', 'HEAD');
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  const home = mkdtempSync(join(tmpdir(), 'bb-home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const ghLog = join(home, 'gh.log');
  const cacheRoot = join(home, 'cache');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CACHE_HOME: cacheRoot, GH_LOG: ghLog, TERM: 'xterm' };
  delete env.GH_TOKEN;
  delete env.BB_COMPLETION_PRS;
  const w: World = {
    repo,
    env,
    cacheDir: join(cacheRoot, 'baby-bird', 'completion'),
    ghLog,
    gh(body) {
      const file = join(bin, 'gh');
      writeFileSync(file, `#!/bin/sh\necho called >> "$GH_LOG"\n${body}\n`);
      chmodSync(file, 0o755);
    },
    ghCalls: () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length : 0),
  };
  w.gh(`cat <<'EOF_PRS'\n${PRS}\nEOF_PRS`);
  return w;
}

function cacheFile(w: World): string | null {
  if (!existsSync(w.cacheDir)) return null;
  const name = readdirSync(w.cacheDir).find((f) => /^prs-\d+$/.test(f));
  return name ? join(w.cacheDir, name) : null;
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the background refresh');
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Completed {
  candidates: string[];
  stderr: string;
  ms: number;
}

function bash(w: World, words: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Completed {
  const started = Date.now();
  const res = spawnSync(BASH!, [join(HELPERS, 'bash-complete.sh'), scripts.bash, ...words], { cwd: opts.cwd ?? w.repo.dir, env: opts.env ?? w.env, encoding: 'utf8', timeout: 15_000 });
  expect(res.status, res.stderr).toBe(0);
  return { candidates: res.stdout.split('\n').filter(Boolean), stderr: res.stderr, ms: Date.now() - started };
}

function zsh(w: World, line: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Completed {
  const started = Date.now();
  const res = spawnSync(ZSH!, ['-f', join(HELPERS, 'zsh-complete.zsh'), scripts.zsh, line], { cwd: opts.cwd ?? w.repo.dir, env: opts.env ?? w.env, encoding: 'utf8', timeout: 20_000 });
  expect(res.status, res.stderr).toBe(0);
  const candidates = res.stdout.split('\n').filter(Boolean);
  return { candidates, stderr: res.stderr, ms: Date.now() - started };
}

const REFS = ['feature/login', 'fix-typo', 'main', 'origin/feature/login', 'origin/main', 'v1.0', 'HEAD'];
const SUBCOMMANDS = ['ask', 'cache', 'config', 'init', 'completion'];

describe.skipIf(!BASH)('bash completion', () => {
  it('offers subcommands, refs from git and open pull request numbers from gh', async () => {
    const w = await world();
    const first = bash(w, ['bb', '']);
    expect(first.candidates).toEqual([...SUBCOMMANDS, ...REFS, '12', '9', '7']);
    expect(first.stderr).toBe('');
    // The symbolic origin/HEAD is not offered.
    expect(first.candidates).not.toContain('origin');
    expect(readFileSync(cacheFile(w)!, 'utf8')).toMatch(/^\d+\n12\tAdd widgets \(feat\/widgets\)\n/);

    expect(bash(w, ['bb', 'f']).candidates).toEqual(['feature/login', 'fix-typo']);
    expect(bash(w, ['bb', '1']).candidates).toEqual(['12']);
    expect(bash(w, ['bb', '#']).candidates).toEqual(['#12', '#9', '#7']);
    expect(bash(w, ['bb', 'ask', 'ori']).candidates).toEqual(['origin/feature/login', 'origin/main']);
    expect(bash(w, ['bb', 'ask', '']).candidates).toEqual([...REFS, '12', '9', '7']);
    // After the range comes the question; nothing to offer.
    expect(bash(w, ['bb', 'ask', 'HEAD', '']).candidates).toEqual([]);
    expect(bash(w, ['bb', 'main', '']).candidates).toEqual([]);
    // All of that from one gh call: the cache was fresh.
    expect(w.ghCalls()).toBe(1);
  });

  it('completes the second half of A..B and A...B, and the values of flags', async () => {
    const w = await world();
    expect(bash(w, ['bb', 'main..f']).candidates).toEqual(['main..feature/login', 'main..fix-typo']);
    expect(bash(w, ['bb', 'v1.0...origin/']).candidates).toEqual(['v1.0...origin/feature/login', 'v1.0...origin/main']);
    expect(bash(w, ['bb', '--base', 'ma']).candidates).toEqual(['main']);
    expect(bash(w, ['bb', '--base', 'main', '--head', 'v']).candidates).toEqual(['v1.0']);
    expect(bash(w, ['bb', '--pr', '']).candidates).toEqual(['12', '9', '7']);
    expect(bash(w, ['bb', '--pr', '#1']).candidates).toEqual(['12']);
    expect(bash(w, ['bb', '--preset', 'claude-s']).candidates).toEqual(['claude-sonnet']);
    expect(bash(w, ['bb', '--ba']).candidates).toEqual(['--base']);
    expect(bash(w, ['bb', '--d']).candidates).toEqual(['--debug', '--direct', '--dump-prompt']);
    expect(bash(w, ['bb', 'ask', '--dump']).candidates).toEqual(['--dump-context']);
    expect(bash(w, ['bb', 'cache', '']).candidates).toEqual(['ls', 'clear', 'path']);
    expect(bash(w, ['bb', 'completion', '']).candidates).toEqual(['zsh', 'bash']);
    // A value-taking flag swallows the next word, so `main` here is not the range.
    expect(bash(w, ['bb', '--preset', 'main', 'fix']).candidates).toEqual(['fix-typo']);
  });

  it('follows -C to another repository, and offers only subcommands outside one', async () => {
    const w = await world();
    const elsewhere = mkdtempSync(join(tmpdir(), 'bb-nowhere-'));
    expect(bash(w, ['bb', '-C', w.repo.dir, 'fix'], { cwd: elsewhere }).candidates).toEqual(['fix-typo']);
    expect(bash(w, ['bb', '-C', w.repo.dir, '1'], { cwd: elsewhere }).candidates).toEqual(['12']);
    const outside = bash(w, ['bb', ''], { cwd: elsewhere });
    expect(outside.candidates).toEqual(SUBCOMMANDS);
    expect(outside.stderr).toBe('');
    expect(w.ghCalls()).toBe(1);
  });

  it('does not wait for a slow gh, and has its answer next time', async () => {
    const w = await world();
    w.gh(`sleep 3\ncat <<'EOF_PRS'\n${PRS}\nEOF_PRS`);
    const first = bash(w, ['bb', '']);
    expect(first.candidates).toEqual([...SUBCOMMANDS, ...REFS]);
    expect(first.stderr).toBe('');
    // One second of grace on the very first Tab in a repository, then it gives up.
    expect(first.ms).toBeLessThan(2500);
    // While that gh is still running, another Tab neither waits nor starts a second one.
    const second = bash(w, ['bb', '']);
    expect(second.ms).toBeLessThan(2000);
    expect(w.ghCalls()).toBe(1);

    await until(() => cacheFile(w) !== null);
    expect(bash(w, ['bb', '1']).candidates).toEqual(['12']);
    expect(w.ghCalls()).toBe(1);
  });

  it('serves a stale cache at once and refreshes it in the background', async () => {
    const w = await world();
    bash(w, ['bb', '']);
    const file = cacheFile(w)!;
    writeFileSync(file, '1000\n3\tAn old pull request (old)\n');
    w.gh(`sleep 3\nprintf '21\\tA new pull request (new)\\n'`);

    const stale = bash(w, ['bb', '--pr', '']);
    expect(stale.candidates).toEqual(['3']);
    // Well under the three seconds gh takes: nothing waited for it.
    expect(stale.ms).toBeLessThan(2000);
    await until(() => readFileSync(file, 'utf8').includes('A new pull request'));
    expect(bash(w, ['bb', '--pr', '']).candidates).toEqual(['21']);
    expect(w.ghCalls()).toBe(2);
    // Temporary files are cleaned up.
    expect(readdirSync(w.cacheDir)).toEqual([file.split('/').pop()]);
  });

  it('stays silent and keeps completing refs when gh fails, is killed, is turned off, or is missing', async () => {
    const w = await world();
    w.gh('echo "HTTP 401: Bad credentials" >&2\necho "partial junk"\nexit 1');
    const failed = bash(w, ['bb', '']);
    expect(failed.candidates).toEqual([...SUBCOMMANDS, ...REFS]);
    expect(failed.stderr).toBe('');
    // The failure is remembered (a timestamp, no pull requests), so the next Tab does not ask again.
    expect(readFileSync(cacheFile(w)!, 'utf8')).toMatch(/^\d+\n$/);
    expect(bash(w, ['bb', '']).candidates).toEqual([...SUBCOMMANDS, ...REFS]);
    expect(w.ghCalls()).toBe(1);

    const off = await world();
    expect(bash(off, ['bb', ''], { env: { ...off.env, BB_COMPLETION_PRS: '0' } }).candidates).toEqual([...SUBCOMMANDS, ...REFS]);
    expect(off.ghCalls()).toBe(0);

    // No gh at all: a PATH with nothing but git on it.
    const bare = await world();
    const only = mkdtempSync(join(tmpdir(), 'bb-onlygit-'));
    symlinkSync(join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git'), join(only, 'git'));
    const missing = bash(bare, ['bb', ''], { env: { ...bare.env, PATH: only } });
    expect(missing.candidates).toEqual([...SUBCOMMANDS, ...REFS]);
    expect(missing.stderr).toBe('');
    expect(bare.ghCalls()).toBe(0);
    expect(cacheFile(bare)).toBeNull();
  });

  it('never evaluates a ref name, and leaves out names bash would act on', async () => {
    const w = await world();
    const marker = join(w.repo.dir, 'pwned');
    w.repo.git('branch', `x$(touch\${IFS}${marker})`);
    w.repo.git('branch', 'x;y');
    w.repo.git('branch', 'x-plain');
    expect(bash(w, ['bb', 'x']).candidates).toEqual(['x-plain']);
    expect(bash(w, ['bb', 'main..x']).candidates).toEqual(['main..x-plain']);
    expect(existsSync(marker)).toBe(false);
  });
});

describe.skipIf(!ZSH_PTY)('zsh completion', () => {
  it('offers subcommands and options with descriptions, refs, and pull requests with their titles', async () => {
    const w = await world();
    const root = zsh(w, 'bb ');
    expect(root.candidates.slice(0, 2)).toEqual([
      'ask -- chat with the LLM about a tour (the tour is generated or taken from the cache first)',
      'cache -- manage cached tours',
    ]);
    for (const ref of REFS) expect(root.candidates).toContain(ref);
    expect(root.candidates).not.toContain('origin');
    // gh's order is kept, and a colon or quotes in a title do no harm.
    expect(root.candidates.slice(-3)).toEqual(['12 -- Add widgets (feat/widgets)', '9 -- fix: don\'t "break" the cache (fix/cache)', '7 -- Older one (old)']);

    expect(zsh(w, 'bb f').candidates).toEqual(['feature/login', 'fix-typo']);
    expect(zsh(w, 'bb 1').candidates).toEqual(['12 -- Add widgets (feat/widgets)']);
    expect(zsh(w, 'bb #').candidates.map((c) => c.split(' ')[0])).toEqual(['#12', '#9', '#7']);
    expect(zsh(w, 'bb --pr ').candidates.map((c) => c.split(' ')[0])).toEqual(['12', '9', '7']);
    expect(zsh(w, 'bb --ba').candidates).toEqual(['--base -- what to compare against: tour what --head (default HEAD) added since it forked from <ref>']);
    expect(zsh(w, 'bb cache ').candidates).toEqual(['ls -- list cached tours', 'clear -- delete all cached tours', 'path -- print the cache directory']);
    expect(zsh(w, 'bb completion ').candidates).toEqual(['zsh', 'bash']);
    expect(w.ghCalls()).toBe(1);
  });

  it('completes the second half of a range, flag values, and `bb ask`', async () => {
    const w = await world();
    expect(zsh(w, 'bb main..f').candidates).toEqual(['main..feature/login', 'main..fix-typo']);
    expect(zsh(w, 'bb v1.0...origin/').candidates).toEqual(['v1.0...origin/feature/login', 'v1.0...origin/main']);
    expect(zsh(w, 'bb --base main --head v').candidates).toEqual(['v1.0']);
    expect(zsh(w, 'bb --preset claude-s').candidates).toEqual(['claude-sonnet']);
    expect(zsh(w, 'bb ask ori').candidates).toEqual(['origin/feature/login', 'origin/main']);
    expect(zsh(w, 'bb ask HEAD ').candidates).toEqual([]);
    const elsewhere = mkdtempSync(join(tmpdir(), 'bb-nowhere-'));
    expect(zsh(w, `bb -C ${w.repo.dir} fix`, { cwd: elsewhere }).candidates).toEqual(['fix-typo']);
    expect(zsh(w, 'bb ', { cwd: elsewhere }).candidates.map((c) => c.split(' ')[0])).toEqual(SUBCOMMANDS);
  });

  it('works when autoloaded from fpath as _bb, and for the baby-bird command name', async () => {
    const w = await world();
    const env = { ...w.env, BB_COMPLETION_FPATH: join(scripts.zsh, '..') };
    expect(zsh(w, 'bb fix', { env }).candidates).toEqual(['fix-typo']);
    expect(zsh(w, 'baby-bird --pr 1', { env }).candidates).toEqual(['12 -- Add widgets (feat/widgets)']);
  });

  it('does not wait for a slow gh, stays quiet when it fails, and never evaluates a ref name', async () => {
    const w = await world();
    w.gh(`sleep 3\ncat <<'EOF_PRS'\n${PRS}\nEOF_PRS`);
    const slow = zsh(w, 'bb fix');
    expect(slow.candidates).toEqual(['fix-typo']);
    const numbers = zsh(w, 'bb 1');
    expect(numbers.candidates).toEqual([]);
    expect(numbers.ms).toBeLessThan(3000);
    await until(() => cacheFile(w) !== null);
    expect(zsh(w, 'bb 1').candidates).toEqual(['12 -- Add widgets (feat/widgets)']);

    const broken = await world();
    broken.gh('echo "HTTP 401: Bad credentials" >&2\nexit 1');
    const marker = join(broken.repo.dir, 'pwned');
    broken.repo.git('branch', `x$(touch\${IFS}${marker})`);
    broken.repo.git('branch', 'x-plain');
    const out = zsh(broken, 'bb x');
    // zsh quotes what it inserts, so the odd name can be offered; it must not have been run.
    expect(out.candidates).toContain('x-plain');
    expect(out.candidates).toHaveLength(2);
    expect(existsSync(marker)).toBe(false);
    expect(out.stderr).toBe('');
  });
});
