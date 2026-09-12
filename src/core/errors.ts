export class BbError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, opts: { exitCode?: number; hint?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}

export class UsageError extends BbError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 2, hint });
  }
}

export class ConfigError extends BbError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 2, hint });
  }
}

export class NotARepoError extends BbError {
  constructor(cwd: string) {
    super(`Not a git repository: ${cwd}`, { exitCode: 3, hint: 'Run bb inside a git repository, or pass --cwd <dir>.' });
  }
}

export class GitError extends BbError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message, { exitCode: 3, ...opts });
  }
}

export class NoChangesError extends BbError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 3, hint });
  }
}

export class LlmFailedError extends BbError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message, { exitCode: 4, ...opts });
  }
}

export class BadLlmOutputError extends BbError {
  readonly raw: string;

  constructor(message: string, raw: string, hint?: string) {
    super(message, { exitCode: 5, hint });
    this.raw = raw;
  }
}
