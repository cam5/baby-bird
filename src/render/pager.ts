import { spawn } from 'node:child_process';

export interface PagerOptions {
  mode: 'auto' | 'always' | 'never';
  isTTY: boolean;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

/** Write output to stdout, through $PAGER (default `less -RFX`) when it would not fit the screen. */
export async function writeMaybePaged(output: string, opts: PagerOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const lineCount = output.split('\n').length;
  const shouldPage = opts.mode === 'always' || (opts.mode === 'auto' && opts.isTTY && lineCount > opts.rows - 1);
  if (!shouldPage) {
    process.stdout.write(output);
    return;
  }
  const pagerCmd = (env.PAGER && env.PAGER.trim()) || 'less';
  const cmd = pagerCmd === 'less' && !env.LESS ? 'less -RFX' : pagerCmd;
  await new Promise<void>((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], env });
    let fellBack = false;
    child.on('error', () => {
      fellBack = true;
      process.stdout.write(output);
      resolve();
    });
    child.on('close', () => {
      if (!fellBack) resolve();
    });
    child.stdin.on('error', () => {}); // pager quit early
    child.stdin.end(output);
  });
}
