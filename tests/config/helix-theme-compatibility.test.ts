import assert from 'node:assert/strict';
import { CancellationSource } from '../../packages/primitives/src/entrypoints/launch';
import { decodeHelixWorkbenchTheme, discoverCustomThemeConfigs, loadCustomThemeConfig, parseThemeConfig } from '../../packages/services/config/index';

const files = new Map<string, string>([
  ['/themes/base.toml', '"ui.background" = { bg = "paper" }\n"ui.text" = "ink"\ncomment = { fg = "muted", modifiers = ["italic"] }\n[palette]\npaper = "#101010"\nink = "#f0f0f0"\nmuted = "#808080"\n'],
  ['/themes/child.toml', 'inherits = "base"\n"ui.menu" = {\n  fg = "ink",\n  bg = "panel",\n  modifiers = ["bold"],\n}\n"ui.menu.selected" = { fg = "paper", bg = "accent" }\n"ui.menu.scroll" = { fg = "accent", bg = "panel" }\n"ui.picker.header" = { fg = "paper", bg = "panel" }\n"ui.cursor.primary.normal" = { fg = "paper", bg = "accent" }\n"ui.statusline.insert" = { fg = "paper", bg = "accent" }\n"diagnostic.error".underline = { color = "red", style = "curl" }\n[palette]\npanel = "#202020"\naccent = "#303030"\n'],
]);

const reads: string[] = [];
const filesystem = {
  async enumerateDirectory(): Promise<{ readonly ok: true; readonly value: readonly { readonly kind: string; readonly name: string }[] }> {
    return { ok: true, value: [...files.keys()].map((path) => ({ kind: 'file' as const, name: path.slice('/themes/'.length) })) };
  },
  async readFile(path: string): Promise<{ readonly ok: true; readonly value: Uint8Array }> {
    reads.push(path);
    return { ok: true, value: new TextEncoder().encode(files.get(path) ?? '') };
  },
};

const cancellation = new CancellationSource();
const discovered = await discoverCustomThemeConfigs(filesystem, '/themes', cancellation.token);
cancellation.dispose();
assert.equal(discovered.diagnostics.length, 0, 'Helix inheritance and multiline styles parse without diagnostics');
const child = discovered.themes.get('child')?.theme;
assert.notEqual(child, undefined, 'the child theme is discovered');
assert.equal(child!.styles.comment?.fg, 'muted', 'the parent scope is retained');
assert.deepEqual(child!.styles['ui.menu']?.modifiers, ['bold'], 'multiline style modifiers are retained');
assert.equal(child!.styles['diagnostic.error']?.underline?.style, 'curl', 'dotted style-property assignments merge into their scope');

const workbench = decodeHelixWorkbenchTheme(child!);
assert.equal(workbench.background, '#101010', 'ui.background maps to the editor background');
assert.equal(workbench.styles['ui.menu']?.bg, '#202020', 'palette references resolve before UI paint');
assert.equal(workbench.styles['diagnostic.error']?.underline?.color, '\u0000xi-terminal-index:1', 'terminal palette names retain indexed-colour intent until the UI boundary');
assert.deepEqual(workbench.syntaxStyles.comment?.modifiers, ['italic'], 'syntax modifiers stay attached to their Helix scope mapping');
for (const scope of ['ui.menu.scroll', 'ui.picker.header', 'ui.cursor.primary.normal', 'ui.statusline.insert']) assert.notEqual(workbench.styles[scope], undefined, `${scope} is preserved for its matching Xi widget`);

reads.length = 0;
const configured = await loadCustomThemeConfig(filesystem, '/themes', 'child', new CancellationSource().token);
assert.equal(configured.diagnostics.length, 0, 'the configured theme and its parent load without diagnostics');
assert.equal(configured.theme?.theme.styles.comment?.fg, 'muted', 'configured-theme loading resolves inheritance');
assert.deepEqual(reads, ['/themes/child.toml', '/themes/base.toml'], 'configured-theme startup reads only its inheritance chain');

assert.equal(parseThemeConfig('keyword = { modifiers = ["flashing"] }').ok, false, 'unknown Helix modifiers are rejected');
assert.equal(parseThemeConfig('keyword = { underline = { style = "double" } }').ok, false, 'unknown Helix underline styles are rejected');

const terminalAndRainbow = parseThemeConfig('gray_scope = "gray"\nlight_gray_scope = "light-gray"\nindexed = "123"\nrainbow = ["red", { fg = "#abc", modifiers = ["bold"] }]');
assert.equal(terminalAndRainbow.ok, true, 'Helix terminal colours and rainbow style arrays parse');
if (!terminalAndRainbow.ok) throw new Error('terminal/rainbow theme did not parse');
const terminalWorkbench = decodeHelixWorkbenchTheme(terminalAndRainbow.value);
assert.equal(terminalWorkbench.styles.gray_scope?.fg, '\u0000xi-terminal-index:8', 'Helix gray is ANSI bright black');
assert.equal(terminalWorkbench.styles.light_gray_scope?.fg, '\u0000xi-terminal-index:7', 'Helix light-gray is ANSI white');
assert.equal(terminalWorkbench.styles.indexed?.fg, '\u0000xi-terminal-index:123', 'numeric ANSI colours retain their palette index');
assert.equal(terminalWorkbench.styles['rainbow.0']?.fg, '\u0000xi-terminal-index:1', 'rainbow array entries become Helix rainbow.N scopes');
assert.deepEqual(terminalWorkbench.styles['rainbow.1']?.modifiers, ['bold'], 'rainbow style tables retain modifiers');
assert.equal(parseThemeConfig('keyword = "#1234"').ok, true, 'style syntax is parsed before colour resolution');
files.set('/themes/bad-hex.toml', 'keyword = "#1234"');
const badHex = await discoverCustomThemeConfigs(filesystem, '/themes', new CancellationSource().token);
assert.ok(badHex.diagnostics.some((diagnostic) => diagnostic.fileName === 'bad-hex.toml' && diagnostic.message.includes('unknown colours')), 'hex lengths Helix rejects are diagnosed');
files.delete('/themes/bad-hex.toml');
assert.equal(parseThemeConfig('rainbow = ["red", 1]').ok, false, 'rainbow entries must be valid Helix styles');

files.set('/themes/unknown.toml', 'keyword = "not-a-colour"');
const unknown = await discoverCustomThemeConfigs(filesystem, '/themes', new CancellationSource().token);
assert.ok(unknown.diagnostics.some((diagnostic) => diagnostic.fileName === 'unknown.toml' && diagnostic.message.includes('unknown colours')), 'unresolved palette names are diagnosed instead of silently falling back');

console.log('Helix theme compatibility passed inheritance, palette, multiline style and dotted underline fixtures');
