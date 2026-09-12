import type { Config } from '../core/config.js';
import { GhCodeHost } from './gh.js';
import { NoCodeHost } from './none.js';
import type { CodeHost } from './provider.js';

export type { CodeHost } from './provider.js';
export { GhCodeHost } from './gh.js';
export { NoCodeHost } from './none.js';

export function createCodeHost(config: Config, opts: { debug?: (msg: string) => void } = {}): CodeHost {
  switch (config.codehost.provider) {
    case 'gh':
      return new GhCodeHost({ debug: opts.debug });
    case 'none':
      return new NoCodeHost();
  }
}
