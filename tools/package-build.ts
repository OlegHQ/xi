import { createXiSolidBuildPlugin } from './solid-build-plugin';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const result = await Bun.build({
  entrypoints: [resolve(root, 'apps/xi/src/main.ts')],
  target: 'bun', format: 'esm', bytecode: false, minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"' },
  compile: { outfile: resolve(process.argv[2] ?? resolve(root, 'dist/xi')) },
  plugins: [createXiSolidBuildPlugin()],
});
if (!result.success) throw new AggregateError(result.logs, 'Xi package build failed');
