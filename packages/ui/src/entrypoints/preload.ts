import { ensureSolidTransformPlugin } from '@opentui/solid/bun-plugin';

// The build plugin omits this module after compiling TSX. Source runs reuse transforms.
ensureSolidTransformPlugin({ cacheDirectory: new URL(`../../../../.cache/solid/${Bun.version}`, import.meta.url).pathname });
