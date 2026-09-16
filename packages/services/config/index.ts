import type { CommandId, Result } from '../../contracts/src/index.ts';

/** Configuration files are parsed as untrusted text before this owner validates them. */
export interface ConfigDiagnostic {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly path: string;
  readonly code:
    | 'syntax-error'
    | 'duplicate-key'
    | 'invalid-type'
    | 'invalid-value'
    | 'missing-field'
    | 'unknown-key'
    | 'unknown-command'
    | 'duplicate-binding'
    | 'binding-prefix-conflict'
    | 'native-alias-collision'
    | 'untrusted-executable-change'
    | 'unsupported-schema';
  readonly message: string;
}

export interface SourceLocation {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
}

export type TomlValue = string | number | boolean | readonly TomlValue[] | { readonly [key: string]: TomlValue };

export interface TomlEntry {
  readonly path: readonly string[];
  readonly value: TomlValue;
  readonly location: SourceLocation;
}

export interface ParsedToml {
  readonly fileName: string;
  readonly value: { readonly [key: string]: TomlValue };
  readonly entries: readonly TomlEntry[];
}

export interface TomlParseFailure {
  readonly diagnostics: readonly ConfigDiagnostic[];
}

export type ConfigProfile = 'strict' | 'xi' | 'personal';

export interface ConfigCommandCatalog {
  readonly commandIds: readonly string[];
  readonly nativeExNames?: readonly string[];
}

export const DEFAULT_COMMAND_CATALOG: ConfigCommandCatalog = Object.freeze({
  commandIds: Object.freeze([
    'files.pick', 'buffers.pick', 'search.workspace', 'files.edit-directory', 'files.edit-buffer-directory', 'theme.pick',
    'lsp.code-action', 'lsp.rename', 'panel.files.focus', 'panel.search.focus', 'panel.git.focus', 'panel.outline.focus',
    'selection.add-above', 'selection.add-below', 'selection.add-next-match', 'selection.skip-next-match',
    'selection.select-all-matches', 'selection.split-lines', 'selection.select-regex', 'selection.keep-matching',
    'selection.remove-primary', 'selection.keep-primary', 'selection.rotate-primary-next', 'selection.rotate-primary-previous',
    'selection.collapse', 'selection.flip', 'selection.merge', 'selection.undo', 'buffer.next', 'buffer.previous',
    'config.open', 'config.reload', 'write.quit', 'quit.all', 'write.all',
  ]),
  nativeExNames: Object.freeze(['quit', 'write', 'wq', 'x', 'qa', 'wa', 'Xi']),
});

export interface ConfigLayer {
  readonly name: string;
  readonly kind: 'defaults' | 'user' | 'profile' | 'workspace' | 'language' | 'cli';
  readonly source: string;
  readonly fileName?: string;
  readonly trusted?: boolean;
}

export interface ConfigCompilerOptions {
  readonly profile?: ConfigProfile;
  readonly commandCatalog?: ConfigCommandCatalog;
  readonly nativeExNames?: readonly string[];
  readonly initialGeneration?: number;
}

export interface SelectionConfig {
  readonly limit: number;
  readonly historyLimit: number;
}

export interface MouseConfig {
  readonly enabled: boolean;
  readonly modifier: 'none' | 'shift' | 'alt' | 'ctrl' | 'meta';
  readonly scrollLines: number;
}

export interface EditorConfig {
  readonly theme: string;
  readonly lineNumber: 'absolute' | 'relative' | 'none';
  readonly scrolloff: number;
  readonly mouse: MouseConfig;
  readonly wrap: boolean;
  readonly motionTrail: 'off' | 'last-motion';
  readonly selection: SelectionConfig;
  readonly hintsDelayMs: number;
  readonly cursorShape: { readonly normal: 'block' | 'bar' | 'underline'; readonly insert: 'block' | 'bar' | 'underline'; readonly visual: 'block' | 'bar' | 'underline' };
  readonly lsp: { readonly enable: boolean; readonly inlayHints: boolean };
}

export interface SearchConfig {
  readonly debounceMs: number;
  readonly maxVisibleResults: number;
  readonly hidden: boolean;
  readonly followSymlinks: boolean;
}

export interface BindingConfig {
  readonly mode: string;
  readonly keys: readonly string[];
  readonly commandId: CommandId;
  readonly source: string;
}

export interface LanguageServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly rootMarkers: readonly string[];
}

export interface FormatterConfig {
  readonly command: string;
  readonly args: readonly string[];
}

export interface LanguageConfig {
  readonly name: string;
  readonly fileTypes: readonly string[];
  readonly languageServers: readonly string[];
  readonly indent: { readonly tabWidth: number; readonly unit: string } | undefined;
  readonly formatter: FormatterConfig | undefined;
  readonly formatters: readonly FormatterConfig[];
  readonly autoFormat: boolean;
}

export interface AliasConfig {
  readonly name: string;
  readonly commandId: CommandId;
  readonly source: string;
}

export interface CompiledConfig {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly profile: ConfigProfile;
  readonly editor: EditorConfig;
  readonly search: SearchConfig;
  readonly bindings: readonly BindingConfig[];
  readonly aliases: readonly AliasConfig[];
  readonly languageServers: readonly LanguageServerConfig[];
  readonly languages: readonly LanguageConfig[];
  readonly provenance: Readonly<Record<string, string>>;
}

export interface ConfigCompileFailure {
  readonly diagnostics: readonly ConfigDiagnostic[];
}

export type ConfigCompileResult = Result<CompiledConfig, ConfigCompileFailure>;

export interface CapturedConfigGeneration {
  readonly generation: number;
  readonly profile: ConfigProfile;
}

export class ConfigStore {
  #snapshot: CompiledConfig;

  constructor(initial: CompiledConfig) {
    this.#snapshot = initial;
  }

