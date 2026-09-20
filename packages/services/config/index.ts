import type { CancellationToken, CommandId, PlatformFailure, Result } from '../../contracts/src/index.ts';

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
    | 'unsupported-schema'
    | 'disposed';
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
    'files.pick', 'buffers.pick', 'command.pick', 'search.workspace', 'search.replace', 'files.edit-directory', 'files.edit-buffer-directory', 'theme.pick',
    'lsp.hover', 'lsp.code-action', 'lsp.rename', 'panel.files.focus', 'panel.search.focus', 'panel.git.focus', 'panel.outline.focus', 'panel.problems.focus', 'panel.preview', 'panel.open', 'panel.close', 'git.diff', 'editor.mouse.toggle', 'sidebar.toggle', 'macro.record',
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
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly sidebarPanel: 'files' | 'search' | 'git';
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
  #disposed = false;

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
    if (this.#disposed) return { ok: false, error: { diagnostics: Object.freeze([disposedDiagnostic()]) } };
    const result = compileConfig(layers, {
      ...options,
      initialGeneration: this.#snapshot.generation,
      profile: options.profile ?? this.#snapshot.profile,
    });
    if (result.ok) this.#snapshot = result.value;
    return result;
  }

  /** Idempotent. Later reloads fail with a `disposed` diagnostic; `snapshot` keeps returning the last compiled config. */
  dispose(): void {
    this.#disposed = true;
  }
}

function disposedDiagnostic(): ConfigDiagnostic {
  return { fileName: '<config-store>', line: 1, column: 1, path: '$', code: 'disposed', message: 'config store is disposed' };
}

