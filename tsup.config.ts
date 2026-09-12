import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  splitting: true,
});