  get snapshot(): CompiledConfig { return this.#snapshot; }

  captureGeneration(): CapturedConfigGeneration {
    return Object.freeze({ generation: this.#snapshot.generation, profile: this.#snapshot.profile });
  }

  isCurrent(captured: CapturedConfigGeneration): boolean {
    return captured.generation === this.#snapshot.generation && captured.profile === this.#snapshot.profile;
  }

  /** Compile first, then publish one immutable generation. Failed reloads are invisible. */
  reload(layers: readonly ConfigLayer[], options: ConfigCompilerOptions = {}): ConfigCompileResult {
    const result = compileConfig(layers, {
      ...options,
      initialGeneration: this.#snapshot.generation,
      profile: options.profile ?? this.#snapshot.profile,
    });
    if (result.ok) this.#snapshot = result.value;
    return result;
  }
}

const defaultEditor: EditorConfig = Object.freeze({
  theme: 'xi-light', lineNumber: 'absolute', scrolloff: 5,
  mouse: Object.freeze({ enabled: true, modifier: 'none', scrollLines: 3 }), wrap: false,
  motionTrail: 'last-motion', selection: Object.freeze({ limit: 10_000, historyLimit: 100 }), hintsDelayMs: 250,
  cursorShape: Object.freeze({ normal: 'block', insert: 'block', visual: 'block' }),
  lsp: Object.freeze({ enable: true, inlayHints: false }),
});
const defaultSearch: SearchConfig = Object.freeze({ debounceMs: 40, maxVisibleResults: 10_000, hidden: true, followSymlinks: false });

/** Parse the TOML subset used by Xi config, language and theme files. */
export function parseToml(source: string, fileName = 'config.toml'): Result<ParsedToml, TomlParseFailure> {
  const root: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
  const entries: TomlEntry[] = [];
  let table: string[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  const lines = source.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const clean = stripComment(line);
    const trimmed = clean.trim();
    if (trimmed.length === 0) continue;
    const column = clean.search(/\S/u) + 1;
    if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
      const header = trimmed.slice(2, -2).trim();
      const path = parseDottedPath(header);
      if (path === undefined || path.length === 0) {
        diagnostics.push(diag(fileName, lineIndex + 1, column, '$', 'syntax-error', 'invalid array-table header'));
        continue;
      }
      if (tablePathConflicts(root, path.slice(0, -1))) {
        diagnostics.push(diag(fileName, lineIndex + 1, column, path.join('.'), 'invalid-type', 'array-table parent conflicts with a scalar'));
        continue;
      }
      const parent = ensureTable(root, path.slice(0, -1));
      const key = path[path.length - 1] as string;
      const previous = parent[key];
      if (previous !== undefined && !Array.isArray(previous)) {
        diagnostics.push(diag(fileName, lineIndex + 1, column, path.join('.'), 'invalid-type', 'array table conflicts with an existing table'));
        continue;
      }
      const list = Array.isArray(previous) ? [...previous] : [];
      const item: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
      list.push(item);
      parent[key] = list;
      table = [...path.slice(0, -1), key, String(list.length - 1)];
      continue;
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const header = trimmed.slice(1, -1).trim();
      const path = parseDottedPath(header);
      if (path === undefined || path.length === 0) {
        diagnostics.push(diag(fileName, lineIndex + 1, column, '$', 'syntax-error', 'invalid table header'));
        continue;
      }
      if (tablePathConflicts(root, path)) {
        diagnostics.push(diag(fileName, lineIndex + 1, column, path.join('.'), 'invalid-type', 'table conflicts with a scalar value'));
        continue;
      }
      ensureTable(root, path);
      table = path;
      continue;
    }
    const equals = findEquals(clean);
    if (equals < 0) {
      diagnostics.push(diag(fileName, lineIndex + 1, column, '$', 'syntax-error', 'expected a table header or key = value assignment'));
      continue;
    }
    const keyText = clean.slice(0, equals).trim();
    const pathParts = parseDottedPath(keyText);
    if (pathParts === undefined || pathParts.length === 0) {
      diagnostics.push(diag(fileName, lineIndex + 1, column, '$', 'syntax-error', 'invalid key'));
      continue;
    }
    const valueText = clean.slice(equals + 1).trim();
    const parsed = parseValue(valueText);
    if (!parsed.ok) {
      diagnostics.push(diag(fileName, lineIndex + 1, equals + 2, [...table, ...pathParts].join('.'), 'syntax-error', parsed.error.message));
      continue;
    }
    const fullPath = [...table, ...pathParts];
    const parent = ensureTable(root, fullPath.slice(0, -1));
    const key = fullPath[fullPath.length - 1] as string;
    if (parent[key] !== undefined) {
      diagnostics.push(diag(fileName, lineIndex + 1, column, fullPath.join('.'), 'duplicate-key', `duplicate key ${fullPath.join('.')}`));
      continue;
    }
    parent[key] = parsed.value;
    entries.push(Object.freeze({ path: Object.freeze(fullPath), value: parsed.value, location: Object.freeze({ fileName, line: lineIndex + 1, column }) }));
  }
  return diagnostics.length === 0
    ? { ok: true, value: Object.freeze({ fileName, value: freezeValue(root) as { readonly [key: string]: TomlValue }, entries: Object.freeze(entries) }) }
    : { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
}

export function compileConfig(layers: readonly ConfigLayer[], options: ConfigCompilerOptions = {}): ConfigCompileResult {
  const catalog = options.commandCatalog ?? DEFAULT_COMMAND_CATALOG;
  const parsed: { readonly layer: ConfigLayer; readonly document: ParsedToml }[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  for (const layer of layers) {
    const result = parseToml(layer.source, layer.fileName ?? `${layer.name}.toml`);
    if (!result.ok) diagnostics.push(...result.error.diagnostics);
    else parsed.push({ layer, document: result.value });
  }
  if (diagnostics.length > 0) return { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };

  const profile = options.profile ?? inferProfile(parsed);
  const active = parsed.filter(({ layer, document }) => layer.kind !== 'profile' || profile === 'personal' || document.value.profile !== 'personal');
  const merged: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
  const provenance: Record<string, string> = Object.create(null) as Record<string, string>;
  const locations = new Map<string, SourceLocation>();
  for (const { layer, document } of active) {
    if (layer.kind === 'workspace' && layer.trusted !== true && containsExecutableSetting(document.value)) {
      const location = document.entries.find((entry) => isExecutablePath(entry.path))?.location ?? { fileName: document.fileName, line: 1, column: 1 };
      diagnostics.push(diag(location.fileName, location.line, location.column, 'workspace', 'untrusted-executable-change', 'workspace executable settings require explicit trust'));
      continue;
    }
    validateKnownKeys(document, layer, diagnostics);
    for (const entry of document.entries) locations.set(entry.path.join('.'), entry.location);
    mergeValue(merged, document.value, '', layer.name, provenance, locations);
  }
  if (diagnostics.length > 0) return { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
  const compiled = validateMerged(merged, profile, catalog, provenance, locations);
  if (!compiled.ok) return compiled;
  const generation = (options.initialGeneration ?? 0) + 1;
  return { ok: true, value: Object.freeze({ ...compiled.value, generation }) };
}

function inferProfile(parsed: readonly { readonly layer: ConfigLayer; readonly document: ParsedToml }[]): ConfigProfile {
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const value = parsed[index]?.document.value.profile;
    if (value === 'strict' || value === 'xi' || value === 'personal') return value;
  }
  return 'xi';
}

export function compileInitialConfig(options: ConfigCompilerOptions = {}): ConfigCompileResult {
  return compileConfig([{ name: 'defaults', kind: 'defaults', source: DEFAULT_CONFIG_TOML, fileName: 'config/default.toml' }], options);
}

export function parseLanguageConfig(source: string, fileName = 'languages.toml'): Result<readonly LanguageConfig[], ConfigCompileFailure> {
  const parsed = parseToml(source, fileName);
  if (!parsed.ok) return parsed;
  const schemaDiagnostics: ConfigDiagnostic[] = [];
  for (const entry of parsed.value.entries) {
    const path = entry.path;
    const languageField = path[0] === 'language' && path.length >= 2 && /^\d+$/u.test(path[1] ?? '')
      && (path.length === 2 || ['name', 'file-types', 'language-servers', 'indent', 'indent.tab-width', 'indent.unit', 'formatter', 'formatter.command', 'formatter.args', 'formatters', 'auto-format'].includes(path.slice(2).join('.')));
    const serverField = path[0] === 'language-server' && (path.length === 2 || ['command', 'args', 'root-markers'].includes(path.at(-1) ?? ''));
    if (!(path[0] === 'schema-version' || languageField || serverField)) {
      schemaDiagnostics.push({ ...entry.location, path: path.join('.'), code: 'unknown-key', message: `unknown language configuration key ${path.join('.')}` });
    }
  }
  if (schemaDiagnostics.length > 0) return { ok: false, error: { diagnostics: Object.freeze(schemaDiagnostics) } };
  const root = parsed.value.value;
  const servers = asRecord(root['language-server']);
  const serverNames = new Set(Object.keys(servers ?? {}));
  const rawLanguages = root.language;
  if (!Array.isArray(rawLanguages)) return { ok: false, error: { diagnostics: [diag(fileName, 1, 1, 'language', 'missing-field', 'languages.toml requires at least one [[language]] table')] } };
  const diagnostics: ConfigDiagnostic[] = [];
  const values: LanguageConfig[] = [];
  for (let index = 0; index < rawLanguages.length; index += 1) {
    const record = asRecord(rawLanguages[index]);
    const path = `language[${index}]`;
    if (record === undefined) { diagnostics.push(diag(fileName, 1, 1, path, 'invalid-type', 'language entry must be a table')); continue; }
    const name = textField(record, 'name');
    const fileTypes = stringArrayField(record, 'file-types');
    const languageServers = stringArrayField(record, 'language-servers') ?? [];
    if (name === undefined || fileTypes === undefined) { diagnostics.push(diag(fileName, 1, 1, path, 'missing-field', 'language requires name and file-types')); continue; }
    for (const server of languageServers) if (!serverNames.has(server)) diagnostics.push(diag(fileName, 1, 1, `${path}.language-servers`, 'invalid-value', `unknown language server ${server}`));
    const indentRecord = asRecord(record.indent);
    const indent = indentRecord === undefined ? undefined : {
      tabWidth: integerField(indentRecord, 'tab-width') ?? 2,
      unit: textField(indentRecord, 'unit') ?? '\t',
    };
    const formatter = formatterValue(record.formatter, fileName, `${path}.formatter`, diagnostics);
    const formattersRaw = record.formatters;
    const formatters = Array.isArray(formattersRaw) ? formattersRaw.map((value, formatterIndex) => formatterValue(value, fileName, `${path}.formatters[${formatterIndex}]`, diagnostics)).filter((item): item is FormatterConfig => item !== undefined) : [];
    values.push(Object.freeze({ name, fileTypes, languageServers, indent: indent === undefined ? undefined : Object.freeze(indent), formatter, formatters: Object.freeze(formatters), autoFormat: booleanField(record, 'auto-format') ?? false }));
  }
  return diagnostics.length === 0 ? { ok: true, value: Object.freeze(values) } : { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
}

export interface ThemeConfig { readonly schemaVersion: 1; readonly name: string; readonly tokens: Readonly<Record<string, string>>; }

export function parseThemeConfig(source: string, fileName = 'theme.toml'): Result<ThemeConfig, ConfigCompileFailure> {
  const parsed = parseToml(source, fileName);
  if (!parsed.ok) return parsed;
  const root = parsed.value.value;
  const version = root['schema-version'];
  const name = root.name;
  const tokens = asRecord(root.tokens);
  const diagnostics: ConfigDiagnostic[] = [];
  if (version !== 1) diagnostics.push(diag(fileName, 1, 1, 'schema-version', 'unsupported-schema', 'theme schema-version must be 1'));
  if (typeof name !== 'string' || name.length === 0) diagnostics.push(diag(fileName, 1, 1, 'name', 'missing-field', 'theme name is required'));
  if (tokens === undefined) diagnostics.push(diag(fileName, 1, 1, 'tokens', 'missing-field', 'theme tokens table is required'));
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(tokens ?? {})) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) diagnostics.push(diag(fileName, 1, 1, `tokens.${key}`, 'invalid-value', 'theme token must be a six-digit hexadecimal color'));
    else output[key] = value;
  }
  return diagnostics.length === 0 ? { ok: true, value: Object.freeze({ schemaVersion: 1, name: name as string, tokens: Object.freeze(output) }) } : { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
}

export const DEFAULT_CONFIG_TOML = `schema-version = 1
profile = "xi"

[editor]
theme = "xi-light"
line-number = "absolute"
scrolloff = 5
wrap = false
motion-trail = "last-motion"
selection-limit = 10000
selection-history-limit = 100

[editor.cursor-shape]
normal = "block"
insert = "block"
visual = "block"

[editor.lsp]
enable = true
inlay-hints = false

[editor.mouse]
enabled = true
modifier = "none"
scroll-lines = 3

[editor.hints]
delay-ms = 250

[search]
debounce-ms = 40
max-visible-results = 10000
hidden = true
follow-symlinks = false

[keys.normal.space]
f = "files.pick"
b = "buffers.pick"
"/" = "search.workspace"
o = "files.edit-directory"
O = "files.edit-buffer-directory"
t = "theme.pick"
a = "lsp.code-action"
r = "lsp.rename"

[keys.normal.space.v]
f = "panel.files.focus"
s = "panel.search.focus"
g = "panel.git.focus"
o = "panel.outline.focus"

[aliases]
buffer-next = "buffer.next"
buffer-previous = "buffer.previous"
theme = "theme.pick"
config-open = "config.open"
config-reload = "config.reload"
write-quit = "write.quit"
quit-all = "quit.all"
write-all = "write.all"
`;

export const PERSONAL_MIGRATION_TOML = `schema-version = 1
profile = "personal"

[editor]
theme = "xi-light"
mouse = true
motion-trail = "last-motion"

[keys.normal.space]
t = "theme.pick"

[aliases]
theme = "theme.pick"
buffer-next = "buffer.next"
buffer-previous = "buffer.previous"
`;

export const DEFAULT_LANGUAGES_TOML = `schema-version = 1

[language-server.typescript]
command = "typescript-language-server"
args = ["--stdio"]
root-markers = ["tsconfig.json", "package.json", ".git"]

[[language]]
name = "typescript"
file-types = ["ts", "tsx"]
language-servers = ["typescript"]
indent = { tab-width = 2, unit = "\\t" }
formatter = { command = "biome", args = ["format", "--stdin-file-path", "{file}"] }
auto-format = true
`;

export const DEFAULT_THEME_TOML = `schema-version = 1
name = "xi-light"

[tokens]
"selection.primary" = "#D6E5F2"
"selection.secondary" = "#E4ECF3"
"cursor.primary" = "#263238"
"cursor.secondary" = "#455A64"
"motion.trail" = "#EEF2F4"
"operator.preview" = "#B0BEC5"
`;

function validateKnownKeys(document: ParsedToml, layer: ConfigLayer, diagnostics: ConfigDiagnostic[]): void {
  for (const entry of document.entries) {
    const path = entry.path.join('.');
    if (isKnownPath(entry.path)) continue;
    diagnostics.push({ ...entry.location, path, code: 'unknown-key', message: `unknown configuration key ${path}` });
  }
  const version = document.value['schema-version'];
  if (version !== undefined && version !== 1) diagnostics.push({ fileName: document.fileName, line: 1, column: 1, path: 'schema-version', code: 'unsupported-schema', message: `unsupported configuration schema ${String(version)}` });
  void layer;
}

function validateMerged(
  root: Record<string, TomlValue>, profile: ConfigProfile, catalog: ConfigCommandCatalog,
  provenance: Record<string, string>, locations: Map<string, SourceLocation>,
): ConfigCompileResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const editor = asRecord(root.editor) ?? Object.create(null) as Record<string, TomlValue>;
  const search = asRecord(root.search) ?? Object.create(null) as Record<string, TomlValue>;
  const editorMouse = asRecord(editor.mouse);
  const cursorShape = asRecord(editor['cursor-shape']);
  const lsp = asRecord(editor.lsp);
  const hints = asRecord(editor.hints);
  const schemaVersion = root['schema-version'];
  if (schemaVersion !== undefined && schemaVersion !== 1) diagnostics.push(issue('schema-version', 'unsupported-schema', 'schema-version must be 1', locations));
  const theme = textField(editor, 'theme') ?? 'xi-light';
  const lineNumber = enumField(editor, 'line-number', ['absolute', 'relative', 'none'] as const, 'absolute', diagnostics, locations, 'editor.line-number');
  const scrolloff = boundedInteger(editor, 'scrolloff', 0, 1000, 5, diagnostics, locations, 'editor.scrolloff');
  const mouseEnabled = booleanField(editor, 'mouse') ?? booleanField(editorMouse ?? Object.create(null), 'enabled') ?? true;
  const mouseModifier = enumField(editorMouse ?? Object.create(null), 'modifier', ['none', 'shift', 'alt', 'ctrl', 'meta'] as const, 'none', diagnostics, locations, 'editor.mouse.modifier');
  const scrollLines = boundedInteger(editorMouse ?? Object.create(null), 'scroll-lines', 1, 1000, 3, diagnostics, locations, 'editor.mouse.scroll-lines');
  const wrap = booleanField(editor, 'wrap') ?? false;
  const configuredMotionTrail = enumField(editor, 'motion-trail', ['off', 'last-motion'] as const, profile === 'strict' ? 'off' : 'last-motion', diagnostics, locations, 'editor.motion-trail');
  const motionTrail = profile === 'strict' ? 'off' : configuredMotionTrail;
  const selectionLimit = boundedInteger(editor, 'selection-limit', 1, 10_000_000, 10_000, diagnostics, locations, 'editor.selection-limit');
  const selectionHistoryLimit = boundedInteger(editor, 'selection-history-limit', 1, 10_000, 100, diagnostics, locations, 'editor.selection-history-limit');
  const hintsDelayMs = boundedInteger(hints ?? Object.create(null), 'delay-ms', 0, 60_000, 250, diagnostics, locations, 'editor.hints.delay-ms');
  const shapes = {
    normal: enumField(cursorShape ?? Object.create(null), 'normal', ['block', 'bar', 'underline'] as const, 'block', diagnostics, locations, 'editor.cursor-shape.normal'),
    insert: enumField(cursorShape ?? Object.create(null), 'insert', ['block', 'bar', 'underline'] as const, 'block', diagnostics, locations, 'editor.cursor-shape.insert'),
    visual: enumField(cursorShape ?? Object.create(null), 'visual', ['block', 'bar', 'underline'] as const, 'block', diagnostics, locations, 'editor.cursor-shape.visual'),
  };
  const lspConfig = { enable: booleanField(lsp ?? Object.create(null), 'enable') ?? true, inlayHints: booleanField(lsp ?? Object.create(null), 'inlay-hints') ?? false };
  const searchConfig: SearchConfig = Object.freeze({
    debounceMs: boundedInteger(search, 'debounce-ms', 0, 60_000, 40, diagnostics, locations, 'search.debounce-ms'),
    maxVisibleResults: boundedInteger(search, 'max-visible-results', 1, 1_000_000, 10_000, diagnostics, locations, 'search.max-visible-results'),
    hidden: booleanField(search, 'hidden') ?? true,
    followSymlinks: booleanField(search, 'follow-symlinks') ?? false,
  });
  const catalogIds = new Set(catalog.commandIds);
  const bindings = compileBindings(root.keys, profile, catalogIds, provenance, locations, diagnostics);
  const aliases = compileAliases(root.aliases, profile, catalogIds, catalog.nativeExNames ?? DEFAULT_COMMAND_CATALOG.nativeExNames ?? [], provenance, locations, diagnostics);
  const languageServers = compileServers(root['language-server'], locations, diagnostics);
  const languages = compileLanguages(root.language, languageServers, locations, diagnostics);
  if (diagnostics.length > 0) return { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
  const editorConfig: EditorConfig = Object.freeze({ theme, lineNumber, scrolloff, mouse: Object.freeze({ enabled: mouseEnabled, modifier: mouseModifier, scrollLines }), wrap, motionTrail, selection: Object.freeze({ limit: selectionLimit, historyLimit: selectionHistoryLimit }), hintsDelayMs, cursorShape: Object.freeze(shapes), lsp: Object.freeze(lspConfig) });
  return { ok: true, value: Object.freeze({ schemaVersion: 1, generation: 0, profile, editor: editorConfig, search: searchConfig, bindings: Object.freeze(bindings), aliases: Object.freeze(aliases), languageServers: Object.freeze(languageServers), languages: Object.freeze(languages), provenance: Object.freeze({ ...provenance }) }) };
}

function compileBindings(value: TomlValue | undefined, profile: ConfigProfile, commandIds: Set<string>, provenance: Record<string, string>, locations: Map<string, SourceLocation>, diagnostics: ConfigDiagnostic[]): BindingConfig[] {
  const modes = asRecord(value);
  if (modes === undefined) return [];
  const output: BindingConfig[] = [];
  const seen = new Map<string, BindingConfig>();
  const walk = (node: Record<string, TomlValue>, path: string[], keys: string[]): void => {
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string') {
        const commandPath = [...path, key].join('.');
        if (!commandIds.has(child)) { diagnostics.push(issue(commandPath, 'unknown-command', `unknown command ${child}`, locations)); continue; }
        const mode = path[0] ?? 'normal';
        if (profile === 'strict' && mode !== 'normal' && mode !== 'visual' && mode !== 'insert' && mode !== 'replace' && mode !== 'operator-pending' && mode !== 'command-line') {
          diagnostics.push(issue(commandPath, 'invalid-value', `unknown mapping mode ${mode}`, locations));
        }
        const token = normalizeKeyToken(key);
        if (token === undefined) { diagnostics.push(issue(commandPath, 'invalid-value', `unknown key ${key}`, locations)); continue; }
        const nextKeys = [...keys, token];
        const normalized = JSON.stringify(nextKeys.map(normalizeCanonicalKey));
        const prior = seen.get(`${mode}\u0000${normalized}`);
        if (prior !== undefined) { diagnostics.push(issue(commandPath, 'duplicate-binding', `duplicate normalized binding ${nextKeys.join(' ')}`, locations)); continue; }
        for (const priorBinding of seen.values()) {
          if (priorBinding.mode !== mode) continue;
          const prefix = isPrefix(priorBinding.keys, nextKeys) || isPrefix(nextKeys, priorBinding.keys);
          if (prefix) diagnostics.push(issue(commandPath, 'binding-prefix-conflict', `binding ${nextKeys.join(' ')} conflicts with ${priorBinding.keys.join(' ')}`, locations));
        }
        const binding = Object.freeze({ mode, keys: Object.freeze(nextKeys), commandId: child as CommandId, source: provenance[`keys.${commandPath}`] ?? provenance[commandPath] ?? 'merged' });
        seen.set(`${mode}\u0000${normalized}`, binding);
        output.push(binding);
      } else if (asRecord(child) !== undefined) walk(asRecord(child) as Record<string, TomlValue>, [...path, key], [...keys, normalizeKeyToken(key) ?? key]);
    }
  };
  for (const [mode, valueForMode] of Object.entries(modes)) {
    const record = asRecord(valueForMode);
    if (record !== undefined) walk(record, [mode], []);
  }
  return output;
}

function compileAliases(value: TomlValue | undefined, profile: ConfigProfile, commandIds: Set<string>, nativeExNames: readonly string[], provenance: Record<string, string>, locations: Map<string, SourceLocation>, diagnostics: ConfigDiagnostic[]): AliasConfig[] {
  if (profile === 'strict') return [];
  const aliases = asRecord(value);
  if (aliases === undefined) return [];
  const native = new Set(nativeExNames.map((item) => item.toLowerCase()));
  const seen = new Set<string>();
  const output: AliasConfig[] = [];
  for (const [name, target] of Object.entries(aliases)) {
    const path = `aliases.${name}`;
    if (typeof target !== 'string' || !commandIds.has(target)) { diagnostics.push(issue(path, typeof target === 'string' ? 'unknown-command' : 'invalid-type', `alias ${name} must target a known command`, locations)); continue; }
    const normalized = normalizeAlias(name);
    if (normalized === undefined) { diagnostics.push(issue(path, 'invalid-value', `invalid alias ${name}`, locations)); continue; }
    if ([...native].some((reserved) => reserved === normalized || reserved.startsWith(normalized))) { diagnostics.push(issue(path, 'native-alias-collision', `alias ${name} is reserved by native Ex`, locations)); continue; }
    if (seen.has(normalized)) { diagnostics.push(issue(path, 'duplicate-binding', `duplicate normalized alias ${name}`, locations)); continue; }
    seen.add(normalized);
    output.push(Object.freeze({ name, commandId: target as CommandId, source: provenance[path] ?? 'merged' }));
  }
  return output;
}

function compileServers(value: TomlValue | undefined, locations: Map<string, SourceLocation>, diagnostics: ConfigDiagnostic[]): LanguageServerConfig[] {
  const servers = asRecord(value);
  if (servers === undefined) return [];
  const output: LanguageServerConfig[] = [];
  for (const [name, valueForServer] of Object.entries(servers)) {
    const record = asRecord(valueForServer);
    const path = `language-server.${name}`;
    const command = record === undefined ? undefined : textField(record, 'command');
    if (command === undefined || command.length === 0) { diagnostics.push(issue(path, 'missing-field', 'language server command is required', locations)); continue; }
    const serverRecord = record as Record<string, TomlValue>;
    output.push(Object.freeze({ name, command, args: stringArrayField(serverRecord, 'args') ?? [], rootMarkers: stringArrayField(serverRecord, 'root-markers') ?? [] }));
  }
  return output;
}

function compileLanguages(value: TomlValue | undefined, servers: readonly LanguageServerConfig[], locations: Map<string, SourceLocation>, diagnostics: ConfigDiagnostic[]): LanguageConfig[] {
  const values = Array.isArray(value) ? value : [];
  const names = new Set(servers.map((server) => server.name));
  const output: LanguageConfig[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const record = asRecord(values[index]);
    const path = `language[${index}]`;
    if (record === undefined) { diagnostics.push(issue(path, 'invalid-type', 'language entry must be a table', locations)); continue; }
    const name = textField(record, 'name');
    const fileTypes = stringArrayField(record, 'file-types');
    const languageServers = stringArrayField(record, 'language-servers') ?? [];
    if (name === undefined || fileTypes === undefined) { diagnostics.push(issue(path, 'missing-field', 'language requires name and file-types', locations)); continue; }
    for (const server of languageServers) if (!names.has(server)) diagnostics.push(issue(`${path}.language-servers`, 'invalid-value', `unknown language server ${server}`, locations));
    const indentRecord = asRecord(record.indent);
    const indent = indentRecord === undefined ? undefined : Object.freeze({ tabWidth: integerField(indentRecord, 'tab-width') ?? 2, unit: textField(indentRecord, 'unit') ?? '\t' });
    const formatters: FormatterConfig[] = [];
    if (Array.isArray(record.formatters)) for (const item of record.formatters) { const formatter = formatterValue(item, locations.get(path)?.fileName ?? 'config.toml', path, diagnostics); if (formatter !== undefined) formatters.push(formatter); }
    output.push(Object.freeze({ name, fileTypes, languageServers, indent, formatter: formatterValue(record.formatter, locations.get(path)?.fileName ?? 'config.toml', `${path}.formatter`, diagnostics), formatters: Object.freeze(formatters), autoFormat: booleanField(record, 'auto-format') ?? false }));
  }
  return output;
}

function formatterValue(value: TomlValue | undefined, fileName: string, path: string, diagnostics: ConfigDiagnostic[]): FormatterConfig | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (record === undefined) { diagnostics.push(diag(fileName, 1, 1, path, 'invalid-type', 'formatter must be an inline table')); return undefined; }
  const command = textField(record, 'command');
  if (command === undefined) { diagnostics.push(diag(fileName, 1, 1, path, 'missing-field', 'formatter command is required')); return undefined; }
  return Object.freeze({ command, args: stringArrayField(record, 'args') ?? [] });
}