const defaultEditor: EditorConfig = Object.freeze({
  sidebarVisible: true, sidebarWidth: 28, sidebarPanel: 'files',
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
  const lines = logicalTomlLines(source);
  for (const logicalLine of lines) {
    const lineIndex = logicalLine.line - 1;
    const line = logicalLine.source;
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

export interface TaskConfig {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly problemMatcher: 'generic-compiler' | 'none';
}

/** Configured argv tasks (docs/plan/04-services.md's "basic tasks" contract): explicit argv,
 * cwd/env, and an optional built-in problem matcher -- never automatic shell evaluation. */
export function parseTasksConfig(source: string, fileName = 'tasks.toml'): Result<readonly TaskConfig[], ConfigCompileFailure> {
  const parsed = parseToml(source, fileName);
  if (!parsed.ok) return parsed;
  const schemaDiagnostics: ConfigDiagnostic[] = [];
  for (const entry of parsed.value.entries) {
    const path = entry.path;
    const taskField = path[0] === 'task' && path.length >= 2 && /^\d+$/u.test(path[1] ?? '')
      && (path.length === 2 || ['id', 'argv', 'cwd', 'env', 'problem-matcher'].includes(path.slice(2).join('.')));
    if (!(path[0] === 'schema-version' || taskField)) {
      schemaDiagnostics.push({ ...entry.location, path: path.join('.'), code: 'unknown-key', message: `unknown task configuration key ${path.join('.')}` });
    }
  }
  if (schemaDiagnostics.length > 0) return { ok: false, error: { diagnostics: Object.freeze(schemaDiagnostics) } };
  const root = parsed.value.value;
  const rawTasks = root.task;
  if (!Array.isArray(rawTasks)) return { ok: false, error: { diagnostics: [diag(fileName, 1, 1, 'task', 'missing-field', 'tasks.toml requires at least one [[task]] table')] } };
  const diagnostics: ConfigDiagnostic[] = [];
  const values: TaskConfig[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < rawTasks.length; index += 1) {
    const record = asRecord(rawTasks[index]);
    const path = `task[${index}]`;
    if (record === undefined) { diagnostics.push(diag(fileName, 1, 1, path, 'invalid-type', 'task entry must be a table')); continue; }
    const id = textField(record, 'id');
    const argv = stringArrayField(record, 'argv');
    if (id === undefined || argv === undefined || argv.length === 0) { diagnostics.push(diag(fileName, 1, 1, path, 'missing-field', 'task requires id and a non-empty argv')); continue; }
    if (seenIds.has(id)) { diagnostics.push(diag(fileName, 1, 1, path, 'invalid-value', `duplicate task id ${id}`)); continue; }
    seenIds.add(id);
    const cwd = textField(record, 'cwd');
    const envRecord = asRecord(record.env);
    const env: Record<string, string> = {};
    if (envRecord !== undefined) for (const [key, value] of Object.entries(envRecord)) if (typeof value === 'string') env[key] = value;
    const problemMatcherRaw = textField(record, 'problem-matcher');
    const problemMatcher: TaskConfig['problemMatcher'] = problemMatcherRaw === 'generic-compiler' ? 'generic-compiler' : 'none';
    values.push(Object.freeze({ id, argv: [argv[0] as string, ...argv.slice(1)] as [string, ...string[]], ...(cwd === undefined ? {} : { cwd }), env: Object.freeze(env), problemMatcher }));
  }
  return diagnostics.length === 0 ? { ok: true, value: Object.freeze(values) } : { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
}

/** Helix theme files are deliberately free-form: a scope is either a foreground colour or a
 * style table. Keep that representation intact here; UI adapters choose the scopes they paint. */
export interface HelixThemeStyle {
  readonly fg?: string;
  readonly bg?: string;
  readonly modifiers?: readonly string[];
  readonly underline?: { readonly color?: string; readonly style?: string };
}

export interface ThemeConfig {
  readonly inherits?: string;
  readonly palette: Readonly<Record<string, string>>;
  readonly styles: Readonly<Record<string, HelixThemeStyle>>;
  /** Helix also permits non-style theme data (for example a grammar's rainbow palette). Xi
   * preserves it even when no current surface consumes it. */
  readonly extras: Readonly<Record<string, TomlValue>>;
}

const HELIX_MODIFIERS = new Set(['bold', 'dim', 'italic', 'underlined', 'slow_blink', 'rapid_blink', 'reversed', 'hidden', 'crossed_out']);
const HELIX_UNDERLINE_STYLES = new Set(['line', 'curl', 'dashed', 'dotted', 'double_line']);

/** The base surface tokens every `WorkbenchTheme` (packages/ui/theme) requires -- kept here,
 * next to the theme.toml parser, so token-schema validation lives with the schema it validates
 * rather than in the composition root. Only main.ts maps a validated token table into the UI's
 * `WorkbenchTheme` launch shape, since only it knows that type. */
export const REQUIRED_WORKBENCH_THEME_TOKENS = Object.freeze(['background', 'surface', 'surface.active', 'foreground', 'muted', 'border', 'accent', 'error'] as const);

export function hasRequiredWorkbenchThemeTokens(tokens: Readonly<Record<string, string>>): boolean {
  return REQUIRED_WORKBENCH_THEME_TOKENS.every((key) => tokens[key] !== undefined);
}

export function parseThemeConfig(source: string, fileName = 'theme.toml'): Result<ThemeConfig, ConfigCompileFailure> {
  const parsed = parseToml(source, fileName);
  if (!parsed.ok) return parsed;
  const palette = asRecord(parsed.value.value.palette);
  const styles: Record<string, HelixThemeStyle> = Object.create(null) as Record<string, HelixThemeStyle>;
  const colors: Record<string, string> = Object.create(null) as Record<string, string>;
  const extras: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
  const diagnostics: ConfigDiagnostic[] = [];
  const inherits = parsed.value.value.inherits;
  if (inherits !== undefined && typeof inherits !== 'string') diagnostics.push(diag(fileName, 1, 1, 'inherits', 'invalid-type', 'inherits must name a theme'));
  for (const [name, color] of Object.entries(palette ?? {})) {
    if (typeof color !== 'string') diagnostics.push(diag(fileName, 1, 1, `palette.${name}`, 'invalid-type', 'palette colours must be strings'));
    else colors[name] = color;
  }
  for (const entry of parsed.value.entries) {
    if (entry.path[0] === 'palette' || entry.path[0] === 'inherits') continue;
    const property = entry.path.at(-1);
    if (entry.path.length > 1 && property !== undefined && ['fg', 'bg', 'modifiers', 'underline'].includes(property)) {
      const scope = entry.path.slice(0, -1).join('.');
      const update = helixStyle(Object.freeze({ [property]: entry.value }));
      if (update === undefined) diagnostics.push(diag(entry.location.fileName, entry.location.line, entry.location.column, entry.path.join('.'), 'invalid-type', `invalid ${property} style property`));
      else styles[scope] = Object.freeze({ ...(styles[scope] ?? {}), ...update });
      continue;
    }
    const key = entry.path.join('.');
    const style = helixStyle(entry.value);
    if (style !== undefined) styles[key] = Object.freeze({ ...(styles[key] ?? {}), ...style });
    else if (key === 'rainbow' && Array.isArray(entry.value) && entry.value.every((value) => helixStyle(value) !== undefined)) extras[key] = entry.value;
    else diagnostics.push(diag(entry.location.fileName, entry.location.line, entry.location.column, key, 'invalid-type', 'a Helix theme scope must be a colour or style table; rainbow must be an array of styles'));
  }
  return diagnostics.length === 0
    ? { ok: true, value: Object.freeze({ ...(typeof inherits === 'string' ? { inherits } : {}), palette: Object.freeze(colors), styles: Object.freeze(styles), extras: Object.freeze(extras) }) }
    : { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
}

function helixStyle(value: TomlValue): HelixThemeStyle | undefined {
  if (typeof value === 'string') return Object.freeze({ fg: value });
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const fg = typeof record.fg === 'string' ? record.fg : undefined;
  const bg = typeof record.bg === 'string' ? record.bg : undefined;
  const modifiers = stringArrayField(record, 'modifiers');
  const underlineRecord = asRecord(record.underline);
  const underline = underlineRecord === undefined ? undefined : {
    ...(typeof underlineRecord.color === 'string' ? { color: underlineRecord.color } : {}),
    ...(typeof underlineRecord.style === 'string' ? { style: underlineRecord.style } : {}),
  };
  if (Object.keys(record).some((key) => !['fg', 'bg', 'modifiers', 'underline'].includes(key))
    || (record.fg !== undefined && fg === undefined) || (record.bg !== undefined && bg === undefined)
    || (record.modifiers !== undefined && (modifiers === undefined || modifiers.some((modifier) => !HELIX_MODIFIERS.has(modifier))))
    || (record.underline !== undefined && (underlineRecord === undefined || (underlineRecord.style !== undefined && (typeof underlineRecord.style !== 'string' || !HELIX_UNDERLINE_STYLES.has(underlineRecord.style)))))) return undefined;
  return Object.freeze({ ...(fg === undefined ? {} : { fg }), ...(bg === undefined ? {} : { bg }), ...(modifiers === undefined ? {} : { modifiers }), ...(underline === undefined ? {} : { underline: Object.freeze(underline) }) });
}

/** Filesystem operations custom-theme discovery needs: reading one theme file and listing the
 * themes directory. A narrow slice of the platform filesystem adapter, not the adapter itself,
 * so this module never depends on `packages/platform`. */
export interface ThemeDiscoveryFilesystemPort {
  readFile(path: string, cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>>;
  enumerateDirectory(path: string, root: string, cancellation: CancellationToken): Promise<Result<readonly { readonly kind: string; readonly name: string }[], PlatformFailure>>;
}

export interface DiscoveredCustomTheme { readonly id: string; readonly theme: ThemeConfig; }
export interface ThemeDiscoveryDiagnostic { readonly fileName: string; readonly message: string; }

/** Discover and parse every `*.toml` file directly under `directory` as a theme config. A
 * missing directory is the common case (no custom themes) and produces an empty list, not an
 * error. An individual unreadable or invalid file is reported as a diagnostic and skipped --
 * it never partially applies and never blocks the other files or the caller's startup. */
export async function discoverCustomThemeConfigs(
  filesystem: ThemeDiscoveryFilesystemPort,
  directory: string,
  cancellation: CancellationToken,
): Promise<{ readonly themes: ReadonlyMap<string, DiscoveredCustomTheme>; readonly diagnostics: readonly ThemeDiscoveryDiagnostic[] }> {
  const listed = await filesystem.enumerateDirectory(directory, directory, cancellation);
  const themes = new Map<string, DiscoveredCustomTheme>();
  const diagnostics: ThemeDiscoveryDiagnostic[] = [];
  if (!listed.ok) return { themes, diagnostics };
  for (const entry of listed.value) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.toml')) continue;
    const path = `${directory}/${entry.name}`;
    const read = await filesystem.readFile(path, cancellation);
    if (!read.ok) { diagnostics.push({ fileName: entry.name, message: `could not read theme file ${entry.name}: ${read.error.message}` }); continue; }
    const parsed = parseThemeConfig(new TextDecoder('utf-8').decode(read.value), entry.name);
    if (!parsed.ok) {
      diagnostics.push({ fileName: entry.name, message: `theme file ${entry.name} is invalid: ${parsed.error.diagnostics.map((d) => d.message).join('; ')}` });
      continue;
    }
    themes.set(entry.name.replace(/\.toml$/u, ''), { id: entry.name.replace(/\.toml$/u, ''), theme: parsed.value });
  }
  const resolved = new Map<string, DiscoveredCustomTheme>();
  const visit = (id: string, trail: readonly string[]): ThemeConfig | undefined => {
    const cached = resolved.get(id);
    if (cached !== undefined) return cached.theme;
    const candidate = themes.get(id);
    if (candidate === undefined) return undefined;
    if (trail.includes(id)) { diagnostics.push({ fileName: `${id}.toml`, message: `theme inheritance cycle: ${[...trail, id].join(' -> ')}` }); return undefined; }
    const parent = candidate.theme.inherits === undefined ? undefined : visit(candidate.theme.inherits, [...trail, id]);
    if (candidate.theme.inherits !== undefined && parent === undefined) { diagnostics.push({ fileName: `${id}.toml`, message: `theme inherits missing or invalid theme ${candidate.theme.inherits}` }); return undefined; }
    const theme = Object.freeze({
      ...(candidate.theme.inherits === undefined ? {} : { inherits: candidate.theme.inherits }),
      palette: Object.freeze({ ...(parent?.palette ?? {}), ...candidate.theme.palette }),
      styles: Object.freeze({ ...(parent?.styles ?? {}), ...candidate.theme.styles }),
      extras: Object.freeze({ ...(parent?.extras ?? {}), ...candidate.theme.extras }),
    });
    const invalidColors = invalidThemeColors(theme);
    if (invalidColors.length > 0) {
      diagnostics.push({ fileName: `${id}.toml`, message: `theme has unknown colours: ${invalidColors.join(', ')}` });
      return undefined;
    }
    resolved.set(id, { id, theme });
    return theme;
  };
  for (const id of themes.keys()) visit(id, []);
  return { themes: resolved, diagnostics };
}

/** Load one configured custom theme and only the parent chain it names. This keeps selecting a
 * theme at startup independent of the size of the user's theme catalog. */
export async function loadCustomThemeConfig(
  filesystem: ThemeDiscoveryFilesystemPort,
  directory: string,
  id: string,
  cancellation: CancellationToken,
): Promise<{ readonly theme: DiscoveredCustomTheme | undefined; readonly diagnostics: readonly ThemeDiscoveryDiagnostic[] }> {
  const diagnostics: ThemeDiscoveryDiagnostic[] = [];
  const cache = new Map<string, ThemeConfig>();
  const visit = async (candidateId: string, trail: readonly string[]): Promise<ThemeConfig | undefined> => {
    const cached = cache.get(candidateId);
    if (cached !== undefined) return cached;
    if (!/^[A-Za-z0-9_.-]+$/u.test(candidateId)) {
      diagnostics.push({ fileName: `${candidateId}.toml`, message: `invalid theme id ${candidateId}` });
      return undefined;
    }
    if (trail.includes(candidateId)) {
      diagnostics.push({ fileName: `${candidateId}.toml`, message: `theme inheritance cycle: ${[...trail, candidateId].join(' -> ')}` });
      return undefined;
    }
    const read = await filesystem.readFile(`${directory}/${candidateId}.toml`, cancellation);
    if (!read.ok) {
      diagnostics.push({ fileName: `${candidateId}.toml`, message: `could not read theme file ${candidateId}.toml: ${read.error.message}` });
      return undefined;
    }
    const parsed = parseThemeConfig(new TextDecoder('utf-8').decode(read.value), `${candidateId}.toml`);
    if (!parsed.ok) {
      diagnostics.push({ fileName: `${candidateId}.toml`, message: `theme file ${candidateId}.toml is invalid: ${parsed.error.diagnostics.map((d) => d.message).join('; ')}` });
      return undefined;
    }
    const parent = parsed.value.inherits === undefined ? undefined : await visit(parsed.value.inherits, [...trail, candidateId]);
    if (parsed.value.inherits !== undefined && parent === undefined) {
      diagnostics.push({ fileName: `${candidateId}.toml`, message: `theme inherits missing or invalid theme ${parsed.value.inherits}` });
      return undefined;
    }
    const theme = Object.freeze({
      ...(parsed.value.inherits === undefined ? {} : { inherits: parsed.value.inherits }),
      palette: Object.freeze({ ...(parent?.palette ?? {}), ...parsed.value.palette }),
      styles: Object.freeze({ ...(parent?.styles ?? {}), ...parsed.value.styles }),
      extras: Object.freeze({ ...(parent?.extras ?? {}), ...parsed.value.extras }),
    });
    const invalidColors = invalidThemeColors(theme);
    if (invalidColors.length > 0) {
      diagnostics.push({ fileName: `${candidateId}.toml`, message: `theme has unknown colours: ${invalidColors.join(', ')}` });
      return undefined;
    }
    cache.set(candidateId, theme);
    return theme;
  };
  const theme = await visit(id, []);
  return { theme: theme === undefined ? undefined : { id, theme }, diagnostics: Object.freeze(diagnostics) };
}

export interface RequiredWorkbenchThemeTokens {
  readonly background: string;
  readonly surface: string;
  readonly ['surface.active']: string;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly error: string;
}

/** Validates that every base surface token `REQUIRED_WORKBENCH_THEME_TOKENS` names is present,
 * returning them typed (no `as string` cast needed at the call site) instead of the plain
 * boolean `hasRequiredWorkbenchThemeTokens` predicate. Only the base surface set is validated
 * here; optional editor-layer tokens (selection.primary, cursor.primary, ...) stay a loose
 * lookup on the caller's token table, unchanged. */
export function decodeRequiredWorkbenchThemeTokens(tokens: Readonly<Record<string, string>>): Result<RequiredWorkbenchThemeTokens, readonly string[]> {
  const missing = REQUIRED_WORKBENCH_THEME_TOKENS.filter((key) => tokens[key] === undefined);
  if (missing.length > 0) return { ok: false, error: missing };
  return {
    ok: true,
    value: {
      background: tokens.background as string,
      surface: tokens.surface as string,
      'surface.active': tokens['surface.active'] as string,
      foreground: tokens.foreground as string,
      muted: tokens.muted as string,
      border: tokens.border as string,
      accent: tokens.accent as string,
      error: tokens.error as string,
    },
  };
}

/** Structurally identical to `packages/ui`'s `WorkbenchTheme` (minus the `syntax` field, which
 * theme.toml never sets), without this package depending on `packages/ui` -- the composition
 * root assigns this straight into that type. */
export interface WorkbenchThemeTokens extends RequiredWorkbenchThemeTokens {
  readonly surfaceActive: string;
  readonly selectionPrimary?: string;
  readonly selectionSecondary?: string;
  readonly cursorPrimary?: string;
  readonly cursorSecondary?: string;
  readonly motionTrail?: string;
  readonly operatorPreview?: string;
}

/** Resolved Helix styles are retained on the UI theme so every surface can use its own Helix
 * key instead of silently sharing a hand-picked Xi palette token. */
export type HelixWorkbenchThemeTokens = Omit<WorkbenchThemeTokens, 'surface.active'> & {
  readonly styles: Readonly<Record<string, HelixThemeStyle>>;
  readonly syntax: Readonly<Record<string, string>>;
  readonly syntaxStyles: Readonly<Record<string, HelixThemeStyle>>;
  readonly diffAdded?: string;
  readonly diffRemoved?: string;
  readonly diffHunk?: string;
  readonly cursorOnSelection?: string;
  readonly searchMatch?: string;
};

const HELIX_TERMINAL_PALETTE: Readonly<Record<string, string>> = Object.freeze({
  default: '\u0000xi-terminal-default', black: '\u0000xi-terminal-index:0', red: '\u0000xi-terminal-index:1', green: '\u0000xi-terminal-index:2', yellow: '\u0000xi-terminal-index:3', blue: '\u0000xi-terminal-index:4', magenta: '\u0000xi-terminal-index:5', cyan: '\u0000xi-terminal-index:6', gray: '\u0000xi-terminal-index:8',
  'light-red': '\u0000xi-terminal-index:9', 'light-green': '\u0000xi-terminal-index:10', 'light-yellow': '\u0000xi-terminal-index:11', 'light-blue': '\u0000xi-terminal-index:12', 'light-magenta': '\u0000xi-terminal-index:13', 'light-cyan': '\u0000xi-terminal-index:14', 'light-gray': '\u0000xi-terminal-index:7', white: '\u0000xi-terminal-index:15',
});

function resolvedHelixColor(theme: ThemeConfig, color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  return resolveHelixColor(theme, color, new Set<string>());
}

function resolveHelixColor(theme: ThemeConfig, color: string, seen: Set<string>): string | undefined {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(color)) return color;
  if (seen.has(color)) return undefined;
  const paletteColor = theme.palette[color];
  if (paletteColor !== undefined) {
    seen.add(color);
    return resolveHelixColor(theme, paletteColor, seen);
  }
  const indexed = /^\d{1,3}$/u.test(color) ? Number(color) : Number.NaN;
  return Number.isInteger(indexed) && indexed <= 255 ? `\u0000xi-terminal-index:${indexed}` : HELIX_TERMINAL_PALETTE[color];
}

function invalidThemeColors(theme: ThemeConfig): readonly string[] {
  const invalid = new Set<string>();
  for (const [name] of Object.entries(theme.palette)) if (resolvedHelixColor(theme, name) === undefined) invalid.add(name);
  for (const style of Object.values(theme.styles)) {
    for (const color of [style.fg, style.bg, style.underline?.color]) if (color !== undefined && resolvedHelixColor(theme, color) === undefined) invalid.add(color);
  }
  const rainbow = theme.extras.rainbow;
  if (Array.isArray(rainbow)) for (const value of rainbow) {
    const style = helixStyle(value);
    if (style !== undefined) for (const color of [style.fg, style.bg, style.underline?.color]) if (color !== undefined && resolvedHelixColor(theme, color) === undefined) invalid.add(color);
  }
  return Object.freeze([...invalid].sort());
}

/** Helix chooses the longest matching dotted scope, not a field-by-field merge. */
function helixStyleFor(theme: ThemeConfig, scope: string): HelixThemeStyle | undefined {
  let candidate = scope;
  while (candidate.length > 0) {
    const style = theme.styles[candidate];
    if (style !== undefined) return style;
    candidate = candidate.slice(0, candidate.lastIndexOf('.'));
  }
  return undefined;
}

function resolvedHelixStyles(theme: ThemeConfig): Readonly<Record<string, HelixThemeStyle>> {
  const styles: Record<string, HelixThemeStyle> = Object.create(null) as Record<string, HelixThemeStyle>;
  for (const [scope, style] of Object.entries(theme.styles)) {
    const fg = resolvedHelixColor(theme, style.fg);
    const bg = resolvedHelixColor(theme, style.bg);
    const underlineColor = resolvedHelixColor(theme, style.underline?.color);
    styles[scope] = Object.freeze({
      ...(fg === undefined ? {} : { fg }), ...(bg === undefined ? {} : { bg }),
      ...(style.modifiers === undefined ? {} : { modifiers: style.modifiers }),
      ...(style.underline === undefined ? {} : { underline: Object.freeze({ ...(underlineColor === undefined ? {} : { color: underlineColor }), ...(style.underline.style === undefined ? {} : { style: style.underline.style }) }) }),
    });
  }
  const rainbow = theme.extras.rainbow;
  if (Array.isArray(rainbow)) for (let index = 0; index < rainbow.length; index += 1) {
    const style = helixStyle(rainbow[index] as TomlValue);
    if (style !== undefined) styles[`rainbow.${index}`] = resolvedHelixStyle(theme, style);
  }
  return Object.freeze(styles);
}

function resolvedHelixStyle(theme: ThemeConfig, style: HelixThemeStyle): HelixThemeStyle {
  const fg = resolvedHelixColor(theme, style.fg);
  const bg = resolvedHelixColor(theme, style.bg);
  const underlineColor = resolvedHelixColor(theme, style.underline?.color);
  return Object.freeze({
    ...(fg === undefined ? {} : { fg }), ...(bg === undefined ? {} : { bg }),
    ...(style.modifiers === undefined ? {} : { modifiers: style.modifiers }),
    ...(style.underline === undefined ? {} : { underline: Object.freeze({ ...(underlineColor === undefined ? {} : { color: underlineColor }), ...(style.underline.style === undefined ? {} : { style: style.underline.style }) }) }),
  });
}

/** Map each existing Xi paint site to its documented Helix scope. The resolved scope map stays
 * available for newer widgets, while these fields keep the established UI adapter boundary. */
export function decodeHelixWorkbenchTheme(theme: ThemeConfig): HelixWorkbenchThemeTokens {
  const foreground = resolvedHelixColor(theme, helixStyleFor(theme, 'ui.text')?.fg) ?? '#FFFFFF';
  const background = resolvedHelixColor(theme, helixStyleFor(theme, 'ui.background')?.bg) ?? '#000000';
  const surface = resolvedHelixColor(theme, helixStyleFor(theme, 'ui.popup')?.bg) ?? resolvedHelixColor(theme, helixStyleFor(theme, 'ui.menu')?.bg) ?? background;
  const surfaceActive = resolvedHelixColor(theme, helixStyleFor(theme, 'ui.menu.selected')?.bg) ?? resolvedHelixColor(theme, helixStyleFor(theme, 'ui.text.focus')?.bg) ?? resolvedHelixColor(theme, helixStyleFor(theme, 'ui.selection.primary')?.bg) ?? resolvedHelixColor(theme, helixStyleFor(theme, 'ui.selection')?.bg) ?? surface;
  const muted = resolvedHelixColor(theme, helixStyleFor(theme, 'ui.text.inactive')?.fg) ?? resolvedHelixColor(theme, helixStyleFor(theme, 'ui.linenr')?.fg) ?? foreground;
  const border = resolvedHelixColor(theme, helixStyleFor(theme, 'ui.window')?.fg) ?? muted;
  const accent = resolvedHelixColor(theme, helixStyleFor(theme, 'ui.text.focus')?.fg) ?? resolvedHelixColor(theme, helixStyleFor(theme, 'ui.linenr.selected')?.fg) ?? foreground;
  const error = resolvedHelixColor(theme, helixStyleFor(theme, 'error')?.fg) ?? resolvedHelixColor(theme, helixStyleFor(theme, 'diagnostic.error')?.fg) ?? '#FF0000';
  const color = (scope: string): string | undefined => resolvedHelixColor(theme, helixStyleFor(theme, scope)?.fg);
  const backgroundColor = (scope: string): string | undefined => resolvedHelixColor(theme, helixStyleFor(theme, scope)?.bg);
  const selectionPrimary = backgroundColor('ui.selection.primary') ?? backgroundColor('ui.selection');
  const selectionSecondary = backgroundColor('ui.selection');
  const cursorPrimary = backgroundColor('ui.cursor.primary') ?? backgroundColor('ui.cursor');
  const cursorSecondary = backgroundColor('ui.cursor');
  const cursorOnSelection = backgroundColor('ui.cursor.primary.select') ?? backgroundColor('ui.cursor.select');
  const searchMatch = backgroundColor('ui.highlight');
  const diffAdded = backgroundColor('diff.plus');
  const diffRemoved = backgroundColor('diff.minus');
  const diffHunk = color('diff.delta');
  const syntax: Record<string, string> = Object.create(null) as Record<string, string>;
  const syntaxStyles: Record<string, HelixThemeStyle> = Object.create(null) as Record<string, HelixThemeStyle>;
  for (const [kind, scope] of Object.entries({ comment: 'comment', string: 'string', number: 'constant.numeric', keyword: 'keyword', boolean: 'constant.builtin.boolean', type: 'type', function: 'function', operator: 'operator', punctuation: 'punctuation', variable: 'variable', property: 'variable.other.member', constant: 'constant' })) {
    const value = color(scope);
    if (value !== undefined) syntax[kind] = value;
    const style = helixStyleFor(theme, scope);
    if (style !== undefined) syntaxStyles[kind] = resolvedHelixStyle(theme, style);
  }
  return Object.freeze({
    background, surface, surfaceActive, foreground, muted, border, accent, error,
    ...(selectionPrimary === undefined ? {} : { selectionPrimary }),
    ...(selectionSecondary === undefined ? {} : { selectionSecondary }),
    ...(cursorPrimary === undefined ? {} : { cursorPrimary }),
    ...(cursorSecondary === undefined ? {} : { cursorSecondary }),
    ...(cursorOnSelection === undefined ? {} : { cursorOnSelection }),
    ...(searchMatch === undefined ? {} : { searchMatch }),
    ...(diffAdded === undefined ? {} : { diffAdded }),
    ...(diffRemoved === undefined ? {} : { diffRemoved }),
    ...(diffHunk === undefined ? {} : { diffHunk }),
    styles: resolvedHelixStyles(theme), syntax: Object.freeze(syntax), syntaxStyles: Object.freeze(syntaxStyles),
  });
}

const OPTIONAL_WORKBENCH_THEME_TOKEN_KEYS = Object.freeze([
  ['selection.primary', 'selectionPrimary'],
  ['selection.secondary', 'selectionSecondary'],
  ['cursor.primary', 'cursorPrimary'],
  ['cursor.secondary', 'cursorSecondary'],
  ['motion.trail', 'motionTrail'],
  ['operator.preview', 'operatorPreview'],
] as const);

/** Full `WorkbenchTheme`-shaped decode: required base surface tokens plus whichever optional
 * editor-layer tokens (selection.primary, cursor.primary, ...) are present, never partially
 * applied -- returns `undefined` (not `error`) for a missing base token so the composition root
 * can report a file-specific diagnostic instead of a generic validation failure. */
export function decodeWorkbenchThemeTokens(tokens: Readonly<Record<string, string>>): WorkbenchThemeTokens | undefined {
  const required = decodeRequiredWorkbenchThemeTokens(tokens);
  if (!required.ok) return undefined;
  const { background, surface, foreground, muted, border, accent, error } = required.value;
  const optional: Record<string, string> = {};
  for (const [tomlKey, fieldName] of OPTIONAL_WORKBENCH_THEME_TOKEN_KEYS) {
    const value = tokens[tomlKey];
    if (value !== undefined) optional[fieldName] = value;
  }
  return Object.freeze({
    background, surface, surfaceActive: required.value['surface.active'], foreground, muted, border, accent, error,
    ...optional,
  }) as WorkbenchThemeTokens;
}

export interface FormatterEnvironmentSelection {
  readonly command: string;
  readonly args: readonly string[];
}

/** XI_FORMATTER_COMMAND/XI_FORMATTER_ARGS stay a hard override (tests/e2e/t055-formatting-pty.py
 * relies on them); with no env override, a buffer's languages.toml [[language]].formatter entry
 * (if any) selects the external formatter for that language. Pure environment/config parsing --
 * the composition root still owns constructing the actual `FormatterPipeline` (a platform
 * process port is a UI/app-layer concern this package never imports). */
export function resolveFormatterSelection(
  env: Readonly<Record<string, string | undefined>>,
  configuredFormatter?: { readonly command: string; readonly args: readonly string[] },
): Result<FormatterEnvironmentSelection | undefined, { readonly message: string }> {
  const envCommand = env.XI_FORMATTER_COMMAND?.trim();
  if (envCommand === undefined || envCommand.length === 0) {
    if (configuredFormatter === undefined || configuredFormatter.command.trim().length === 0) return { ok: true, value: undefined };
    return { ok: true, value: { command: configuredFormatter.command, args: [...configuredFormatter.args] } };
  }
  const rawArgs = env.XI_FORMATTER_ARGS;
  if (rawArgs === undefined) return { ok: true, value: { command: envCommand, args: [] } };
  try {
    const decoded: unknown = JSON.parse(rawArgs);
    if (!Array.isArray(decoded) || !decoded.every((value): value is string => typeof value === 'string')) throw new TypeError('formatter args must be a JSON string array');
    return { ok: true, value: { command: envCommand, args: [...decoded] } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'formatter args are invalid';
    return { ok: false, error: { message } };
  }
}

/** XI_FORMAT_ON_SAVE stays a hard override for tests that set it
 * (tests/e2e/t055-formatting-pty.py) rather than a second, conflicting source. */
export function resolveFormatOnSave(env: Readonly<Record<string, string | undefined>>, configuredAutoFormat: boolean): boolean {
  return env.XI_FORMAT_ON_SAVE === '1' || configuredAutoFormat;
}

/** Filesystem slice `loadStartupXiConfig` needs to read `config.toml`/`languages.toml`. */
export interface StartupConfigFilesystemPort {
  readFile(path: string, cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>>;
}

export interface LoadedStartupConfig {
  readonly config: CompiledConfig | undefined;
  readonly diagnostics: readonly string[];
}

/** Read `config.toml` and `languages.toml` from `configDirectory` (both optional -- a missing
 * file just means "use defaults", not an error) and compile them. A parse/schema failure is
 * reported as a diagnostic message and falls back to `config: undefined` rather than blocking
 * startup or partially applying a broken file. `extraCommandIds` lets a caller (the workbench's
 * own `view.*` scroll commands, for example) join the default command catalog so config
 * validation accepts bindings that target them, without this package depending on the
 * workbench. */
export async function loadStartupXiConfig(
  filesystem: StartupConfigFilesystemPort,
  configDirectory: string,
  cancellation: CancellationToken,
  extraCommandIds: readonly string[] = [],
  overridesPath?: string,
): Promise<LoadedStartupConfig> {
  const layers: ConfigLayer[] = [
    { name: 'defaults', kind: 'defaults', source: DEFAULT_CONFIG_TOML, fileName: 'config/default.toml' },
    // Built-in languages.toml (typescript/pyright/...): without it, a user with no
    // ~/.config/xi/languages.toml had no language server for anything but the hardcoded
    // ts/js fallback. A user `[[language]]` array replaces this list wholesale (arrays do not
    // merge); `[language-server.<name>]` tables merge by name.
    { name: 'default-languages', kind: 'language', source: DEFAULT_LANGUAGES_TOML, fileName: 'config/languages.toml' },
  ];
  const configToml = await filesystem.readFile(`${configDirectory}/config.toml`, cancellation);
  if (configToml.ok) layers.push({ name: 'user', kind: 'user', source: new TextDecoder('utf-8').decode(configToml.value), fileName: 'config.toml' });
  const languagesToml = await filesystem.readFile(`${configDirectory}/languages.toml`, cancellation);
  if (languagesToml.ok) layers.push({ name: 'languages', kind: 'language', source: new TextDecoder('utf-8').decode(languagesToml.value), fileName: 'languages.toml' });
  if (overridesPath !== undefined) {
    const overrides = await filesystem.readFile(overridesPath, cancellation);
    if (overrides.ok) {
      try {
        layers.push({ name: 'state-overrides', kind: 'user', source: new TextDecoder('utf-8', { fatal: true }).decode(overrides.value), fileName: overridesPath });
      } catch {
        return { config: undefined, diagnostics: [`${overridesPath}: invalid UTF-8`] };
      }
    }
  }
  const commandCatalog = { ...DEFAULT_COMMAND_CATALOG, commandIds: [...DEFAULT_COMMAND_CATALOG.commandIds, ...extraCommandIds] };
  const compiled = compileConfig(layers, { commandCatalog });
  if (!compiled.ok) return { config: undefined, diagnostics: compiled.error.diagnostics.map((diagnostic) => diagnostic.message) };
  return { config: compiled.value, diagnostics: [] };
}

export const DEFAULT_CONFIG_TOML = `schema-version = 1
profile = "xi"

[editor]
sidebar-visible = true
sidebar-width = 28
sidebar-panel = "files"
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
q = "macro.record"
c = "config.open"
s = "sidebar.toggle"
f = "files.pick"
b = "buffers.pick"
";" = "command.pick"
"/" = "search.workspace"
o = "files.edit-directory"
O = "files.edit-buffer-directory"
t = "theme.pick"
k = "lsp.hover"
a = "lsp.code-action"
d = "panel.problems.focus"
e = "panel.problems.focus"
m = "editor.mouse.toggle"
r = "search.replace"

[keys.normal.space.v]
p = "panel.problems.focus"
f = "panel.files.focus"
s = "panel.search.focus"
g = "panel.git.focus"
o = "panel.outline.focus"
d = "git.diff"

[keys.files-panel.space]
s = "sidebar.toggle"
l = "panel.preview"
o = "panel.open"
q = "panel.close"

[keys.search-panel.space]
s = "sidebar.toggle"
l = "panel.preview"
o = "panel.open"
q = "panel.close"

[keys.git-panel.space]
s = "sidebar.toggle"
l = "panel.preview"
o = "panel.open"
q = "panel.close"

[keys.diff-panel.space]
s = "sidebar.toggle"
l = "panel.preview"
o = "panel.open"
q = "panel.close"

[aliases]
files = "files.pick"
buffers = "buffers.pick"
commands = "command.pick"
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
sidebar-visible = true
sidebar-width = 28
sidebar-panel = "files"
theme = "xi-light"
mouse = true
motion-trail = "last-motion"

[keys.normal.space]
q = "macro.record"
c = "config.open"
s = "sidebar.toggle"
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

[language-server.pyright]
command = "pyright-langserver"
args = ["--stdio"]
root-markers = ["pyproject.toml", "setup.py", "requirements.txt", ".git"]

[[language]]
name = "typescript"
file-types = ["ts", "tsx"]
language-servers = ["typescript"]
indent = { tab-width = 2, unit = "\\t" }
formatter = { command = "biome", args = ["format", "--stdin-file-path", "{file}"] }
auto-format = true

[[language]]
name = "python"
file-types = ["py", "pyi"]
language-servers = ["pyright"]
indent = { tab-width = 4, unit = "    " }

[[language]]
name = "json"
file-types = ["json", "jsonc"]
indent = { tab-width = 2, unit = "  " }

[[language]]
name = "toml"
file-types = ["toml"]
indent = { tab-width = 2, unit = "  " }

[[language]]
name = "markdown"
file-types = ["md", "markdown"]
indent = { tab-width = 2, unit = "  " }
`;

export const DEFAULT_THEME_TOML = `"ui.background" = { bg = "paper" }
"ui.text" = "ink"
"ui.selection.primary" = { bg = "selection" }
"ui.cursor.primary" = { fg = "paper", bg = "ink" }
"ui.menu" = { fg = "ink", bg = "panel" }
"ui.menu.selected" = { fg = "paper", bg = "ink" }
error = "red"

[palette]
paper = "#FCFCFA"
panel = "#F1F2F5"
ink = "#1E2430"
selection = "#D6E5F2"
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
  if (editor['sidebar-visible'] !== undefined && typeof editor['sidebar-visible'] !== 'boolean') {
    diagnostics.push(issue('editor.sidebar-visible', 'invalid-type', 'editor.sidebar-visible must be a boolean', locations));
  }
  const sidebarWidth = boundedInteger(editor, 'sidebar-width', 22, 40, 28, diagnostics, locations, 'editor.sidebar-width');
  const sidebarPanel = enumField(editor, 'sidebar-panel', ['files', 'search', 'git'] as const, 'files', diagnostics, locations, 'editor.sidebar-panel');
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
  const editorConfig: EditorConfig = Object.freeze({ sidebarWidth, sidebarPanel, sidebarVisible: booleanField(editor, 'sidebar-visible') ?? true, theme, lineNumber, scrolloff, mouse: Object.freeze({ enabled: mouseEnabled, modifier: mouseModifier, scrollLines }), wrap, motionTrail, selection: Object.freeze({ limit: selectionLimit, historyLimit: selectionHistoryLimit }), hintsDelayMs, cursorShape: Object.freeze(shapes), lsp: Object.freeze(lspConfig) });
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
        if (profile === 'strict' && mode !== 'normal' && mode !== 'visual' && mode !== 'insert' && mode !== 'replace' && mode !== 'operator-pending' && mode !== 'command-line'
          && mode !== 'files-panel' && mode !== 'search-panel' && mode !== 'git-panel' && mode !== 'diff-panel') {
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
    'editor.sidebar-visible', 'editor.sidebar-width', 'editor.sidebar-panel', 'editor.selection-limit', 'editor.selection-history-limit', 'editor.cursor-shape', 'editor.cursor-shape.normal',
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

/** TOML allows an inline array/table to span lines. The main parser intentionally remains
 * line-oriented, so join only an assignment whose value still has an open delimiter. */
function logicalTomlLines(source: string): readonly { readonly source: string; readonly line: number }[] {
  const output: Array<{ readonly source: string; readonly line: number }> = [];
  let pending = '';
  let firstLine = 0;
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = stripComment(raw);
    if (pending.length === 0) { pending = line; firstLine = index + 1; }
    else pending += ` ${line.trim()}`;
    if (tomlValueOpen(pending)) continue;
    output.push(Object.freeze({ source: pending, line: firstLine }));
    pending = '';
  }
  if (pending.length > 0) output.push(Object.freeze({ source: pending, line: firstLine }));
  return Object.freeze(output);
}

function tomlValueOpen(line: string): boolean {
  const equals = findEquals(line);
  if (equals < 0) return false;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (const char of line.slice(equals + 1)) {
    if (quote.length > 0) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
  }
  return depth > 0;
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
      if (key === undefined || !item.ok) return { ok: false, error: { message: 'invalid inline table entry' } };
      const parent = ensureTable(record, key.slice(0, -1));
      const name = key[key.length - 1] as string;
      if (parent[name] !== undefined) return { ok: false, error: { message: 'duplicate inline table key' } };
      parent[name] = item.value;
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

/** Source-preserving scalar update inside an already parsed inline-table assignment.
 * Reuse the TOML quote/depth scanner; masked comments keep original character offsets. */
export function patchInlineTableScalar(source: string, line: number, key: string, value: boolean | string | number): string {
  const start = source.split('\n').slice(0, line - 1).reduce((offset, part) => offset + part.length + 1, 0);
  const tail = source.slice(start);
  const clean = tail.split('\n').map(part => stripComment(part).padEnd(part.length)).join('\n');
  const equals = findEquals(clean);
  const assignment = splitTopLevel(clean.slice(equals + 1), '\n')[0] ?? '';
  const open = assignment.indexOf('{');
  const close = assignment.lastIndexOf('}');
  if (equals < 0 || open < 0 || close < open) throw new Error('cannot locate inline editor table');
  const bodyStart = start + equals + 1 + open + 1;
  const body = assignment.slice(open + 1, close);
  let offset = bodyStart;
  for (const part of splitTopLevel(body, ',')) {
    const delimiter = findEquals(part);
    const path = parseDottedPath(part.slice(0, delimiter).trim());
    if (delimiter >= 0 && path?.length === 1 && path[0] === key) {
      const raw = part.slice(delimiter + 1);
      const token = raw.trim();
      const parsed = parseValue(token);
      if (!parsed.ok || typeof parsed.value !== typeof value) throw new Error(`${key} has an invalid type; state file left unchanged`);
      const valueStart = offset + delimiter + 1 + raw.search(/\S/u);
      return source.slice(0, valueStart) + JSON.stringify(value) + source.slice(valueStart + token.length);
    }
    offset += part.length + 1;
  }
  const insertion = bodyStart + body.length;
  const separator = body.trim().length === 0 || body.trimEnd().endsWith(',') ? '' : ',';
  return source.slice(0, insertion) + `${separator} ${key} = ${JSON.stringify(value)} ` + source.slice(insertion);
}


/** Change one scalar assignment while preserving its key, spacing and trailing comment. */
export function patchTomlScalar(source: string, line: number, value: boolean | string | number): string {
  const start = source.split('\n').slice(0, line - 1).reduce((offset, part) => offset + part.length + 1, 0);
  const assignment = stripComment(source.slice(start).split('\n')[0] ?? '');
  const equals = findEquals(assignment);
  if (equals < 0) throw new Error('cannot locate state assignment');
  const raw = assignment.slice(equals + 1);
  const token = raw.trim();
  const parsed = parseValue(token);
  if (!parsed.ok || typeof parsed.value !== typeof value) throw new Error('invalid state value type');
  const offset = start + equals + 1 + raw.search(/\S/u);
  return source.slice(0, offset) + JSON.stringify(value) + source.slice(offset + token.length);
}
