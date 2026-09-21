import assert from 'node:assert/strict';
import { EditorStatePersistence, updateEditorState, updateSidebarVisibility } from '../../packages/services/config/state';
import { parseToml } from '../../packages/services/config';
import type { PlatformFailure, Result } from '../../packages/contracts/src/index';
const original = '# personal settings\r\n[editor] # keep\r\ntheme = "xi-dark"\r\nsidebar-visible = true # keep this too\r\n[keys.normal.space]\r\ng = "sidebar.toggle"\r\n';
const patched = updateSidebarVisibility(original, false);
assert.equal(patched, original.replace('true #', 'false #'));
assert.equal(updateSidebarVisibility(patched, false), patched);
for (const source of ['', '[editor]\ntheme="xi-dark"\n', 'editor.theme="xi-dark"\n']) {
  const result = parseToml(updateSidebarVisibility(source, false));
  assert.ok(result.ok);
  assert.equal(((result.value.value.xi as Record<string, unknown>).sidebar as Record<string, unknown>).visible, false);
}
assert.throws(() => updateSidebarVisibility('[editor]\nsidebar-visible="bad"', false));
assert.throws(() => updateSidebarVisibility('invalid', false));
for (const source of [
  'editor = { theme = "xi-dark", sidebar-visible = true } # keep\n',
  `editor = { theme = "{,#}", 'sidebar-visible' = true, mouse = { enabled = true } }\n`,
  'editor = {\n  theme = "xi-dark", # keep } misleading brace\n  sidebar-visible = true\n} # keep\n',
]) {
  assert.equal(updateSidebarVisibility(source, false), source.replace('sidebar-visible = true', 'sidebar-visible = false').replace("'sidebar-visible' = true", "'sidebar-visible' = false"));
}
for (const source of ['editor = {} # keep', 'editor = { theme = "xi-dark" } # keep']) {
  const patchedInline = updateSidebarVisibility(source, false);
  const parsedInline = Bun.TOML.parse(patchedInline) as { editor: { 'sidebar-visible': boolean } };
  assert.equal(parsedInline.editor['sidebar-visible'], false);
  assert.ok(patchedInline.endsWith('# keep'));
}
const canonical = updateSidebarVisibility('[xi.sidebar]\nvisible = true # keep\nwidth = 28\n', false);
assert.equal(canonical, '[xi.sidebar]\nvisible = false # keep\nwidth = 28\n');
const canonicalAdded = updateSidebarVisibility('[xi.sidebar]\nwidth = 28\n', false);
const canonicalParsed = parseToml(canonicalAdded);
assert.ok(canonicalParsed.ok);
assert.deepEqual((canonicalParsed.value.value.xi as Record<string, unknown>).sidebar, { visible: false, width: 28 });

const files = new Map<string, Uint8Array>();
const errors: string[] = [];
let fail = false;
let writes = 0;
const filesystem = {
  async readFile(path: string): Promise<Result<Uint8Array, PlatformFailure>> {
    const value = files.get(path);
    return value === undefined ? { ok: false, error: { code: 'not-found', message: 'missing', retryable: false } } : { ok: true, value };
  },
  async writeFileAtomic(path: string, value: Uint8Array): Promise<Result<void, PlatformFailure>> {
    writes++;
    if (fail) return { ok: false, error: { code: 'permission-denied', message: 'read only', retryable: false } };
    files.set(path, value);
    return { ok: true, value: undefined };
  },
};
const state = new EditorStatePersistence(filesystem, '/.xi.toml', message => errors.push(message));
for (let i = 0; i < 100; i++) state.setSidebarVisible(i % 2 === 0);
state.setTheme('xi-light');
state.setTheme('xi-dark');
state.setSidebarPanel('git');
state.setSidebarWidth(34);
await state.dispose();
assert.equal(writes, 1, 'burst toggles coalesce to one pending value');
const saved = parseToml(new TextDecoder().decode(files.get('/.xi.toml')));
assert.ok(saved.ok);
assert.equal((saved.value.value.editor as Record<string, unknown>).theme, 'xi-dark');
assert.deepEqual((saved.value.value.xi as Record<string, unknown>).sidebar, { visible: false, panel: 'git', width: 34 });
files.set('/.xi.toml', new TextEncoder().encode(original));
fail = true;
const failure = new EditorStatePersistence(filesystem, '/.xi.toml', message => errors.push(message));
failure.setSidebarVisible(false);
await failure.dispose();
assert.match(errors[0]!, /read only/);
assert.equal(new TextDecoder().decode(files.get('/.xi.toml')), original);
for (const source of [
  '[editor] # keep\ntheme = "old#value" # theme comment\nsidebar-visible = true\n',
  "editor.theme = 'old' # keep\n",
  'editor = { theme = "old", sidebar-visible = true } # keep\n',
  'editor = { sidebar-visible = true } # keep\n',
]) {
  const updated = updateEditorState(source, 'theme', 'new"theme');
  const parsed = Bun.TOML.parse(updated) as { editor: { theme: string } };
  assert.equal(parsed.editor.theme, 'new"theme');
  assert.ok(updated.includes('# keep'));
}
console.log('State persistence preserves settings/comments, coalesces theme and visibility, flushes and reports failures');