function isKnownPath(path: readonly string[]): boolean {
  const joined = path.join('.');
  if (joined === 'schema-version' || joined === 'profile') return true;
  if (joined === 'editor' || joined === 'search' || joined === 'aliases' || joined === 'keys' || joined === 'language-server' || joined === 'language') return true;
  if (joined.startsWith('aliases.') || joined.startsWith('keys.')) return true;
  const editorPaths = new Set([
    'editor.theme', 'editor.line-number', 'editor.scrolloff', 'editor.mouse', 'editor.wrap', 'editor.motion-trail',
    'editor.selection-limit', 'editor.selection-history-limit', 'editor.cursor-shape', 'editor.cursor-shape.normal',
    'editor.cursor-shape.insert', 'editor.cursor-shape.visual', 'editor.lsp', 'editor.lsp.enable', 'editor.lsp.inlay-hints',
    'editor.mouse.enabled', 'editor.mouse.modifier', 'editor.mouse.scroll-lines', 'editor.hints', 'editor.hints.delay-ms',
  ]);
  if (editorPaths.has(joined)) return true;
  const searchPaths = new Set(['search.debounce-ms', 'search.max-visible-results', 'search.hidden', 'search.follow-symlinks']);
  if (searchPaths.has(joined)) return true;
  if (path[0] === 'language-server' && (path.length === 2 || ['command', 'args', 'root-markers'].includes(path.at(-1) ?? ''))) return true;
  if (path[0] === 'language') {
    const fields = new Set(['name', 'file-types', 'language-servers', 'indent', 'indent.tab-width', 'indent.unit', 'formatter', 'formatter.command', 'formatter.args', 'formatters', 'auto-format']);
    const suffix = path.slice(2).join('.');
    return /^language\.\d+(?:\.[a-z-]+(?:\.[a-z-]+)?)?$/u.test(joined) && (path.length === 2 || fields.has(suffix));
  }
  return false;
}

