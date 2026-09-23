import assert from 'node:assert/strict';
import configurationLedger from '../../docs/configuration-ledger.json' with { type: 'json' };
import {
  ConfigStore,
  DEFAULT_COMMAND_CATALOG,
  DEFAULT_CONFIG_TOML,
  DEFAULT_LANGUAGES_TOML,
  DEFAULT_THEME_TOML,
  PERSONAL_MIGRATION_TOML,
  compileConfig,
  compileInitialConfig,
  parseLanguageConfig,
  parseThemeConfig,
  parseToml,
  resolveFormatOnSave,
  workspaceTrustAllows,
  type ConfigLayer,
} from '../../packages/services/config/index';
import { resolveEditorColorMode } from '../../apps/xi/src/wiring/ui';
import { resolvePaintColor } from '../../packages/ui/theme/motion-tokens';
import { pathCompletionToken } from '../../packages/workbench/language/completion';
import { VIEW_COMMAND_IDS } from '../../packages/workbench/input/view-commands';

const defaults: ConfigLayer = { name: 'defaults', kind: 'defaults', fileName: 'config/default.toml', source: DEFAULT_CONFIG_TOML };
const personal: ConfigLayer = { name: 'personal-migration', kind: 'profile', fileName: 'config/personal-migration.toml', source: PERSONAL_MIGRATION_TOML };

const parsed = parseToml(DEFAULT_CONFIG_TOML, 'config/default.toml');
assert.equal(parsed.ok, true, 'T036-TOML-01 shipped example parses as TOML');
if (!parsed.ok) throw new Error('default TOML did not parse');
assert.ok(parsed.value.entries.some((entry) => entry.path.join('.') === 'keys.normal.space.f'), 'T036-TOML-02 dotted table entries retain their source path');
const conditionalDefaults = new Set(['editor.clipboard-provider', 'editor.soft-wrap.enable', 'xi.motion-trail']);
for (const item of configurationLedger.items) {
  if (item.status !== 'effective' || item.default === null || item.path.startsWith('$') || item.path.includes('*') || item.path === 'keys.insert' || conditionalDefaults.has(item.path)) continue;
  let declared: unknown = parsed.value.value;
  for (const segment of item.path.split('.')) declared = typeof declared === 'object' && declared !== null && segment in declared ? (declared as Record<string, unknown>)[segment] : undefined;
  assert.notEqual(declared, undefined, `T036-CONFIG-DEFAULT-PRESENCE-01 ${item.path} must be explicit in config/default.toml`);
}
const literal = parseToml("theme = 'a\\nb'\n'literal\\nkey' = 'c\\td'\n");
assert.equal(literal.ok, true, 'TOML literal strings and keys parse');
if (literal.ok) {
  assert.equal(literal.value.value.theme, 'a\\nb', 'literal string backslashes remain literal');
  assert.equal(literal.value.value['literal\\nkey'], 'c\\td', 'literal key and value backslashes remain literal');
}
for (const source of ['editor = 1', 'keys = 1', '[keys.normal]\nx = 1', '[editor.unknown-empty]']) {
  const rejected = compileConfig([{ name: 'invalid-shape', kind: 'user', fileName: 'invalid-shape.toml', source }]);
  assert.equal(rejected.ok, false, `invalid config shape is rejected: ${source}`);
  if (!rejected.ok) assert.equal(rejected.error.diagnostics[0]?.fileName, 'invalid-shape.toml');
}

