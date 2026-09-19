import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, 'dist/dev/main.js');
const buildOnly = process.argv[2] === '--build-only';

if (buildOnly || await sourcesAreNewer(output)) {
  const { createSolidTransformPlugin } = await import('@opentui/solid/bun-plugin');
  const result = await Bun.build({
    entrypoints: [resolve(root, 'apps/xi/src/main.ts')],
    target: 'bun', format: 'esm', splitting: true, minify: true,
    outdir: resolve(root, 'dist/dev'),
    external: ['@opentui/core', '@opentui/core-*', 'web-tree-sitter'],
    plugins: [createSolidTransformPlugin()],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Xi dev build failed');
}

if (!buildOnly) {
  await import(output);
}

async function sourcesAreNewer(target: string): Promise<boolean> {
  if (!await stat(target).then(() => true).catch(() => false)) return true;
  const changed = Bun.spawnSync([
    'find', 'apps/xi/src', 'packages', 'package.json', 'bun.lock', 'tsconfig.json', 'tools/xi-dev.ts',
    '-type', 'f', '-newer', target, '-print', '-quit',
  ], { cwd: root, stdout: 'pipe', stderr: 'inherit' });
  if (changed.exitCode !== 0) throw new Error(`Xi dev source check failed (${changed.exitCode})`);
  return changed.stdout.length > 0;
}