function isExecutablePath(path: readonly string[]): boolean {
  return path.includes('command') || path.includes('args') || path.includes('formatter') || path.includes('formatters') || path.includes('task');
}

function containsExecutableSetting(value: TomlValue): boolean {
  if (Array.isArray(value)) return value.some((item) => containsExecutableSetting(item));
  const record = asRecord(value);
  if (record === undefined) return false;
  for (const [key, child] of Object.entries(record)) if (isExecutablePath([key]) || containsExecutableSetting(child)) return true;
  return false;
}

function mergeValue(target: Record<string, TomlValue>, source: { readonly [key: string]: TomlValue }, prefix: string, sourceName: string, provenance: Record<string, string>, locations: Map<string, SourceLocation>): void {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    const existing = target[key];
    if (isTable(value) && isTable(existing)) mergeValue(existing as Record<string, TomlValue>, value, path, sourceName, provenance, locations);
    else {
      target[key] = cloneValue(value);
      provenance[path] = sourceName;
      markLeafProvenance(value, path, sourceName, provenance);
    }
  }
}

function markLeafProvenance(value: TomlValue, path: string, sourceName: string, provenance: Record<string, string>): void {
  provenance[path] = sourceName;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) markLeafProvenance(value[index] as TomlValue, `${path}.${index}`, sourceName, provenance);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, TomlValue>)) markLeafProvenance(child, `${path}.${key}`, sourceName, provenance);
}

