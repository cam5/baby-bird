import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export class TempRepo {
  private constructor(readonly dir: string) {}

  static async create(): Promise<TempRepo> {
    const dir = await mkdtemp(join(tmpdir(), 'bb-repo-'));
    const repo = new TempRepo(dir);
    repo.git('init', '-q', '-b', 'main');
    return repo;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, env: GIT_ENV, encoding: 'utf8' });
  }

  async write(rel: string, content: string): Promise<void> {
    const abs = join(this.dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  async commit(message: string, files: Record<string, string>): Promise<string> {
    for (const [rel, content] of Object.entries(files)) await this.write(rel, content);
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }
}
