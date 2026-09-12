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
}

export interface Renderer {
  render(tour: Tour, opts: RenderOptions): string;
}