const initial = compileInitialConfig();
assert.equal(initial.ok, true, 'T036-CONFIG-01 shipped example validates');
if (!initial.ok) throw new Error('default config did not compile');
const fallback = compileConfig([]);
assert.equal(fallback.ok, true, 'T036-CONFIG-FALLBACK-01 compiler fallback validates');
if (!fallback.ok) throw new Error('config fallback did not compile');
assert.deepEqual(initial.value.editor, fallback.value.editor, 'T036-CONFIG-FALLBACK-02 canonical defaults and compiler fallback produce the same editor settings');
assert.deepEqual(initial.value.search, fallback.value.search, 'T036-CONFIG-FALLBACK-03 canonical defaults and compiler fallback produce the same search settings');
assert.equal(initial.value.schemaVersion, 1, 'T036-XI-SCHEMA-VERSION-DEFAULT-01 canonical xi.schema-version compiles to schema version 1');
assert.equal(initial.value.profile, 'xi', 'T036-XI-PROFILE-DEFAULT-01 canonical xi.profile selects the Xi profile');
assert.deepEqual({ visible: initial.value.editor.sidebarVisible, width: initial.value.editor.sidebarWidth, panel: initial.value.editor.sidebarPanel }, { visible: true, width: 28, panel: 'files' }, 'T036-XI-SIDEBAR-DEFAULT-01 canonical xi.sidebar defaults reach the compiled config');
assert.equal(initial.value.editor.mouse.modifier, 'none', 'T036-XI-MOUSE-DEFAULT-01 canonical xi.mouse.modifier defaults to no required modifier');
assert.ok(initial.value.bindings.some((binding) => binding.mode === 'files-panel'), 'T036-KEYS-DEFAULT-01 shipped Xi panel bindings remain available through canonical xi.keys contexts');
const strictXiMetadata = compileConfig([defaults, { name: 'strict-xi-metadata', kind: 'user', fileName: 'strict-xi-metadata.toml', source: '[xi]\nschema-version = 1\nprofile = "strict"\n' }]);
assert.equal(strictXiMetadata.ok, true, 'T036-XI-METADATA-SCHEMA-01 canonical xi metadata compiles');
if (strictXiMetadata.ok) {
  assert.equal(strictXiMetadata.value.profile, 'strict', 'T036-XI-PROFILE-RUNTIME-01 canonical xi.profile reaches the compiled profile');
  assert.equal(strictXiMetadata.value.editor.motionTrail, 'off', 'T036-XI-PROFILE-RUNTIME-02 strict profile disables motion trail through the compiled config');
}
const invalidXiMetadata = compileConfig([{ name: 'invalid-xi-metadata', kind: 'user', fileName: 'invalid-xi-metadata.toml', source: '[xi]\nschema-version = 2\nprofile = "unknown"\n' }]);
assert.equal(invalidXiMetadata.ok, false, 'T036-XI-METADATA-INVALID-01 unsupported canonical xi metadata is rejected');
const configuredXiSidebar = compileConfig([defaults, { name: 'xi-sidebar', kind: 'user', fileName: 'xi-sidebar.toml', source: '[xi.sidebar]\nvisible = false\nwidth = 34\npanel = "search"\n' }]);
assert.equal(configuredXiSidebar.ok, true, 'T036-XI-SIDEBAR-SCHEMA-01 canonical xi.sidebar fields compile');
if (configuredXiSidebar.ok) assert.deepEqual({ visible: configuredXiSidebar.value.editor.sidebarVisible, width: configuredXiSidebar.value.editor.sidebarWidth, panel: configuredXiSidebar.value.editor.sidebarPanel }, { visible: false, width: 34, panel: 'search' }, 'T036-XI-SIDEBAR-RUNTIME-01 canonical xi.sidebar values reach the compiled config');
const invalidXiSidebar = compileConfig([{ name: 'invalid-xi-sidebar', kind: 'user', fileName: 'invalid-xi-sidebar.toml', source: '[xi.sidebar]\nvisible = "yes"\nwidth = 99\npanel = "unknown"\n' }]);
assert.equal(invalidXiSidebar.ok, false, 'T036-XI-SIDEBAR-INVALID-01 invalid canonical xi.sidebar values are rejected');
const configuredXiRuntime = compileConfig([defaults, { name: 'xi-runtime', kind: 'user', fileName: 'xi-runtime.toml', source: '[xi]\nmotion-trail = "off"\n[xi.mouse]\nmodifier = "shift"\n[xi.selection]\nlimit = 20\nhistory-limit = 3\n[xi.hints]\ndelay-ms = 17\n[xi.search]\ndebounce-ms = 7\nmax-visible-results = 25\n[xi.aliases]\nxi-test = "config.reload"\n' }]);
assert.equal(configuredXiRuntime.ok, true, 'T036-XI-RUNTIME-SCHEMA-01 canonical Xi runtime settings compile');
if (configuredXiRuntime.ok) {
  assert.equal(configuredXiRuntime.value.editor.motionTrail, 'off', 'T036-XI-MOTION-RUNTIME-01 canonical xi.motion-trail reaches the runtime');
  assert.equal(configuredXiRuntime.value.editor.mouse.modifier, 'shift', 'T036-XI-MOUSE-RUNTIME-01 canonical xi.mouse.modifier reaches the runtime');
  assert.deepEqual(configuredXiRuntime.value.editor.selection, { limit: 20, historyLimit: 3 }, 'T036-XI-SELECTION-RUNTIME-01 canonical xi.selection reaches the runtime');
  assert.equal(configuredXiRuntime.value.editor.hintsDelayMs, 17, 'T036-XI-HINTS-RUNTIME-01 canonical xi.hints.delay-ms reaches the runtime');
  assert.deepEqual(configuredXiRuntime.value.search, { debounceMs: 7, maxVisibleResults: 25, hidden: true, followSymlinks: false }, 'T036-XI-SEARCH-RUNTIME-01 canonical xi.search reaches the runtime');
  assert.ok(configuredXiRuntime.value.aliases.some((alias) => alias.name === 'xi-test'), 'T036-XI-ALIASES-RUNTIME-01 canonical xi.aliases reaches the runtime');
}
const invalidXiRuntime = compileConfig([{ name: 'invalid-xi-runtime', kind: 'user', fileName: 'invalid-xi-runtime.toml', source: '[xi]\nmotion-trail = "invalid"\n[xi.mouse]\nmodifier = "invalid"\n[xi.selection]\nlimit = 0\nhistory-limit = 0\n[xi.hints]\ndelay-ms = -1\n[xi.search]\ndebounce-ms = -1\nmax-visible-results = 0\n[xi.aliases]\nxi-test = "unknown.command"\n' }]);
assert.equal(invalidXiRuntime.ok, false, 'T036-XI-RUNTIME-INVALID-01 invalid canonical Xi runtime settings are rejected');
const helixKeyMap = compileConfig([{ name: 'helix-key-map', kind: 'user', fileName: 'helix-key-map.toml', source: '[keys.normal]\nC-s = ":write"\n[keys.insert]\nC-s = ":write"\n[keys.select]\nC-s = ":write"\n' }]);
assert.equal(helixKeyMap.ok, true, 'T036-KEYS-SCHEMA-01 Helix key names and typable Ex values compile');
if (helixKeyMap.ok) {
  assert.deepEqual(helixKeyMap.value.bindings.map((binding) => ({ mode: binding.mode, keys: binding.keys, commandId: binding.commandId })), [
    { mode: 'normal', keys: ['<C-s>'], commandId: 'ex:write' },
    { mode: 'insert', keys: ['<C-s>'], commandId: 'ex:write' },
    { mode: 'select', keys: ['<C-s>'], commandId: 'ex:write' },
  ], 'T036-KEYS-RUNTIME-01 canonical Helix key maps retain mode, key and Ex command semantics');
}
const helixKeyValueForms = compileConfig([{ name: 'helix-key-value-forms', kind: 'user', fileName: 'helix-key-value-forms.toml', source: '[keys.normal]\nret = ["no_op", "no_op"]\nA-x = "@x<C-s>"\n' }]);
assert.equal(helixKeyValueForms.ok, true, 'T036-KEYS-FORMS-SCHEMA-01 Helix command sequences and @ macros compile');
if (helixKeyValueForms.ok) {
  assert.ok(helixKeyValueForms.value.bindings.some((binding) => binding.commandId.startsWith('sequence:')), 'T036-KEYS-FORMS-RUNTIME-01 command sequences retain ordered actions');
  assert.ok(helixKeyValueForms.value.bindings.some((binding) => binding.commandId.startsWith('macro:')), 'T036-KEYS-FORMS-RUNTIME-02 @ macros retain parsed key tokens');
}
const invalidHelixKeyValueForms = compileConfig([{ name: 'invalid-helix-key-value-forms', kind: 'user', fileName: 'invalid-helix-key-value-forms.toml', source: '[keys.normal]\nret = ["no_op", 3]\nA-x = "@x<C-s"\n' }]);
assert.equal(invalidHelixKeyValueForms.ok, false, 'T036-KEYS-FORMS-INVALID-01 malformed command sequences and macros are rejected');
const xiKeyMap = compileConfig([defaults, { name: 'xi-key-map', kind: 'user', fileName: 'xi-key-map.toml', source: '[xi.keys.files-panel.space]\nz = "panel.open"\n' }]);
assert.equal(xiKeyMap.ok, true, 'T036-XI-KEYS-SCHEMA-01 canonical xi.keys contexts compile');
if (xiKeyMap.ok) assert.ok(xiKeyMap.value.bindings.some((binding) => binding.mode === 'files-panel' && binding.keys.join('.') === '<Space>.z' && binding.commandId === 'panel.open'), 'T036-XI-KEYS-RUNTIME-01 canonical xi.keys reaches the panel binding runtime');
const invalidHelixKeyMap = compileConfig([{ name: 'invalid-helix-key-map', kind: 'user', fileName: 'invalid-helix-key-map.toml', source: '[keys.normal]\nC-s = "not_a_command"\n' }]);
assert.equal(invalidHelixKeyMap.ok, false, 'T036-KEYS-INVALID-01 unknown key commands are rejected');
const expectedViewBindings = { '<C-Up>': 'view.scroll-up', '<C-Down>': 'view.scroll-down', '<C-d>': 'view.half-page-down', '<C-u>': 'view.half-page-up' };
const expectedNormalLeader = {
  q: 'macro.record', c: 'config.open', s: 'sidebar.toggle', f: 'files.pick', b: 'buffers.pick',
  ';': 'command.pick', '/': 'search.workspace', o: 'files.edit-directory', O: 'files.edit-buffer-directory',
  t: 'theme.pick', k: 'lsp.hover', a: 'lsp.code-action', d: 'diagnostics.pick',
  e: 'panel.problems.focus', m: 'editor.mouse.toggle', r: 'search.replace',
};
const expectedPanelLeader = { s: 'sidebar.toggle', l: 'panel.preview', o: 'panel.open', q: 'panel.close' };
const expectedFocusedPanelLeaders = {
  'files-panel': { ...expectedPanelLeader, h: 'panel.include-hidden', i: 'panel.include-ignored', f: 'panel.files.focus', g: 'panel.git.focus', e: 'panel.expand-all' },
  'search-panel': { ...expectedPanelLeader, h: 'panel.include-hidden', i: 'panel.include-ignored', f: 'panel.files.focus', g: 'panel.git.focus' },
  'file-picker': { h: 'panel.include-hidden', i: 'panel.include-ignored' },
  'git-panel': { ...expectedPanelLeader, f: 'panel.files.focus', g: 'panel.git.focus' },
  'diff-panel': expectedPanelLeader,
};
const expectedBindings = [
  ...['normal', 'select'].flatMap(mode => Object.entries(expectedViewBindings).map(([key, command]) => [`${mode}:${key}`, command] as const)),
  ...Object.entries(expectedNormalLeader).map(([key, command]) => [`normal:<Space> ${key}`, command] as const),
  ...Object.entries({ p: 'panel.problems.focus', f: 'panel.files.focus', s: 'panel.search.focus', g: 'panel.git.focus', o: 'panel.outline.focus', d: 'git.diff' }).map(([key, command]) => [`normal:<Space> v ${key}`, command] as const),
  ...Object.entries(expectedFocusedPanelLeaders).flatMap(([mode, panelBindings]) => Object.entries(panelBindings).map(([key, command]) => [`${mode}:<Space> ${key}`, command] as const)),
];
const actualBindings = new Map(initial.value.bindings.map(binding => [`${binding.mode}:${binding.keys.join(' ')}`, binding.commandId]));
for (const [context, command] of expectedBindings) assert.equal(actualBindings.get(context), command, `T036-CONFIG-DEFAULT-BINDING-01 ${context}`);
assert.equal(actualBindings.size, expectedBindings.length, 'T036-CONFIG-DEFAULT-BINDING-02 no undeclared default bindings');
for (const commandId of VIEW_COMMAND_IDS) assert.ok(DEFAULT_COMMAND_CATALOG.commandIds.includes(commandId), `T036-VIEW-CATALOG-01 ${commandId} is configurable`);
const expectedAliases = {
  files: 'files.pick', buffers: 'buffers.pick', commands: 'command.pick', 'buffer-next': 'buffer.next',
  'buffer-previous': 'buffer.previous', theme: 'theme.pick', 'config-open': 'config.open',
  'config-reload': 'config.reload', 'write-quit': 'write.quit', 'quit-all': 'quit.all', 'write-all': 'write.all',
};
const actualAliases = new Map(initial.value.aliases.map(alias => [alias.name, alias.commandId]));
for (const [name, command] of Object.entries(expectedAliases)) assert.equal(actualAliases.get(name), command, `T036-CONFIG-DEFAULT-ALIAS-01 ${name}`);
assert.equal(actualAliases.size, Object.keys(expectedAliases).length, 'T036-CONFIG-DEFAULT-ALIAS-02 no undeclared default aliases');
assert.ok(initial.value.bindings.every((binding) => DEFAULT_COMMAND_CATALOG.commandIds.includes(binding.commandId)), 'T036-CONFIG-03 every binding command resolves in the catalog');
assert.ok(DEFAULT_COMMAND_CATALOG.commandIds.includes('config.open'), 'T036-CONFIG-OPEN-SCHEMA-01 config.open is a registered command id');
assert.ok(DEFAULT_COMMAND_CATALOG.commandIds.includes('config.reload'), 'T036-CONFIG-OPEN-DEFAULT-01 config command catalog retains the reload companion');
assert.equal(initial.value.aliases.find((alias) => alias.name === 'config-reload')?.commandId, 'config.reload', 'T036-CONFIG-RELOAD-DEFAULT-01 config-reload alias resolves to the reload command');
const invalidConfigOpenCommand = compileConfig([{ name: 'invalid-config-open', kind: 'user', fileName: 'invalid-config-open.toml', source: '[keys.normal]\nspace = "config-open"\n' }]);
assert.equal(invalidConfigOpenCommand.ok, false, 'T036-CONFIG-OPEN-INVALID-01 the Ex spelling is not accepted as a keybinding command id');
assert.equal(initial.value.aliases.length, 11, 'T036-CONFIG-04 friendly aliases compile to stable command IDs');
assert.equal(initial.value.editor.selection.limit, 10_000, 'T036-CONFIG-05 selection limit is validated and retained');
assert.equal(initial.value.editor.selection.historyLimit, 100, 'T036-CONFIG-06 selection history limit is validated and retained');
assert.equal(initial.value.editor.hintsDelayMs, 250, 'T036-CONFIG-07 hint delay is validated and retained');
assert.equal(initial.value.editor.scrolloff, 5, 'T036-CONFIG-09 Helix scrolloff default is retained');
assert.equal(initial.value.editor.continueComments, true, 'T036-CONTINUE-COMMENTS-DEFAULT-01 Helix continue-comments default is retained');
assert.equal(initial.value.editor.idleTimeout, 250, 'T036-IDLE-TIMEOUT-01 Helix idle-timeout default is retained');
assert.deepEqual(initial.value.editor.jumpLabelAlphabet, [...'abcdefghijklmnopqrstuvwxyz'], 'T036-JUMP-LABEL-DEFAULT-01 Helix jump-label-alphabet default is retained');
const configuredJumpLabelAlphabet = compileConfig([defaults, { name: 'jump-label-alphabet', kind: 'user', fileName: 'jump-label-alphabet.toml', source: '[editor]\njump-label-alphabet = "xy"\n' }]);
assert.equal(configuredJumpLabelAlphabet.ok, true, 'T036-JUMP-LABEL-SCHEMA-01 unique jump-label-alphabet compiles');
if (configuredJumpLabelAlphabet.ok) assert.deepEqual(configuredJumpLabelAlphabet.value.editor.jumpLabelAlphabet, ['x', 'y'], 'T036-JUMP-LABEL-RUNTIME-01 jump-label-alphabet reaches the compiled config');
const invalidJumpLabelAlphabet = compileConfig([{ name: 'invalid-jump-label-alphabet', kind: 'user', fileName: 'invalid-jump-label-alphabet.toml', source: '[editor]\njump-label-alphabet = "xyx"\n' }]);
assert.equal(invalidJumpLabelAlphabet.ok, false, 'T036-JUMP-LABEL-INVALID-01 duplicate jump-label-alphabet characters are rejected');
assert.equal(initial.value.editor.lsp.enable, true, 'T036-CONFIG-10 Helix LSP enable default is retained');
assert.deepEqual(initial.value.editor.themeVariants, {}, 'T036-THEME-VARIANTS-DEFAULT-01 master theme variants default to no configured selectors');
assert.equal(initial.value.editor.lsp.snippets, true, 'T036-LSP-SNIPPETS-01 Helix snippets default is retained');
assert.equal(initial.value.editor.lsp.displayMessages, true, 'T036-LSP-DISPLAY-MESSAGES-01 Helix display-messages default is retained');
assert.equal(initial.value.editor.lsp.displayProgressMessages, false, 'T036-LSP-DISPLAY-PROGRESS-01 Helix display-progress-messages default is retained');
assert.equal(initial.value.editor.lsp.displayColorSwatches, true, 'T036-LSP-COLOR-SWATCHES-DEFAULT-01 Helix display-color-swatches defaults to true');
assert.equal(initial.value.editor.autoCompletion, true, 'T036-AUTO-COMPLETION-01 Helix auto-completion default is retained');
assert.equal(initial.value.editor.pathCompletion, true, 'T036-PATH-COMPLETION-01 Helix path-completion default is retained');
assert.deepEqual(pathCompletionToken('import "./src/'), { start: 8, text: './src/' }, 'T036-PATH-COMPLETION-UNIT-01 recognizes a relative path token');
assert.equal(pathCompletionToken('const value = alpha'), undefined, 'T036-PATH-COMPLETION-UNIT-02 leaves ordinary identifiers on LSP completion');
const configuredWordCompletion = compileConfig([defaults, { name: 'word-completion', kind: 'user', fileName: 'word-completion.toml', source: '[editor.word-completion]\nenable = false\ntrigger-length = 4\n' }]);
assert.equal(configuredWordCompletion.ok, true, 'T036-WORD-COMPLETION-SCHEMA-01 Helix word-completion fields compile');
if (configuredWordCompletion.ok) assert.deepEqual(configuredWordCompletion.value.editor.wordCompletion, { enable: false, triggerLength: 4 }, 'T036-WORD-COMPLETION-RUNTIME-01 word-completion values reach the compiled config');
const invalidWordCompletion = compileConfig([{ name: 'invalid-word-completion', kind: 'user', fileName: 'invalid-word-completion.toml', source: '[editor.word-completion]\nenable = "yes"\ntrigger-length = 0\n' }]);
assert.equal(invalidWordCompletion.ok, false, 'T036-WORD-COMPLETION-INVALID-01 invalid word-completion values are rejected');
assert.deepEqual(initial.value.editor.workspaceTrust, { level: 'servers', prompt: true, trusted: [] }, 'T036-WORKSPACE-TRUST-DEFAULT-01 Helix workspace-trust defaults are retained');
assert.equal(initial.value.editor.workspaceTrust.level, 'servers', 'T036-WORKSPACE-TRUST-LEVEL-DEFAULT-01 workspace-trust.level defaults to servers');
assert.equal(initial.value.editor.workspaceTrust.prompt, true, 'T036-WORKSPACE-TRUST-PROMPT-DEFAULT-01 workspace-trust.prompt defaults to true');
assert.deepEqual(initial.value.editor.workspaceTrust.trusted, [], 'T036-WORKSPACE-TRUST-TRUSTED-DEFAULT-01 workspace-trust.trusted defaults to an empty list');
const configuredWorkspaceTrust = compileConfig([defaults, { name: 'workspace-trust', kind: 'user', fileName: 'workspace-trust.toml', source: '[editor.workspace-trust]\nlevel = "none"\nprompt = false\ntrusted = ["~/src/*"]\n' }]);
assert.equal(configuredWorkspaceTrust.ok, true, 'T036-WORKSPACE-TRUST-SCHEMA-01 Helix workspace-trust fields compile');
if (configuredWorkspaceTrust.ok) assert.deepEqual(configuredWorkspaceTrust.value.editor.workspaceTrust, { level: 'none', prompt: false, trusted: ['~/src/*'] }, 'T036-WORKSPACE-TRUST-RUNTIME-01 workspace-trust values reach the compiled config');
if (configuredWorkspaceTrust.ok) {
  assert.equal(configuredWorkspaceTrust.value.editor.workspaceTrust.level, 'none', 'T036-WORKSPACE-TRUST-LEVEL-RUNTIME-01 workspace-trust.level reaches the runtime');
  assert.equal(configuredWorkspaceTrust.value.editor.workspaceTrust.prompt, false, 'T036-WORKSPACE-TRUST-PROMPT-RUNTIME-01 workspace-trust.prompt reaches the runtime');
  assert.deepEqual(configuredWorkspaceTrust.value.editor.workspaceTrust.trusted, ['~/src/*'], 'T036-WORKSPACE-TRUST-TRUSTED-RUNTIME-01 workspace-trust.trusted reaches the runtime');
}
assert.equal(workspaceTrustAllows('/home/user/src/project', { level: 'none', prompt: false, trusted: ['~/src/*'] }, { HOME: '/home/user' }), true, 'T036-WORKSPACE-TRUST-MATCH-01 trusted path patterns allow a matching workspace');
assert.equal(workspaceTrustAllows('/home/user/src/a/b', { level: 'none', prompt: false, trusted: ['~/src/*'] }, { HOME: '/home/user' }), false, 'T036-WORKSPACE-TRUST-MATCH-02 single-star patterns do not cross path components');
assert.equal(workspaceTrustAllows('/tmp/project', { level: 'insecure', prompt: true, trusted: [] }), true, 'T036-WORKSPACE-TRUST-MATCH-03 insecure level allows every workspace');
assert.equal(workspaceTrustAllows('/tmp/project', { level: 'none', prompt: true, trusted: ['$MISSING/*'] }, {}), false, 'T036-WORKSPACE-TRUST-MATCH-04 unknown environment variables never broaden trust');
const invalidWorkspaceTrust = compileConfig([{ name: 'invalid-workspace-trust', kind: 'user', fileName: 'invalid-workspace-trust.toml', source: '[editor.workspace-trust]\nlevel = "always"\ntrusted = [""]\n' }]);
assert.equal(invalidWorkspaceTrust.ok, false, 'T036-WORKSPACE-TRUST-INVALID-01 invalid workspace-trust values are rejected');
const invalidWorkspaceTrustLevel = compileConfig([{ name: 'invalid-workspace-trust-level', kind: 'user', fileName: 'invalid-workspace-trust-level.toml', source: '[editor.workspace-trust]\nlevel = "always"\n' }]);
assert.equal(invalidWorkspaceTrustLevel.ok, false, 'T036-WORKSPACE-TRUST-LEVEL-INVALID-01 unsupported workspace-trust.level values are rejected');
const invalidWorkspaceTrustPrompt = compileConfig([{ name: 'invalid-workspace-trust-prompt', kind: 'user', fileName: 'invalid-workspace-trust-prompt.toml', source: '[editor.workspace-trust]\nprompt = "yes"\n' }]);
assert.equal(invalidWorkspaceTrustPrompt.ok, false, 'T036-WORKSPACE-TRUST-PROMPT-INVALID-01 non-boolean workspace-trust.prompt is rejected');
const invalidWorkspaceTrustTrusted = compileConfig([{ name: 'invalid-workspace-trust-trusted', kind: 'user', fileName: 'invalid-workspace-trust-trusted.toml', source: '[editor.workspace-trust]\ntrusted = [""]\n' }]);
assert.equal(invalidWorkspaceTrustTrusted.ok, false, 'T036-WORKSPACE-TRUST-TRUSTED-INVALID-01 empty workspace-trust.trusted patterns are rejected');
assert.equal(initial.value.editor.completionTimeout, 250, 'T036-COMPLETION-TIMEOUT-01 Helix completion-timeout default is retained');
assert.equal(initial.value.editor.completionTriggerLen, 2, 'T036-COMPLETION-TRIGGER-LEN-01 Helix completion-trigger-len default is retained');
assert.equal(initial.value.editor.previewCompletionInsert, true, 'T036-PREVIEW-COMPLETION-INSERT-01 Helix preview-completion-insert default is retained');
assert.equal(initial.value.editor.autoInfo, true, 'T036-AUTO-INFO-01 Helix auto-info default is retained');
assert.equal(initial.value.editor.completionReplace, false, 'T036-COMPLETION-REPLACE-01 Helix completion-replace default is retained');
assert.equal(initial.value.editor.colorModes, false, 'T036-COLOR-MODES-01 Helix color-modes default is retained');
assert.equal(initial.value.editor.rainbowBrackets, false, 'T036-RAINBOW-BRACKETS-DEFAULT-01 Helix rainbow-brackets defaults to false');
assert.equal(initial.value.editor.trueColor, false, 'T036-TRUE-COLOR-01 Helix true-color default is retained');
assert.equal(initial.value.editor.undercurl, false, 'T036-UNDERCURL-01 Helix undercurl default is retained');
assert.equal(resolveEditorColorMode(false, { TERM: 'xterm-256color' }), 'ansi256', 'T036-TRUE-COLOR-UNIT-01 capability detection retains reduced color mode');
assert.equal(resolveEditorColorMode(false, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }), 'truecolor', 'T036-TRUE-COLOR-UNIT-02 capability detection recognizes truecolor');
assert.equal(resolveEditorColorMode(true, { TERM: 'dumb' }), 'truecolor', 'T036-TRUE-COLOR-UNIT-03 true-color overrides a false terminal capability detection');
assert.equal(resolveEditorColorMode(false, { TERM: 'dumb' }), 'no-color', 'T036-TRUE-COLOR-UNIT-04 dumb terminals remain uncolored without the override');
assert.equal(resolvePaintColor('#123456', 'ansi256').intent, 'indexed', 'T036-TRUE-COLOR-UNIT-05 reduced color mode retains indexed terminal intent');
assert.equal(initial.value.editor.bufferline, 'never', 'T036-BUFFERLINE-01 Helix bufferline default is retained');
assert.equal(initial.value.editor.fileExplorer.hidden, true, 'T036-FILE-EXPLORER-HIDDEN-DEFAULT-01 Xi hides dotfiles in Files by default');
assert.equal(initial.value.editor.fileExplorer.followSymlinks, false, 'T036-FILE-EXPLORER-SYMLINKS-DEFAULT-01 master file-explorer.follow-symlinks defaults to false');
assert.equal(initial.value.editor.fileExplorer.parents, true, 'T036-FILE-EXPLORER-PARENTS-DEFAULT-01 Xi reads parent ignore files by default');
assert.equal(initial.value.editor.fileExplorer.ignore, true, 'T036-FILE-EXPLORER-IGNORE-DEFAULT-01 Xi reads .ignore by default');
assert.equal(initial.value.editor.fileExplorer.gitIgnore, true, 'T036-FILE-EXPLORER-GIT-IGNORE-DEFAULT-01 Xi reads .gitignore by default');
assert.equal(initial.value.editor.fileExplorer.gitGlobal, true, 'T036-FILE-EXPLORER-GIT-GLOBAL-DEFAULT-01 Xi reads global Git ignore by default');
assert.equal(initial.value.editor.fileExplorer.gitExclude, true, 'T036-FILE-EXPLORER-GIT-EXCLUDE-DEFAULT-01 Xi reads Git exclude by default');
assert.equal(initial.value.editor.fileExplorer.flattenDirs, true, 'T036-FILE-EXPLORER-FLATTEN-DIRS-DEFAULT-01 master file-explorer.flatten-dirs defaults to true');
assert.equal(initial.value.editor.defaultLineEnding, 'native', 'T036-DEFAULT-LINE-ENDING-01 Helix default-line-ending default is retained');
assert.equal(initial.value.editor.popupBorder, 'none', 'T036-POPUP-BORDER-01 Helix popup-border default is retained');
assert.deepEqual(initial.value.editor.statusline.left, ['mode', 'spinner', 'file-name', 'read-only-indicator', 'file-modification-indicator'], 'T036-STATUSLINE-LAYOUT-01 Helix statusline left default is retained');
assert.equal(initial.value.editor.statusline.left.includes('code-action-hint'), false, 'T036-CODE-ACTION-HINT-STATUSLINE-DEFAULT-01 code-action-hint is opt-in by default');
assert.deepEqual(initial.value.editor.statusline.center, [], 'T036-STATUSLINE-LAYOUT-01-PART2 Helix statusline center default is retained');
assert.deepEqual(initial.value.editor.statusline.right, ['diagnostics', 'selections', 'register', 'position', 'file-encoding'], 'T036-STATUSLINE-LAYOUT-01-PART3 Helix statusline right default is retained');
assert.equal(initial.value.editor.lsp.displaySignatureHelpDocs, true, 'T036-LSP-SIGNATURE-DOCS-01 Helix signature-help documentation default is retained');
assert.equal(initial.value.editor.mouse.enabled, true, 'T036-CONFIG-12 Helix editor.mouse default is retained');
assert.equal(initial.value.editor.lineNumber, 'absolute', 'T036-CONFIG-13 Helix line-number default is retained');
assert.equal(initial.value.editor.lineNumberMinWidth, 3, 'T036-GUTTER-MIN-WIDTH-01 Helix line-number minimum width default is retained');
assert.deepEqual(initial.value.editor.gutters, ['diagnostics', 'spacer', 'line-numbers', 'spacer', 'diff'], 'T036-GUTTERS-01 Helix default gutter layout is retained');
assert.deepEqual(initial.value.editor.indentGuides, { render: false, character: '│', skipLevels: 0 }, 'T036-INDENT-GUIDES-01 Helix indent-guide defaults are retained');
assert.deepEqual(initial.value.editor.whitespace.render, { default: false, space: false, nbsp: false, nnbsp: false, tab: false, newline: false }, 'T036-WHITESPACE-01 Helix whitespace render defaults are retained');
assert.deepEqual(initial.value.editor.whitespace.characters, { space: '·', nbsp: '⍽', nnbsp: '␣', tab: '→', tabpad: ' ', newline: '⏎' }, 'T036-WHITESPACE-CHARACTERS-01 Helix whitespace character defaults are retained');
assert.deepEqual(initial.value.editor.smartTab, { enable: true, supersedeMenu: false }, 'T036-SMART-TAB-01 Helix smart-tab defaults are retained');
assert.deepEqual(initial.value.editor.wordCompletion, { enable: true, triggerLength: 7 }, 'T036-WORD-COMPLETION-DEFAULT-01 Helix word-completion defaults are retained');
assert.deepEqual(initial.value.editor.autoPairs, { '(': ')', '{': '}', '[': ']', '"': '"', "'": "'", '`': '`' }, 'T036-AUTO-PAIRS-DEFAULT-01 Helix standard auto-pairs are retained');
assert.equal(initial.value.editor.editorConfig, true, 'T036-EDITOR-CONFIG-01 Helix editor-config default is retained');
assert.equal(initial.value.editor.statusline.separator, '│', 'T036-STATUSLINE-SEPARATOR-01 Helix statusline separator default is retained');
assert.deepEqual(initial.value.editor.statusline.mode, { normal: 'NOR', insert: 'INS', select: 'SEL' }, 'T036-STATUSLINE-MODES-01 Helix statusline mode labels default is retained');
assert.deepEqual(initial.value.editor.statusline.diagnostics, ['warning', 'error'], 'T036-STATUSLINE-DIAGNOSTICS-01 Helix statusline diagnostic severity default is retained');
assert.deepEqual(initial.value.editor.statusline.workspaceDiagnostics, ['warning', 'error'], 'T036-STATUSLINE-WORKSPACE-DIAGNOSTICS-01 Helix workspace statusline diagnostic severity default is retained');
assert.equal(initial.value.editor.cursorline, false, 'T036-CURSORLINE-01 Helix cursorline default is retained');
assert.equal(initial.value.editor.cursorcolumn, false, 'T036-CURSORCOLUMN-01 Helix cursorcolumn default is retained');
assert.deepEqual(initial.value.editor.rulers, [], 'T036-RULERS-01 Helix rulers default is retained');
assert.equal(initial.value.editor.textWidth, 80, 'T036-TEXT-WIDTH-01 Helix text-width default is retained');
assert.equal(initial.value.editor.atomicSave, true, 'T036-ATOMIC-SAVE-DEFAULT-01 Helix atomic-save defaults to true');
assert.equal(initial.value.editor.indentHeuristic, 'hybrid', 'T036-INDENT-HEURISTIC-DEFAULT-01 Helix indent-heuristic defaults to hybrid');
assert.equal(initial.value.editor.bufferPicker.startPosition, 'current', 'T036-BUFFER-PICKER-DEFAULT-01 Helix buffer-picker start-position defaults to current');
assert.deepEqual(initial.value.editor.workspaceLspRoots, [], 'T036-WORKSPACE-LSP-ROOTS-DEFAULT-01 workspace-lsp-roots defaults to an empty list');
assert.equal(initial.value.editor.wrapAtTextWidth, false, 'T036-WRAP-TEXT-WIDTH-01 Helix wrap-at-text-width default is retained');
assert.equal(initial.value.editor.filePicker.hidden, true, 'T036-FILE-PICKER-HIDDEN-01 Helix file-picker hidden default is retained');
assert.equal(initial.value.editor.filePicker.followSymlinks, true, 'T036-FILE-PICKER-SYMLINKS-01 Helix file-picker follow-symlinks default is retained');
assert.equal(initial.value.editor.filePicker.deduplicateLinks, true, 'T036-FILE-PICKER-DEDUPE-01 Helix file-picker deduplicate-links default is retained');
assert.equal(initial.value.editor.filePicker.parents, true, 'T036-FILE-PICKER-PARENTS-01 Helix file-picker parents default is retained');
assert.equal(initial.value.editor.filePicker.ignore, true, 'T036-FILE-PICKER-IGNORE-01 Helix file-picker ignore default is retained');
assert.equal(initial.value.editor.filePicker.gitIgnore, true, 'T036-FILE-PICKER-GIT-IGNORE-01 Helix file-picker git-ignore default is retained');
assert.equal(initial.value.editor.filePicker.gitGlobal, true, 'T036-FILE-PICKER-GIT-GLOBAL-01 Helix file-picker git-global default is retained');
assert.equal(initial.value.editor.filePicker.gitExclude, true, 'T036-FILE-PICKER-GIT-EXCLUDE-01 Helix file-picker git-exclude default is retained');
assert.equal(initial.value.editor.filePicker.maxDepth, undefined, 'T036-FILE-PICKER-MAX-DEPTH-01 Helix file-picker max-depth is unset by default');
assert.equal(initial.value.editor.wrap, false, 'T036-CONFIG-14 Helix soft-wrap default is retained');
assert.equal(initial.value.editor.softWrapMaxWrap, 20, 'T036-SOFT-WRAP-MAX-01 Helix soft-wrap max-wrap default is retained');
assert.equal(initial.value.editor.softWrapMaxIndentRetain, 40, 'T036-SOFT-WRAP-INDENT-01 Helix soft-wrap max-indent-retain default is retained');
assert.equal(initial.value.editor.wrapIndicator, '↪ ', 'T036-WRAP-INDICATOR-01 Helix soft-wrap wrap-indicator default is retained');
assert.equal(initial.value.editor.inlineDiagnosticsCursorLine, 'warning', 'T036-INLINE-DIAGNOSTICS-FILTER-01 Helix master cursor-line diagnostic filter default is warning');
assert.equal(compileConfig([{ name: 'stable-inline-diagnostics-default', kind: 'user', fileName: 'stable-inline-diagnostics-default.toml', source: '[editor.inline-diagnostics]\ncursor-line = "disable"\n' }]).ok, true, 'T036-INLINE-DIAGNOSTICS-FILTER-MASTER-DEFAULT-01 explicit stable disable remains accepted');
assert.equal(initial.value.editor.inlineDiagnosticsOtherLines, 'disable', 'T036-INLINE-DIAGNOSTICS-FILTER-01-PART2 Helix other-lines diagnostic filter default is retained');
assert.equal(initial.value.editor.endOfLineDiagnostics, 'hint', 'T036-END-OF-LINE-DIAGNOSTICS-01 Helix master end-of-line-diagnostics default is hint');
assert.equal(compileConfig([{ name: 'stable-end-of-line-default', kind: 'user', fileName: 'stable-end-of-line-default.toml', source: '[editor]\nend-of-line-diagnostics = "disable"\n' }]).ok, true, 'T036-END-OF-LINE-DIAGNOSTICS-MASTER-DEFAULT-01 explicit stable disable remains accepted');
assert.equal(initial.value.editor.inlineDiagnosticsPrefixLen, 1, 'T036-INLINE-DIAGNOSTICS-PREFIX-LEN-01 Helix prefix-len default is retained');
assert.equal(initial.value.editor.inlineDiagnosticsMaxWrap, 20, 'T036-INLINE-DIAGNOSTICS-MAX-WRAP-01 Helix max-wrap default is retained');
assert.equal(initial.value.editor.inlineDiagnosticsMinDiagnosticWidth, 40, 'T036-INLINE-DIAGNOSTICS-MIN-WIDTH-01 Helix min-diagnostic-width default is retained');
assert.equal(initial.value.editor.inlineDiagnosticsMaxDiagnostics, 10, 'T036-INLINE-DIAGNOSTICS-MAX-01 Helix max-diagnostics default is retained');
assert.equal(initial.value.editor.autoFormat, true, 'T036-AUTO-FORMAT-01 Helix auto-format default is retained');
assert.deepEqual(initial.value.editor.autoSave, { focusLost: false, afterDelay: { enable: false, timeout: 3000 } }, 'T036-AUTO-SAVE-01 Helix auto-save defaults are retained');
assert.equal(initial.value.editor.defaultYankRegister, '"', 'T036-DEFAULT-YANK-REGISTER-01 Helix default-yank-register default is retained');
assert.equal(initial.value.editor.mouseYankRegister, '*', 'T036-MOUSE-YANK-REGISTER-DEFAULT-01 Helix master mouse-yank-register default is retained');
assert.deepEqual(initial.value.editor.shell, ['sh', '-c'], 'T036-SHELL-DEFAULT-01 Helix editor.shell default is retained');
assert.deepEqual(initial.value.editor.clipboardProvider, { kind: 'builtin', name: 'platform' }, 'T036-CLIPBOARD-BUILTIN-DEFAULT-01 the built-in clipboard provider is the platform default');
assert.equal(initial.value.editor.middleClickPaste, true, 'T036-MIDDLE-CLICK-PASTE-DEFAULT-01 middle-click paste is enabled by default');
const customClipboard = compileConfig([defaults, { name: 'clipboard', kind: 'user', fileName: 'clipboard.toml', source: '[editor.clipboard-provider.custom]\nyank = { command = "cat", args = [] }\npaste = { command = "cat", args = [] }\nprimary-yank = { command = "cat", args = ["--primary"] }\nprimary-paste = { command = "cat", args = ["--primary"] }\n[editor]\nmiddle-click-paste = false\n' }]);
assert.equal(customClipboard.ok, true, 'T036-CLIPBOARD-CUSTOM-SCHEMA-01 custom clipboard commands compile as argv');
if (customClipboard.ok) {
  assert.equal(customClipboard.value.editor.clipboardProvider.kind, 'custom', 'T036-CLIPBOARD-CUSTOM-UNIT-01 custom provider reaches the compiled config');
  assert.equal(customClipboard.value.editor.clipboardProvider.kind === 'custom' ? customClipboard.value.editor.clipboardProvider.primaryPaste?.args[0] : undefined, '--primary', 'T036-CLIPBOARD-PRIMARY-UNIT-01 primary paste retains its argv');
  assert.equal(customClipboard.value.editor.middleClickPaste, false, 'T036-MIDDLE-CLICK-PASTE-SCHEMA-01 middle-click paste can be disabled');
}
const invalidClipboard = compileConfig([defaults, { name: 'invalid-clipboard', kind: 'user', fileName: 'invalid-clipboard.toml', source: '[editor.clipboard-provider.custom]\nyank = { command = "" }\n' }]);
assert.equal(invalidClipboard.ok, false, 'T036-CLIPBOARD-CUSTOM-INVALID-01 custom provider requires non-empty yank and paste commands');
const builtinClipboardNames = ['pasteboard', 'wayland', 'x-clip', 'x-sel', 'tmux', 'termux', 'win32-yank', 'windows', 'termcode', 'none'];
for (const name of builtinClipboardNames) {
  const configuredBuiltin = compileConfig([{ name: `builtin-${name}`, kind: 'user', fileName: `builtin-${name}.toml`, source: `[editor]\nclipboard-provider = "${name}"\n` }]);
  assert.equal(configuredBuiltin.ok, true, `T036-CLIPBOARD-BUILTIN-SCHEMA-01 ${name} is an accepted Helix clipboard provider`);
  if (configuredBuiltin.ok) assert.deepEqual(configuredBuiltin.value.editor.clipboardProvider, { kind: 'builtin', name }, `T036-CLIPBOARD-BUILTIN-UNIT-01 ${name} reaches the compiled provider snapshot`);
}
assert.equal(compileConfig([{ name: 'invalid-builtin-clipboard', kind: 'user', fileName: 'invalid-builtin-clipboard.toml', source: '[editor]\nclipboard-provider = "tty"\n' }]).ok, false, 'T036-CLIPBOARD-BUILTIN-INVALID-01 retired non-Helix clipboard providers remain rejected');
const invalidMiddleClickPaste = compileConfig([{ name: 'invalid-middle-click-paste', kind: 'user', fileName: 'invalid-middle-click-paste.toml', source: '[editor]\\nmiddle-click-paste = "true"\\n' }]);
assert.equal(invalidMiddleClickPaste.ok, false, 'T036-MIDDLE-CLICK-PASTE-INVALID-01 middle-click-paste rejects non-boolean values');
const configuredShell = compileConfig([{ name: 'shell', kind: 'user', fileName: 'shell.toml', source: '[editor]\nshell = ["python3", "-c"]\n' }]);
assert.equal(configuredShell.ok, true, 'T036-SHELL-SCHEMA-01 editor.shell accepts a two-element command array');
if (configuredShell.ok) assert.deepEqual(configuredShell.value.editor.shell, ['python3', '-c'], 'T036-SHELL-UNIT-01 configured editor.shell reaches the compiled snapshot');
assert.equal(compileConfig([{ name: 'invalid-shell', kind: 'user', fileName: 'invalid-shell.toml', source: '[editor]\nshell = []\n' }]).ok, false, 'T036-SHELL-INVALID-01 editor.shell rejects an empty command array');
const shellWithArgs = compileConfig([{ name: 'shell-with-args', kind: 'user', source: '[editor]\nshell = ["bash", "--noprofile", "-c"]\n' }]);
assert.equal(shellWithArgs.ok, true, 'editor.shell accepts additional process arguments');
if (shellWithArgs.ok) assert.deepEqual(shellWithArgs.value.editor.shell, ['bash', '--noprofile', '-c']);
assert.equal(compileConfig([{ name: 'large-scrolloff', kind: 'user', source: '[editor]\nscrolloff = 1001\n' }]).ok, true, 'scrolloff accepts Helix usize values above 1000');
assert.equal(compileConfig([{ name: 'zero-trigger', kind: 'user', source: '[editor]\ncompletion-trigger-len = 0\n' }]).ok, true, 'completion-trigger-len accepts zero like Helix u8');
assert.equal(compileConfig([{ name: 'max-trigger', kind: 'user', source: '[editor]\ncompletion-trigger-len = 255\n' }]).ok, true, 'completion-trigger-len accepts 255');
assert.equal(compileConfig([{ name: 'overflow-trigger', kind: 'user', source: '[editor]\ncompletion-trigger-len = 256\n' }]).ok, false, 'completion-trigger-len rejects 256');
assert.equal(initial.value.editor.insertFinalNewline, true, 'T036-INSERT-FINAL-NEWLINE-01 Helix insert-final-newline default is retained');
assert.equal(initial.value.editor.trimFinalNewlines, false, 'T036-TRIM-FINAL-NEWLINES-01 Helix trim-final-newlines default is retained');
assert.equal(initial.value.editor.trimTrailingWhitespace, false, 'T036-TRIM-TRAILING-WHITESPACE-01 Helix trim-trailing-whitespace default is retained');
assert.equal(initial.value.editor.search.smartCase, true, 'T036-SEARCH-SMART-CASE-01 Helix editor.search.smart-case default is retained');
assert.equal(initial.value.editor.search.wrapAround, true, 'T036-SEARCH-WRAP-AROUND-01 Helix editor.search.wrap-around default is retained');
assert.equal(initial.value.editor.lsp.autoSignatureHelp, true, 'T036-AUTO-SIGNATURE-HELP-01 Helix auto-signature-help default is retained');
assert.equal(initial.value.editor.lsp.displayInlayHints, false, 'T036-LSP-INLAY-HINTS-DEFAULT-01 Helix display-inlay-hints defaults to false');
assert.equal(initial.value.editor.lsp.autoDocumentHighlight, false, 'T036-LSP-DOCUMENT-HIGHLIGHT-DEFAULT-01 Helix auto-document-highlight defaults to false');
assert.equal(initial.value.editor.lsp.gotoReferenceIncludeDeclaration, true, 'T036-LSP-GOTO-REFERENCES-DEFAULT-01 goto-reference-include-declaration defaults to true');
assert.equal(initial.value.editor.lsp.inlayHintsLengthLimit, undefined, 'T036-LSP-INLAY-HINTS-LIMIT-DEFAULT-01 unset inlay-hints-length-limit remains unset');
assert.equal(initial.value.editor.cursorShape.normal, 'block', 'T036-CURSOR-SHAPE-01 normal cursor-shape default is retained');
assert.equal(initial.value.editor.cursorShape.insert, 'block', 'T036-CURSOR-SHAPE-01-PART2 insert cursor-shape default is retained');
assert.equal(initial.value.editor.cursorShape.select, 'block', 'T036-CURSOR-SHAPE-01-PART3 select cursor-shape default is retained');
assert.equal(initial.value.editor.mouse.scrollLines, 3, 'T036-CONFIG-11 Helix scroll-lines default reaches the mouse-compatible runtime field');
assert.equal(initial.value.editor.kittyKeyboardProtocol, 'auto', 'T036-KITTY-KEYBOARD-DEFAULT-01 Helix master kitty-keyboard-protocol defaults to auto');
assert.equal(initial.value.search.debounceMs, 5, 'T036-XI-SEARCH-DEFAULT-01 Xi search uses the fast default debounce');
assert.equal(initial.value.provenance['editor.theme'], 'defaults', 'T036-CONFIG-08 effective values retain layer provenance');
assert.equal(resolveFormatOnSave({}, true, false), false, 'T036-AUTO-FORMAT-05 global auto-format false gates language auto-format');
assert.equal(resolveFormatOnSave({}, true, true), true, 'T036-AUTO-FORMAT-06 global auto-format true preserves language auto-format');
assert.equal(resolveFormatOnSave({ XI_FORMAT_ON_SAVE: '1' }, true, false), true, 'T036-AUTO-FORMAT-07 explicit formatter environment override remains supported');

