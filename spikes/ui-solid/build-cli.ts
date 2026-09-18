/** Identical production settings and application sources; only the UI adapter differs. */
import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../..');
const destination = resolve(repository, process.env['XI_UI_PROOF_OUTDIR'] ?? '.artifacts/ui-solid/build');
await mkdir(destination, { recursive: true });
const sources: Record<string, string> = {};
const binaries: Record<string, string> = {};
for (const mode of ['core', 'react', 'solid']) {
  const result = await Bun.build({
    entrypoints: [resolve(repository, 'apps/xi/src/main.ts')],
    target: 'bun', format: 'esm', bytecode: true, minify: true,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"' },
    compile: { outfile: resolve(destination, `xi-${mode}`) },
    plugins: [{
      name: 'same-core-ui-comparison',
      setup(build) {
        build.onResolve({ filter: /^@opentui\/core(?:\/|$)/ }, args => ({ path: Bun.resolveSync(args.path, repository) }));
        if (mode !== 'core') build.onResolve({ filter: /packages\/ui\/src\/entrypoints\/launch$/ }, () => ({ path: resolve(repository, `spikes/ui-${mode}/launch.tsx`) }));
        build.onLoad({ filter: /\.(?:ts|tsx)$/ }, async args => {
          const contents = await readFile(args.path, 'utf8');
          sources[`${mode}:${args.path}`] = createHash('sha256').update(contents).digest('hex');
          // Let the official build-time Solid compiler transform JSX and select the
          // reactive client runtime. Returning undefined continues the plugin chain.
          if (mode === 'solid' && args.path.endsWith('.tsx')) return undefined;
          return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
        });
      },
    }, ...(mode === 'solid' ? [createSolidTransformPlugin()] : [])],
  });
  if (!result.success) throw new AggregateError(result.logs, `build ${mode} failed`);
  const binary = resolve(destination, `xi-${mode}`);
  binaries[mode] = createHash('sha256').update(await readFile(binary)).digest('hex');
  console.log(`${mode}: ${binary}`);
}
await writeFile(resolve(destination, 'build-manifest.json'), JSON.stringify({ bun: Bun.version, minify: true, nodeEnv: 'production', sources, binaries }, null, 2) + '\n');