function isTable(value: TomlValue | undefined): value is { readonly [key: string]: TomlValue } { return asRecord(value) !== undefined; }
function cloneValue(value: TomlValue): TomlValue { if (Array.isArray(value)) return value.map(cloneValue); if (isTable(value)) { const record: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>; for (const [key, child] of Object.entries(value)) record[key] = cloneValue(child); return record; } return value; }
function freezeValue(value: TomlValue): TomlValue { if (Array.isArray(value)) return Object.freeze(value.map(freezeValue)); if (isTable(value)) { const record: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>; for (const [key, child] of Object.entries(value)) record[key] = freezeValue(child); return Object.freeze(record); } return value; }

function ensureTable(root: Record<string, TomlValue>, path: readonly string[]): Record<string, TomlValue> {
  let current: Record<string, TomlValue> = root;
  for (let pathIndex = 0; pathIndex < path.length; pathIndex += 1) {
    const key = path[pathIndex] as string;
    const existing = current[key];
    if (isTable(existing)) current = existing as Record<string, TomlValue>;
    else if (Array.isArray(existing) && /^\d+$/u.test(path[pathIndex + 1] ?? '')) {
      const mutable = existing as TomlValue[];
      const item = mutable[Number(path[pathIndex + 1])];
      if (isTable(item)) { current = item as Record<string, TomlValue>; pathIndex += 1; }
      else { const next: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>; mutable[Number(path[pathIndex + 1])] = next; current = next; pathIndex += 1; }
    } else {
      const next: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
      current[key] = next;
      current = next;
    }
  }
  return current;
}