const configuredScrolloff = compileConfig([defaults, { name: 'scrolloff', kind: 'user', fileName: 'scrolloff.toml', source: '[editor]\nscrolloff = 8\n' }]);
assert.equal(configuredScrolloff.ok, true, 'T036-SCROLLOFF-01 configured Helix scrolloff compiles');
if (configuredScrolloff.ok) assert.equal(configuredScrolloff.value.editor.scrolloff, 8, 'T036-SCROLLOFF-02 configured scrolloff reaches the compiled snapshot');
const disabledAutoPairs = compileConfig([defaults, { name: 'auto-pairs-disabled', kind: 'user', fileName: 'auto-pairs-disabled.toml', source: '[editor]\nauto-pairs = false\n' }]);
assert.equal(disabledAutoPairs.ok, true, 'T036-AUTO-PAIRS-BOOLEAN-01 false auto-pairs compiles');
if (disabledAutoPairs.ok) assert.equal(disabledAutoPairs.value.editor.autoPairs, false, 'T036-AUTO-PAIRS-BOOLEAN-02 false reaches the compiled editor config');
const invalidBooleanAutoPairs = compileConfig([{ name: 'invalid-auto-pairs-boolean', kind: 'user', fileName: 'invalid-auto-pairs-boolean.toml', source: '[editor]\nauto-pairs = "true"\n' }]);
assert.equal(invalidBooleanAutoPairs.ok, false, 'T036-AUTO-PAIRS-BOOLEAN-03 non-boolean auto-pairs shorthand is rejected');
const customAutoPairs = compileConfig([defaults, { name: 'auto-pairs-custom', kind: 'user', fileName: 'auto-pairs-custom.toml', source: '[editor.auto-pairs]\nx = "y"\n' }]);
assert.equal(customAutoPairs.ok, true, 'T036-AUTO-PAIRS-TABLE-01 custom auto-pairs compiles');
if (customAutoPairs.ok) assert.deepEqual(customAutoPairs.value.editor.autoPairs, { x: 'y' }, 'T036-AUTO-PAIRS-TABLE-02 custom table reaches the compiled editor config');
const invalidAutoPairs = compileConfig([{ name: 'invalid-auto-pairs', kind: 'user', fileName: 'invalid-auto-pairs.toml', source: '[editor.auto-pairs]\nx = "yy"\n' }]);
assert.equal(invalidAutoPairs.ok, false, 'T036-AUTO-PAIRS-INVALID-03 multi-character pair values are rejected');
const configuredAutoSave = compileConfig([defaults, { name: 'auto-save', kind: 'user', fileName: 'auto-save.toml', source: '[editor.auto-save]\nfocus-lost = true\nafter-delay.enable = true\nafter-delay.timeout = 120\n' }]);
assert.equal(configuredAutoSave.ok, true, 'T036-AUTO-SAVE-02 configured delayed auto-save compiles');
if (configuredAutoSave.ok) {
  assert.deepEqual(configuredAutoSave.value.editor.autoSave.afterDelay, { enable: true, timeout: 120 }, 'T036-AUTO-SAVE-03 configured delayed auto-save reaches the compiled snapshot');
  assert.equal(configuredAutoSave.value.editor.autoSave.focusLost, true, 'T036-AUTO-SAVE-FOCUS-01 focus-lost reaches the save coordinator');
}
const booleanAutoSave = compileConfig([defaults, { name: 'auto-save-boolean', kind: 'user', fileName: 'auto-save-boolean.toml', source: '[editor]\nauto-save = true\n' }]);
assert.equal(booleanAutoSave.ok, true, 'T036-AUTO-SAVE-04 Helix boolean auto-save shorthand compiles');
if (booleanAutoSave.ok) assert.equal(booleanAutoSave.value.editor.autoSave.focusLost, true, 'T036-AUTO-SAVE-05 boolean auto-save shorthand enables focus-lost saving');
const invalidBooleanAutoSave = compileConfig([{ name: 'invalid-auto-save-boolean', kind: 'user', fileName: 'invalid-auto-save-boolean.toml', source: '[editor]\nauto-save = "true"\n' }]);
assert.equal(invalidBooleanAutoSave.ok, false, 'T036-AUTO-SAVE-BOOLEAN-06 non-boolean auto-save shorthand is rejected');
const invalidFocusLostAutoSave = compileConfig([{ name: 'invalid-auto-save-focus', kind: 'user', fileName: 'invalid-auto-save-focus.toml', source: '[editor.auto-save]\nfocus-lost = "true"\n' }]);
assert.equal(invalidFocusLostAutoSave.ok, false, 'T036-AUTO-SAVE-FOCUS-06 non-boolean focus-lost auto-save is rejected');
const invalidAutoSave = compileConfig([{ name: 'invalid-auto-save', kind: 'user', fileName: 'invalid-auto-save.toml', source: '[editor.auto-save]\nafter-delay.timeout = -1\n' }]);
assert.equal(invalidAutoSave.ok, false, 'T036-AUTO-SAVE-06 negative auto-save timeout is rejected');
const invalidScrolloff = compileConfig([{ name: 'invalid-scrolloff', kind: 'user', fileName: 'invalid-scrolloff.toml', source: '[editor]\nscrolloff = -1\n' }]);
assert.equal(invalidScrolloff.ok, false, 'T036-SCROLLOFF-03 negative scrolloff is rejected');
const configuredContinueComments = compileConfig([defaults, { name: 'continue-comments', kind: 'user', fileName: 'continue-comments.toml', source: '[editor]\ncontinue-comments = false\n' }]);
assert.equal(configuredContinueComments.ok, true, 'T036-CONTINUE-COMMENTS-SCHEMA-01 configured continue-comments compiles');
if (configuredContinueComments.ok) assert.equal(configuredContinueComments.value.editor.continueComments, false, 'T036-CONTINUE-COMMENTS-UNIT-01 configured continue-comments reaches the compiled snapshot');
const invalidContinueComments = compileConfig([{ name: 'invalid-continue-comments', kind: 'user', fileName: 'invalid-continue-comments.toml', source: '[editor]\ncontinue-comments = "false"\n' }]);
assert.equal(invalidContinueComments.ok, false, 'T036-CONTINUE-COMMENTS-INVALID-01 non-boolean continue-comments is rejected');
const idleTimeout = compileConfig([defaults, { name: 'idle-timeout', kind: 'user', fileName: 'idle-timeout.toml', source: '[editor]\nidle-timeout = 40\n' }]);
assert.equal(idleTimeout.ok, true, 'T036-IDLE-TIMEOUT-02 configured idle-timeout compiles');
if (idleTimeout.ok) assert.equal(idleTimeout.value.editor.idleTimeout, 40, 'T036-IDLE-TIMEOUT-03 configured idle-timeout reaches the input router');
const invalidIdleTimeout = compileConfig([{ name: 'invalid-idle-timeout', kind: 'user', fileName: 'invalid-idle-timeout.toml', source: '[editor]\nidle-timeout = -1\n' }]);
assert.equal(invalidIdleTimeout.ok, false, 'T036-IDLE-TIMEOUT-04 negative idle-timeout is rejected');
const rootTheme = compileConfig([defaults, { name: 'root-theme', kind: 'user', fileName: 'root-theme.toml', source: 'theme = "xi-dark"\n' }]);
assert.equal(rootTheme.ok, true, 'T036-THEME-ROOT-01 Helix root theme compiles');
if (rootTheme.ok) {
  assert.equal(rootTheme.value.editor.theme, 'xi-dark', 'T036-THEME-ROOT-02 root theme reaches the existing theme consumer');
  assert.equal(rootTheme.value.provenance['editor.theme'], 'root-theme', 'T036-THEME-ROOT-03 root theme provenance reaches the consumer');
}
const invalidRootTheme = compileConfig([{ name: 'invalid-root-theme', kind: 'user', fileName: 'invalid-root-theme.toml', source: 'theme = true\n' }]);
assert.equal(invalidRootTheme.ok, false, 'T036-THEME-ROOT-04 non-string root theme is rejected');
const rootThemeVariants = compileConfig([defaults, { name: 'root-theme-variants', kind: 'user', fileName: 'root-theme-variants.toml', source: '[theme]\ndark = "xi-dark"\nlight = "xi-light"\nfallback = "xi-dark"\n' }]);
assert.equal(rootThemeVariants.ok, true, 'T036-THEME-VARIANTS-SCHEMA-01 master theme variants compile');
if (rootThemeVariants.ok) {
  assert.deepEqual(rootThemeVariants.value.editor.themeVariants, { dark: 'xi-dark', light: 'xi-light', fallback: 'xi-dark' }, 'T036-THEME-VARIANTS-UNIT-01 theme variants reach the startup theme consumer');
  assert.equal(rootThemeVariants.value.editor.themeVariants.dark, 'xi-dark', 'T036-THEME-DARK-UNIT-01 configured dark theme reaches the startup consumer');
  assert.equal(rootThemeVariants.value.editor.themeVariants.light, 'xi-light', 'T036-THEME-LIGHT-UNIT-01 configured light theme reaches the startup consumer');
  assert.equal(rootThemeVariants.value.editor.themeVariants.fallback, 'xi-dark', 'T036-THEME-FALLBACK-UNIT-01 configured fallback reaches the startup consumer');
}
const invalidRootThemeVariants = compileConfig([{ name: 'invalid-root-theme-variants', kind: 'user', fileName: 'invalid-root-theme-variants.toml', source: '[theme]\ndark = true\n' }]);
assert.equal(invalidRootThemeVariants.ok, false, 'T036-THEME-VARIANTS-INVALID-01 non-string theme variants are rejected');
const cursorline = compileConfig([defaults, { name: 'cursorline', kind: 'user', fileName: 'cursorline.toml', source: '[editor]\ncursorline = true\n' }]);
assert.equal(cursorline.ok, true, 'T036-CURSORLINE-02 editor.cursorline=true compiles');
if (cursorline.ok) assert.equal(cursorline.value.editor.cursorline, true, 'T036-CURSORLINE-03 cursorline reaches the UI runtime');
const invalidCursorline = compileConfig([{ name: 'invalid-cursorline', kind: 'user', fileName: 'invalid-cursorline.toml', source: '[editor]\ncursorline = "true"\n' }]);
assert.equal(invalidCursorline.ok, false, 'T036-CURSORLINE-04 non-boolean cursorline is rejected');
const cursorcolumn = compileConfig([defaults, { name: 'cursorcolumn', kind: 'user', fileName: 'cursorcolumn.toml', source: '[editor]\ncursorcolumn = true\n' }]);
assert.equal(cursorcolumn.ok, true, 'T036-CURSORCOLUMN-02 editor.cursorcolumn=true compiles');
if (cursorcolumn.ok) assert.equal(cursorcolumn.value.editor.cursorcolumn, true, 'T036-CURSORCOLUMN-03 cursorcolumn reaches the UI runtime');
const invalidCursorcolumn = compileConfig([{ name: 'invalid-cursorcolumn', kind: 'user', fileName: 'invalid-cursorcolumn.toml', source: '[editor]\ncursorcolumn = "true"\n' }]);
assert.equal(invalidCursorcolumn.ok, false, 'T036-CURSORCOLUMN-04 non-boolean cursorcolumn is rejected');
const rulers = compileConfig([defaults, { name: 'rulers', kind: 'user', fileName: 'rulers.toml', source: '[editor]\nrulers = [5, 80]\n' }]);
assert.equal(rulers.ok, true, 'T036-RULERS-02 editor.rulers compiles');
if (rulers.ok) assert.deepEqual(rulers.value.editor.rulers, [5, 80], 'T036-RULERS-03 editor.rulers reaches the UI runtime');
const invalidRulers = compileConfig([{ name: 'invalid-rulers', kind: 'user', fileName: 'invalid-rulers.toml', source: '[editor]\nrulers = [0, "80"]\n' }]);
assert.equal(invalidRulers.ok, false, 'T036-RULERS-04 non-positive or non-integer rulers are rejected');
const textWidth = compileConfig([defaults, { name: 'text-width', kind: 'user', fileName: 'text-width.toml', source: '[editor]\ntext-width = 5\n[editor.soft-wrap]\nenable = true\nwrap-at-text-width = true\n' }]);
assert.equal(textWidth.ok, true, 'T036-TEXT-WIDTH-02 editor.text-width and wrap-at-text-width compile');
if (textWidth.ok) { assert.equal(textWidth.value.editor.textWidth, 5, 'T036-TEXT-WIDTH-03 text-width reaches the layout runtime'); assert.equal(textWidth.value.editor.wrapAtTextWidth, true, 'T036-WRAP-TEXT-WIDTH-02 wrap-at-text-width reaches the layout runtime'); }
const invalidTextWidth = compileConfig([{ name: 'invalid-text-width', kind: 'user', fileName: 'invalid-text-width.toml', source: '[editor]\ntext-width = 0\n[editor.soft-wrap]\nwrap-at-text-width = "true"\n' }]);
assert.equal(invalidTextWidth.ok, false, 'T036-TEXT-WIDTH-04 invalid text-width and wrap-at-text-width are rejected');
const nonAtomicSave = compileConfig([defaults, { name: 'atomic-save-disabled', kind: 'user', fileName: 'atomic-save-disabled.toml', source: '[editor]\natomic-save = false\n' }]);
assert.equal(nonAtomicSave.ok, true, 'T036-ATOMIC-SAVE-SCHEMA-01 atomic-save boolean compiles');
if (nonAtomicSave.ok) assert.equal(nonAtomicSave.value.editor.atomicSave, false, 'T036-ATOMIC-SAVE-UNIT-01 atomic-save reaches the compiled persistence policy');
const invalidAtomicSave = compileConfig([{ name: 'invalid-atomic-save', kind: 'user', fileName: 'invalid-atomic-save.toml', source: '[editor]\natomic-save = "false"\n' }]);
assert.equal(invalidAtomicSave.ok, false, 'T036-ATOMIC-SAVE-INVALID-01 non-boolean atomic-save is rejected');
for (const value of ['simple', 'tree-sitter', 'hybrid'] as const) {
  const configuredIndentHeuristic = compileConfig([defaults, { name: `indent-heuristic-${value}`, kind: 'user', fileName: `indent-heuristic-${value}.toml`, source: `[editor]\nindent-heuristic = "${value}"\n` }]);
  assert.equal(configuredIndentHeuristic.ok, true, `T036-INDENT-HEURISTIC-SCHEMA-01 ${value} indent-heuristic compiles`);
  if (configuredIndentHeuristic.ok) assert.equal(configuredIndentHeuristic.value.editor.indentHeuristic, value, `T036-INDENT-HEURISTIC-UNIT-01 ${value} indent-heuristic reaches the compiled runtime`);
}
const invalidIndentHeuristic = compileConfig([{ name: 'invalid-indent-heuristic', kind: 'user', fileName: 'invalid-indent-heuristic.toml', source: '[editor]\nindent-heuristic = "bogus"\n' }]);
assert.equal(invalidIndentHeuristic.ok, false, 'T036-INDENT-HEURISTIC-INVALID-01 unsupported indent-heuristic is rejected');
const previousBufferPicker = compileConfig([defaults, { name: 'buffer-picker-previous', kind: 'user', fileName: 'buffer-picker-previous.toml', source: '[editor.buffer-picker]\nstart-position = "previous"\n' }]);
assert.equal(previousBufferPicker.ok, true, 'T036-BUFFER-PICKER-SCHEMA-01 buffer-picker previous start-position compiles');
if (previousBufferPicker.ok) assert.equal(previousBufferPicker.value.editor.bufferPicker.startPosition, 'previous', 'T036-BUFFER-PICKER-UNIT-01 buffer-picker start-position reaches the compiled picker runtime');
const invalidBufferPicker = compileConfig([{ name: 'invalid-buffer-picker', kind: 'user', fileName: 'invalid-buffer-picker.toml', source: '[editor.buffer-picker]\nstart-position = "last"\n' }]);
assert.equal(invalidBufferPicker.ok, false, 'T036-BUFFER-PICKER-INVALID-01 unsupported buffer-picker start-position is rejected');
const configuredFileExplorer = compileConfig([defaults, { name: 'file-explorer-hidden', kind: 'user', fileName: 'file-explorer-hidden.toml', source: '[editor.file-explorer]\nhidden = true\nfollow-symlinks = true\nparents = true\nignore = true\ngit-ignore = true\ngit-global = true\ngit-exclude = true\nflatten-dirs = false\n' }]);
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-HIDDEN-SCHEMA-01 file-explorer.hidden compiles');
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-SYMLINKS-SCHEMA-01 file-explorer.follow-symlinks compiles');
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-PARENTS-SCHEMA-01 file-explorer.parents compiles');
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-IGNORE-SCHEMA-01 file-explorer.ignore compiles');
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-GIT-IGNORE-SCHEMA-01 file-explorer.git-ignore compiles');
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-GIT-GLOBAL-SCHEMA-01 file-explorer.git-global compiles');
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-GIT-EXCLUDE-SCHEMA-01 file-explorer.git-exclude compiles');
assert.equal(configuredFileExplorer.ok, true, 'T036-FILE-EXPLORER-FLATTEN-DIRS-SCHEMA-01 file-explorer.flatten-dirs compiles');
if (configuredFileExplorer.ok) assert.equal(configuredFileExplorer.value.editor.fileExplorer.hidden, true, 'T036-FILE-EXPLORER-HIDDEN-UNIT-01 file-explorer.hidden reaches the compiled Explorer policy');
if (configuredFileExplorer.ok) assert.equal(configuredFileExplorer.value.editor.fileExplorer.followSymlinks, true, 'T036-FILE-EXPLORER-SYMLINKS-UNIT-02 file-explorer.follow-symlinks reaches the compiled Explorer policy');
if (configuredFileExplorer.ok) {
  assert.equal(configuredFileExplorer.value.editor.fileExplorer.parents, true, 'T036-FILE-EXPLORER-PARENTS-UNIT-01 file-explorer.parents reaches the compiled Explorer policy');
  assert.equal(configuredFileExplorer.value.editor.fileExplorer.ignore, true, 'T036-FILE-EXPLORER-IGNORE-UNIT-01 file-explorer.ignore reaches the compiled Explorer policy');
  assert.equal(configuredFileExplorer.value.editor.fileExplorer.gitIgnore, true, 'T036-FILE-EXPLORER-GIT-IGNORE-UNIT-01 file-explorer.git-ignore reaches the compiled Explorer policy');
  assert.equal(configuredFileExplorer.value.editor.fileExplorer.gitGlobal, true, 'T036-FILE-EXPLORER-GIT-GLOBAL-UNIT-01 file-explorer.git-global reaches the compiled Explorer policy');
  assert.equal(configuredFileExplorer.value.editor.fileExplorer.gitExclude, true, 'T036-FILE-EXPLORER-GIT-EXCLUDE-UNIT-01 file-explorer.git-exclude reaches the compiled Explorer policy');
  assert.equal(configuredFileExplorer.value.editor.fileExplorer.flattenDirs, false, 'T036-FILE-EXPLORER-FLATTEN-DIRS-UNIT-01 file-explorer.flatten-dirs reaches the compiled Explorer policy');
}
const invalidFileExplorer = compileConfig([{ name: 'invalid-file-explorer', kind: 'user', fileName: 'invalid-file-explorer.toml', source: '[editor.file-explorer]\nhidden = "true"\n' }]);
assert.equal(invalidFileExplorer.ok, false, 'T036-FILE-EXPLORER-HIDDEN-INVALID-01 non-boolean file-explorer.hidden is rejected');
const invalidFileExplorerSymlinks = compileConfig([{ name: 'invalid-file-explorer-symlinks', kind: 'user', fileName: 'invalid-file-explorer-symlinks.toml', source: '[editor.file-explorer]\nfollow-symlinks = "true"\n' }]);
assert.equal(invalidFileExplorerSymlinks.ok, false, 'T036-FILE-EXPLORER-SYMLINKS-INVALID-01 non-boolean file-explorer.follow-symlinks is rejected');
const invalidFileExplorerIgnore = compileConfig([{ name: 'invalid-file-explorer-ignore', kind: 'user', fileName: 'invalid-file-explorer-ignore.toml', source: '[editor.file-explorer]\nignore = "true"\n' }]);
assert.equal(invalidFileExplorerIgnore.ok, false, 'T036-FILE-EXPLORER-IGNORE-INVALID-01 non-boolean file-explorer.ignore is rejected');
assert.equal(invalidFileExplorerIgnore.ok, false, 'T036-FILE-EXPLORER-PARENTS-INVALID-01 invalid file-explorer ignore-source values are rejected');
assert.equal(invalidFileExplorerIgnore.ok, false, 'T036-FILE-EXPLORER-GIT-IGNORE-INVALID-01 invalid file-explorer ignore-source values are rejected');
assert.equal(invalidFileExplorerIgnore.ok, false, 'T036-FILE-EXPLORER-GIT-GLOBAL-INVALID-01 invalid file-explorer ignore-source values are rejected');
assert.equal(invalidFileExplorerIgnore.ok, false, 'T036-FILE-EXPLORER-GIT-EXCLUDE-INVALID-01 invalid file-explorer ignore-source values are rejected');
const invalidFileExplorerFlattenDirs = compileConfig([{ name: 'invalid-file-explorer-flatten-dirs', kind: 'user', fileName: 'invalid-file-explorer-flatten-dirs.toml', source: '[editor.file-explorer]\nflatten-dirs = "false"\n' }]);
assert.equal(invalidFileExplorerFlattenDirs.ok, false, 'T036-FILE-EXPLORER-FLATTEN-DIRS-INVALID-01 non-boolean file-explorer.flatten-dirs is rejected');
const workspaceLspRoots = compileConfig([defaults, { name: 'workspace-lsp-roots', kind: 'workspace', fileName: '.helix/config.toml', source: '[editor]\nworkspace-lsp-roots = ["client", "server/api"]\n' }]);
assert.equal(workspaceLspRoots.ok, true, 'T036-WORKSPACE-LSP-ROOTS-SCHEMA-01 relative workspace LSP roots compile');
if (workspaceLspRoots.ok) assert.deepEqual(workspaceLspRoots.value.editor.workspaceLspRoots, ['client', 'server/api'], 'T036-WORKSPACE-LSP-ROOTS-UNIT-01 configured workspace LSP roots reach the compiled config');
const invalidWorkspaceLspRoots = compileConfig([{ name: 'invalid-workspace-lsp-roots', kind: 'workspace', fileName: '.helix/config.toml', source: '[editor]\nworkspace-lsp-roots = ["/tmp", "../outside"]\n' }]);
assert.equal(invalidWorkspaceLspRoots.ok, false, 'T036-WORKSPACE-LSP-ROOTS-INVALID-01 absolute and parent-traversing roots are rejected');
const configuredEditorSearch = compileConfig([defaults, { name: 'editor-search', kind: 'user', fileName: 'editor-search.toml', source: '[editor.search]\nsmart-case = false\nwrap-around = false\n' }]);
assert.equal(configuredEditorSearch.ok, true, 'T036-SEARCH-02 editor.search options compile');
if (configuredEditorSearch.ok) {
  assert.equal(configuredEditorSearch.value.editor.search.smartCase, false, 'T036-SEARCH-03 smart-case reaches the search runtime');
  assert.equal(configuredEditorSearch.value.editor.search.wrapAround, false, 'T036-SEARCH-04 wrap-around reaches the search runtime');
}
const invalidEditorSearch = compileConfig([{ name: 'invalid-editor-search', kind: 'user', fileName: 'invalid-editor-search.toml', source: '[editor.search]\nsmart-case = "true"\n' }]);
assert.equal(invalidEditorSearch.ok, false, 'T036-SEARCH-05 non-boolean editor.search values are rejected');
const statuslineWorkingDirectory = compileConfig([defaults, { name: 'statusline-working-directory', kind: 'user', fileName: 'statusline-working-directory.toml', source: '[editor.statusline]\nleft = ["current-working-directory"]\n' }]);
assert.equal(statuslineWorkingDirectory.ok, true, 'T036-STATUSLINE-CWD-01 current-working-directory is an accepted Helix statusline element');
if (statuslineWorkingDirectory.ok) assert.deepEqual(statuslineWorkingDirectory.value.editor.statusline.left, ['current-working-directory'], 'T036-STATUSLINE-CWD-02 current-working-directory reaches the compiled statusline layout');
const invalidStatuslineWorkingDirectory = compileConfig([{ name: 'invalid-statusline-working-directory', kind: 'user', fileName: 'invalid-statusline-working-directory.toml', source: '[editor.statusline]\nleft = ["current-working-directory", "not-an-element"]\n' }]);
assert.equal(invalidStatuslineWorkingDirectory.ok, false, 'T036-STATUSLINE-CWD-03 unsupported statusline elements remain rejected');
const defaultLineEnding = compileConfig([defaults, { name: 'default-line-ending', kind: 'user', fileName: 'default-line-ending.toml', source: '[editor]\ndefault-line-ending = "nel"\n' }]);
assert.equal(defaultLineEnding.ok, true, 'T036-DEFAULT-LINE-ENDING-02 configured default-line-ending compiles');
if (defaultLineEnding.ok) assert.equal(defaultLineEnding.value.editor.defaultLineEnding, 'nel', 'T036-DEFAULT-LINE-ENDING-03 configured default-line-ending reaches the document factory');
const invalidDefaultLineEnding = compileConfig([{ name: 'invalid-default-line-ending', kind: 'user', fileName: 'invalid-default-line-ending.toml', source: '[editor]\ndefault-line-ending = "bogus"\n' }]);
assert.equal(invalidDefaultLineEnding.ok, false, 'T036-DEFAULT-LINE-ENDING-04 unsupported default-line-ending is rejected');
const popupBorder = compileConfig([defaults, { name: 'popup-border', kind: 'user', fileName: 'popup-border.toml', source: '[editor]\npopup-border = "menu"\n' }]);
assert.equal(popupBorder.ok, true, 'T036-POPUP-BORDER-02 configured popup-border compiles');
if (popupBorder.ok) assert.equal(popupBorder.value.editor.popupBorder, 'menu', 'T036-POPUP-BORDER-03 configured popup-border reaches the UI runtime');
const invalidPopupBorder = compileConfig([{ name: 'invalid-popup-border', kind: 'user', fileName: 'invalid-popup-border.toml', source: '[editor]\npopup-border = "dialog"\n' }]);
assert.equal(invalidPopupBorder.ok, false, 'T036-POPUP-BORDER-04 unsupported popup-border is rejected');
const insertFinalNewline = compileConfig([defaults, { name: 'insert-final-newline', kind: 'user', fileName: 'insert-final-newline.toml', source: '[editor]\ninsert-final-newline = false\n' }]);
assert.equal(insertFinalNewline.ok, true, 'T036-INSERT-FINAL-NEWLINE-02 editor.insert-final-newline=false compiles');
if (insertFinalNewline.ok) assert.equal(insertFinalNewline.value.editor.insertFinalNewline, false, 'T036-INSERT-FINAL-NEWLINE-03 insert-final-newline reaches the save runtime');
const invalidInsertFinalNewline = compileConfig([{ name: 'invalid-insert-final-newline', kind: 'user', fileName: 'invalid-insert-final-newline.toml', source: '[editor]\ninsert-final-newline = "false"\n' }]);
assert.equal(invalidInsertFinalNewline.ok, false, 'T036-INSERT-FINAL-NEWLINE-04 non-boolean insert-final-newline is rejected');
const saveTrims = compileConfig([defaults, { name: 'save-trims', kind: 'user', fileName: 'save-trims.toml', source: '[editor]\ntrim-final-newlines = true\ntrim-trailing-whitespace = true\n' }]);
assert.equal(saveTrims.ok, true, 'T036-SAVE-TRIMS-02 save trimming options compile');
if (saveTrims.ok) {
  assert.equal(saveTrims.value.editor.trimFinalNewlines, true, 'T036-SAVE-TRIMS-03 trim-final-newlines reaches the save runtime');
  assert.equal(saveTrims.value.editor.trimTrailingWhitespace, true, 'T036-SAVE-TRIMS-04 trim-trailing-whitespace reaches the save runtime');
}
const invalidSaveTrims = compileConfig([{ name: 'invalid-save-trims', kind: 'user', fileName: 'invalid-save-trims.toml', source: '[editor]\ntrim-final-newlines = "true"\ntrim-trailing-whitespace = 1\n' }]);
assert.equal(invalidSaveTrims.ok, false, 'T036-SAVE-TRIMS-05 non-boolean save trimming options are rejected');
const filePickerHidden = compileConfig([defaults, { name: 'file-picker-hidden', kind: 'user', fileName: 'file-picker-hidden.toml', source: '[editor.file-picker]\nhidden = false\n' }]);
assert.equal(filePickerHidden.ok, true, 'T036-FILE-PICKER-HIDDEN-02 editor.file-picker.hidden=false compiles');
if (filePickerHidden.ok) assert.equal(filePickerHidden.value.editor.filePicker.hidden, false, 'T036-FILE-PICKER-HIDDEN-03 file-picker hidden reaches the picker runtime');
const invalidFilePickerHidden = compileConfig([{ name: 'invalid-file-picker-hidden', kind: 'user', fileName: 'invalid-file-picker-hidden.toml', source: '[editor.file-picker]\nhidden = "false"\n' }]);
assert.equal(invalidFilePickerHidden.ok, false, 'T036-FILE-PICKER-HIDDEN-04 non-boolean file-picker hidden is rejected');
const filePickerSymlinks = compileConfig([defaults, { name: 'file-picker-symlinks', kind: 'user', fileName: 'file-picker-symlinks.toml', source: '[editor.file-picker]\nfollow-symlinks = false\n' }]);
assert.equal(filePickerSymlinks.ok, true, 'T036-FILE-PICKER-SYMLINKS-02 editor.file-picker.follow-symlinks=false compiles');
if (filePickerSymlinks.ok) assert.equal(filePickerSymlinks.value.editor.filePicker.followSymlinks, false, 'T036-FILE-PICKER-SYMLINKS-03 follow-symlinks reaches the filesystem runtime');
const invalidFilePickerSymlinks = compileConfig([{ name: 'invalid-file-picker-symlinks', kind: 'user', fileName: 'invalid-file-picker-symlinks.toml', source: '[editor.file-picker]\nfollow-symlinks = "false"\n' }]);
assert.equal(invalidFilePickerSymlinks.ok, false, 'T036-FILE-PICKER-SYMLINKS-04 non-boolean follow-symlinks is rejected');
const filePickerDedupe = compileConfig([defaults, { name: 'file-picker-dedupe', kind: 'user', fileName: 'file-picker-dedupe.toml', source: '[editor.file-picker]\ndeduplicate-links = false\n' }]);
assert.equal(filePickerDedupe.ok, true, 'T036-FILE-PICKER-DEDUPE-02 editor.file-picker.deduplicate-links=false compiles');
if (filePickerDedupe.ok) assert.equal(filePickerDedupe.value.editor.filePicker.deduplicateLinks, false, 'T036-FILE-PICKER-DEDUPE-03 deduplicate-links reaches the filesystem runtime');
const invalidFilePickerDedupe = compileConfig([{ name: 'invalid-file-picker-dedupe', kind: 'user', fileName: 'invalid-file-picker-dedupe.toml', source: '[editor.file-picker]\ndeduplicate-links = "false"\n' }]);
assert.equal(invalidFilePickerDedupe.ok, false, 'T036-FILE-PICKER-DEDUPE-04 non-boolean deduplicate-links is rejected');
const filePickerIgnoreSources = compileConfig([defaults, { name: 'file-picker-ignore-sources', kind: 'user', fileName: 'file-picker-ignore-sources.toml', source: '[editor.file-picker]\nparents = false\nignore = false\ngit-ignore = false\ngit-global = false\ngit-exclude = false\n' }]);
assert.equal(filePickerIgnoreSources.ok, true, 'T036-FILE-PICKER-IGNORE-SOURCES-02 file-picker ignore source switches compile');
if (filePickerIgnoreSources.ok) assert.deepEqual(filePickerIgnoreSources.value.editor.filePicker, { hidden: true, followSymlinks: true, deduplicateLinks: true, parents: false, ignore: false, gitIgnore: false, gitGlobal: false, gitExclude: false, maxDepth: undefined }, 'T036-FILE-PICKER-IGNORE-SOURCES-03 ignore source switches reach the filesystem runtime');
const invalidFilePickerIgnore = compileConfig([{ name: 'invalid-file-picker-ignore', kind: 'user', fileName: 'invalid-file-picker-ignore.toml', source: '[editor.file-picker]\nignore = "false"\n' }]);
assert.equal(invalidFilePickerIgnore.ok, false, 'T036-FILE-PICKER-IGNORE-SOURCES-04 non-boolean ignore source is rejected');
const filePickerMaxDepth = compileConfig([defaults, { name: 'file-picker-max-depth', kind: 'user', fileName: 'file-picker-max-depth.toml', source: '[editor.file-picker]\nmax-depth = 1\n' }]);
assert.equal(filePickerMaxDepth.ok, true, 'T036-FILE-PICKER-MAX-DEPTH-02 editor.file-picker.max-depth compiles');
if (filePickerMaxDepth.ok) assert.equal(filePickerMaxDepth.value.editor.filePicker.maxDepth, 1, 'T036-FILE-PICKER-MAX-DEPTH-03 max-depth reaches the filesystem runtime');
const invalidFilePickerMaxDepth = compileConfig([{ name: 'invalid-file-picker-max-depth', kind: 'user', fileName: 'invalid-file-picker-max-depth.toml', source: '[editor.file-picker]\nmax-depth = -1\n' }]);
assert.equal(invalidFilePickerMaxDepth.ok, false, 'T036-FILE-PICKER-MAX-DEPTH-04 negative max-depth is rejected');
const disabledMouse = compileConfig([defaults, { name: 'mouse-disabled', kind: 'user', fileName: 'mouse-disabled.toml', source: '[editor]\nmouse = false\n' }]);
assert.equal(disabledMouse.ok, true, 'T036-MOUSE-01 canonical editor.mouse=false compiles');
if (disabledMouse.ok) assert.equal(disabledMouse.value.editor.mouse.enabled, false, 'T036-MOUSE-02 editor.mouse=false reaches the runtime consumer');
const invalidMouse = compileConfig([{ name: 'invalid-mouse', kind: 'user', fileName: 'invalid-mouse.toml', source: '[editor]\nmouse = "false"\n' }]);
assert.equal(invalidMouse.ok, false, 'T036-MOUSE-03 non-boolean editor.mouse is rejected');
const relativeLineNumber = compileConfig([defaults, { name: 'relative-line-number', kind: 'user', fileName: 'relative-line-number.toml', source: '[editor]\nline-number = "relative"\n' }]);
assert.equal(relativeLineNumber.ok, true, 'T036-LINE-NUMBER-01 Helix relative line-number compiles');
if (relativeLineNumber.ok) assert.equal(relativeLineNumber.value.editor.lineNumber, 'relative', 'T036-LINE-NUMBER-02 relative line-number reaches the compiled snapshot');
const invalidLineNumber = compileConfig([{ name: 'invalid-line-number', kind: 'user', fileName: 'invalid-line-number.toml', source: '[editor]\nline-number = "none"\n' }]);
assert.equal(invalidLineNumber.ok, false, 'T036-LINE-NUMBER-03 unsupported line-number value is rejected');
const gutterMinWidth = compileConfig([defaults, { name: 'gutter-min-width', kind: 'user', fileName: 'gutter-min-width.toml', source: '[editor.gutters.line-numbers]\nmin-width = 5\n' }]);
assert.equal(gutterMinWidth.ok, true, 'T036-GUTTER-MIN-WIDTH-02 configured line-number minimum width compiles');
if (gutterMinWidth.ok) assert.equal(gutterMinWidth.value.editor.lineNumberMinWidth, 5, 'T036-GUTTER-MIN-WIDTH-03 line-number minimum width reaches the UI runtime');
const invalidGutterMinWidth = compileConfig([{ name: 'invalid-gutter-min-width', kind: 'user', fileName: 'invalid-gutter-min-width.toml', source: '[editor.gutters.line-numbers]\nmin-width = 0\n' }]);
assert.equal(invalidGutterMinWidth.ok, false, 'T036-GUTTER-MIN-WIDTH-04 zero line-number minimum width is rejected');
const gutterArray = compileConfig([defaults, { name: 'gutter-array', kind: 'user', fileName: 'gutter-array.toml', source: '[editor]\ngutters = ["line-numbers"]\n' }]);
assert.equal(gutterArray.ok, true, 'T036-GUTTERS-02 scalar editor.gutters array compiles');
if (gutterArray.ok) assert.deepEqual(gutterArray.value.editor.gutters, ['line-numbers'], 'T036-GUTTERS-03 scalar editor.gutters reaches the UI runtime');
const gutterLayout = compileConfig([defaults, { name: 'gutter-layout', kind: 'user', fileName: 'gutter-layout.toml', source: '[editor.gutters]\nlayout = ["diff", "diagnostics", "line-numbers"]\n' }]);
assert.equal(gutterLayout.ok, true, 'T036-GUTTERS-LAYOUT-02 table editor.gutters.layout compiles');
if (gutterLayout.ok) assert.deepEqual(gutterLayout.value.editor.gutters, ['diff', 'diagnostics', 'line-numbers'], 'T036-GUTTERS-LAYOUT-03 editor.gutters.layout reaches the UI runtime');
const codeActionHintGutter = compileConfig([defaults, { name: 'code-action-hint-gutter', kind: 'user', fileName: 'code-action-hint-gutter.toml', source: '[editor]\ngutters = ["code-action-hint"]\n' }]);
assert.equal(codeActionHintGutter.ok, true, 'T036-CODE-ACTION-HINT-GUTTER-SCHEMA-01 code-action-hint is an accepted gutter');
if (codeActionHintGutter.ok) assert.deepEqual(codeActionHintGutter.value.editor.gutters, ['code-action-hint'], 'T036-CODE-ACTION-HINT-GUTTER-RUNTIME-01 gutter code-action-hint reaches the runtime');
const invalidCodeActionHintGutter = compileConfig([{ name: 'invalid-code-action-hint-gutter', kind: 'user', fileName: 'invalid-code-action-hint-gutter.toml', source: '[editor]\ngutters = ["code-action-hint", "unknown"]\n' }]);
assert.equal(invalidCodeActionHintGutter.ok, false, 'T036-CODE-ACTION-HINT-GUTTER-INVALID-01 unsupported gutter values remain rejected');
const invalidGutters = compileConfig([{ name: 'invalid-gutters', kind: 'user', fileName: 'invalid-gutters.toml', source: '[editor]\ngutters = ["line-numbers", "unknown"]\n' }]);
assert.equal(invalidGutters.ok, false, 'T036-GUTTERS-04 unsupported gutter names are rejected');
for (const section of ['diagnostics', 'diff', 'spacer', 'code-action-hint']) {
  const emptySection = compileConfig([{ name: 'empty-gutter-section', kind: 'user', fileName: 'empty-gutter-section.toml', source: `[editor.gutters.${section}]\n` }]);
  assert.equal(emptySection.ok, false, `T036-GUTTERS-EMPTY-02 pinned Helix rejects the documented empty ${section} section`);
}
const invalidGutterSection = compileConfig([{ name: 'invalid-gutter-section', kind: 'user', fileName: 'invalid-gutter-section.toml', source: '[editor.gutters.diagnostics]\nmarker = true\n' }]);
assert.equal(invalidGutterSection.ok, false, 'T036-GUTTERS-EMPTY-04 gutter section children remain rejected as unknown settings');
const indentGuides = compileConfig([defaults, { name: 'indent-guides', kind: 'user', fileName: 'indent-guides.toml', source: '[editor.indent-guides]\nrender = true\ncharacter = "|"\nskip-levels = 1\n' }]);
assert.equal(indentGuides.ok, true, 'T036-INDENT-GUIDES-02 configured indent guides compile');
if (indentGuides.ok) assert.deepEqual(indentGuides.value.editor.indentGuides, { render: true, character: '|', skipLevels: 1 }, 'T036-INDENT-GUIDES-03 configured indent guides reach the UI runtime');
const invalidIndentGuides = compileConfig([{ name: 'invalid-indent-guides', kind: 'user', fileName: 'invalid-indent-guides.toml', source: '[editor.indent-guides]\nrender = "true"\ncharacter = "||"\nskip-levels = -1\n' }]);
assert.equal(invalidIndentGuides.ok, false, 'T036-INDENT-GUIDES-04 invalid indent-guide values are rejected');
const whitespace = compileConfig([defaults, { name: 'whitespace', kind: 'user', fileName: 'whitespace.toml', source: '[editor.whitespace]\nrender = "all"\n[editor.whitespace.characters]\nspace = "·"\ntab = "→"\ntabpad = "·"\n' }]);
assert.equal(whitespace.ok, true, 'T036-WHITESPACE-02 configured whitespace rendering compiles');
if (whitespace.ok) {
  assert.deepEqual(whitespace.value.editor.whitespace.render, { default: true, space: true, nbsp: true, nnbsp: true, tab: true, newline: true }, 'T036-WHITESPACE-03 render=all reaches the UI runtime');
  assert.equal(whitespace.value.editor.whitespace.characters.tabpad, '·', 'T036-WHITESPACE-04 configured tab padding reaches the UI runtime');
}
const whitespaceTable = compileConfig([defaults, { name: 'whitespace-table', kind: 'user', fileName: 'whitespace-table.toml', source: '[editor.whitespace.render]\nspace = "all"\ntab = "all"\n' }]);
assert.equal(whitespaceTable.ok, true, 'T036-WHITESPACE-05 per-kind whitespace rendering compiles');
if (whitespaceTable.ok) assert.deepEqual(whitespaceTable.value.editor.whitespace.render, { default: false, space: true, nbsp: false, nnbsp: false, tab: true, newline: false }, 'T036-WHITESPACE-06 per-kind render values reach the UI runtime');
const invalidWhitespace = compileConfig([{ name: 'invalid-whitespace', kind: 'user', fileName: 'invalid-whitespace.toml', source: '[editor.whitespace]\nrender = "visible"\n[editor.whitespace.characters]\nspace = ".."\n' }]);
assert.equal(invalidWhitespace.ok, false, 'T036-WHITESPACE-07 invalid render and character values are rejected');
const smartTab = compileConfig([defaults, { name: 'smart-tab', kind: 'user', fileName: 'smart-tab.toml', source: '[editor.smart-tab]\nenable = false\nsupersede-menu = true\n' }]);
assert.equal(smartTab.ok, true, 'T036-SMART-TAB-02 configured smart-tab compiles');
if (smartTab.ok) assert.deepEqual(smartTab.value.editor.smartTab, { enable: false, supersedeMenu: true }, 'T036-SMART-TAB-03 configured smart-tab reaches the compiled runtime');
const invalidSmartTab = compileConfig([{ name: 'invalid-smart-tab', kind: 'user', fileName: 'invalid-smart-tab.toml', source: '[editor.smart-tab]\nenable = "false"\n' }]);
assert.equal(invalidSmartTab.ok, false, 'T036-SMART-TAB-04 invalid smart-tab values are rejected');
const editorConfig = compileConfig([defaults, { name: 'editor-config', kind: 'user', fileName: 'editor-config.toml', source: '[editor]\neditor-config = false\n' }]);
assert.equal(editorConfig.ok, true, 'T036-EDITOR-CONFIG-02 configured editor-config compiles');
if (editorConfig.ok) assert.equal(editorConfig.value.editor.editorConfig, false, 'T036-EDITOR-CONFIG-03 configured editor-config reaches the startup loader');
const invalidEditorConfig = compileConfig([{ name: 'invalid-editor-config', kind: 'user', fileName: 'invalid-editor-config.toml', source: '[editor]\neditor-config = "false"\n' }]);
assert.equal(invalidEditorConfig.ok, false, 'T036-EDITOR-CONFIG-04 invalid editor-config values are rejected');
const statusline = compileConfig([defaults, { name: 'statusline', kind: 'user', fileName: 'statusline.toml', source: '[editor.statusline]\nleft = ["mode", "file-base-name"]\ncenter = ["position"]\nright = ["file-line-ending"]\nseparator = "~"\nmode.normal = "NORMX"\nmode.insert = "INSX"\nmode.select = "SELX"\n' }]);
assert.equal(statusline.ok, true, 'T036-STATUSLINE-02 configured statusline labels compile');
if (statusline.ok) {
  assert.equal(statusline.value.editor.statusline.separator, '~', 'T036-STATUSLINE-SEPARATOR-02 configured separator reaches the UI runtime');
  assert.deepEqual(statusline.value.editor.statusline.left, ['mode', 'file-base-name'], 'T036-STATUSLINE-LAYOUT-02 configured left elements reach the UI runtime');
  assert.deepEqual(statusline.value.editor.statusline.center, ['position'], 'T036-STATUSLINE-LAYOUT-02-PART2 configured center elements reach the UI runtime');
  assert.deepEqual(statusline.value.editor.statusline.right, ['file-line-ending'], 'T036-STATUSLINE-LAYOUT-02-PART3 configured right elements reach the UI runtime');
  assert.deepEqual(statusline.value.editor.statusline.mode, { normal: 'NORMX', insert: 'INSX', select: 'SELX' }, 'T036-STATUSLINE-MODES-02 configured mode labels reach the UI runtime');
}
const statuslineCatalog = compileConfig([defaults, { name: 'statusline-catalog', kind: 'user', fileName: 'statusline-catalog.toml', source: '[editor.statusline]\nleft = ["mode", "spinner", "file-name", "file-absolute-path", "file-base-name", "file-modification-indicator", "read-only-indicator", "file-encoding", "file-line-ending", "file-indent-style", "file-type", "diagnostics", "workspace-diagnostics", "selections", "primary-selection-length", "position", "position-percentage", "separator", "spacer", "version-control", "register", "total-line-numbers", "code-action-hint"]\n' }]);
assert.equal(statuslineCatalog.ok, true, 'T036-STATUSLINE-ELEMENTS-01 every stable Helix statusline element compiles');
if (statuslineCatalog.ok) assert.equal(statuslineCatalog.value.editor.statusline.left.length, 23, 'T036-STATUSLINE-ELEMENTS-02 the compiled catalog retains every stable element');
const codeActionHintStatusline = compileConfig([defaults, { name: 'code-action-hint-statusline', kind: 'user', fileName: 'code-action-hint-statusline.toml', source: '[editor.statusline]\nleft = ["code-action-hint"]\n' }]);
assert.equal(codeActionHintStatusline.ok, true, 'T036-CODE-ACTION-HINT-STATUSLINE-SCHEMA-01 code-action-hint is an accepted statusline element');
if (codeActionHintStatusline.ok) assert.deepEqual(codeActionHintStatusline.value.editor.statusline.left, ['code-action-hint'], 'T036-CODE-ACTION-HINT-STATUSLINE-RUNTIME-01 statusline code-action-hint reaches the runtime');
const invalidCodeActionHintStatusline = compileConfig([{ name: 'invalid-code-action-hint-statusline', kind: 'user', fileName: 'invalid-code-action-hint-statusline.toml', source: '[editor.statusline]\nleft = ["code-action-hint", "not-an-element"]\n' }]);
assert.equal(invalidCodeActionHintStatusline.ok, false, 'T036-CODE-ACTION-HINT-STATUSLINE-INVALID-01 unsupported statusline values remain rejected');
const colorModes = compileConfig([defaults, { name: 'color-modes', kind: 'user', fileName: 'color-modes.toml', source: '[editor]\ncolor-modes = true\n' }]);
assert.equal(colorModes.ok, true, 'T036-COLOR-MODES-02 configured color-modes compiles');
if (colorModes.ok) assert.equal(colorModes.value.editor.colorModes, true, 'T036-COLOR-MODES-03 configured color-modes reaches the UI runtime');
const invalidColorModes = compileConfig([{ name: 'invalid-color-modes', kind: 'user', fileName: 'invalid-color-modes.toml', source: '[editor]\ncolor-modes = "true"\n' }]);
assert.equal(invalidColorModes.ok, false, 'T036-COLOR-MODES-04 non-boolean color-modes is rejected');
const rainbowBrackets = compileConfig([defaults, { name: 'rainbow-brackets', kind: 'user', fileName: 'rainbow-brackets.toml', source: '[editor]\nrainbow-brackets = true\n' }]);
assert.equal(rainbowBrackets.ok, true, 'T036-RAINBOW-BRACKETS-SCHEMA-01 configured rainbow-brackets compiles');
if (rainbowBrackets.ok) assert.equal(rainbowBrackets.value.editor.rainbowBrackets, true, 'T036-RAINBOW-BRACKETS-RUNTIME-01 configured rainbow-brackets reaches syntax highlighting');
const invalidRainbowBrackets = compileConfig([{ name: 'invalid-rainbow-brackets', kind: 'user', fileName: 'invalid-rainbow-brackets.toml', source: '[editor]\nrainbow-brackets = "true"\n' }]);
assert.equal(invalidRainbowBrackets.ok, false, 'T036-RAINBOW-BRACKETS-INVALID-01 non-boolean rainbow-brackets is rejected');
const trueColor = compileConfig([defaults, { name: 'true-color', kind: 'user', fileName: 'true-color.toml', source: '[editor]\ntrue-color = true\n' }]);
assert.equal(trueColor.ok, true, 'T036-TRUE-COLOR-02 configured true-color compiles');
if (trueColor.ok) assert.equal(trueColor.value.editor.trueColor, true, 'T036-TRUE-COLOR-03 configured true-color reaches the UI runtime');
const invalidTrueColor = compileConfig([{ name: 'invalid-true-color', kind: 'user', fileName: 'invalid-true-color.toml', source: '[editor]\ntrue-color = "true"\n' }]);
assert.equal(invalidTrueColor.ok, false, 'T036-TRUE-COLOR-04 non-boolean true-color is rejected');
const undercurl = compileConfig([defaults, { name: 'undercurl', kind: 'user', fileName: 'undercurl.toml', source: '[editor]\nundercurl = true\n' }]);
assert.equal(undercurl.ok, true, 'T036-UNDERCURL-02 configured undercurl compiles');
if (undercurl.ok) assert.equal(undercurl.value.editor.undercurl, true, 'T036-UNDERCURL-03 configured undercurl reaches the UI runtime');
const invalidUndercurl = compileConfig([{ name: 'invalid-undercurl', kind: 'user', fileName: 'invalid-undercurl.toml', source: '[editor]\nundercurl = "true"\n' }]);
assert.equal(invalidUndercurl.ok, false, 'T036-UNDERCURL-04 non-boolean undercurl is rejected');
const pathCompletion = compileConfig([defaults, { name: 'path-completion', kind: 'user', fileName: 'path-completion.toml', source: '[editor]\npath-completion = false\n' }]);
assert.equal(pathCompletion.ok, true, 'T036-PATH-COMPLETION-02 configured path-completion compiles');
if (pathCompletion.ok) assert.equal(pathCompletion.value.editor.pathCompletion, false, 'T036-PATH-COMPLETION-03 configured path-completion reaches the completion runtime');
const invalidPathCompletion = compileConfig([{ name: 'invalid-path-completion', kind: 'user', fileName: 'invalid-path-completion.toml', source: '[editor]\npath-completion = "true"\n' }]);
assert.equal(invalidPathCompletion.ok, false, 'T036-PATH-COMPLETION-04 non-boolean path-completion is rejected');
const bufferline = compileConfig([defaults, { name: 'bufferline', kind: 'user', fileName: 'bufferline.toml', source: '[editor]\nbufferline = "multiple"\n' }]);
assert.equal(bufferline.ok, true, 'T036-BUFFERLINE-02 configured bufferline compiles');
if (bufferline.ok) assert.equal(bufferline.value.editor.bufferline, 'multiple', 'T036-BUFFERLINE-03 configured bufferline reaches the UI runtime');
const invalidBufferline = compileConfig([{ name: 'invalid-bufferline', kind: 'user', fileName: 'invalid-bufferline.toml', source: '[editor]\nbufferline = "sometimes"\n' }]);
assert.equal(invalidBufferline.ok, false, 'T036-BUFFERLINE-04 unsupported bufferline value is rejected');
const statuslineDiagnostics = compileConfig([defaults, { name: 'statusline-diagnostics', kind: 'user', fileName: 'statusline-diagnostics.toml', source: '[editor.statusline]\ndiagnostics = ["error"]\nworkspace-diagnostics = ["warning", "info"]\n' }]);
assert.equal(statuslineDiagnostics.ok, true, 'T036-STATUSLINE-DIAGNOSTICS-02 configured statusline diagnostic severities compile');
if (statuslineDiagnostics.ok) {
  assert.deepEqual(statuslineDiagnostics.value.editor.statusline.diagnostics, ['error'], 'T036-STATUSLINE-DIAGNOSTICS-03 configured document severities reach the UI runtime');
  assert.deepEqual(statuslineDiagnostics.value.editor.statusline.workspaceDiagnostics, ['warning', 'info'], 'T036-STATUSLINE-WORKSPACE-DIAGNOSTICS-03 configured workspace severities reach the UI runtime');
}
const invalidStatusline = compileConfig([{ name: 'invalid-statusline', kind: 'user', fileName: 'invalid-statusline.toml', source: '[editor.statusline]\nleft = ["not-an-element"]\nseparator = 1\nmode.normal = false\ndiagnostics = ["fatal"]\n' }]);
assert.equal(invalidStatusline.ok, false, 'T036-STATUSLINE-04 invalid separator, mode labels and diagnostic severities are rejected');
const softWrap = compileConfig([defaults, { name: 'soft-wrap', kind: 'user', fileName: 'soft-wrap.toml', source: '[editor.soft-wrap]\nenable = true\n' }]);
assert.equal(softWrap.ok, true, 'T036-SOFT-WRAP-01 Helix editor.soft-wrap.enable compiles');
if (softWrap.ok) assert.equal(softWrap.value.editor.wrap, true, 'T036-SOFT-WRAP-02 soft-wrap reaches the layout consumer');
const wrapIndicator = compileConfig([defaults, { name: 'wrap-indicator', kind: 'user', fileName: 'wrap-indicator.toml', source: '[editor.soft-wrap]\nwrap-indicator = ">> "\n' }]);
assert.equal(wrapIndicator.ok, true, 'T036-WRAP-INDICATOR-02 configured wrap-indicator compiles');
if (wrapIndicator.ok) assert.equal(wrapIndicator.value.editor.wrapIndicator, '>> ', 'T036-WRAP-INDICATOR-03 configured wrap-indicator reaches the layout consumer');
const softWrapLimits = compileConfig([defaults, { name: 'soft-wrap-limits', kind: 'user', fileName: 'soft-wrap-limits.toml', source: '[editor.soft-wrap]\nmax-wrap = 25\nmax-indent-retain = 8\n' }]);
assert.equal(softWrapLimits.ok, true, 'T036-SOFT-WRAP-LIMIT-01 configured soft-wrap limits compile');
if (softWrapLimits.ok) {
  assert.equal(softWrapLimits.value.editor.softWrapMaxWrap, 25, 'T036-SOFT-WRAP-LIMIT-02 max-wrap reaches the layout consumer');
  assert.equal(softWrapLimits.value.editor.softWrapMaxIndentRetain, 8, 'T036-SOFT-WRAP-LIMIT-03 max-indent-retain reaches the layout consumer');
}
const invalidSoftWrapLimits = compileConfig([{ name: 'invalid-soft-wrap-limits', kind: 'user', fileName: 'invalid-soft-wrap-limits.toml', source: '[editor.soft-wrap]\nmax-wrap = -1\nmax-indent-retain = "8"\n' }]);
assert.equal(invalidSoftWrapLimits.ok, false, 'T036-SOFT-WRAP-LIMIT-04 invalid soft-wrap limits are rejected');
const invalidWrapIndicator = compileConfig([{ name: 'invalid-wrap-indicator', kind: 'user', fileName: 'invalid-wrap-indicator.toml', source: '[editor.soft-wrap]\nwrap-indicator = "bad\\nindicator"\n' }]);
assert.equal(invalidWrapIndicator.ok, false, 'T036-WRAP-INDICATOR-04 newline wrap-indicator is rejected');
const legacyWrap = compileConfig([defaults, { name: 'legacy-wrap', kind: 'user', fileName: 'legacy-wrap.toml', source: '[editor]\nwrap = true\n' }]);
assert.equal(legacyWrap.ok, true, 'T036-SOFT-WRAP-05 legacy editor.wrap remains accepted');
if (legacyWrap.ok) assert.equal(legacyWrap.value.editor.wrap, true, 'T036-SOFT-WRAP-05 legacy editor.wrap retains its behavior');
const invalidSoftWrap = compileConfig([{ name: 'invalid-soft-wrap', kind: 'user', fileName: 'invalid-soft-wrap.toml', source: '[editor]\nsoft-wrap = true\n' }]);
assert.equal(invalidSoftWrap.ok, false, 'T036-SOFT-WRAP-03 non-table editor.soft-wrap is rejected');
const invalidSoftWrapEnable = compileConfig([{ name: 'invalid-soft-wrap-enable', kind: 'user', fileName: 'invalid-soft-wrap-enable.toml', source: '[editor.soft-wrap]\nenable = "true"\n' }]);
assert.equal(invalidSoftWrapEnable.ok, false, 'T036-SOFT-WRAP-04 non-boolean editor.soft-wrap.enable is rejected');
const inlineDiagnosticsMax = compileConfig([defaults, { name: 'inline-diagnostics-max', kind: 'user', fileName: 'inline-diagnostics-max.toml', source: '[editor.inline-diagnostics]\nmax-diagnostics = 1\n' }]);
assert.equal(inlineDiagnosticsMax.ok, true, 'T036-INLINE-DIAGNOSTICS-MAX-02 configured max-diagnostics compiles');
if (inlineDiagnosticsMax.ok) assert.equal(inlineDiagnosticsMax.value.editor.inlineDiagnosticsMaxDiagnostics, 1, 'T036-INLINE-DIAGNOSTICS-MAX-03 max-diagnostics reaches the UI runtime');
const invalidInlineDiagnosticsMax = compileConfig([{ name: 'invalid-inline-diagnostics-max', kind: 'user', fileName: 'invalid-inline-diagnostics-max.toml', source: '[editor.inline-diagnostics]\nmax-diagnostics = 0\n' }]);
assert.equal(invalidInlineDiagnosticsMax.ok, false, 'T036-INLINE-DIAGNOSTICS-MAX-04 zero max-diagnostics is rejected');
const inlineDiagnosticsFilters = compileConfig([defaults, { name: 'inline-diagnostics-filters', kind: 'user', fileName: 'inline-diagnostics-filters.toml', source: '[editor.inline-diagnostics]\ncursor-line = "error"\nother-lines = "warning"\n' }]);
assert.equal(inlineDiagnosticsFilters.ok, true, 'T036-INLINE-DIAGNOSTICS-FILTER-02 configured diagnostic filters compile');
if (inlineDiagnosticsFilters.ok) {
  assert.equal(inlineDiagnosticsFilters.value.editor.inlineDiagnosticsCursorLine, 'error', 'T036-INLINE-DIAGNOSTICS-FILTER-03 cursor-line filter reaches the UI runtime');
  assert.equal(inlineDiagnosticsFilters.value.editor.inlineDiagnosticsOtherLines, 'warning', 'T036-INLINE-DIAGNOSTICS-FILTER-03-PART2 other-lines filter reaches the UI runtime');
}
const invalidInlineDiagnosticsFilter = compileConfig([{ name: 'invalid-inline-diagnostics-filter', kind: 'user', fileName: 'invalid-inline-diagnostics-filter.toml', source: '[editor.inline-diagnostics]\ncursor-line = "fatal"\n' }]);
assert.equal(invalidInlineDiagnosticsFilter.ok, false, 'T036-INLINE-DIAGNOSTICS-FILTER-04 unsupported diagnostic severity is rejected');
const inlineDiagnosticsPrefix = compileConfig([defaults, { name: 'inline-diagnostics-prefix', kind: 'user', fileName: 'inline-diagnostics-prefix.toml', source: '[editor.inline-diagnostics]\nprefix-len = 3\n' }]);
assert.equal(inlineDiagnosticsPrefix.ok, true, 'T036-INLINE-DIAGNOSTICS-PREFIX-LEN-02 configured prefix-len compiles');
if (inlineDiagnosticsPrefix.ok) assert.equal(inlineDiagnosticsPrefix.value.editor.inlineDiagnosticsPrefixLen, 3, 'T036-INLINE-DIAGNOSTICS-PREFIX-LEN-03 prefix-len reaches the UI runtime');
const invalidInlineDiagnosticsPrefix = compileConfig([{ name: 'invalid-inline-diagnostics-prefix', kind: 'user', fileName: 'invalid-inline-diagnostics-prefix.toml', source: '[editor.inline-diagnostics]\nprefix-len = -1\n' }]);
assert.equal(invalidInlineDiagnosticsPrefix.ok, false, 'T036-INLINE-DIAGNOSTICS-PREFIX-LEN-04 negative prefix-len is rejected');
const endOfLineDiagnostics = compileConfig([defaults, { name: 'end-of-line-diagnostics', kind: 'user', fileName: 'end-of-line-diagnostics.toml', source: '[editor]\nend-of-line-diagnostics = "warning"\n' }]);
assert.equal(endOfLineDiagnostics.ok, true, 'T036-END-OF-LINE-DIAGNOSTICS-02 configured end-of-line-diagnostics compiles');
if (endOfLineDiagnostics.ok) assert.equal(endOfLineDiagnostics.value.editor.endOfLineDiagnostics, 'warning', 'T036-END-OF-LINE-DIAGNOSTICS-03 end-of-line-diagnostics reaches the UI runtime');
const invalidEndOfLineDiagnostics = compileConfig([{ name: 'invalid-end-of-line-diagnostics', kind: 'user', fileName: 'invalid-end-of-line-diagnostics.toml', source: '[editor]\nend-of-line-diagnostics = "fatal"\n' }]);
assert.equal(invalidEndOfLineDiagnostics.ok, false, 'T036-END-OF-LINE-DIAGNOSTICS-04 unsupported end-of-line severity is rejected');
const inlineDiagnosticsMaxWrap = compileConfig([defaults, { name: 'inline-diagnostics-max-wrap', kind: 'user', fileName: 'inline-diagnostics-max-wrap.toml', source: '[editor.inline-diagnostics]\nmax-wrap = 5\n' }]);
assert.equal(inlineDiagnosticsMaxWrap.ok, true, 'T036-INLINE-DIAGNOSTICS-MAX-WRAP-02 configured max-wrap compiles');
if (inlineDiagnosticsMaxWrap.ok) assert.equal(inlineDiagnosticsMaxWrap.value.editor.inlineDiagnosticsMaxWrap, 5, 'T036-INLINE-DIAGNOSTICS-MAX-WRAP-03 max-wrap reaches the UI runtime');
const invalidInlineDiagnosticsMaxWrap = compileConfig([{ name: 'invalid-inline-diagnostics-max-wrap', kind: 'user', fileName: 'invalid-inline-diagnostics-max-wrap.toml', source: '[editor.inline-diagnostics]\nmax-wrap = -1\n' }]);
assert.equal(invalidInlineDiagnosticsMaxWrap.ok, false, 'T036-INLINE-DIAGNOSTICS-MAX-WRAP-04 negative max-wrap is rejected');
const inlineDiagnosticsMinWidth = compileConfig([defaults, { name: 'inline-diagnostics-min-width', kind: 'user', fileName: 'inline-diagnostics-min-width.toml', source: '[editor.inline-diagnostics]\nmin-diagnostic-width = 12\n' }]);
assert.equal(inlineDiagnosticsMinWidth.ok, true, 'T036-INLINE-DIAGNOSTICS-MIN-WIDTH-02 configured min-diagnostic-width compiles');
if (inlineDiagnosticsMinWidth.ok) assert.equal(inlineDiagnosticsMinWidth.value.editor.inlineDiagnosticsMinDiagnosticWidth, 12, 'T036-INLINE-DIAGNOSTICS-MIN-WIDTH-03 min-diagnostic-width reaches the UI runtime');
const invalidInlineDiagnosticsMinWidth = compileConfig([{ name: 'invalid-inline-diagnostics-min-width', kind: 'user', fileName: 'invalid-inline-diagnostics-min-width.toml', source: '[editor.inline-diagnostics]\nmin-diagnostic-width = -1\n' }]);
assert.equal(invalidInlineDiagnosticsMinWidth.ok, false, 'T036-INLINE-DIAGNOSTICS-MIN-WIDTH-04 negative min-diagnostic-width is rejected');
const disabledAutoFormat = compileConfig([defaults, { name: 'auto-format-disabled', kind: 'user', fileName: 'auto-format-disabled.toml', source: '[editor]\nauto-format = false\n' }]);
assert.equal(disabledAutoFormat.ok, true, 'T036-AUTO-FORMAT-02 editor.auto-format=false compiles');
if (disabledAutoFormat.ok) assert.equal(disabledAutoFormat.value.editor.autoFormat, false, 'T036-AUTO-FORMAT-03 editor.auto-format reaches the save runtime');
const invalidAutoFormat = compileConfig([{ name: 'invalid-auto-format', kind: 'user', fileName: 'invalid-auto-format.toml', source: '[editor]\nauto-format = "false"\n' }]);
assert.equal(invalidAutoFormat.ok, false, 'T036-AUTO-FORMAT-04 non-boolean editor.auto-format is rejected');
const autoCompletion = compileConfig([defaults, { name: 'auto-completion', kind: 'user', fileName: 'auto-completion.toml', source: '[editor]\nauto-completion = false\ncompletion-timeout = 5\ncompletion-trigger-len = 4\npreview-completion-insert = false\ncompletion-replace = true\n' }]);
assert.equal(autoCompletion.ok, true, 'T036-AUTO-COMPLETION-02 configured automatic completion compiles');
assert.equal(autoCompletion.ok, true, 'T036-COMPLETION-TRIGGER-LEN-02 completion-trigger-len accepts a positive integer');
assert.equal(autoCompletion.ok, true, 'T036-COMPLETION-REPLACE-02 completion-replace accepts a boolean');
assert.equal(autoCompletion.ok, true, 'T036-COMPLETION-TIMEOUT-02 configured completion-timeout compiles');
if (autoCompletion.ok) {
  assert.equal(autoCompletion.value.editor.autoCompletion, false, 'T036-AUTO-COMPLETION-03 auto-completion reaches the input runtime');
  assert.equal(autoCompletion.value.editor.completionTimeout, 5, 'T036-COMPLETION-TIMEOUT-03 completion-timeout reaches the completion runtime');
  assert.equal(autoCompletion.value.editor.completionTriggerLen, 4, 'T036-COMPLETION-TRIGGER-LEN-03 completion-trigger-len reaches the completion runtime');
  assert.equal(autoCompletion.value.editor.previewCompletionInsert, false, 'T036-PREVIEW-COMPLETION-INSERT-03 preview-completion-insert reaches the completion runtime');
  assert.equal(autoCompletion.value.editor.autoInfo, true, 'T036-AUTO-INFO-05 default auto-info reaches the router runtime');
  assert.equal(autoCompletion.value.editor.completionReplace, true, 'T036-COMPLETION-REPLACE-03 completion-replace reaches the completion runtime');
}
const disabledAutoInfo = compileConfig([defaults, { name: 'auto-info-disabled', kind: 'user', fileName: 'auto-info-disabled.toml', source: '[editor]\nauto-info = false\n' }]);
assert.equal(disabledAutoInfo.ok, true, 'T036-AUTO-INFO-02 configured editor.auto-info compiles');
if (disabledAutoInfo.ok) assert.equal(disabledAutoInfo.value.editor.autoInfo, false, 'T036-AUTO-INFO-03 editor.auto-info reaches the input runtime');
const invalidAutoCompletion = compileConfig([{ name: 'invalid-auto-completion', kind: 'user', fileName: 'invalid-auto-completion.toml', source: '[editor]\nauto-completion = "false"\ncompletion-timeout = -1\ncompletion-trigger-len = 256\npreview-completion-insert = "true"\ncompletion-replace = "true"\n' }]);
assert.equal(invalidAutoCompletion.ok, false, 'T036-AUTO-COMPLETION-04 invalid automatic completion settings are rejected');
if (!invalidAutoCompletion.ok) assert.ok(invalidAutoCompletion.error.diagnostics.some((diagnostic) => diagnostic.path === 'editor.completion-timeout'), 'T036-COMPLETION-TIMEOUT-04 negative completion-timeout is rejected');
if (!invalidAutoCompletion.ok) assert.ok(invalidAutoCompletion.error.diagnostics.some((diagnostic) => diagnostic.path === 'editor.completion-replace'), 'T036-COMPLETION-REPLACE-04 non-boolean completion-replace is rejected');
if (!invalidAutoCompletion.ok) assert.ok(invalidAutoCompletion.error.diagnostics.some((diagnostic) => diagnostic.path === 'editor.completion-trigger-len'), 'T036-COMPLETION-TRIGGER-LEN-04 completion-trigger-len above u8 is rejected');
if (!invalidAutoCompletion.ok) assert.ok(invalidAutoCompletion.error.diagnostics.some((diagnostic) => diagnostic.path === 'editor.preview-completion-insert'), 'T036-PREVIEW-COMPLETION-INSERT-04 non-boolean preview-completion-insert is rejected');
const invalidAutoInfo = compileConfig([{ name: 'invalid-auto-info', kind: 'user', fileName: 'invalid-auto-info.toml', source: '[editor]\nauto-info = "true"\n' }]);
assert.equal(invalidAutoInfo.ok, false, 'T036-AUTO-INFO-04 non-boolean editor.auto-info is rejected');
if (!invalidAutoInfo.ok) assert.ok(invalidAutoInfo.error.diagnostics.some((diagnostic) => diagnostic.path === 'editor.auto-info'), 'T036-AUTO-INFO-04-PART2 invalid editor.auto-info names its path');
const defaultYankRegister = compileConfig([defaults, { name: 'default-yank-register', kind: 'user', fileName: 'default-yank-register.toml', source: '[editor]\ndefault-yank-register = "a"\n' }]);
assert.equal(defaultYankRegister.ok, true, 'T036-DEFAULT-YANK-REGISTER-02 configured editor.default-yank-register compiles');
if (defaultYankRegister.ok) assert.equal(defaultYankRegister.value.editor.defaultYankRegister, 'a', 'T036-DEFAULT-YANK-REGISTER-03 configured register reaches the Vim runtime');
const invalidDefaultYankRegister = compileConfig([{ name: 'invalid-default-yank-register', kind: 'user', fileName: 'invalid-default-yank-register.toml', source: '[editor]\ndefault-yank-register = "ab"\n' }]);
assert.equal(invalidDefaultYankRegister.ok, false, 'T036-DEFAULT-YANK-REGISTER-04 multi-character registers are rejected');
const mouseYankRegister = compileConfig([defaults, { name: 'mouse-yank-register', kind: 'user', fileName: 'mouse-yank-register.toml', source: '[editor]\nmouse-yank-register = "a"\n' }]);
assert.equal(mouseYankRegister.ok, true, 'T036-MOUSE-YANK-REGISTER-SCHEMA-01 configured editor.mouse-yank-register compiles');
if (mouseYankRegister.ok) assert.equal(mouseYankRegister.value.editor.mouseYankRegister, 'a', 'T036-MOUSE-YANK-REGISTER-UNIT-01 configured mouse yank register reaches the Vim runtime');
const invalidMouseYankRegister = compileConfig([{ name: 'invalid-mouse-yank-register', kind: 'user', fileName: 'invalid-mouse-yank-register.toml', source: '[editor]\nmouse-yank-register = "ab"\n' }]);
assert.equal(invalidMouseYankRegister.ok, false, 'T036-MOUSE-YANK-REGISTER-INVALID-01 multi-character mouse yank registers are rejected');
const kittyKeyboardProtocol = compileConfig([defaults, { name: 'kitty-keyboard-protocol', kind: 'user', fileName: 'kitty-keyboard-protocol.toml', source: '[editor]\nkitty-keyboard-protocol = "disabled"\n' }]);
assert.equal(kittyKeyboardProtocol.ok, true, 'T036-KITTY-KEYBOARD-SCHEMA-01 configured kitty-keyboard-protocol compiles');
if (kittyKeyboardProtocol.ok) assert.equal(kittyKeyboardProtocol.value.editor.kittyKeyboardProtocol, 'disabled', 'T036-KITTY-KEYBOARD-UNIT-01 configured Kitty protocol reaches the terminal runtime');
const invalidKittyKeyboardProtocol = compileConfig([{ name: 'invalid-kitty-keyboard-protocol', kind: 'user', fileName: 'invalid-kitty-keyboard-protocol.toml', source: '[editor]\nkitty-keyboard-protocol = "sometimes"\n' }]);
assert.equal(invalidKittyKeyboardProtocol.ok, false, 'T036-KITTY-KEYBOARD-INVALID-01 unsupported Kitty protocol values are rejected');
const autoSignatureHelp = compileConfig([defaults, { name: 'auto-signature-help', kind: 'user', fileName: 'auto-signature-help.toml', source: '[editor.lsp]\nauto-signature-help = false\n' }]);
assert.equal(autoSignatureHelp.ok, true, 'T036-AUTO-SIGNATURE-HELP-02 configured editor.lsp.auto-signature-help compiles');
if (autoSignatureHelp.ok) assert.equal(autoSignatureHelp.value.editor.lsp.autoSignatureHelp, false, 'T036-AUTO-SIGNATURE-HELP-03 auto-signature-help reaches the LSP runtime');
const invalidAutoSignatureHelp = compileConfig([{ name: 'invalid-auto-signature-help', kind: 'user', fileName: 'invalid-auto-signature-help.toml', source: '[editor.lsp]\nauto-signature-help = "false"\n' }]);
assert.equal(invalidAutoSignatureHelp.ok, false, 'T036-AUTO-SIGNATURE-HELP-04 non-boolean auto-signature-help is rejected');
const barCursor = compileConfig([defaults, { name: 'bar-cursor', kind: 'user', fileName: 'bar-cursor.toml', source: '[editor.cursor-shape]\nnormal = "bar"\n' }]);
assert.equal(barCursor.ok, true, 'T036-CURSOR-SHAPE-02 Helix normal cursor bar compiles');
if (barCursor.ok) assert.equal(barCursor.value.editor.cursorShape.normal, 'bar', 'T036-CURSOR-SHAPE-03 normal cursor bar reaches the UI runtime');
const insertCursor = compileConfig([defaults, { name: 'insert-cursor', kind: 'user', fileName: 'insert-cursor.toml', source: '[editor.cursor-shape]\ninsert = "underline"\n' }]);
assert.equal(insertCursor.ok, true, 'T036-CURSOR-SHAPE-05 Helix insert cursor underline compiles');
if (insertCursor.ok) assert.equal(insertCursor.value.editor.cursorShape.insert, 'underline', 'T036-CURSOR-SHAPE-06 insert cursor underline reaches the UI runtime');
const hiddenSelectCursor = compileConfig([defaults, { name: 'hidden-select-cursor', kind: 'user', fileName: 'hidden-select-cursor.toml', source: '[editor.cursor-shape]\nselect = "hidden"\n' }]);
assert.equal(hiddenSelectCursor.ok, true, 'T036-CURSOR-SHAPE-07 Helix select hidden cursor compiles');
if (hiddenSelectCursor.ok) assert.equal(hiddenSelectCursor.value.editor.cursorShape.select, 'hidden', 'T036-CURSOR-SHAPE-08 select hidden reaches the UI runtime');
const invalidCursorShape = compileConfig([{ name: 'invalid-cursor-shape', kind: 'user', fileName: 'invalid-cursor-shape.toml', source: '[editor.cursor-shape]\nnormal = "beam"\n' }]);
assert.equal(invalidCursorShape.ok, false, 'T036-CURSOR-SHAPE-04 unsupported cursor shape is rejected');
const disabledLsp = compileConfig([defaults, { name: 'lsp-disabled', kind: 'user', fileName: 'lsp-disabled.toml', source: '[editor.lsp]\nenable = false\n' }]);
assert.equal(disabledLsp.ok, true, 'T036-LSP-ENABLE-01 editor.lsp.enable=false compiles');
if (disabledLsp.ok) assert.equal(disabledLsp.value.editor.lsp.enable, false, 'T036-LSP-ENABLE-02 disabled LSP reaches the compiled snapshot');
const invalidLsp = compileConfig([{ name: 'invalid-lsp', kind: 'user', fileName: 'invalid-lsp.toml', source: '[editor.lsp]\nenable = "false"\n' }]);
assert.equal(invalidLsp.ok, false, 'T036-LSP-ENABLE-03 non-boolean editor.lsp.enable is rejected');
const disabledSnippets = compileConfig([defaults, { name: 'snippets-disabled', kind: 'user', fileName: 'snippets-disabled.toml', source: '[editor.lsp]\nsnippets = false\n' }]);
assert.equal(disabledSnippets.ok, true, 'T036-LSP-SNIPPETS-02 editor.lsp.snippets=false compiles');
if (disabledSnippets.ok) assert.equal(disabledSnippets.value.editor.lsp.snippets, false, 'T036-LSP-SNIPPETS-03 snippets reaches the LSP and completion runtimes');
const invalidSnippets = compileConfig([{ name: 'invalid-snippets', kind: 'user', fileName: 'invalid-snippets.toml', source: '[editor.lsp]\nsnippets = "false"\n' }]);
assert.equal(invalidSnippets.ok, false, 'T036-LSP-SNIPPETS-04 non-boolean snippets is rejected');
const inlayHints = compileConfig([defaults, { name: 'inlay-hints', kind: 'user', fileName: 'inlay-hints.toml', source: '[editor.lsp]\ndisplay-inlay-hints = true\ninlay-hints-length-limit = 80\n' }]);
assert.equal(inlayHints.ok, true, 'T036-LSP-INLAY-HINTS-SCHEMA-01 exact Helix inlay-hint settings compile');
if (inlayHints.ok) {
  assert.equal(inlayHints.value.editor.lsp.displayInlayHints, true, 'T036-LSP-INLAY-HINTS-RUNTIME-01 display-inlay-hints reaches the LSP runtime');
  assert.equal(inlayHints.value.editor.lsp.inlayHintsLengthLimit, 80, 'T036-LSP-INLAY-HINTS-LIMIT-RUNTIME-01 inlay-hints-length-limit reaches the LSP runtime');
}
const legacyInlayHints = compileConfig([defaults, { name: 'legacy-inlay-hints', kind: 'user', fileName: 'legacy-inlay-hints.toml', source: '[editor.lsp]\ninlay-hints = true\n' }]);
assert.equal(legacyInlayHints.ok, true, 'T036-LSP-INLAY-HINTS-MIGRATION-01 Xi legacy inlay-hints remains accepted');
if (legacyInlayHints.ok) assert.equal(legacyInlayHints.value.editor.lsp.displayInlayHints, true, 'T036-LSP-INLAY-HINTS-MIGRATION-02 legacy inlay-hints maps to display-inlay-hints');
const invalidInlayHints = compileConfig([{ name: 'invalid-inlay-hints', kind: 'user', fileName: 'invalid-inlay-hints.toml', source: '[editor.lsp]\ndisplay-inlay-hints = "true"\ninlay-hints-length-limit = 0\n' }]);
assert.equal(invalidInlayHints.ok, false, 'T036-LSP-INLAY-HINTS-INVALID-01 inlay-hint settings reject wrong types and zero limits');
const colorSwatches = compileConfig([defaults, { name: 'color-swatches', kind: 'user', fileName: 'color-swatches.toml', source: '[editor.lsp]\ndisplay-color-swatches = false\n' }]);
assert.equal(colorSwatches.ok, true, 'T036-LSP-COLOR-SWATCHES-SCHEMA-01 exact Helix color-swatch setting compiles');
if (colorSwatches.ok) assert.equal(colorSwatches.value.editor.lsp.displayColorSwatches, false, 'T036-LSP-COLOR-SWATCHES-RUNTIME-01 display-color-swatches reaches the LSP runtime');
const invalidColorSwatches = compileConfig([{ name: 'invalid-color-swatches', kind: 'user', fileName: 'invalid-color-swatches.toml', source: '[editor.lsp]\ndisplay-color-swatches = "true"\n' }]);
assert.equal(invalidColorSwatches.ok, false, 'T036-LSP-COLOR-SWATCHES-INVALID-01 non-boolean display-color-swatches is rejected');
const documentHighlight = compileConfig([defaults, { name: 'document-highlight', kind: 'user', fileName: 'document-highlight.toml', source: '[editor.lsp]\nauto-document-highlight = true\n' }]);
assert.equal(documentHighlight.ok, true, 'T036-LSP-DOCUMENT-HIGHLIGHT-SCHEMA-01 exact Helix document-highlight setting compiles');
if (documentHighlight.ok) assert.equal(documentHighlight.value.editor.lsp.autoDocumentHighlight, true, 'T036-LSP-DOCUMENT-HIGHLIGHT-RUNTIME-01 auto-document-highlight reaches the LSP runtime');
const invalidDocumentHighlight = compileConfig([{ name: 'invalid-document-highlight', kind: 'user', fileName: 'invalid-document-highlight.toml', source: '[editor.lsp]\nauto-document-highlight = "true"\n' }]);
assert.equal(invalidDocumentHighlight.ok, false, 'T036-LSP-DOCUMENT-HIGHLIGHT-INVALID-01 non-boolean auto-document-highlight is rejected');
const gotoReferenceDeclaration = compileConfig([defaults, { name: 'goto-reference-declaration', kind: 'user', fileName: 'goto-reference-declaration.toml', source: '[editor.lsp]\ngoto-reference-include-declaration = false\n' }]);
assert.equal(gotoReferenceDeclaration.ok, true, 'T036-LSP-GOTO-REFERENCES-SCHEMA-01 goto-reference-include-declaration compiles');
if (gotoReferenceDeclaration.ok) assert.equal(gotoReferenceDeclaration.value.editor.lsp.gotoReferenceIncludeDeclaration, false, 'T036-LSP-GOTO-REFERENCES-RUNTIME-01 goto-reference-include-declaration reaches the LSP runtime');
const invalidGotoReferenceDeclaration = compileConfig([{ name: 'invalid-goto-reference-declaration', kind: 'user', fileName: 'invalid-goto-reference-declaration.toml', source: '[editor.lsp]\ngoto-reference-include-declaration = "false"\n' }]);
assert.equal(invalidGotoReferenceDeclaration.ok, false, 'T036-LSP-GOTO-REFERENCES-INVALID-01 non-boolean goto-reference-include-declaration is rejected');
const hiddenSignatureDocs = compileConfig([defaults, { name: 'signature-docs', kind: 'user', fileName: 'signature-docs.toml', source: '[editor.lsp]\ndisplay-signature-help-docs = false\n' }]);
assert.equal(hiddenSignatureDocs.ok, true, 'T036-LSP-SIGNATURE-DOCS-02 editor.lsp.display-signature-help-docs=false compiles');
if (hiddenSignatureDocs.ok) assert.equal(hiddenSignatureDocs.value.editor.lsp.displaySignatureHelpDocs, false, 'T036-LSP-SIGNATURE-DOCS-03 signature-help documentation visibility reaches the runtime snapshot');
const invalidSignatureDocs = compileConfig([{ name: 'invalid-signature-docs', kind: 'user', fileName: 'invalid-signature-docs.toml', source: '[editor.lsp]\ndisplay-signature-help-docs = "false"\n' }]);
assert.equal(invalidSignatureDocs.ok, false, 'T036-LSP-SIGNATURE-DOCS-04 non-boolean signature-help documentation setting is rejected');
const lspMessages = compileConfig([defaults, { name: 'lsp-messages', kind: 'user', fileName: 'lsp-messages.toml', source: '[editor.lsp]\ndisplay-messages = false\ndisplay-progress-messages = true\n' }]);
assert.equal(lspMessages.ok, true, 'T036-LSP-DISPLAY-MESSAGES-02 configured LSP message visibility compiles');
if (lspMessages.ok) {
  assert.equal(lspMessages.value.editor.lsp.displayMessages, false, 'T036-LSP-DISPLAY-MESSAGES-03 display-messages reaches the LSP runtime');
  assert.equal(lspMessages.value.editor.lsp.displayProgressMessages, true, 'T036-LSP-DISPLAY-PROGRESS-03 display-progress-messages reaches the LSP runtime');
}
const invalidLspMessages = compileConfig([{ name: 'invalid-lsp-messages', kind: 'user', fileName: 'invalid-lsp-messages.toml', source: '[editor.lsp]\ndisplay-messages = "false"\ndisplay-progress-messages = 1\n' }]);
assert.equal(invalidLspMessages.ok, false, 'T036-LSP-DISPLAY-MESSAGES-04 non-boolean LSP message settings are rejected');
const configuredScrollLines = compileConfig([defaults, { name: 'scroll-lines', kind: 'user', fileName: 'scroll-lines.toml', source: '[editor]\nscroll-lines = 7\n' }]);
assert.equal(configuredScrollLines.ok, true, 'T036-SCROLL-LINES-01 Helix editor.scroll-lines compiles');
if (configuredScrollLines.ok) assert.equal(configuredScrollLines.value.editor.mouse.scrollLines, 7, 'T036-SCROLL-LINES-02 canonical scroll-lines reaches the runtime consumer');
const invalidScrollLines = compileConfig([{ name: 'invalid-scroll-lines', kind: 'user', fileName: 'invalid-scroll-lines.toml', source: '[editor]\nscroll-lines = 0\n' }]);
assert.equal(invalidScrollLines.ok, false, 'T036-SCROLL-LINES-03 zero scroll-lines is rejected');

