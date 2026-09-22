import assert from 'node:assert/strict';
import { CancellationSource } from '../../packages/primitives/src/entrypoints/launch';
import { loadStartupXiConfig } from '../../packages/services/config';
const files = new Map([
  ['/home/test/.config/xi/config.toml', '[editor]\ntheme = "xi-dark"\n'],
  ['/home/test/.xi.toml', '[editor]\nsidebar-visible = false\nsidebar-width = 34\nsidebar-panel = "search"\ntheme = "xi-light"\n[keys.normal.space]\ng = "sidebar.toggle"\n'],
]);
const cancellation = new CancellationSource();
const filesystem = { readFile: async (path: string) => ({ ok: true as const, value: new TextEncoder().encode(files.get(path) ?? '') }) };
const loaded = await loadStartupXiConfig(filesystem, '/home/test/.config/xi', cancellation.token, [], '/home/test/.xi.toml');
assert.deepEqual(loaded.diagnostics, []);
assert.equal(loaded.config?.editor.sidebarVisible, false);
assert.equal(loaded.config?.editor.sidebarWidth, 34);
assert.equal(loaded.config?.editor.sidebarPanel, 'search');
assert.equal(loaded.config?.editor.theme, 'xi-dark', 'canonical user config wins over legacy home state');
assert.ok(loaded.config?.bindings.some(binding => binding.commandId === 'sidebar.toggle' && binding.keys.at(-1) === 'g'));
files.set('/home/test/.xi.toml', '[editor]\nsidebar-visible = "no"\n');
const invalid = await loadStartupXiConfig(filesystem, '/home/test/.config/xi', cancellation.token, [], '/home/test/.xi.toml');
assert.equal(invalid.config, undefined, 'invalid visibility cannot silently become visible');
assert.ok(invalid.diagnostics.length > 0);
cancellation.dispose();
console.log('Home state overrides load with precedence, key remapping and type validation');