function tablePathConflicts(root: Record<string, TomlValue>, path: readonly string[]): boolean {
  let current: TomlValue = root;
  for (let index = 0; index < path.length; index += 1) {
    if (Array.isArray(current)) {
      const array = current as readonly TomlValue[];
      const item: TomlValue | undefined = array[Number(path[index])];
      if (item === undefined) return false;
      current = item;
      continue;
    }
    const record = asRecord(current);
    if (record === undefined) return true;
    const child = record[path[index] as string];
    if (child === undefined) return false;
    current = child;
  }
  return current !== undefined && !Array.isArray(current) && asRecord(current) === undefined;
}

function parseDottedPath(value: string): string[] | undefined {
  const result: string[] = [];
  let rest = value.trim();
  while (rest.length > 0) {
    const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_/-]+))/u.exec(rest);
    if (match === null) return undefined;
    const key = match[1] ?? match[2] ?? match[3];
    if (key === undefined || key.length === 0) return undefined;
    result.push(unescapeString(key));
    rest = rest.slice(match[0].length).trim();
    if (rest.length === 0) break;
    if (!rest.startsWith('.')) return undefined;
    rest = rest.slice(1).trim();
  }
  return result;
}

function parseValue(value: string): Result<TomlValue, { readonly message: string }> {
  const trimmed = value.trim();
  if (trimmed === 'true' || trimmed === 'false') return { ok: true, value: trimmed === 'true' };
  if (/^[+-]?(?:0|[1-9][0-9_]*)$/u.test(trimmed)) return { ok: true, value: Number(trimmed.replaceAll('_', '')) };
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return { ok: true, value: unescapeString(trimmed.slice(1, -1)) };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const parts = splitTopLevel(trimmed.slice(1, -1), ',');
    const values: TomlValue[] = [];
    for (const part of parts) { if (part.trim().length === 0) continue; const item = parseValue(part); if (!item.ok) return item; values.push(item.value); }
    return { ok: true, value: Object.freeze(values) };
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const record: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
    for (const part of splitTopLevel(trimmed.slice(1, -1), ',')) {
      if (part.trim().length === 0) continue;
      const equals = findEquals(part);
      if (equals < 0) return { ok: false, error: { message: 'invalid inline table entry' } };
      const key = parseDottedPath(part.slice(0, equals).trim());
      const item = parseValue(part.slice(equals + 1));
      if (key === undefined || key.length !== 1 || !item.ok) return { ok: false, error: { message: 'invalid inline table entry' } };
      record[key[0] as string] = item.value;
    }
    return { ok: true, value: Object.freeze(record) };
  }
  return { ok: false, error: { message: `unsupported TOML value ${trimmed}` } };
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const result: string[] = [];
  let start = 0; let depth = 0; let quote = ''; let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (quote.length > 0) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[' || char === '{') depth += 1; else if (char === ']' || char === '}') depth -= 1;
    else if (char === delimiter && depth === 0) { result.push(value.slice(start, index)); start = index + 1; }
  }
  result.push(value.slice(start));
  return result;
}

