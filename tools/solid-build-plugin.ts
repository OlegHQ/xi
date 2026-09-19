import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin';
import type { BunPlugin } from 'bun';

/** Source preloads register a compiler; transformed builds must not ship that compiler. */
export function createXiSolidBuildPlugin(): BunPlugin {
  const solid = createSolidTransformPlugin();
  return {
    name: 'xi-solid',
    setup(build) {
      build.onLoad({ filter: /[/\\]packages[/\\]ui[/\\]src[/\\]entrypoints[/\\]preload\.ts$/ }, () => ({ contents: '', loader: 'ts' }));
      solid.setup(build);
    },
  };
}
