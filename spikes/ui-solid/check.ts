import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin';
import { resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../..');
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'check.test.tsx')],
  compile: { outfile: resolve(repository, '.artifacts/ui-solid/check-adapter') },
  target: 'bun',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEV': '"false"' },
  plugins: [{ name: 'same-core', setup(build) {
    build.onResolve({ filter: /^@opentui\/core(?:\/|$)/ }, args => ({ path: Bun.resolveSync(args.path, repository) }));
  } }, createSolidTransformPlugin()],
});
if (!result.success) throw new AggregateError(result.logs, 'Solid check compilation failed');
const child = Bun.spawn([result.outputs[0]!.path], { stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
