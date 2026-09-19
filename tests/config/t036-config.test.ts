import assert from 'node:assert/strict';
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
  type ConfigLayer,
} from '../../packages/services/config/index';

const defaults: ConfigLayer = { name: 'defaults', kind: 'defaults', fileName: 'config/default.toml', source: DEFAULT_CONFIG_TOML };
const personal: ConfigLayer = { name: 'personal-migration', kind: 'profile', fileName: 'config/personal-migration.toml', source: PERSONAL_MIGRATION_TOML };

const parsed = parseToml(DEFAULT_CONFIG_TOML, 'config/default.toml');
assert.equal(parsed.ok, true, 'T036-TOML-01 shipped example parses as TOML');
if (!parsed.ok) throw new Error('default TOML did not parse');
assert.ok(parsed.value.entries.some((entry) => entry.path.join('.') === 'keys.normal.space.f'), 'T036-TOML-02 dotted table entries retain their source path');

const initial = compileInitialConfig();
assert.equal(initial.ok, true, 'T036-CONFIG-01 shipped example validates');
if (!initial.ok) throw new Error('default config did not compile');
assert.equal(initial.value.bindings.length, 30, 'T036-CONFIG-02 every shipped editor and panel key declaration compiles');
assert.ok(initial.value.bindings.every((binding) => DEFAULT_COMMAND_CATALOG.commandIds.includes(binding.commandId)), 'T036-CONFIG-03 every binding command resolves in the catalog');
assert.equal(initial.value.aliases.length, 11, 'T036-CONFIG-04 friendly aliases compile to stable command IDs');
assert.equal(initial.value.editor.selection.limit, 10_000, 'T036-CONFIG-05 selection limit is validated and retained');
assert.equal(initial.value.editor.selection.historyLimit, 100, 'T036-CONFIG-06 selection history limit is validated and retained');
assert.equal(initial.value.editor.hintsDelayMs, 250, 'T036-CONFIG-07 hint delay is validated and retained');
assert.equal(initial.value.provenance['editor.theme'], 'defaults', 'T036-CONFIG-08 effective values retain layer provenance');

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
assert.equal(unknown.ok, false, 'T036-FAIL-UNKNOWN-01 unknown setting is rejected');
assert.equal(unknown.ok ? undefined : unknown.error.diagnostics[0]?.line, 3, 'T036-FAIL-UNKNOWN-02 unknown setting carries source line');

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
const theme = parseThemeConfig(DEFAULT_THEME_TOML, 'config/themes/xi-light.toml');
assert.equal(theme.ok, true, 'T036-THEME-01 shipped theme example validates');
if (theme.ok) assert.equal(theme.value.tokens['selection.primary'], '#D6E5F2', 'T036-THEME-02 semantic theme token is retained');
const invalidLanguage = parseLanguageConfig('schema-version = 1\n[[language]]\nname = "x"\nfile-types = ["x"]\nwat = true\n', 'invalid-languages.toml');
assert.equal(invalidLanguage.ok, false, 'T036-FAIL-LANGUAGE-01 unknown language field is rejected');
const invalidTheme = parseThemeConfig('schema-version = 1\nname = "x"\n[tokens]\n"selection.primary" = "red"\n', 'invalid-theme.toml');
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