const overridden = compileConfig([
  defaults,
  { name: 'user', kind: 'user', fileName: 'user.toml', source: '[editor]\ntheme = "user-theme"\n[search]\nhidden = false\n' },
]);
assert.equal(overridden.ok, true, 'T036-MERGE-01 user layer deep-merges with defaults');
if (!overridden.ok) throw new Error('user layer did not compile');
assert.equal(overridden.value.editor.theme, 'user-theme', 'T036-MERGE-02 scalar values replace lower layers');
assert.equal(overridden.value.editor.wrap, false, 'T036-MERGE-03 unrelated lower-layer values survive');
assert.equal(overridden.value.search.hidden, false, 'T036-MERGE-04 nested table values replace by field');
assert.equal(overridden.value.provenance['editor.theme'], 'user', 'T036-MERGE-05 overridden field provenance changes atomically');

const store = new ConfigStore(initial.value);
const captured = store.captureGeneration();
const reloaded = store.reload([
  defaults,
  { name: 'user', kind: 'user', fileName: 'user.toml', source: '[editor]\ntheme = "night"\n' },
]);
assert.equal(reloaded.ok, true, 'T036-RELOAD-01 valid reload compiles a candidate');
assert.equal(store.snapshot.editor.theme, 'night', 'T036-RELOAD-02 valid reload publishes one new immutable snapshot');
assert.equal(store.isCurrent(captured), false, 'T036-RELOAD-03 old captured key sequence becomes stale after publication');
const goodSnapshot = store.snapshot;
const badReload = store.reload([
  defaults,
  { name: 'broken', kind: 'user', fileName: 'broken.toml', source: '[editor]\nunknown-setting = true\n' },
]);
assert.equal(badReload.ok, false, 'T036-RELOAD-04 invalid reload is rejected');
assert.equal(store.snapshot, goodSnapshot, 'T036-RELOAD-05 invalid reload preserves the exact last-good snapshot object');

