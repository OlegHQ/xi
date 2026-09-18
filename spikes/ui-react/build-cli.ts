/** Reproducible compiled comparisons without editing the working tree or runtime flags. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../..');
const destination = resolve(repository, process.env['XI_UI_PROOF_OUTDIR'] ?? '.artifacts/ui-proof');
await mkdir(destination, { recursive: true });
const baselinePath = process.argv[2];
const modes = baselinePath === undefined ? ['core', 'react', 'react-unminified'] : ['private', 'core', 'react', 'react-unminified'];
const sources: Record<string, string> = {};
const binaries: Record<string, string> = {};
for (const mode of modes) {
  const result = await Bun.build({
    entrypoints: [resolve(repository, 'apps/xi/src/main.ts')],
    target: 'bun', format: 'esm', bytecode: true, minify: mode !== 'react-unminified',
    // Compile out React/reconciler development branches, independent of launch env.
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"' },
    compile: { outfile: resolve(destination, `xi-${mode}`) },
    plugins: [{
      name: 'isolated-ui-comparison',
      setup(build) {
        // One patched Core copy for React, native custom renderables and the CLI.
        build.onResolve({ filter: /^@opentui\/core(?:\/|$)/ }, args => ({ path: Bun.resolveSync(args.path, repository) }));
        if (mode.startsWith('react')) build.onResolve({ filter: /packages\/ui\/src\/entrypoints\/launch$/ }, () => ({ path: resolve(import.meta.dir, 'launch.tsx') }));
        build.onLoad({ filter: /\.(?:ts|tsx)$/ }, async args => {
          const path = args.path;
          const contents = await readFile(mode === 'private' && args.path === resolve(repository, 'packages/ui/src/terminal.ts')
            ? resolve(repository, baselinePath!) : path, 'utf8');
          sources[`${mode}:${path}`] = createHash('sha256').update(contents).digest('hex');
          return { contents, loader: path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: resolve(path, '..') };
        });
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, `build ${mode} failed`);
  const binary = resolve(destination, `xi-${mode}`);
  binaries[mode] = createHash('sha256').update(await readFile(binary)).digest('hex');
  console.log(`${mode}: ${binary}`);
}
await writeFile(resolve(destination, 'build-manifest.json'), JSON.stringify({ bun: Bun.version, nodeEnv: 'production', baselinePath, sources, binaries }, null, 2) + '\n');
