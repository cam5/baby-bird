import type { Tour } from '../core/types.js';

export interface RenderOptions {
  /** Emit ANSI colors. */
  color: boolean;
  /** Target width in columns. */
  width: number;
  /** Render only this 1-based section (header still included). */
  section?: number;
  /** Whether the tour came from the cache, for the header note. */
  fromCache?: boolean;
  /** Language-aware token colors in excerpts, layered under add/del background tints. Needs color. */
  highlight?: boolean;
  /** Which background tints to use for added/removed lines. */
  theme?: 'dark' | 'light';
}

export interface Renderer {
  render(tour: Tour, opts: RenderOptions): string;
}