const duplicate = compileConfig([
  { name: 'duplicate', kind: 'user', fileName: 'duplicate.toml', source: 'schema-version = 1\n[keys.normal.space]\nf = "files.pick"\n[keys.normal.Space]\nf = "buffers.pick"\n' },
]);
assert.equal(duplicate.ok, false, 'T036-FAIL-DUP-01 duplicate normalized binding is rejected');
assert.equal(duplicate.ok ? undefined : duplicate.error.diagnostics.some((item) => item.code === 'duplicate-binding'), true, 'T036-FAIL-DUP-02 duplicate fixture reports duplicate-binding');

const unknown = compileConfig([{ name: 'unknown', kind: 'user', fileName: 'unknown.toml', source: 'schema-version = 1\n[editor]\nnot-a-setting = true\n' }]);
assert.equal(unknown.ok, false, 'T036-UNKNOWN-FIELDS-SCHEMA-01 unknown setting is rejected');
assert.equal(unknown.ok ? undefined : unknown.error.diagnostics[0]?.line, 3, 'T036-UNKNOWN-FIELDS-UNIT-01 unknown setting carries source line');

const untrustedWorkspace = compileConfig([
  defaults,
  { name: 'workspace', kind: 'workspace', fileName: '.xi/config.toml', source: '[language-server.local]\ncommand = "local-language-server"\n' },
]);
assert.equal(untrustedWorkspace.ok, false, 'T036-FAIL-EXEC-01 workspace executable change requires trust');
assert.equal(untrustedWorkspace.ok ? undefined : untrustedWorkspace.error.diagnostics.some((item) => item.code === 'untrusted-executable-change'), true, 'T036-FAIL-EXEC-02 executable trust diagnostic is explicit');
const trustedWorkspace = compileConfig([
  defaults,
  { name: 'workspace', kind: 'workspace', trusted: true, fileName: '.xi/config.toml', source: '[language-server.local]\ncommand = "local-language-server"\nargs = ["--stdio"]\n' },
]);
assert.equal(trustedWorkspace.ok, true, 'T036-TRUST-01 trusted workspace executable configuration is usable');