function stripComment(value: string): string { let quote = ''; let escaped = false; for (let index = 0; index < value.length; index += 1) { const char = value[index] as string; if (quote.length > 0) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; } else if (char === '"' || char === "'") quote = char; else if (char === '#') return value.slice(0, index); } return value; }
function findEquals(value: string): number { let quote = ''; let depth = 0; let escaped = false; for (let index = 0; index < value.length; index += 1) { const char = value[index] as string; if (quote.length > 0) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; } if (char === '"' || char === "'") quote = char; else if (char === '[' || char === '{') depth += 1; else if (char === ']' || char === '}') depth -= 1; else if (char === '=' && depth === 0) return index; } return -1; }
function unescapeString(value: string): string { return value.replaceAll(/\\([\\"'nrt])/gu, (_match, escaped: string) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" }[escaped] ?? escaped)); }
function normalizeAlias(value: string): string | undefined { return /^[a-z][a-z0-9_-]*$/iu.test(value) ? value.toLowerCase() : undefined; }
function normalizeCanonicalKey(value: string): string { return value.startsWith('<') ? value.toLowerCase() : value; }
function isPrefix(left: readonly string[], right: readonly string[]): boolean { return left.length < right.length && left.every((value, index) => normalizeCanonicalKey(value) === normalizeCanonicalKey(right[index] as string)); }
function normalizeKeyToken(value: string): string | undefined { const named = new Map([['space', '<Space>'], ['esc', '<Esc>'], ['escape', '<Esc>'], ['enter', '<Enter>'], ['return', '<Enter>'], ['tab', '<Tab>'], ['backspace', '<BS>'], ['up', '<Up>'], ['down', '<Down>'], ['left', '<Left>'], ['right', '<Right>']]); const lower = value.toLowerCase(); if (named.has(lower)) return named.get(lower); if (/^<(?:(?:c|ctrl|a|alt|m|meta|s|shift)-)?[a-z0-9]+>$/iu.test(value)) return value; if (value.length === 1 && value !== '\u0000' && !/\s/u.test(value)) return value; return undefined; }
function asRecord(value: TomlValue | undefined): Record<string, TomlValue> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, TomlValue> : undefined; }
function textField(record: Record<string, TomlValue>, key: string): string | undefined { const value = record[key]; return typeof value === 'string' ? value : undefined; }
function stringArrayField(record: Record<string, TomlValue>, key: string): readonly string[] | undefined { const value = record[key]; return Array.isArray(value) && value.every((item) => typeof item === 'string') ? Object.freeze(value as string[]) : undefined; }
function integerField(record: Record<string, TomlValue>, key: string): number | undefined { const value = record[key]; return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
function booleanField(record: Record<string, TomlValue>, key: string): boolean | undefined { const value = record[key]; return typeof value === 'boolean' ? value : undefined; }
function boundedInteger(record: Record<string, TomlValue>, key: string, min: number, max: number, fallback: number, diagnostics: ConfigDiagnostic[], locations: Map<string, SourceLocation>, path: string): number { const value = record[key]; if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) { diagnostics.push(issue(path, 'invalid-value', `${path} must be an integer from ${min} to ${max}`, locations)); return fallback; } return value; }
function enumField<T extends string>(record: Record<string, TomlValue>, key: string, values: readonly T[], fallback: T, diagnostics: ConfigDiagnostic[], locations: Map<string, SourceLocation>, path: string): T { const value = record[key]; if (value === undefined) return fallback; if (typeof value !== 'string' || !values.includes(value as T)) { diagnostics.push(issue(path, 'invalid-value', `${path} must be one of ${values.join(', ')}`, locations)); return fallback; } return value as T; }
function issue(path: string, code: ConfigDiagnostic['code'], message: string, locations: Map<string, SourceLocation>): ConfigDiagnostic { const location = locations.get(path) ?? { fileName: 'config.toml', line: 1, column: 1 }; return { ...location, path, code, message }; }
function diag(fileName: string, line: number, column: number, path: string, code: ConfigDiagnostic['code'], message: string): ConfigDiagnostic { return { fileName, line, column, path, code, message }; }
