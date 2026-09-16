import { strict as assert } from 'node:assert';
import * as renderer from '@opentui/core/renderer';

// Mix the narrow, full and testing entrypoints as real applications do.
// Duplicate classes or native owners would break instanceof and destruction.
const full = await import('@opentui/core');
const { createTestRenderer } = await import('@opentui/core/testing');
for (const [name, value] of Object.entries(renderer)) {
  assert.equal(value, (full as unknown as Readonly<Record<string, unknown>>)[name], `shared export ${name}`);
}
assert.equal('Audio' in renderer, false);
assert.equal('MarkdownRenderable' in renderer, false);
const setup = await createTestRenderer({ width: 20, height: 5 });
class Primitive extends renderer.Renderable {}
try {
  const child = new Primitive(setup.renderer, { width: 5, height: 1 });
  assert.ok(child instanceof full.Renderable);
  setup.renderer.root.add(child);
  await setup.renderOnce();
  assert.ok(setup.captureCharFrame().length > 0);
} finally {
  setup.renderer.destroy();
}
console.log('T122 renderer entry shares class, function and native state with full/testing exports');