const strict = compileConfig([defaults, personal], { profile: 'strict' });
assert.equal(strict.ok, true, 'T036-PROFILE-01 strict profile remains valid with personal migration present');
if (!strict.ok) throw new Error('strict profile did not compile');
assert.equal(strict.value.aliases.length, 0, 'T036-PROFILE-02 personal aliases never enter strict parity profile');
assert.equal(strict.value.editor.motionTrail, 'off', 'T036-PROFILE-03 strict profile disables decorative motion trail');
const personalProfile = compileConfig([defaults, personal], { profile: 'personal' });
assert.equal(personalProfile.ok, true, 'T036-PROFILE-04 personal migration profile compiles');
if (!personalProfile.ok) throw new Error('personal profile did not compile');
assert.ok(personalProfile.value.aliases.some((alias) => alias.name === 'theme'), 'T036-PROFILE-05 personal alias is available only in personal/Xi profiles');

const malformed = parseToml('[editor\nmouse = true', 'broken.toml');
assert.equal(malformed.ok, false, 'T036-FAIL-SYNTAX-01 malformed table header is rejected');
assert.equal(malformed.ok ? undefined : malformed.error.diagnostics[0]?.fileName, 'broken.toml', 'T036-FAIL-SYNTAX-02 malformed input names its source file');

