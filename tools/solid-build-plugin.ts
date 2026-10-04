import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin';
import type { BunPlugin } from 'bun';

/** Source preloads register a compiler; transformed builds must not ship that compiler. */
export function createXiSolidBuildPlugin(): BunPlugin {
  const solid = createSolidTransformPlugin();
  return {
    name: 'xi-solid',
    setup(build) {
      build.onLoad({ filter: /[/\\]packages[/\\]ui[/\\]src[/\\]entrypoints[/\\]preload\.ts$/ }, () => ({ contents: '', loader: 'ts' }));
      build.onLoad({ filter: /[/\\]node_modules[/\\]@opentui[/\\]core[/\\]index\.bun\.js$/ }, async (args) => {
        const code = await Bun.file(args.path).text();
        return {
          contents: code.replace('import.meta.require("./chunk-bun-sjm2gmzs.js")', 'require("marked")'),
          loader: 'js',
        };
      });
      solid.setup(build);
    },
  };
}