const languages = parseLanguageConfig(DEFAULT_LANGUAGES_TOML, 'config/languages.toml');
assert.equal(languages.ok, true, 'T036-LANGUAGE-01 shipped language example validates');
if (languages.ok) {
  assert.equal(languages.value[0]?.name, 'typescript', 'T036-LANGUAGE-02 language identity is retained');
  assert.equal(languages.value[0]?.formatter?.command, 'biome', 'T036-LANGUAGE-03 formatter command remains argv configuration');
}
const shippedLanguages = compileConfig([defaults, { name: 'default-languages', kind: 'language', source: DEFAULT_LANGUAGES_TOML }]);
assert.equal(shippedLanguages.ok, true, 'T036-LANGUAGE-RUBY-01 shipped Ruby configuration compiles');
if (shippedLanguages.ok) {
  const ruby = shippedLanguages.value.languages.find((entry) => entry.name === 'ruby');
  const rubyServer = shippedLanguages.value.languageServers.find((entry) => entry.name === ruby?.languageServers[0]);
  assert.ok(ruby?.fileTypes.includes('rb') && ruby.fileTypes.includes('Gemfile'), 'T036-LANGUAGE-RUBY-02 Ruby extensions and conventional filenames ship by default');
  assert.equal(rubyServer?.command, 'ruby-lsp', 'T036-LANGUAGE-RUBY-03 Ruby LSP ships by default');
}
const theme = parseThemeConfig(DEFAULT_THEME_TOML, 'config/themes/xi-light.toml');
assert.equal(theme.ok, true, 'T036-THEME-01 shipped theme example validates');
if (theme.ok) assert.equal(theme.value.styles['ui.selection.primary']?.bg, 'selection', 'T036-THEME-02 Helix semantic scope is retained');
const invalidLanguage = parseLanguageConfig('schema-version = 1\n[[language]]\nname = "x"\nfile-types = ["x"]\nwat = true\n', 'invalid-languages.toml');
assert.equal(invalidLanguage.ok, false, 'T036-FAIL-LANGUAGE-01 unknown language field is rejected');
const invalidTheme = parseThemeConfig('"ui.selection.primary" = 1\n', 'invalid-theme.toml');
assert.equal(invalidTheme.ok, false, 'T036-FAIL-THEME-01 invalid theme color is rejected');

// A user languages.toml layer (as apps/xi/src/main.ts's loadStartupConfig reads at startup)
// changes which language-server command a file's languageId resolves to, away from the
// hardcoded typescript-language-server default.
const pythonLanguages: ConfigLayer = {
  name: 'languages', kind: 'language', fileName: 'languages.toml',
  source: 'schema-version = 1\n\n[language-server.pyright]\ncommand = "pyright-langserver"\nargs = ["--stdio"]\nroot-markers = ["pyproject.toml"]\n\n[[language]]\nname = "python"\nfile-types = ["py"]\nlanguage-servers = ["pyright"]\n',
};
const withPython = compileConfig([defaults, pythonLanguages]);
assert.equal(withPython.ok, true, 'T036-LANGUAGE-04 a user language-server layer compiles');
if (withPython.ok) {
  const python = withPython.value.languages.find((entry) => entry.name === 'python');
  assert.ok(python !== undefined && python.fileTypes.includes('py'), 'T036-LANGUAGE-05 configured file-type maps to the configured language');
  const server = withPython.value.languageServers.find((entry) => entry.name === python?.languageServers[0]);
  assert.equal(server?.command, 'pyright-langserver', 'T036-LANGUAGE-06 the configured language server, not typescript-language-server, is chosen');
}

console.log('T036 config passed TOML diagnostics, schema validation, provenance merge, atomic last-good reload, profile isolation, executable trust, language and theme fixtures');
