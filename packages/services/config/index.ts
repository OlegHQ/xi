import type { CancellationToken, CommandId, PlatformFailure, Result } from '../../contracts/src/index.ts';
import defaultConfigToml from '../../../config/default.toml' with { type: 'text' };

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
  readonly tables: readonly { readonly path: readonly string[]; readonly location: SourceLocation }[];
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
    'files.pick', 'buffers.pick', 'diagnostics.pick', 'command.pick', 'search.workspace', 'search.replace', 'files.edit-directory', 'files.edit-buffer-directory', 'theme.pick',
    'lsp.hover', 'lsp.code-action', 'lsp.references', 'lsp.rename', 'editor.goto-word', 'panel.files.focus', 'panel.search.focus', 'panel.git.focus', 'panel.outline.focus', 'panel.problems.focus', 'panel.preview', 'panel.open', 'panel.close', 'git.diff', 'editor.mouse.toggle', 'sidebar.toggle', 'macro.record',
    'selection.add-above', 'selection.add-below', 'selection.add-next-match', 'selection.skip-next-match',
    'selection.select-all-matches', 'selection.split-lines', 'selection.select-regex', 'selection.keep-matching',
    'selection.remove-primary', 'selection.keep-primary', 'selection.rotate-primary-next', 'selection.rotate-primary-previous',
    'selection.collapse', 'selection.flip', 'selection.merge', 'selection.undo', 'buffer.next', 'buffer.previous',
    'view.scroll-up', 'view.scroll-down', 'view.scroll-page-up', 'view.scroll-page-down', 'view.half-page-up', 'view.half-page-down',
    'config.open', 'config.reload', 'write.quit', 'quit.all', 'write.all', 'noop',
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

export type StatuslineElement = 'mode' | 'spinner' | 'file-name' | 'file-absolute-path' | 'file-base-name' | 'file-modification-indicator' | 'file-encoding' | 'file-line-ending' | 'file-indent-style' | 'read-only-indicator' | 'total-line-numbers' | 'file-type' | 'diagnostics' | 'workspace-diagnostics' | 'selections' | 'primary-selection-length' | 'position' | 'position-percentage' | 'separator' | 'spacer' | 'version-control' | 'register' | 'current-working-directory' | 'code-action-hint';
export type StatuslineDiagnosticSeverity = 'hint' | 'info' | 'warning' | 'error';
export type EditorGutter = 'diagnostics' | 'spacer' | 'line-numbers' | 'diff' | 'code-action-hint';
export interface IndentGuidesConfig {
  readonly render: boolean;
  readonly character: string;
  readonly skipLevels: number;
}
export interface WhitespaceConfig {
  readonly render: { readonly default: boolean; readonly space: boolean; readonly nbsp: boolean; readonly nnbsp: boolean; readonly tab: boolean; readonly newline: boolean };
  readonly characters: { readonly space: string; readonly nbsp: string; readonly nnbsp: string; readonly tab: string; readonly tabpad: string; readonly newline: string };
}
export interface SmartTabConfig {
  readonly enable: boolean;
  readonly supersedeMenu: boolean;
}
export interface WordCompletionConfig {
  readonly enable: boolean;
  readonly triggerLength: number;
}
export interface WorkspaceTrustConfig {
  readonly level: 'none' | 'servers' | 'insecure';
  readonly prompt: boolean;
  readonly trusted: readonly string[];
}

export interface WorkspaceTrustDecision {
  readonly workspaceConfigAllowed: boolean;
  readonly serversAllowed: boolean;
  readonly gitAllowed: boolean;
  readonly stale: boolean;
}

export interface WorkspaceTrustResolver {
  resolve(workspaceRoot: string, config: WorkspaceTrustConfig, cancellation: CancellationToken): Promise<WorkspaceTrustDecision>;
}

/** Returns whether a workspace may load its project configuration under the compiled trust policy. */
export function workspaceTrustAllows(workspaceRoot: string, config: WorkspaceTrustConfig, environment: Readonly<Record<string, string | undefined>> = {}): boolean {
  if (config.level === 'insecure') return true;
  const normalizedRoot = normalizeTrustPath(workspaceRoot);
  return config.trusted.some((pattern) => globMatches(normalizedRoot, expandTrustPattern(pattern, environment)));
}
export type InlineDiagnosticsFilter = 'disable' | StatuslineDiagnosticSeverity;
export type DefaultLineEnding = 'native' | 'lf' | 'crlf' | 'ff' | 'cr' | 'nel';
export type PopupBorder = 'none' | 'popup' | 'menu' | 'all';
export type AutoPairsConfig = false | Readonly<Record<string, string>>;

export interface StatuslineConfig {
  readonly left: readonly StatuslineElement[];
  readonly center: readonly StatuslineElement[];
  readonly right: readonly StatuslineElement[];
  readonly separator: string;
  readonly mode: { readonly normal: string; readonly insert: string; readonly select: string };
  readonly diagnostics: readonly StatuslineDiagnosticSeverity[];
  readonly workspaceDiagnostics: readonly StatuslineDiagnosticSeverity[];
}

export interface EditorConfig {
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly sidebarPanel: 'files' | 'search' | 'git';
  readonly theme: string;
  readonly themeVariants: { readonly dark?: string; readonly light?: string; readonly fallback?: string };
  readonly lineNumber: 'absolute' | 'relative';
  readonly lineNumberMinWidth: number;
  readonly gutters: readonly EditorGutter[];
  readonly indentGuides: IndentGuidesConfig;
  readonly whitespace: WhitespaceConfig;
  readonly smartTab: SmartTabConfig;
  readonly wordCompletion: WordCompletionConfig;
  readonly workspaceTrust: WorkspaceTrustConfig;
  readonly autoPairs: AutoPairsConfig;
  readonly editorConfig: boolean;
  readonly continueComments: boolean;
  readonly cursorline: boolean;
  readonly cursorcolumn: boolean;
  readonly rainbowBrackets: boolean;
  readonly rulers: readonly number[];
  readonly textWidth: number;
  readonly workspaceLspRoots: readonly string[];
  readonly wrapAtTextWidth: boolean;
  readonly scrolloff: number;
  readonly idleTimeout: number;
  readonly mouse: MouseConfig;
  readonly shell: readonly [string, ...string[]];
  readonly kittyKeyboardProtocol: 'auto' | 'enabled' | 'disabled';
  readonly mouseYankRegister: string;
  readonly clipboardProvider: ClipboardProviderConfig;
  readonly middleClickPaste: boolean;
  readonly wrap: boolean;
  readonly softWrapMaxWrap: number;
  readonly softWrapMaxIndentRetain: number;
  readonly wrapIndicator: string;
  readonly pathCompletion: boolean;
  readonly inlineDiagnosticsCursorLine: InlineDiagnosticsFilter;
  readonly inlineDiagnosticsOtherLines: InlineDiagnosticsFilter;
  readonly endOfLineDiagnostics: InlineDiagnosticsFilter;
  readonly inlineDiagnosticsPrefixLen: number;
  readonly inlineDiagnosticsMaxWrap: number;
  readonly inlineDiagnosticsMinDiagnosticWidth: number;
  readonly inlineDiagnosticsMaxDiagnostics: number;
  readonly autoCompletion: boolean;
  readonly completionTimeout: number;
  readonly completionTriggerLen: number;
  readonly previewCompletionInsert: boolean;
  readonly autoInfo: boolean;
  readonly completionReplace: boolean;
  readonly colorModes: boolean;
  readonly trueColor: boolean;
  readonly undercurl: boolean;
  readonly bufferline: 'always' | 'never' | 'multiple';
  readonly defaultLineEnding: DefaultLineEnding;
  readonly atomicSave?: boolean;
  readonly indentHeuristic: 'simple' | 'tree-sitter' | 'hybrid';
  readonly jumpLabelAlphabet: readonly string[];
  readonly popupBorder: PopupBorder;
  readonly statusline: StatuslineConfig;
  readonly autoFormat: boolean;
  readonly autoSave: { readonly focusLost: boolean; readonly afterDelay: { readonly enable: boolean; readonly timeout: number } };
  readonly defaultYankRegister: string;
  readonly insertFinalNewline: boolean;
  readonly trimFinalNewlines: boolean;
  readonly trimTrailingWhitespace: boolean;
  readonly search: { readonly smartCase: boolean; readonly wrapAround: boolean };
  readonly motionTrail: 'off' | 'last-motion';
  readonly selection: SelectionConfig;
  readonly hintsDelayMs: number;
  readonly cursorShape: { readonly normal: 'block' | 'bar' | 'underline' | 'hidden'; readonly insert: 'block' | 'bar' | 'underline' | 'hidden'; readonly select: 'block' | 'bar' | 'underline' | 'hidden' };
  readonly filePicker: { readonly hidden: boolean; readonly followSymlinks: boolean; readonly deduplicateLinks: boolean; readonly parents: boolean; readonly ignore: boolean; readonly gitIgnore: boolean; readonly gitGlobal: boolean; readonly gitExclude: boolean; readonly maxDepth: number | undefined };
  readonly fileExplorer: { readonly hidden: boolean; readonly followSymlinks: boolean; readonly parents: boolean; readonly ignore: boolean; readonly gitIgnore: boolean; readonly gitGlobal: boolean; readonly gitExclude: boolean; readonly flattenDirs: boolean };
  readonly bufferPicker: { readonly startPosition: 'current' | 'previous' };
  readonly lsp: { readonly enable: boolean; readonly displayInlayHints: boolean; readonly inlayHintsLengthLimit: number | undefined; readonly inlayHints: boolean; readonly displayColorSwatches: boolean; readonly autoDocumentHighlight: boolean; readonly gotoReferenceIncludeDeclaration: boolean; readonly snippets: boolean; readonly displayMessages: boolean; readonly displayProgressMessages: boolean; readonly autoSignatureHelp: boolean; readonly displaySignatureHelpDocs: boolean };
}

export interface ClipboardCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
}

export type ClipboardProviderConfig =
  | { readonly kind: 'builtin'; readonly name: string }
  | {
    readonly kind: 'custom';
    readonly yank: ClipboardCommandConfig;
    readonly paste: ClipboardCommandConfig;
    readonly primaryYank?: ClipboardCommandConfig;
    readonly primaryPaste?: ClipboardCommandConfig;
  };

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
  popupBorder: 'none', sidebarVisible: true, sidebarWidth: 28, sidebarPanel: 'files',
  theme: 'xi-light', themeVariants: Object.freeze({}), lineNumber: 'absolute', lineNumberMinWidth: 3, gutters: Object.freeze(['diagnostics', 'spacer', 'line-numbers', 'spacer', 'diff'] as EditorGutter[]), indentGuides: Object.freeze({ render: false, character: '│', skipLevels: 0 }), whitespace: Object.freeze({ render: Object.freeze({ default: false, space: false, nbsp: false, nnbsp: false, tab: false, newline: false }), characters: Object.freeze({ space: '·', nbsp: '⍽', nnbsp: '␣', tab: '→', tabpad: ' ', newline: '⏎' }) }), smartTab: Object.freeze({ enable: true, supersedeMenu: false }), wordCompletion: Object.freeze({ enable: true, triggerLength: 7 }), workspaceTrust: Object.freeze({ level: 'servers', prompt: true, trusted: Object.freeze([]) }), autoPairs: Object.freeze({ '(': ')', '{': '}', '[': ']', '"': '"', "'": "'", '`': '`' }), editorConfig: true, continueComments: true, cursorline: false, cursorcolumn: false, rainbowBrackets: false, rulers: Object.freeze([]), textWidth: 80, wrapAtTextWidth: false, scrolloff: 5,
  mouse: Object.freeze({ enabled: true, modifier: 'none', scrollLines: 3 }), shell: Object.freeze(['sh', '-c'] as [string, string]), wrap: false, softWrapMaxWrap: 20, softWrapMaxIndentRetain: 40, pathCompletion: true, autoCompletion: true, completionTimeout: 250, completionTriggerLen: 2, previewCompletionInsert: true, autoInfo: true, completionReplace: false, colorModes: false, trueColor: false, undercurl: false, bufferline: 'never', defaultLineEnding: 'native', statusline: Object.freeze({ left: Object.freeze(['mode', 'spinner', 'file-name', 'read-only-indicator', 'file-modification-indicator'] as StatuslineElement[]), center: Object.freeze([] as StatuslineElement[]), right: Object.freeze(['diagnostics', 'selections', 'register', 'position', 'file-encoding'] as StatuslineElement[]), separator: '│', mode: Object.freeze({ normal: 'NOR', insert: 'INS', select: 'SEL' }), diagnostics: Object.freeze(['warning', 'error'] as StatuslineDiagnosticSeverity[]), workspaceDiagnostics: Object.freeze(['warning', 'error'] as StatuslineDiagnosticSeverity[]), }), autoFormat: true, autoSave: Object.freeze({ focusLost: false, afterDelay: Object.freeze({ enable: false, timeout: 3000 }) }), defaultYankRegister: '"', insertFinalNewline: true, trimFinalNewlines: false, trimTrailingWhitespace: false,
  kittyKeyboardProtocol: 'auto',
  mouseYankRegister: '*',
  clipboardProvider: Object.freeze({ kind: 'builtin', name: 'platform' }),
  middleClickPaste: true,
  search: Object.freeze({ smartCase: true, wrapAround: true }), wrapIndicator: '↪ ', inlineDiagnosticsCursorLine: 'warning', inlineDiagnosticsOtherLines: 'disable', endOfLineDiagnostics: 'hint', inlineDiagnosticsPrefixLen: 1, inlineDiagnosticsMaxWrap: 20, inlineDiagnosticsMinDiagnosticWidth: 40, inlineDiagnosticsMaxDiagnostics: 10,
  idleTimeout: 250, motionTrail: 'last-motion', selection: Object.freeze({ limit: 10_000, historyLimit: 100 }), hintsDelayMs: 250,
  atomicSave: true,
  indentHeuristic: 'hybrid',
  jumpLabelAlphabet: Object.freeze([...('abcdefghijklmnopqrstuvwxyz')]),
  workspaceLspRoots: Object.freeze([]),
  cursorShape: Object.freeze({ normal: 'block', insert: 'block', select: 'block' }),
  filePicker: Object.freeze({ hidden: true, followSymlinks: true, deduplicateLinks: true, parents: true, ignore: true, gitIgnore: true, gitGlobal: true, gitExclude: true, maxDepth: undefined }),
  fileExplorer: Object.freeze({ hidden: false, followSymlinks: false, parents: false, ignore: false, gitIgnore: false, gitGlobal: false, gitExclude: false, flattenDirs: true }),
  bufferPicker: Object.freeze({ startPosition: 'current' }),
  lsp: Object.freeze({ enable: true, displayInlayHints: false, inlayHintsLengthLimit: undefined, inlayHints: false, displayColorSwatches: true, autoDocumentHighlight: false, gotoReferenceIncludeDeclaration: true, snippets: true, displayMessages: true, displayProgressMessages: false, autoSignatureHelp: true, displaySignatureHelpDocs: true }),
});
const defaultSearch: SearchConfig = Object.freeze({ debounceMs: 5, maxVisibleResults: 10_000, hidden: true, followSymlinks: false });

/** Parse the TOML subset used by Xi config, language and theme files. */
export function parseToml(source: string, fileName = 'config.toml'): Result<ParsedToml, TomlParseFailure> {
  const root: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
  const entries: TomlEntry[] = [];
  const tables: { readonly path: readonly string[]; readonly location: SourceLocation }[] = [];
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
      tables.push({ path: Object.freeze(path), location: { fileName, line: lineIndex + 1, column } });
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
      tables.push({ path: Object.freeze(path), location: { fileName, line: lineIndex + 1, column } });
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
    ? { ok: true, value: Object.freeze({ fileName, value: freezeValue(root) as { readonly [key: string]: TomlValue }, entries: Object.freeze(entries), tables: Object.freeze(tables) }) }
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
  const active = parsed.filter(({ layer, document }) => layer.kind !== 'profile' || profile === 'personal' || configProfileValue(document.value) !== 'personal');
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
    applyLegacyAliases(merged, document.value, layer.name, provenance, locations);
  }
  if (diagnostics.length > 0) return { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
  const compiled = validateMerged(merged, profile, catalog, provenance, locations);
  if (!compiled.ok) return compiled;
  const generation = (options.initialGeneration ?? 0) + 1;
  return { ok: true, value: Object.freeze({ ...compiled.value, generation }) };
}

const LEGACY_ALIASES = [
  ['editor.sidebar-visible', 'xi.sidebar.visible'],
  ['editor.sidebar-width', 'xi.sidebar.width'],
  ['editor.sidebar-panel', 'xi.sidebar.panel'],
  ['editor.mouse.modifier', 'xi.mouse.modifier'],
  ['editor.selection-limit', 'xi.selection.limit'],
  ['editor.selection-history-limit', 'xi.selection.history-limit'],
  ['editor.hints.delay-ms', 'xi.hints.delay-ms'],
  ['search.debounce-ms', 'xi.search.debounce-ms'],
  ['search.max-visible-results', 'xi.search.max-visible-results'],
] as const;

function pathValue(root: { readonly [key: string]: TomlValue }, path: string): TomlValue | undefined {
  let current: TomlValue = root;
  for (const key of path.split('.')) {
    const table = asRecord(current);
    if (table === undefined) return undefined;
    current = table[key] as TomlValue;
    if (current === undefined) return undefined;
  }
  return current;
}

function applyLegacyAliases(merged: Record<string, TomlValue>, layer: { readonly [key: string]: TomlValue }, name: string, provenance: Record<string, string>, locations: Map<string, SourceLocation>): void {
  for (const [legacy, canonical] of LEGACY_ALIASES) {
    const value = pathValue(layer, legacy);
    if (value === undefined || pathValue(layer, canonical) !== undefined) continue;
    const keys = canonical.split('.');
    let nested: TomlValue = value;
    for (let index = keys.length - 1; index >= 0; index -= 1) nested = { [keys[index] as string]: nested };
    mergeValue(merged, nested as Record<string, TomlValue>, '', name, provenance, locations);
    const location = locations.get(legacy);
    if (location !== undefined) locations.set(canonical, location);
  }
}

function inferProfile(parsed: readonly { readonly layer: ConfigLayer; readonly document: ParsedToml }[]): ConfigProfile {
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const value = configProfileValue(parsed[index]?.document.value ?? Object.create(null));
    if (value === 'strict' || value === 'xi' || value === 'personal') return value;
  }
  return 'xi';
}

function configProfileValue(root: { readonly [key: string]: TomlValue }): TomlValue | undefined {
  const xi = asRecord(root.xi);
  return xi?.profile ?? root.profile;
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

/** Configured argv tasks: explicit argv, cwd/env and an optional built-in problem matcher;
 * never automatic shell evaluation. */
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
export function resolveFormatOnSave(env: Readonly<Record<string, string | undefined>>, configuredAutoFormat: boolean, globalAutoFormat = true): boolean {
  return env.XI_FORMAT_ON_SAVE === '1' || (globalAutoFormat && configuredAutoFormat);
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
  configPath?: string,
  workspaceConfigPath?: string,
  environment: Readonly<Record<string, string | undefined>> = {},
  workspaceTrustResolver?: WorkspaceTrustResolver,
): Promise<LoadedStartupConfig> {
  const layers: ConfigLayer[] = [
    { name: 'defaults', kind: 'defaults', source: DEFAULT_CONFIG_TOML, fileName: 'config/default.toml' },
    // Built-in languages.toml (typescript/pyright/...): without it, a user with no
    // ~/.config/xi/languages.toml had no language server for anything but the hardcoded
    // ts/js fallback. A user `[[language]]` array replaces this list wholesale (arrays do not
    // merge); `[language-server.<name>]` tables merge by name.
    { name: 'default-languages', kind: 'language', source: DEFAULT_LANGUAGES_TOML, fileName: 'config/languages.toml' },
  ];
  const overridePromise = overridesPath === undefined ? undefined : filesystem.readFile(overridesPath, cancellation);
  const languagesPromise = filesystem.readFile(`${configDirectory}/languages.toml`, cancellation);
  const configToml = await filesystem.readFile(configPath ?? `${configDirectory}/config.toml`, cancellation);
  if (configToml.ok) layers.push({ name: configPath === undefined ? 'user' : 'cli', kind: configPath === undefined ? 'user' : 'cli', source: new TextDecoder('utf-8').decode(configToml.value), fileName: configPath ?? 'config.toml' });
  else if (configPath !== undefined) return { config: undefined, diagnostics: [`${configPath}: ${configToml.error.message}`] };
  let overrideLayer: ConfigLayer | undefined;
  if (overridesPath !== undefined && overridePromise !== undefined) {
    const overrides = await overridePromise;
    if (overrides.ok) {
      try { overrideLayer = { name: 'state-overrides', kind: 'user', source: new TextDecoder('utf-8', { fatal: true }).decode(overrides.value), fileName: overridesPath }; }
      catch { return { config: undefined, diagnostics: [`${overridesPath}: invalid UTF-8`] }; }
    }
  }
  // The old home file remains a compatibility/state fallback; an explicit user or CLI
  // config must win when both contain the same setting.
  if (overrideLayer !== undefined) layers.splice(2, 0, overrideLayer);
  const commandCatalog = { ...DEFAULT_COMMAND_CATALOG, commandIds: [...DEFAULT_COMMAND_CATALOG.commandIds, ...extraCommandIds] };
  const workspaceDiagnostics: string[] = [];
  let userConfig: ConfigCompileResult | undefined;
  const userLayerCount = layers.length;
  if (workspaceConfigPath !== undefined) {
    userConfig = compileConfig(layers, { commandCatalog });
    const trust = userConfig.ok ? userConfig.value.editor.workspaceTrust : defaultEditor.workspaceTrust;
    const workspaceRoot = workspaceRootFromConfigPath(workspaceConfigPath);
    const implicit = workspaceTrustAllows(workspaceRoot, trust, environment);
    const decision = workspaceTrustResolver === undefined
      ? { workspaceConfigAllowed: implicit, serversAllowed: trust.level !== 'none' || implicit, gitAllowed: trust.level === 'insecure' || implicit, stale: false }
      : await workspaceTrustResolver.resolve(workspaceRoot, trust, cancellation);
    if (configPath === undefined) {
      const workspaceLanguagesPath = workspaceConfigPath.replace(/config\.toml$/u, 'languages.toml');
      const [workspaceToml, workspaceLanguagesToml] = await Promise.all([
        filesystem.readFile(workspaceConfigPath, cancellation),
        filesystem.readFile(workspaceLanguagesPath, cancellation),
      ]);
      if (workspaceToml.ok || workspaceLanguagesToml.ok) {
        if (decision.workspaceConfigAllowed) {
          if (workspaceToml.ok) layers.push({ name: 'workspace', kind: 'workspace', trusted: true, source: new TextDecoder('utf-8').decode(workspaceToml.value), fileName: workspaceConfigPath });
          if (workspaceLanguagesToml.ok) layers.push({ name: 'workspace-languages', kind: 'workspace', trusted: true, source: new TextDecoder('utf-8').decode(workspaceLanguagesToml.value), fileName: workspaceLanguagesPath });
        } else if (trust.prompt) workspaceDiagnostics.push(`${workspaceConfigPath}: workspace configuration is untrusted${decision.stale ? ' or stale' : ''} and was not loaded`);
      }
    }
  }
  const languagesToml = await languagesPromise;
  if (languagesToml.ok) layers.push({ name: 'languages', kind: 'language', source: new TextDecoder('utf-8').decode(languagesToml.value), fileName: 'languages.toml' });
  if (layers.length === userLayerCount && userConfig !== undefined) return userConfig.ok
    ? { config: userConfig.value, diagnostics: Object.freeze(workspaceDiagnostics) }
    : { config: undefined, diagnostics: userConfig.error.diagnostics.map((diagnostic) => diagnostic.message) };
  const compiled = compileConfig(layers, { commandCatalog });
  if (!compiled.ok) return { config: undefined, diagnostics: compiled.error.diagnostics.map((diagnostic) => diagnostic.message) };
  return { config: compiled.value, diagnostics: Object.freeze(workspaceDiagnostics) };
}

function workspaceRootFromConfigPath(path: string): string {
  return path.replace(/[\\/]\.helix[\\/]config\.toml$/u, '') || path;
}

function normalizeTrustPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replaceAll(/\/+/gu, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/u, '') : normalized;
}

function expandTrustPattern(pattern: string, environment: Readonly<Record<string, string | undefined>>): string {
  const home = environment.HOME;
  return normalizeTrustPath(pattern.replace(/^~(?=$|[\\/])/u, home ?? '~').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, braced: string | undefined, bare: string | undefined) => environment[braced ?? bare ?? ''] ?? '\u0000'));
}

function globMatches(value: string, pattern: string): boolean {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '*' && pattern[index + 1] === '*') { source += '.*'; index += 1; }
    else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += /[\\^$+{}.[\]|()]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${source}$`, 'u').test(value);
}

export const DEFAULT_CONFIG_TOML = defaultConfigToml;

export const PERSONAL_MIGRATION_TOML = `[xi]
schema-version = 1
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

[language-server.ruby-lsp]
command = "ruby-lsp"
args = []
root-markers = ["Gemfile", "gems.rb", ".ruby-version", ".git"]

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
name = "ruby"
file-types = ["rb", "rake", "gemspec", "Gemfile", "Rakefile", "Guardfile", "Podfile", "Vagrantfile", ".irbrc"]
language-servers = ["ruby-lsp"]
indent = { tab-width = 2, unit = "  " }

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
  for (const table of document.tables) {
    const path = table.path.join('.');
    if (!isKnownPath(table.path)) diagnostics.push({ ...table.location, path, code: 'unknown-key', message: `unknown configuration table ${path}` });
  }
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
  for (const key of ['editor', 'keys', 'search', 'aliases', 'xi'] as const) {
    if (root[key] !== undefined && asRecord(root[key]) === undefined) diagnostics.push(issue(key, 'invalid-type', `${key} must be a table`, locations));
  }
  const editor = asRecord(root.editor) ?? Object.create(null) as Record<string, TomlValue>;
  const xi = asRecord(root.xi);
  const xiSidebar = asRecord(xi?.sidebar);
  const xiMouse = asRecord(xi?.mouse);
  const xiSelection = asRecord(xi?.selection);
  const xiHints = asRecord(xi?.hints);
  const xiSearch = asRecord(xi?.search);
  const search = asRecord(root.search) ?? Object.create(null) as Record<string, TomlValue>;
  const editorSearch = asRecord(editor.search);
  const editorMouse = asRecord(editor.mouse);
  const statusline = asRecord(editor.statusline);
  const statuslineMode = asRecord(statusline?.mode);
  const gutters = asRecord(editor.gutters);
  const indentGuides = asRecord(editor['indent-guides']);
  const whitespace = asRecord(editor.whitespace);
  const whitespaceRender = asRecord(whitespace?.render);
  const whitespaceCharacters = asRecord(whitespace?.characters);
  const smartTab = asRecord(editor['smart-tab']);
  const wordCompletion = asRecord(editor['word-completion']);
  const workspaceTrust = asRecord(editor['workspace-trust']);
  const autoPairs = asRecord(editor['auto-pairs']);
  const lineNumbers = asRecord(gutters?.['line-numbers']);
  const cursorShape = asRecord(editor['cursor-shape']);
  const softWrap = asRecord(editor['soft-wrap']);
  const inlineDiagnostics = asRecord(editor['inline-diagnostics']);
  const filePicker = asRecord(editor['file-picker']);
  const fileExplorer = asRecord(editor['file-explorer']);
  const bufferPicker = asRecord(editor['buffer-picker']);
  const autoSaveTable = asRecord(editor['auto-save']);
  const autoSaveAfterDelay = asRecord(autoSaveTable?.['after-delay']);
  const lsp = asRecord(editor.lsp);
  const hints = asRecord(editor.hints);
  const shell = parseShell(editor.shell);
  const clipboardProvider = parseClipboardProvider(editor['clipboard-provider'], locations, diagnostics);
  const themeTable = asRecord(root.theme);
  const configuredSchemaVersion = xi?.['schema-version'] ?? root['schema-version'];
  const schemaPath = xi?.['schema-version'] === undefined ? 'schema-version' : 'xi.schema-version';
  if (configuredSchemaVersion !== undefined && configuredSchemaVersion !== 1) diagnostics.push(issue(schemaPath, 'unsupported-schema', 'schema-version must be 1', locations));
  const configuredProfile = xi?.profile ?? root.profile;
  const profilePath = xi?.profile === undefined ? 'profile' : 'xi.profile';
  if (configuredProfile !== undefined && (typeof configuredProfile !== 'string' || !['strict', 'xi', 'personal'].includes(configuredProfile))) diagnostics.push(issue(profilePath, 'invalid-value', 'profile must be strict, xi or personal', locations));
  if (root.theme !== undefined && typeof root.theme !== 'string' && themeTable === undefined) diagnostics.push(issue('theme', 'invalid-type', 'theme must be a string or a table', locations));
  for (const key of ['dark', 'light', 'fallback'] as const) if (themeTable?.[key] !== undefined && typeof themeTable[key] !== 'string') diagnostics.push(issue(`theme.${key}`, 'invalid-type', `theme.${key} must be a string`, locations));
  const theme = typeof root.theme === 'string' ? root.theme : textField(editor, 'theme') ?? 'xi-light';
  const themeVariants = Object.freeze({
    ...(typeof themeTable?.dark === 'string' ? { dark: themeTable.dark } : {}),
    ...(typeof themeTable?.light === 'string' ? { light: themeTable.light } : {}),
    ...(typeof themeTable?.fallback === 'string' ? { fallback: themeTable.fallback } : {}),
  });
  if (typeof root.theme === 'string') provenance['editor.theme'] = provenance.theme ?? provenance['editor.theme'] ?? 'merged';
  if (editor.cursorline !== undefined && typeof editor.cursorline !== 'boolean') diagnostics.push(issue('editor.cursorline', 'invalid-type', 'editor.cursorline must be a boolean', locations));
  if (editor.cursorcolumn !== undefined && typeof editor.cursorcolumn !== 'boolean') diagnostics.push(issue('editor.cursorcolumn', 'invalid-type', 'editor.cursorcolumn must be a boolean', locations));
  if (editor['editor-config'] !== undefined && typeof editor['editor-config'] !== 'boolean') diagnostics.push(issue('editor.editor-config', 'invalid-type', 'editor.editor-config must be a boolean', locations));
  if (editor['atomic-save'] !== undefined && typeof editor['atomic-save'] !== 'boolean') diagnostics.push(issue('editor.atomic-save', 'invalid-type', 'editor.atomic-save must be a boolean', locations));
  if (editor.shell !== undefined && (!Array.isArray(editor.shell) || editor.shell.length < 1 || editor.shell.some((value) => typeof value !== 'string' || value.length === 0))) diagnostics.push(issue('editor.shell', 'invalid-value', 'editor.shell must be a non-empty string array', locations));
  if (editor.rulers !== undefined && integerArrayField(editor, 'rulers') === undefined) diagnostics.push(issue('editor.rulers', 'invalid-type', 'editor.rulers must be an array of positive integers', locations));
  if (editor['workspace-lsp-roots'] !== undefined && stringArrayField(editor, 'workspace-lsp-roots') === undefined) diagnostics.push(issue('editor.workspace-lsp-roots', 'invalid-type', 'editor.workspace-lsp-roots must be an array of relative directory strings', locations));
  if (stringArrayField(editor, 'workspace-lsp-roots')?.some((root) => root.length === 0 || root.startsWith('/') || root.includes('\\') || root.split('/').some((part) => part === '' || part === '.' || part === '..'))) diagnostics.push(issue('editor.workspace-lsp-roots', 'invalid-value', 'editor.workspace-lsp-roots must contain non-empty relative directory paths', locations));
  if (editor.gutters !== undefined && !Array.isArray(editor.gutters) && gutters === undefined) diagnostics.push(issue('editor.gutters', 'invalid-type', 'editor.gutters must be an array or table', locations));
  const gutterValues = Array.isArray(editor.gutters) ? editor.gutters : gutters?.layout;
  if (gutterValues !== undefined && (!Array.isArray(gutterValues) || !gutterValues.every((item): item is string => typeof item === 'string' && ['diagnostics', 'spacer', 'line-numbers', 'diff', 'code-action-hint'].includes(item)))) {
    diagnostics.push(issue(Array.isArray(editor.gutters) ? 'editor.gutters' : 'editor.gutters.layout', 'invalid-value', 'gutter layout must be an array of diagnostics, spacer, line-numbers, diff or code-action-hint', locations));
  }
  if (gutters?.layout !== undefined && !Array.isArray(gutters.layout)) diagnostics.push(issue('editor.gutters.layout', 'invalid-type', 'editor.gutters.layout must be an array', locations));
  if (gutters?.['line-numbers'] !== undefined && lineNumbers === undefined) diagnostics.push(issue('editor.gutters.line-numbers', 'invalid-type', 'editor.gutters.line-numbers must be a table', locations));
  for (const gutter of ['diagnostics', 'diff', 'spacer'] as const) {
    if (gutters?.[gutter] !== undefined && asRecord(gutters[gutter]) === undefined) diagnostics.push(issue(`editor.gutters.${gutter}`, 'invalid-type', `editor.gutters.${gutter} must be an empty table`, locations));
  }
  if (editor['indent-guides'] !== undefined && indentGuides === undefined) diagnostics.push(issue('editor.indent-guides', 'invalid-type', 'editor.indent-guides must be a table', locations));
  if (indentGuides?.render !== undefined && typeof indentGuides.render !== 'boolean') diagnostics.push(issue('editor.indent-guides.render', 'invalid-type', 'editor.indent-guides.render must be a boolean', locations));
  if (indentGuides?.character !== undefined && (typeof indentGuides.character !== 'string' || [...indentGuides.character].length !== 1 || /[\r\n\t]/u.test(indentGuides.character))) diagnostics.push(issue('editor.indent-guides.character', 'invalid-value', 'editor.indent-guides.character must be one non-whitespace code point', locations));
  if (indentGuides?.['skip-levels'] !== undefined && (typeof indentGuides['skip-levels'] !== 'number' || !Number.isSafeInteger(indentGuides['skip-levels']) || indentGuides['skip-levels'] < 0 || indentGuides['skip-levels'] > 1000)) diagnostics.push(issue('editor.indent-guides.skip-levels', 'invalid-value', 'editor.indent-guides.skip-levels must be an integer from 0 to 1000', locations));
  if (editor.whitespace !== undefined && whitespace === undefined) diagnostics.push(issue('editor.whitespace', 'invalid-type', 'editor.whitespace must be a table', locations));
  if (whitespace?.render !== undefined && typeof whitespace.render !== 'string' && whitespaceRender === undefined) diagnostics.push(issue('editor.whitespace.render', 'invalid-type', 'editor.whitespace.render must be "all", "none" or a table', locations));
  if (typeof whitespace?.render === 'string' && whitespace.render !== 'all' && whitespace.render !== 'none') diagnostics.push(issue('editor.whitespace.render', 'invalid-value', 'editor.whitespace.render must be "all" or "none"', locations));
  for (const kind of ['default', 'space', 'nbsp', 'nnbsp', 'tab', 'newline'] as const) if (whitespaceRender?.[kind] !== undefined && whitespaceRender[kind] !== 'all' && whitespaceRender[kind] !== 'none') diagnostics.push(issue(`editor.whitespace.render.${kind}`, 'invalid-value', 'whitespace render values must be "all" or "none"', locations));
  if (whitespace?.characters !== undefined && whitespaceCharacters === undefined) diagnostics.push(issue('editor.whitespace.characters', 'invalid-type', 'editor.whitespace.characters must be a table', locations));
  for (const kind of ['space', 'nbsp', 'nnbsp', 'tab', 'tabpad', 'newline'] as const) if (whitespaceCharacters?.[kind] !== undefined && (typeof whitespaceCharacters[kind] !== 'string' || [...whitespaceCharacters[kind] as string].length !== 1 || /[\r\n\t]/u.test(whitespaceCharacters[kind] as string))) diagnostics.push(issue(`editor.whitespace.characters.${kind}`, 'invalid-value', 'whitespace characters must be one code point without tabs or newlines', locations));
  if (editor['smart-tab'] !== undefined && smartTab === undefined) diagnostics.push(issue('editor.smart-tab', 'invalid-type', 'editor.smart-tab must be a table', locations));
  if (smartTab?.enable !== undefined && typeof smartTab.enable !== 'boolean') diagnostics.push(issue('editor.smart-tab.enable', 'invalid-type', 'editor.smart-tab.enable must be a boolean', locations));
  if (smartTab?.['supersede-menu'] !== undefined && typeof smartTab['supersede-menu'] !== 'boolean') diagnostics.push(issue('editor.smart-tab.supersede-menu', 'invalid-type', 'editor.smart-tab.supersede-menu must be a boolean', locations));
  if (editor['word-completion'] !== undefined && wordCompletion === undefined) diagnostics.push(issue('editor.word-completion', 'invalid-type', 'editor.word-completion must be a table', locations));
  if (wordCompletion?.enable !== undefined && typeof wordCompletion.enable !== 'boolean') diagnostics.push(issue('editor.word-completion.enable', 'invalid-type', 'editor.word-completion.enable must be a boolean', locations));
  if (editor['workspace-trust'] !== undefined && workspaceTrust === undefined) diagnostics.push(issue('editor.workspace-trust', 'invalid-type', 'editor.workspace-trust must be a table', locations));
  if (workspaceTrust?.prompt !== undefined && typeof workspaceTrust.prompt !== 'boolean') diagnostics.push(issue('editor.workspace-trust.prompt', 'invalid-type', 'editor.workspace-trust.prompt must be a boolean', locations));
  if (workspaceTrust?.trusted !== undefined && (stringArrayField(workspaceTrust, 'trusted') === undefined || (stringArrayField(workspaceTrust, 'trusted') ?? []).some((pattern) => pattern.length === 0))) diagnostics.push(issue('editor.workspace-trust.trusted', 'invalid-value', 'editor.workspace-trust.trusted must be a non-empty string array', locations));
  if (editor['auto-pairs'] !== undefined && typeof editor['auto-pairs'] !== 'boolean' && autoPairs === undefined) diagnostics.push(issue('editor.auto-pairs', 'invalid-type', 'editor.auto-pairs must be a boolean or table', locations));
  if (autoPairs !== undefined && Object.entries(autoPairs).some(([opening, closing]) => [...opening].length !== 1 || typeof closing !== 'string' || [...closing].length !== 1 || /[\r\n]/u.test(opening + closing))) diagnostics.push(issue('editor.auto-pairs', 'invalid-value', 'editor.auto-pairs table keys and values must be one character without newlines', locations));
  if (editor.statusline !== undefined && statusline === undefined) diagnostics.push(issue('editor.statusline', 'invalid-type', 'editor.statusline must be a table', locations));
  if (statusline?.mode !== undefined && statuslineMode === undefined) diagnostics.push(issue('editor.statusline.mode', 'invalid-type', 'editor.statusline.mode must be a table', locations));
  if (statusline?.separator !== undefined && typeof statusline.separator !== 'string') diagnostics.push(issue('editor.statusline.separator', 'invalid-type', 'editor.statusline.separator must be a string', locations));
  for (const mode of ['normal', 'insert', 'select'] as const) if (statuslineMode?.[mode] !== undefined && typeof statuslineMode[mode] !== 'string') diagnostics.push(issue(`editor.statusline.mode.${mode}`, 'invalid-type', `editor.statusline.mode.${mode} must be a string`, locations));
  if (editor['file-picker'] !== undefined && filePicker === undefined) diagnostics.push(issue('editor.file-picker', 'invalid-type', 'editor.file-picker must be a table', locations));
  if (filePicker?.hidden !== undefined && typeof filePicker.hidden !== 'boolean') diagnostics.push(issue('editor.file-picker.hidden', 'invalid-type', 'editor.file-picker.hidden must be a boolean', locations));
  if (filePicker?.['follow-symlinks'] !== undefined && typeof filePicker['follow-symlinks'] !== 'boolean') diagnostics.push(issue('editor.file-picker.follow-symlinks', 'invalid-type', 'editor.file-picker.follow-symlinks must be a boolean', locations));
  if (filePicker?.['deduplicate-links'] !== undefined && typeof filePicker['deduplicate-links'] !== 'boolean') diagnostics.push(issue('editor.file-picker.deduplicate-links', 'invalid-type', 'editor.file-picker.deduplicate-links must be a boolean', locations));
  for (const key of ['parents', 'ignore', 'git-ignore', 'git-global', 'git-exclude'] as const) if (filePicker?.[key] !== undefined && typeof filePicker[key] !== 'boolean') diagnostics.push(issue(`editor.file-picker.${key}`, 'invalid-type', `editor.file-picker.${key} must be a boolean`, locations));
  if (editor['sidebar-visible'] !== undefined && typeof editor['sidebar-visible'] !== 'boolean') {
    diagnostics.push(issue('editor.sidebar-visible', 'invalid-type', 'editor.sidebar-visible must be a boolean', locations));
  }
  if (xi?.sidebar !== undefined && xiSidebar === undefined) diagnostics.push(issue('xi.sidebar', 'invalid-type', 'xi.sidebar must be a table', locations));
  if (xiSidebar?.visible !== undefined && typeof xiSidebar.visible !== 'boolean') diagnostics.push(issue('xi.sidebar.visible', 'invalid-type', 'xi.sidebar.visible must be a boolean', locations));
  if (xi?.mouse !== undefined && xiMouse === undefined) diagnostics.push(issue('xi.mouse', 'invalid-type', 'xi.mouse must be a table', locations));
  if (xi?.selection !== undefined && xiSelection === undefined) diagnostics.push(issue('xi.selection', 'invalid-type', 'xi.selection must be a table', locations));
  if (xi?.hints !== undefined && xiHints === undefined) diagnostics.push(issue('xi.hints', 'invalid-type', 'xi.hints must be a table', locations));
  if (xi?.search !== undefined && xiSearch === undefined) diagnostics.push(issue('xi.search', 'invalid-type', 'xi.search must be a table', locations));
  if (xi?.aliases !== undefined && asRecord(xi.aliases) === undefined) diagnostics.push(issue('xi.aliases', 'invalid-type', 'xi.aliases must be a table', locations));
  if (editor['buffer-picker'] !== undefined && bufferPicker === undefined) diagnostics.push(issue('editor.buffer-picker', 'invalid-type', 'editor.buffer-picker must be a table', locations));
  if (editor['file-explorer'] !== undefined && fileExplorer === undefined) diagnostics.push(issue('editor.file-explorer', 'invalid-type', 'editor.file-explorer must be a table', locations));
  if (fileExplorer?.hidden !== undefined && typeof fileExplorer.hidden !== 'boolean') diagnostics.push(issue('editor.file-explorer.hidden', 'invalid-type', 'editor.file-explorer.hidden must be a boolean', locations));
  if (fileExplorer?.['follow-symlinks'] !== undefined && typeof fileExplorer['follow-symlinks'] !== 'boolean') diagnostics.push(issue('editor.file-explorer.follow-symlinks', 'invalid-type', 'editor.file-explorer.follow-symlinks must be a boolean', locations));
  if (fileExplorer?.['flatten-dirs'] !== undefined && typeof fileExplorer['flatten-dirs'] !== 'boolean') diagnostics.push(issue('editor.file-explorer.flatten-dirs', 'invalid-type', 'editor.file-explorer.flatten-dirs must be a boolean', locations));
  for (const key of ['parents', 'ignore', 'git-ignore', 'git-global', 'git-exclude'] as const) if (fileExplorer?.[key] !== undefined && typeof fileExplorer[key] !== 'boolean') diagnostics.push(issue(`editor.file-explorer.${key}`, 'invalid-type', `editor.file-explorer.${key} must be a boolean`, locations));
  if (editor['auto-save'] !== undefined && typeof editor['auto-save'] !== 'boolean' && autoSaveTable === undefined) diagnostics.push(issue('editor.auto-save', 'invalid-type', 'editor.auto-save must be a boolean or table', locations));
  if (autoSaveTable?.['focus-lost'] !== undefined && typeof autoSaveTable['focus-lost'] !== 'boolean') diagnostics.push(issue('editor.auto-save.focus-lost', 'invalid-type', 'editor.auto-save.focus-lost must be a boolean', locations));
  if (autoSaveTable?.['after-delay'] !== undefined && autoSaveAfterDelay === undefined) diagnostics.push(issue('editor.auto-save.after-delay', 'invalid-type', 'editor.auto-save.after-delay must be a table', locations));
  if (autoSaveAfterDelay?.enable !== undefined && typeof autoSaveAfterDelay.enable !== 'boolean') diagnostics.push(issue('editor.auto-save.after-delay.enable', 'invalid-type', 'editor.auto-save.after-delay.enable must be a boolean', locations));
  if (editor['auto-completion'] !== undefined && typeof editor['auto-completion'] !== 'boolean') diagnostics.push(issue('editor.auto-completion', 'invalid-type', 'editor.auto-completion must be a boolean', locations));
  if (editor['path-completion'] !== undefined && typeof editor['path-completion'] !== 'boolean') diagnostics.push(issue('editor.path-completion', 'invalid-type', 'editor.path-completion must be a boolean', locations));
  if (editor['completion-replace'] !== undefined && typeof editor['completion-replace'] !== 'boolean') diagnostics.push(issue('editor.completion-replace', 'invalid-type', 'editor.completion-replace must be a boolean', locations));
  if (editor['preview-completion-insert'] !== undefined && typeof editor['preview-completion-insert'] !== 'boolean') diagnostics.push(issue('editor.preview-completion-insert', 'invalid-type', 'editor.preview-completion-insert must be a boolean', locations));
  if (editor['auto-info'] !== undefined && typeof editor['auto-info'] !== 'boolean') diagnostics.push(issue('editor.auto-info', 'invalid-type', 'editor.auto-info must be a boolean', locations));
  if (editor['color-modes'] !== undefined && typeof editor['color-modes'] !== 'boolean') diagnostics.push(issue('editor.color-modes', 'invalid-type', 'editor.color-modes must be a boolean', locations));
  if (editor['rainbow-brackets'] !== undefined && typeof editor['rainbow-brackets'] !== 'boolean') diagnostics.push(issue('editor.rainbow-brackets', 'invalid-type', 'editor.rainbow-brackets must be a boolean', locations));
  if (editor['true-color'] !== undefined && typeof editor['true-color'] !== 'boolean') diagnostics.push(issue('editor.true-color', 'invalid-type', 'editor.true-color must be a boolean', locations));
  if (editor.undercurl !== undefined && typeof editor.undercurl !== 'boolean') diagnostics.push(issue('editor.undercurl', 'invalid-type', 'editor.undercurl must be a boolean', locations));
  if (editor.bufferline !== undefined && typeof editor.bufferline !== 'string') diagnostics.push(issue('editor.bufferline', 'invalid-type', 'editor.bufferline must be a string', locations));
  if (editor.search !== undefined && editorSearch === undefined) diagnostics.push(issue('editor.search', 'invalid-type', 'editor.search must be a table', locations));
  if (editorSearch?.['smart-case'] !== undefined && typeof editorSearch['smart-case'] !== 'boolean') diagnostics.push(issue('editor.search.smart-case', 'invalid-type', 'editor.search.smart-case must be a boolean', locations));
  if (editorSearch?.['wrap-around'] !== undefined && typeof editorSearch['wrap-around'] !== 'boolean') diagnostics.push(issue('editor.search.wrap-around', 'invalid-type', 'editor.search.wrap-around must be a boolean', locations));
  const sidebarWidth = xiSidebar?.width === undefined
    ? boundedInteger(editor, 'sidebar-width', 22, 40, 28, diagnostics, locations, 'editor.sidebar-width')
    : boundedInteger({ width: xiSidebar.width }, 'width', 22, 40, 28, diagnostics, locations, 'xi.sidebar.width');
  const sidebarPanel = xiSidebar?.panel === undefined
    ? enumField(editor, 'sidebar-panel', ['files', 'search', 'git'] as const, 'files', diagnostics, locations, 'editor.sidebar-panel')
    : enumField({ panel: xiSidebar.panel }, 'panel', ['files', 'search', 'git'] as const, 'files', diagnostics, locations, 'xi.sidebar.panel');
  const sidebarVisible = xiSidebar?.visible === undefined ? booleanField(editor, 'sidebar-visible') ?? true : xiSidebar.visible === true;
  const lineNumber = enumField(editor, 'line-number', ['absolute', 'relative'] as const, 'absolute', diagnostics, locations, 'editor.line-number');
  const bufferline = enumField(editor, 'bufferline', ['always', 'never', 'multiple'] as const, 'never', diagnostics, locations, 'editor.bufferline');
  const defaultLineEnding = enumField(editor, 'default-line-ending', ['native', 'lf', 'crlf', 'ff', 'cr', 'nel'] as const, 'native', diagnostics, locations, 'editor.default-line-ending');
  const atomicSave = booleanField(editor, 'atomic-save') ?? true;
  const indentHeuristic = enumField(editor, 'indent-heuristic', ['simple', 'tree-sitter', 'hybrid'] as const, 'hybrid', diagnostics, locations, 'editor.indent-heuristic');
  const popupBorder = enumField(editor, 'popup-border', ['none', 'popup', 'menu', 'all'] as const, 'none', diagnostics, locations, 'editor.popup-border');
  const lineNumberMinWidth = boundedInteger(lineNumbers ?? Object.create(null), 'min-width', 1, 100, 3, diagnostics, locations, 'editor.gutters.line-numbers.min-width');
  const guttersConfig: readonly EditorGutter[] = Object.freeze((gutterValues === undefined || !Array.isArray(gutterValues) || !gutterValues.every((item): item is EditorGutter => typeof item === 'string' && ['diagnostics', 'spacer', 'line-numbers', 'diff', 'code-action-hint'].includes(item)))
    ? ['diagnostics', 'spacer', 'line-numbers', 'spacer', 'diff']
    : [...gutterValues]);
  const indentGuidesConfig: IndentGuidesConfig = Object.freeze({
    render: booleanField(indentGuides ?? Object.create(null), 'render') ?? false,
    character: typeof indentGuides?.character === 'string' && [...indentGuides.character].length === 1 && !/[\r\n\t]/u.test(indentGuides.character) ? indentGuides.character : '│',
    skipLevels: boundedInteger(indentGuides ?? Object.create(null), 'skip-levels', 0, 1000, 0, diagnostics, locations, 'editor.indent-guides.skip-levels'),
  });
  const whitespaceRenderValue = typeof whitespace?.render === 'string' ? whitespace.render : undefined;
  const whitespaceRenderDefault = whitespaceRenderValue === 'all' || whitespaceRender?.default === 'all';
  const whitespaceRenderConfig: WhitespaceConfig['render'] = Object.freeze({
    default: whitespaceRenderDefault,
    space: whitespaceRenderValue === undefined ? (whitespaceRender?.space === undefined ? whitespaceRenderDefault : whitespaceRender.space === 'all') : whitespaceRenderDefault,
    nbsp: whitespaceRenderValue === undefined ? (whitespaceRender?.nbsp === undefined ? whitespaceRenderDefault : whitespaceRender.nbsp === 'all') : whitespaceRenderDefault,
    nnbsp: whitespaceRenderValue === undefined ? (whitespaceRender?.nnbsp === undefined ? whitespaceRenderDefault : whitespaceRender.nnbsp === 'all') : whitespaceRenderDefault,
    tab: whitespaceRenderValue === undefined ? (whitespaceRender?.tab === undefined ? whitespaceRenderDefault : whitespaceRender.tab === 'all') : whitespaceRenderDefault,
    newline: whitespaceRenderValue === undefined ? (whitespaceRender?.newline === undefined ? whitespaceRenderDefault : whitespaceRender.newline === 'all') : whitespaceRenderDefault,
  });
  const whitespaceCharactersConfig: WhitespaceConfig['characters'] = Object.freeze({
    space: typeof whitespaceCharacters?.space === 'string' && [...whitespaceCharacters.space].length === 1 && !/[\r\n\t]/u.test(whitespaceCharacters.space) ? whitespaceCharacters.space : '·',
    nbsp: typeof whitespaceCharacters?.nbsp === 'string' && [...whitespaceCharacters.nbsp].length === 1 && !/[\r\n\t]/u.test(whitespaceCharacters.nbsp) ? whitespaceCharacters.nbsp : '⍽',
    nnbsp: typeof whitespaceCharacters?.nnbsp === 'string' && [...whitespaceCharacters.nnbsp].length === 1 && !/[\r\n\t]/u.test(whitespaceCharacters.nnbsp) ? whitespaceCharacters.nnbsp : '␣',
    tab: typeof whitespaceCharacters?.tab === 'string' && [...whitespaceCharacters.tab].length === 1 && !/[\r\n\t]/u.test(whitespaceCharacters.tab) ? whitespaceCharacters.tab : '→',
    tabpad: typeof whitespaceCharacters?.tabpad === 'string' && [...whitespaceCharacters.tabpad].length === 1 && !/[\r\n\t]/u.test(whitespaceCharacters.tabpad) ? whitespaceCharacters.tabpad : ' ',
    newline: typeof whitespaceCharacters?.newline === 'string' && [...whitespaceCharacters.newline].length === 1 && !/[\r\n\t]/u.test(whitespaceCharacters.newline) ? whitespaceCharacters.newline : '⏎',
  });
  const smartTabConfig: SmartTabConfig = Object.freeze({ enable: booleanField(smartTab ?? Object.create(null), 'enable') ?? true, supersedeMenu: booleanField(smartTab ?? Object.create(null), 'supersede-menu') ?? false });
  const wordCompletionConfig: WordCompletionConfig = Object.freeze({ enable: booleanField(wordCompletion ?? Object.create(null), 'enable') ?? true, triggerLength: boundedInteger(wordCompletion ?? Object.create(null), 'trigger-length', 1, 255, 7, diagnostics, locations, 'editor.word-completion.trigger-length') });
  const workspaceTrustConfig: WorkspaceTrustConfig = Object.freeze({ level: enumField(workspaceTrust ?? Object.create(null), 'level', ['none', 'servers', 'insecure'] as const, 'servers', diagnostics, locations, 'editor.workspace-trust.level'), prompt: booleanField(workspaceTrust ?? Object.create(null), 'prompt') ?? true, trusted: Object.freeze([...(stringArrayField(workspaceTrust ?? Object.create(null), 'trusted') ?? [])]) });
  const statuslineConfig: StatuslineConfig = Object.freeze({ left: statuslineElementsField(statusline ?? Object.create(null), 'left', ['mode', 'spinner', 'file-name', 'read-only-indicator', 'file-modification-indicator'], diagnostics, locations, 'editor.statusline.left'), center: statuslineElementsField(statusline ?? Object.create(null), 'center', [], diagnostics, locations, 'editor.statusline.center'), right: statuslineElementsField(statusline ?? Object.create(null), 'right', ['diagnostics', 'selections', 'register', 'position', 'file-encoding'], diagnostics, locations, 'editor.statusline.right'), separator: textField(statusline ?? Object.create(null), 'separator') ?? '│', mode: Object.freeze({ normal: textField(statuslineMode ?? Object.create(null), 'normal') ?? 'NOR', insert: textField(statuslineMode ?? Object.create(null), 'insert') ?? 'INS', select: textField(statuslineMode ?? Object.create(null), 'select') ?? 'SEL' }), diagnostics: statuslineSeverityField(statusline ?? Object.create(null), 'diagnostics', ['warning', 'error'], diagnostics, locations, 'editor.statusline.diagnostics'), workspaceDiagnostics: statuslineSeverityField(statusline ?? Object.create(null), 'workspace-diagnostics', ['warning', 'error'], diagnostics, locations, 'editor.statusline.workspace-diagnostics') });
  const scrolloff = boundedInteger(editor, 'scrolloff', 0, Number.MAX_SAFE_INTEGER, 5, diagnostics, locations, 'editor.scrolloff');
  const idleTimeout = boundedInteger(editor, 'idle-timeout', 0, 2_147_483_647, 250, diagnostics, locations, 'editor.idle-timeout');
  const completionTimeout = boundedInteger(editor, 'completion-timeout', 0, 2_147_483_647, 250, diagnostics, locations, 'editor.completion-timeout');
  const completionTriggerLen = boundedInteger(editor, 'completion-trigger-len', 0, 255, 2, diagnostics, locations, 'editor.completion-trigger-len');
  const textWidth = boundedInteger(editor, 'text-width', 1, 10_000, 80, diagnostics, locations, 'editor.text-width');
  if (editor['soft-wrap'] !== undefined && softWrap === undefined) {
    diagnostics.push(issue('editor.soft-wrap', 'invalid-type', 'editor.soft-wrap must be a table', locations));
  }
  if (editor['inline-diagnostics'] !== undefined && inlineDiagnostics === undefined) diagnostics.push(issue('editor.inline-diagnostics', 'invalid-type', 'editor.inline-diagnostics must be a table', locations));
  if (softWrap?.enable !== undefined && typeof softWrap.enable !== 'boolean') {
    diagnostics.push(issue('editor.soft-wrap.enable', 'invalid-type', 'editor.soft-wrap.enable must be a boolean', locations));
  }
  if (softWrap?.['wrap-at-text-width'] !== undefined && typeof softWrap['wrap-at-text-width'] !== 'boolean') diagnostics.push(issue('editor.soft-wrap.wrap-at-text-width', 'invalid-type', 'editor.soft-wrap.wrap-at-text-width must be a boolean', locations));
  if (softWrap?.['max-wrap'] !== undefined && (typeof softWrap['max-wrap'] !== 'number' || !Number.isSafeInteger(softWrap['max-wrap']) || softWrap['max-wrap'] < 0 || softWrap['max-wrap'] > 65_535)) diagnostics.push(issue('editor.soft-wrap.max-wrap', 'invalid-value', 'editor.soft-wrap.max-wrap must be an integer from 0 to 65535', locations));
  if (softWrap?.['max-indent-retain'] !== undefined && (typeof softWrap['max-indent-retain'] !== 'number' || !Number.isSafeInteger(softWrap['max-indent-retain']) || softWrap['max-indent-retain'] < 0 || softWrap['max-indent-retain'] > 65_535)) diagnostics.push(issue('editor.soft-wrap.max-indent-retain', 'invalid-value', 'editor.soft-wrap.max-indent-retain must be an integer from 0 to 65535', locations));
  if (softWrap?.['wrap-indicator'] !== undefined && (typeof softWrap['wrap-indicator'] !== 'string' || softWrap['wrap-indicator'].length > 64 || /[\r\n\t]/u.test(String(softWrap['wrap-indicator'])))) diagnostics.push(issue('editor.soft-wrap.wrap-indicator', 'invalid-value', 'editor.soft-wrap.wrap-indicator must be a string of at most 64 characters without tabs or newlines', locations));
  if (editor.mouse !== undefined && typeof editor.mouse !== 'boolean' && editorMouse === undefined) {
    diagnostics.push(issue('editor.mouse', 'invalid-type', 'editor.mouse must be a boolean', locations));
  }
  const mouseEnabled = booleanField(editor, 'mouse') ?? booleanField(editorMouse ?? Object.create(null), 'enabled') ?? true;
  if (editor['middle-click-paste'] !== undefined && typeof editor['middle-click-paste'] !== 'boolean') diagnostics.push(issue('editor.middle-click-paste', 'invalid-type', 'editor.middle-click-paste must be a boolean', locations));
  const middleClickPaste = booleanField(editor, 'middle-click-paste') ?? true;
  const mouseModifier = xiMouse?.modifier === undefined
    ? enumField(editorMouse ?? Object.create(null), 'modifier', ['none', 'shift', 'alt', 'ctrl', 'meta'] as const, 'none', diagnostics, locations, 'editor.mouse.modifier')
    : enumField({ modifier: xiMouse.modifier }, 'modifier', ['none', 'shift', 'alt', 'ctrl', 'meta'] as const, 'none', diagnostics, locations, 'xi.mouse.modifier');
  const scrollLines = editor['scroll-lines'] === undefined
    ? boundedInteger(editorMouse ?? Object.create(null), 'scroll-lines', 1, 1000, 3, diagnostics, locations, 'editor.mouse.scroll-lines')
    : boundedInteger(editor, 'scroll-lines', 1, 1000, 3, diagnostics, locations, 'editor.scroll-lines');
  const wrap = booleanField(softWrap ?? Object.create(null), 'enable') ?? booleanField(editor, 'wrap') ?? false;
  const softWrapMaxWrap = boundedInteger(softWrap ?? Object.create(null), 'max-wrap', 0, 65_535, 20, diagnostics, locations, 'editor.soft-wrap.max-wrap');
  const softWrapMaxIndentRetain = boundedInteger(softWrap ?? Object.create(null), 'max-indent-retain', 0, 65_535, 40, diagnostics, locations, 'editor.soft-wrap.max-indent-retain');
  const wrapIndicatorValue = softWrap?.['wrap-indicator'];
  const wrapIndicator = typeof wrapIndicatorValue === 'string' && wrapIndicatorValue.length <= 64 && !/[\r\n\t]/u.test(wrapIndicatorValue) ? wrapIndicatorValue : '↪ ';
  const autoSave = Object.freeze({
    focusLost: typeof editor['auto-save'] === 'boolean' ? editor['auto-save'] : booleanField(autoSaveTable ?? Object.create(null), 'focus-lost') ?? false,
    afterDelay: Object.freeze({
      enable: booleanField(autoSaveAfterDelay ?? Object.create(null), 'enable') ?? false,
      timeout: boundedInteger(autoSaveAfterDelay ?? Object.create(null), 'timeout', 0, 2_147_483_647, 3000, diagnostics, locations, 'editor.auto-save.after-delay.timeout'),
    }),
  });
  const inlineDiagnosticsCursorLine = enumField(inlineDiagnostics ?? Object.create(null), 'cursor-line', ['disable', 'hint', 'info', 'warning', 'error'] as const, 'warning', diagnostics, locations, 'editor.inline-diagnostics.cursor-line');
  const inlineDiagnosticsOtherLines = enumField(inlineDiagnostics ?? Object.create(null), 'other-lines', ['disable', 'hint', 'info', 'warning', 'error'] as const, 'disable', diagnostics, locations, 'editor.inline-diagnostics.other-lines');
  const endOfLineDiagnostics = enumField(editor, 'end-of-line-diagnostics', ['disable', 'hint', 'info', 'warning', 'error'] as const, 'hint', diagnostics, locations, 'editor.end-of-line-diagnostics');
  const inlineDiagnosticsPrefixLen = boundedInteger(inlineDiagnostics ?? Object.create(null), 'prefix-len', 0, 1_000, 1, diagnostics, locations, 'editor.inline-diagnostics.prefix-len');
  const inlineDiagnosticsMaxWrap = boundedInteger(inlineDiagnostics ?? Object.create(null), 'max-wrap', 0, 1_000, 20, diagnostics, locations, 'editor.inline-diagnostics.max-wrap');
  const inlineDiagnosticsMinDiagnosticWidth = boundedInteger(inlineDiagnostics ?? Object.create(null), 'min-diagnostic-width', 0, 1_000, 40, diagnostics, locations, 'editor.inline-diagnostics.min-diagnostic-width');
  const inlineDiagnosticsMaxDiagnostics = boundedInteger(inlineDiagnostics ?? Object.create(null), 'max-diagnostics', 1, 1_000, 10, diagnostics, locations, 'editor.inline-diagnostics.max-diagnostics');
  if (editor['auto-format'] !== undefined && typeof editor['auto-format'] !== 'boolean') diagnostics.push(issue('editor.auto-format', 'invalid-type', 'editor.auto-format must be a boolean', locations));
  if (editor['continue-comments'] !== undefined && typeof editor['continue-comments'] !== 'boolean') diagnostics.push(issue('editor.continue-comments', 'invalid-type', 'editor.continue-comments must be a boolean', locations));
  if (editor['default-yank-register'] !== undefined && !validYankRegister(editor['default-yank-register'])) diagnostics.push(issue('editor.default-yank-register', 'invalid-value', 'editor.default-yank-register must be one register character', locations));
  if (editor['mouse-yank-register'] !== undefined && !validYankRegister(editor['mouse-yank-register'])) diagnostics.push(issue('editor.mouse-yank-register', 'invalid-value', 'editor.mouse-yank-register must be one register character', locations));
  if (editor['insert-final-newline'] !== undefined && typeof editor['insert-final-newline'] !== 'boolean') diagnostics.push(issue('editor.insert-final-newline', 'invalid-type', 'editor.insert-final-newline must be a boolean', locations));
  if (editor['trim-final-newlines'] !== undefined && typeof editor['trim-final-newlines'] !== 'boolean') diagnostics.push(issue('editor.trim-final-newlines', 'invalid-type', 'editor.trim-final-newlines must be a boolean', locations));
  if (editor['trim-trailing-whitespace'] !== undefined && typeof editor['trim-trailing-whitespace'] !== 'boolean') diagnostics.push(issue('editor.trim-trailing-whitespace', 'invalid-type', 'editor.trim-trailing-whitespace must be a boolean', locations));
  if (editor['jump-label-alphabet'] !== undefined && (typeof editor['jump-label-alphabet'] !== 'string' || [...editor['jump-label-alphabet']].some((character, index, characters) => characters.indexOf(character) !== index))) diagnostics.push(issue('editor.jump-label-alphabet', 'invalid-value', 'editor.jump-label-alphabet must be a string of unique characters', locations));
  const configuredMotionTrail = xi?.['motion-trail'] === undefined
    ? enumField(editor, 'motion-trail', ['off', 'last-motion'] as const, profile === 'strict' ? 'off' : 'last-motion', diagnostics, locations, 'editor.motion-trail')
    : enumField({ 'motion-trail': xi['motion-trail'] }, 'motion-trail', ['off', 'last-motion'] as const, profile === 'strict' ? 'off' : 'last-motion', diagnostics, locations, 'xi.motion-trail');
  const motionTrail = profile === 'strict' ? 'off' : configuredMotionTrail;
  const selectionLimit = xiSelection?.limit === undefined
    ? boundedInteger(editor, 'selection-limit', 1, 10_000_000, 10_000, diagnostics, locations, 'editor.selection-limit')
    : boundedInteger({ limit: xiSelection.limit }, 'limit', 1, 10_000_000, 10_000, diagnostics, locations, 'xi.selection.limit');
  const selectionHistoryLimit = xiSelection?.['history-limit'] === undefined
    ? boundedInteger(editor, 'selection-history-limit', 1, 10_000, 100, diagnostics, locations, 'editor.selection-history-limit')
    : boundedInteger({ 'history-limit': xiSelection['history-limit'] }, 'history-limit', 1, 10_000, 100, diagnostics, locations, 'xi.selection.history-limit');
  const hintsDelayMs = xiHints?.['delay-ms'] === undefined
    ? boundedInteger(hints ?? Object.create(null), 'delay-ms', 0, 60_000, 250, diagnostics, locations, 'editor.hints.delay-ms')
    : boundedInteger({ 'delay-ms': xiHints['delay-ms'] }, 'delay-ms', 0, 60_000, 250, diagnostics, locations, 'xi.hints.delay-ms');
  const cursorShapeValues = ['block', 'bar', 'underline', 'hidden'] as const;
  const shapes = {
    normal: enumField(cursorShape ?? Object.create(null), 'normal', cursorShapeValues, 'block', diagnostics, locations, 'editor.cursor-shape.normal'),
    insert: enumField(cursorShape ?? Object.create(null), 'insert', cursorShapeValues, 'block', diagnostics, locations, 'editor.cursor-shape.insert'),
    select: Object.hasOwn(cursorShape ?? Object.create(null), 'select')
      ? enumField(cursorShape ?? Object.create(null), 'select', cursorShapeValues, 'block', diagnostics, locations, 'editor.cursor-shape.select')
      : enumField(cursorShape ?? Object.create(null), 'visual', cursorShapeValues, 'block', diagnostics, locations, 'editor.cursor-shape.visual'),
  };
  if (lsp?.enable !== undefined && typeof lsp.enable !== 'boolean') diagnostics.push(issue('editor.lsp.enable', 'invalid-type', 'editor.lsp.enable must be a boolean', locations));
  if (lsp?.['display-inlay-hints'] !== undefined && typeof lsp['display-inlay-hints'] !== 'boolean') diagnostics.push(issue('editor.lsp.display-inlay-hints', 'invalid-type', 'editor.lsp.display-inlay-hints must be a boolean', locations));
  if (lsp?.['display-color-swatches'] !== undefined && typeof lsp['display-color-swatches'] !== 'boolean') diagnostics.push(issue('editor.lsp.display-color-swatches', 'invalid-type', 'editor.lsp.display-color-swatches must be a boolean', locations));
  if (lsp?.['auto-document-highlight'] !== undefined && typeof lsp['auto-document-highlight'] !== 'boolean') diagnostics.push(issue('editor.lsp.auto-document-highlight', 'invalid-type', 'editor.lsp.auto-document-highlight must be a boolean', locations));
  if (lsp?.['goto-reference-include-declaration'] !== undefined && typeof lsp['goto-reference-include-declaration'] !== 'boolean') diagnostics.push(issue('editor.lsp.goto-reference-include-declaration', 'invalid-type', 'editor.lsp.goto-reference-include-declaration must be a boolean', locations));
  if (lsp?.['inlay-hints'] !== undefined && typeof lsp['inlay-hints'] !== 'boolean') diagnostics.push(issue('editor.lsp.inlay-hints', 'invalid-type', 'editor.lsp.inlay-hints must be a boolean', locations));
  if (lsp?.snippets !== undefined && typeof lsp.snippets !== 'boolean') diagnostics.push(issue('editor.lsp.snippets', 'invalid-type', 'editor.lsp.snippets must be a boolean', locations));
  if (lsp?.['display-messages'] !== undefined && typeof lsp['display-messages'] !== 'boolean') diagnostics.push(issue('editor.lsp.display-messages', 'invalid-type', 'editor.lsp.display-messages must be a boolean', locations));
  if (lsp?.['display-progress-messages'] !== undefined && typeof lsp['display-progress-messages'] !== 'boolean') diagnostics.push(issue('editor.lsp.display-progress-messages', 'invalid-type', 'editor.lsp.display-progress-messages must be a boolean', locations));
  if (lsp?.['auto-signature-help'] !== undefined && typeof lsp['auto-signature-help'] !== 'boolean') diagnostics.push(issue('editor.lsp.auto-signature-help', 'invalid-type', 'editor.lsp.auto-signature-help must be a boolean', locations));
  if (lsp?.['display-signature-help-docs'] !== undefined && typeof lsp['display-signature-help-docs'] !== 'boolean') diagnostics.push(issue('editor.lsp.display-signature-help-docs', 'invalid-type', 'editor.lsp.display-signature-help-docs must be a boolean', locations));
  const legacyInlayHints = booleanField(lsp ?? Object.create(null), 'inlay-hints');
  const configuredDisplayInlayHints = booleanField(lsp ?? Object.create(null), 'display-inlay-hints');
  const legacyInlayHintsOverride = configuredDisplayInlayHints !== undefined
    && provenance['editor.lsp.display-inlay-hints'] === 'defaults'
    && legacyInlayHints !== undefined
    && provenance['editor.lsp.inlay-hints'] !== 'defaults';
  const displayInlayHints = legacyInlayHintsOverride ? legacyInlayHints : configuredDisplayInlayHints ?? legacyInlayHints ?? false;
  const inlayHintsLengthLimit = optionalBoundedInteger(lsp ?? Object.create(null), 'inlay-hints-length-limit', 1, 16 * 1024, diagnostics, locations, 'editor.lsp.inlay-hints-length-limit');
  const lspConfig = { enable: booleanField(lsp ?? Object.create(null), 'enable') ?? true, displayInlayHints, inlayHintsLengthLimit, inlayHints: displayInlayHints, displayColorSwatches: booleanField(lsp ?? Object.create(null), 'display-color-swatches') ?? true, autoDocumentHighlight: booleanField(lsp ?? Object.create(null), 'auto-document-highlight') ?? false, gotoReferenceIncludeDeclaration: booleanField(lsp ?? Object.create(null), 'goto-reference-include-declaration') ?? true, snippets: booleanField(lsp ?? Object.create(null), 'snippets') ?? true, displayMessages: booleanField(lsp ?? Object.create(null), 'display-messages') ?? true, displayProgressMessages: booleanField(lsp ?? Object.create(null), 'display-progress-messages') ?? false, autoSignatureHelp: booleanField(lsp ?? Object.create(null), 'auto-signature-help') ?? true, displaySignatureHelpDocs: booleanField(lsp ?? Object.create(null), 'display-signature-help-docs') ?? true };
  const searchConfig: SearchConfig = Object.freeze({
    debounceMs: xiSearch?.['debounce-ms'] === undefined
      ? boundedInteger(search, 'debounce-ms', 0, 60_000, 5, diagnostics, locations, 'search.debounce-ms')
      : boundedInteger({ 'debounce-ms': xiSearch['debounce-ms'] }, 'debounce-ms', 0, 60_000, 5, diagnostics, locations, 'xi.search.debounce-ms'),
    maxVisibleResults: xiSearch?.['max-visible-results'] === undefined
      ? boundedInteger(search, 'max-visible-results', 1, 1_000_000, 10_000, diagnostics, locations, 'search.max-visible-results')
      : boundedInteger({ 'max-visible-results': xiSearch['max-visible-results'] }, 'max-visible-results', 1, 1_000_000, 10_000, diagnostics, locations, 'xi.search.max-visible-results'),
    hidden: booleanField(search, 'hidden') ?? true,
    followSymlinks: booleanField(search, 'follow-symlinks') ?? false,
  });
  const catalogIds = new Set(catalog.commandIds);
  const bindings = compileBindings(mergeKeyTables(root.keys, xi?.keys), profile, catalogIds, provenance, locations, diagnostics);
  const aliases = compileAliases(xi?.aliases === undefined ? root.aliases : mergeAliasTables(root.aliases, xi.aliases), profile, catalogIds, catalog.nativeExNames ?? DEFAULT_COMMAND_CATALOG.nativeExNames ?? [], provenance, locations, diagnostics);
  const languageServers = compileServers(root['language-server'], locations, diagnostics);
  const languages = compileLanguages(root.language, languageServers, locations, diagnostics);
  const filePickerMaxDepth = optionalBoundedInteger(filePicker ?? Object.create(null), 'max-depth', 0, 1_000_000, diagnostics, locations, 'editor.file-picker.max-depth');
  const configuredAutoPairs = Object.fromEntries(Object.entries(autoPairs ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const autoPairsConfig: AutoPairsConfig = editor['auto-pairs'] === false
    ? false
    : Object.freeze({ ...autoPairs === undefined ? { '(': ')', '{': '}', '[': ']', '"': '"', "'": "'", '`': '`' } : configuredAutoPairs });
  const filePickerConfig = { hidden: booleanField(filePicker ?? Object.create(null), 'hidden') ?? true, followSymlinks: booleanField(filePicker ?? Object.create(null), 'follow-symlinks') ?? true, deduplicateLinks: booleanField(filePicker ?? Object.create(null), 'deduplicate-links') ?? true, parents: booleanField(filePicker ?? Object.create(null), 'parents') ?? true, ignore: booleanField(filePicker ?? Object.create(null), 'ignore') ?? true, gitIgnore: booleanField(filePicker ?? Object.create(null), 'git-ignore') ?? true, gitGlobal: booleanField(filePicker ?? Object.create(null), 'git-global') ?? true, gitExclude: booleanField(filePicker ?? Object.create(null), 'git-exclude') ?? true, maxDepth: filePickerMaxDepth };
  const fileExplorerConfig = { hidden: booleanField(fileExplorer ?? Object.create(null), 'hidden') ?? false, followSymlinks: booleanField(fileExplorer ?? Object.create(null), 'follow-symlinks') ?? false, parents: booleanField(fileExplorer ?? Object.create(null), 'parents') ?? false, ignore: booleanField(fileExplorer ?? Object.create(null), 'ignore') ?? false, gitIgnore: booleanField(fileExplorer ?? Object.create(null), 'git-ignore') ?? false, gitGlobal: booleanField(fileExplorer ?? Object.create(null), 'git-global') ?? false, gitExclude: booleanField(fileExplorer ?? Object.create(null), 'git-exclude') ?? false, flattenDirs: booleanField(fileExplorer ?? Object.create(null), 'flatten-dirs') ?? true };
  const bufferPickerConfig = { startPosition: enumField(bufferPicker ?? Object.create(null), 'start-position', ['current', 'previous'] as const, 'current', diagnostics, locations, 'editor.buffer-picker.start-position') };
  const kittyKeyboardProtocol = enumField(editor, 'kitty-keyboard-protocol', ['auto', 'enabled', 'disabled'] as const, 'auto', diagnostics, locations, 'editor.kitty-keyboard-protocol');
  const jumpLabelAlphabet = typeof editor['jump-label-alphabet'] === 'string' && [...editor['jump-label-alphabet']].every((character, index, characters) => characters.indexOf(character) === index)
    ? Object.freeze([...editor['jump-label-alphabet']])
    : defaultEditor.jumpLabelAlphabet;
  if (diagnostics.length > 0) return { ok: false, error: { diagnostics: Object.freeze(diagnostics) } };
  const editorConfig: EditorConfig = Object.freeze({ popupBorder, sidebarWidth, sidebarPanel, sidebarVisible, theme, themeVariants, lineNumber, lineNumberMinWidth, gutters: guttersConfig, indentGuides: indentGuidesConfig, whitespace: Object.freeze({ render: whitespaceRenderConfig, characters: whitespaceCharactersConfig }), smartTab: smartTabConfig, wordCompletion: wordCompletionConfig, workspaceTrust: workspaceTrustConfig, autoPairs: autoPairsConfig, editorConfig: booleanField(editor, 'editor-config') ?? true, continueComments: booleanField(editor, 'continue-comments') ?? true, cursorline: booleanField(editor, 'cursorline') ?? false, cursorcolumn: booleanField(editor, 'cursorcolumn') ?? false, rainbowBrackets: booleanField(editor, 'rainbow-brackets') ?? false, rulers: integerArrayField(editor, 'rulers') ?? [], textWidth, workspaceLspRoots: Object.freeze([...(stringArrayField(editor, 'workspace-lsp-roots') ?? [])]), wrapAtTextWidth: booleanField(softWrap ?? Object.create(null), 'wrap-at-text-width') ?? false, scrolloff, idleTimeout, mouse: Object.freeze({ enabled: mouseEnabled, modifier: mouseModifier, scrollLines }), shell, mouseYankRegister: validYankRegister(editor['mouse-yank-register']) ? editor['mouse-yank-register'] : '*', clipboardProvider, middleClickPaste, kittyKeyboardProtocol, wrap, softWrapMaxWrap, softWrapMaxIndentRetain, wrapIndicator, pathCompletion: booleanField(editor, 'path-completion') ?? true, inlineDiagnosticsCursorLine, inlineDiagnosticsOtherLines, endOfLineDiagnostics, inlineDiagnosticsPrefixLen, inlineDiagnosticsMaxWrap, inlineDiagnosticsMinDiagnosticWidth, inlineDiagnosticsMaxDiagnostics, autoCompletion: booleanField(editor, 'auto-completion') ?? true, completionTimeout, completionTriggerLen, previewCompletionInsert: booleanField(editor, 'preview-completion-insert') ?? true, autoInfo: booleanField(editor, 'auto-info') ?? true, completionReplace: booleanField(editor, 'completion-replace') ?? false, colorModes: booleanField(editor, 'color-modes') ?? false, trueColor: booleanField(editor, 'true-color') ?? false, undercurl: booleanField(editor, 'undercurl') ?? false, bufferline, defaultLineEnding, atomicSave, indentHeuristic, jumpLabelAlphabet, statusline: statuslineConfig, autoFormat: booleanField(editor, 'auto-format') ?? true, autoSave, defaultYankRegister: validYankRegister(editor['default-yank-register']) ? editor['default-yank-register'] : '"', insertFinalNewline: booleanField(editor, 'insert-final-newline') ?? true, trimFinalNewlines: booleanField(editor, 'trim-final-newlines') ?? false, trimTrailingWhitespace: booleanField(editor, 'trim-trailing-whitespace') ?? false, search: Object.freeze({ smartCase: booleanField(editorSearch ?? Object.create(null), 'smart-case') ?? true, wrapAround: booleanField(editorSearch ?? Object.create(null), 'wrap-around') ?? true }), motionTrail, selection: Object.freeze({ limit: selectionLimit, historyLimit: selectionHistoryLimit }), hintsDelayMs, cursorShape: Object.freeze(shapes), filePicker: Object.freeze(filePickerConfig), fileExplorer: Object.freeze(fileExplorerConfig), bufferPicker: Object.freeze(bufferPickerConfig), lsp: Object.freeze(lspConfig) });
  return { ok: true, value: Object.freeze({ schemaVersion: 1, generation: 0, profile, editor: Object.freeze({ ...editorConfig, atomicSave }), search: searchConfig, bindings: Object.freeze(bindings), aliases: Object.freeze(aliases), languageServers: Object.freeze(languageServers), languages: Object.freeze(languages), provenance: Object.freeze({ ...provenance }) }) };
}

function compileBindings(value: TomlValue | undefined, profile: ConfigProfile, commandIds: Set<string>, provenance: Record<string, string>, locations: Map<string, SourceLocation>, diagnostics: ConfigDiagnostic[]): BindingConfig[] {
  const modes = asRecord(value);
  if (modes === undefined) return [];
  const output: BindingConfig[] = [];
  const seen = new Map<string, BindingConfig>();
  const walk = (node: Record<string, TomlValue>, path: string[], keys: string[]): void => {
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string' || Array.isArray(child)) {
        const commandPath = [...path, key].join('.');
        const commandId = resolveBindingCommand(child, commandIds);
        if (commandId === undefined) { diagnostics.push(issue(commandPath, 'unknown-command', `unknown command ${child}`, locations)); continue; }
        const mode = path[0] ?? 'normal';
        if (profile === 'strict' && mode !== 'normal' && mode !== 'visual' && mode !== 'insert' && mode !== 'replace' && mode !== 'operator-pending' && mode !== 'command-line'
          && mode !== 'select' && mode !== 'files-panel' && mode !== 'search-panel' && mode !== 'git-panel' && mode !== 'diff-panel') {
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
        const binding = Object.freeze({ mode, keys: Object.freeze(nextKeys), commandId: commandId as CommandId, source: provenance[`keys.${commandPath}`] ?? provenance[commandPath] ?? 'merged' });
        seen.set(`${mode}\u0000${normalized}`, binding);
        output.push(binding);
      } else if (asRecord(child) !== undefined) walk(asRecord(child) as Record<string, TomlValue>, [...path, key], [...keys, normalizeKeyToken(key) ?? key]);
      else diagnostics.push(issue(['keys', ...path, key].join('.'), 'invalid-type', 'key binding must be a command, sequence, or table', locations));
    }
  };
  for (const [mode, valueForMode] of Object.entries(modes)) {
    const record = asRecord(valueForMode);
    if (record !== undefined) walk(record, [mode], []);
    else diagnostics.push(issue(`keys.${mode}`, 'invalid-type', 'key mode must be a table', locations));
  }
  return output;
}

function resolveBindingCommand(value: TomlValue, commandIds: Set<string>): string | undefined {
  if (Array.isArray(value)) {
    if (!value.every((item): item is string => typeof item === 'string')) return undefined;
    const commands = value.map((item) => resolveBindingCommand(item, commandIds));
    if (commands.some((item) => item === undefined || item.startsWith('macro:') || item.startsWith('sequence:'))) return undefined;
    return `sequence:${JSON.stringify(commands)}`;
  }
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('@')) {
    const keys = parseHelixMacro(value.slice(1));
    return keys === undefined ? undefined : `macro:${JSON.stringify(keys)}`;
  }
  if (commandIds.has(value)) return value;
  if (value.startsWith(':') && value.length > 1) return `ex:${value.slice(1)}`;
  if (value === 'no_op') return 'noop';
  return undefined;
}

function parseHelixMacro(source: string): readonly string[] | undefined {
  const keys: string[] = [];
  for (let index = 0; index < source.length;) {
    if (source[index] === '<') {
      const end = source.indexOf('>', index + 1);
      if (end < 0) return undefined;
      const token = normalizeKeyToken(source.slice(index, end + 1));
      if (token === undefined) return undefined;
      keys.push(token);
      index = end + 1;
      continue;
    }
    const character = source[index];
    if (character === undefined) return undefined;
    const token = character === ' ' ? '<Space>' : normalizeKeyToken(character);
    if (token === undefined) return undefined;
    keys.push(token);
    index += character.length;
  }
  return Object.freeze(keys);
}

function mergeKeyTables(legacy: TomlValue | undefined, canonical: TomlValue | undefined): TomlValue | undefined {
  const left = asRecord(legacy);
  const right = asRecord(canonical);
  if (left === undefined) return canonical;
  if (right === undefined) return legacy;
  const merged: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
  for (const [mode, value] of Object.entries(left)) merged[mode] = value;
  for (const [mode, value] of Object.entries(right)) {
    const existing = asRecord(merged[mode]);
    const replacement = asRecord(value);
    if (existing === undefined || replacement === undefined) { merged[mode] = value; continue; }
    merged[mode] = mergeKeyTables(existing, replacement) as TomlValue;
  }
  return merged;
}

function mergeAliasTables(legacy: TomlValue | undefined, canonical: TomlValue): TomlValue {
  const merged: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>;
  for (const source of [asRecord(legacy), asRecord(canonical)]) {
    if (source !== undefined) for (const [name, target] of Object.entries(source)) merged[name] = target;
  }
  return merged;
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

const BUILTIN_CLIPBOARD_PROVIDERS = ['pasteboard', 'wayland', 'x-clip', 'x-sel', 'tmux', 'termux', 'win32-yank', 'windows', 'termcode', 'none'] as const;

function parseShell(value: TomlValue | undefined): readonly [string, ...string[]] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0)
    ? [value[0] as string, ...value.slice(1) as string[]]
    : ['sh', '-c'];
}

function clipboardCommandValue(value: TomlValue | undefined, path: string, locations: Map<string, SourceLocation>, diagnostics: ConfigDiagnostic[], required: boolean): ClipboardCommandConfig | undefined {
  if (value === undefined) {
    if (required) diagnostics.push(issue(path, 'missing-field', `${path} requires a command` , locations));
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined) {
    diagnostics.push(issue(path, 'invalid-type', `${path} must be an inline table`, locations));
    return undefined;
  }
  const command = textField(record, 'command');
  if (command === undefined || command.length === 0) diagnostics.push(issue(`${path}.command`, 'missing-field', `${path}.command must be a non-empty string`, locations));
  if (record.args !== undefined && stringArrayField(record, 'args') === undefined) diagnostics.push(issue(`${path}.args`, 'invalid-type', `${path}.args must be an array of strings`, locations));
  return command === undefined || command.length === 0 ? undefined : Object.freeze({ command, args: Object.freeze([...(stringArrayField(record, 'args') ?? [])]) });
}

function parseClipboardProvider(value: TomlValue | undefined, locations: Map<string, SourceLocation>, diagnostics: ConfigDiagnostic[]): ClipboardProviderConfig {
  if (value === undefined) return Object.freeze({ kind: 'builtin', name: 'platform' });
  if (typeof value === 'string') {
    if (!(BUILTIN_CLIPBOARD_PROVIDERS as readonly string[]).includes(value)) diagnostics.push(issue('editor.clipboard-provider', 'invalid-value', `unknown clipboard provider ${value}`, locations));
    return Object.freeze({ kind: 'builtin', name: value });
  }
  const provider = asRecord(value);
  const custom = asRecord(provider?.custom);
  if (custom === undefined) {
    diagnostics.push(issue('editor.clipboard-provider', 'invalid-type', 'editor.clipboard-provider must be a builtin string or custom table', locations));
    return Object.freeze({ kind: 'builtin', name: 'platform' });
  }
  const yank = clipboardCommandValue(custom.yank, 'editor.clipboard-provider.custom.yank', locations, diagnostics, true);
  const paste = clipboardCommandValue(custom.paste, 'editor.clipboard-provider.custom.paste', locations, diagnostics, true);
  const primaryYank = clipboardCommandValue(custom['primary-yank'], 'editor.clipboard-provider.custom.primary-yank', locations, diagnostics, false);
  const primaryPaste = clipboardCommandValue(custom['primary-paste'], 'editor.clipboard-provider.custom.primary-paste', locations, diagnostics, false);
  if (yank === undefined || paste === undefined) return Object.freeze({ kind: 'builtin', name: 'platform' });
  return Object.freeze({ kind: 'custom', yank, paste, ...(primaryYank === undefined ? {} : { primaryYank }), ...(primaryPaste === undefined ? {} : { primaryPaste }) });
}

function isKnownPath(path: readonly string[]): boolean {
  const joined = path.join('.');
  if (joined === 'schema-version' || joined === 'profile' || joined === 'theme' || joined === 'theme.dark' || joined === 'theme.light' || joined === 'theme.fallback' || joined === 'xi' || joined === 'xi.schema-version' || joined === 'xi.profile' || joined === 'xi.sidebar' || joined === 'xi.sidebar.visible' || joined === 'xi.sidebar.width' || joined === 'xi.sidebar.panel' || joined === 'xi.mouse' || joined === 'xi.mouse.modifier' || joined === 'xi.motion-trail' || joined === 'xi.selection' || joined === 'xi.selection.limit' || joined === 'xi.selection.history-limit' || joined === 'xi.hints' || joined === 'xi.hints.delay-ms' || joined === 'xi.search' || joined === 'xi.search.debounce-ms' || joined === 'xi.search.max-visible-results' || joined === 'xi.aliases' || joined === 'xi.keys') return true;
  if (joined.startsWith('xi.aliases.')) return true;
  if (joined.startsWith('xi.keys.')) return true;
  if (joined === 'editor' || joined === 'search' || joined === 'aliases' || joined === 'keys' || joined === 'language-server' || joined === 'language') return true;
  if (joined.startsWith('aliases.') || joined.startsWith('keys.')) return true;
  if (joined === 'editor.auto-pairs' || joined.startsWith('editor.auto-pairs.')) return true;
  const editorPaths = new Set([
    'editor.true-color', 'editor.undercurl', 'editor.path-completion',
    'editor.theme', 'editor.editor-config', 'editor.line-number', 'editor.gutters', 'editor.gutters.layout', 'editor.gutters.line-numbers', 'editor.gutters.line-numbers.min-width',    'editor.cursorline', 'editor.cursorcolumn', 'editor.rulers', 'editor.text-width', 'editor.scrolloff', 'editor.idle-timeout', 'editor.scroll-lines', 'editor.mouse', 'editor.wrap', 'editor.auto-completion', 'editor.completion-timeout', 'editor.completion-trigger-len', 'editor.preview-completion-insert', 'editor.auto-info', 'editor.completion-replace', 'editor.color-modes', 'editor.bufferline', 'editor.default-line-ending', 'editor.statusline', 'editor.statusline.left', 'editor.statusline.center', 'editor.statusline.right', 'editor.statusline.separator', 'editor.statusline.mode', 'editor.statusline.mode.normal', 'editor.statusline.mode.insert', 'editor.statusline.mode.select', 'editor.statusline.diagnostics', 'editor.statusline.workspace-diagnostics', 'editor.auto-format', 'editor.auto-save', 'editor.auto-save.focus-lost', 'editor.auto-save.after-delay', 'editor.auto-save.after-delay.enable', 'editor.auto-save.after-delay.timeout', 'editor.default-yank-register', 'editor.insert-final-newline', 'editor.trim-final-newlines', 'editor.trim-trailing-whitespace', 'editor.end-of-line-diagnostics', 'editor.search', 'editor.search.smart-case', 'editor.search.wrap-around', 'editor.soft-wrap', 'editor.soft-wrap.enable', 'editor.soft-wrap.wrap-at-text-width', 'editor.soft-wrap.wrap-indicator', 'editor.inline-diagnostics', 'editor.inline-diagnostics.cursor-line', 'editor.inline-diagnostics.other-lines', 'editor.inline-diagnostics.prefix-len', 'editor.inline-diagnostics.max-wrap', 'editor.inline-diagnostics.min-diagnostic-width', 'editor.inline-diagnostics.max-diagnostics', 'editor.motion-trail',
    'editor.theme', 'editor.line-number', 'editor.gutters', 'editor.gutters.layout', 'editor.gutters.line-numbers', 'editor.gutters.line-numbers.min-width', 'editor.indent-guides', 'editor.indent-guides.render', 'editor.indent-guides.character', 'editor.indent-guides.skip-levels', 'editor.whitespace', 'editor.whitespace.render', 'editor.whitespace.render.default', 'editor.whitespace.render.space', 'editor.whitespace.render.nbsp', 'editor.whitespace.render.nnbsp', 'editor.whitespace.render.tab', 'editor.whitespace.render.newline', 'editor.whitespace.characters', 'editor.whitespace.characters.space', 'editor.whitespace.characters.nbsp', 'editor.whitespace.characters.nnbsp', 'editor.whitespace.characters.tab', 'editor.whitespace.characters.tabpad', 'editor.whitespace.characters.newline', 'editor.smart-tab', 'editor.smart-tab.enable', 'editor.smart-tab.supersede-menu', 'editor.word-completion', 'editor.word-completion.enable', 'editor.word-completion.trigger-length', 'editor.cursorline', 'editor.cursorcolumn', 'editor.rulers', 'editor.text-width', 'editor.scrolloff', 'editor.idle-timeout', 'editor.scroll-lines', 'editor.mouse', 'editor.wrap', 'editor.auto-completion', 'editor.completion-timeout', 'editor.completion-trigger-len', 'editor.preview-completion-insert', 'editor.auto-info', 'editor.completion-replace', 'editor.color-modes', 'editor.bufferline', 'editor.default-line-ending', 'editor.statusline', 'editor.statusline.left', 'editor.statusline.center', 'editor.statusline.right', 'editor.statusline.separator', 'editor.statusline.mode', 'editor.statusline.mode.normal', 'editor.statusline.mode.insert', 'editor.statusline.mode.select', 'editor.statusline.diagnostics', 'editor.statusline.workspace-diagnostics', 'editor.auto-format', 'editor.auto-save', 'editor.auto-save.focus-lost', 'editor.auto-save.after-delay', 'editor.auto-save.after-delay.enable', 'editor.auto-save.after-delay.timeout', 'editor.default-yank-register', 'editor.insert-final-newline', 'editor.trim-final-newlines', 'editor.trim-trailing-whitespace', 'editor.end-of-line-diagnostics', 'editor.search', 'editor.search.smart-case', 'editor.search.wrap-around', 'editor.soft-wrap', 'editor.soft-wrap.enable', 'editor.soft-wrap.wrap-at-text-width', 'editor.soft-wrap.wrap-indicator', 'editor.inline-diagnostics', 'editor.inline-diagnostics.cursor-line', 'editor.inline-diagnostics.other-lines', 'editor.inline-diagnostics.prefix-len', 'editor.inline-diagnostics.max-wrap', 'editor.inline-diagnostics.min-diagnostic-width', 'editor.inline-diagnostics.max-diagnostics', 'editor.motion-trail',
    'editor.sidebar-visible', 'editor.sidebar-width', 'editor.sidebar-panel', 'editor.selection-limit', 'editor.selection-history-limit', 'editor.cursor-shape', 'editor.cursor-shape.normal',
    'editor.cursor-shape.insert', 'editor.cursor-shape.select', 'editor.cursor-shape.visual', 'editor.lsp', 'editor.lsp.enable', 'editor.lsp.display-inlay-hints', 'editor.lsp.inlay-hints-length-limit', 'editor.lsp.inlay-hints', 'editor.lsp.display-color-swatches', 'editor.lsp.auto-document-highlight', 'editor.lsp.goto-reference-include-declaration', 'editor.lsp.snippets', 'editor.lsp.display-messages', 'editor.lsp.display-progress-messages', 'editor.lsp.auto-signature-help', 'editor.lsp.display-signature-help-docs',
    'editor.workspace-trust', 'editor.workspace-trust.level', 'editor.workspace-trust.prompt', 'editor.workspace-trust.trusted', 'editor.rainbow-brackets', 'editor.mouse.enabled', 'editor.mouse.modifier', 'editor.mouse.scroll-lines', 'editor.hints', 'editor.hints.delay-ms', 'editor.file-picker', 'editor.file-picker.hidden', 'editor.file-picker.follow-symlinks', 'editor.file-picker.deduplicate-links', 'editor.file-picker.parents', 'editor.file-picker.ignore', 'editor.file-picker.git-ignore', 'editor.file-picker.git-global', 'editor.file-picker.git-exclude', 'editor.file-picker.max-depth',
    'editor.file-explorer', 'editor.file-explorer.hidden', 'editor.file-explorer.follow-symlinks', 'editor.file-explorer.parents', 'editor.file-explorer.ignore', 'editor.file-explorer.git-ignore', 'editor.file-explorer.git-global', 'editor.file-explorer.git-exclude', 'editor.file-explorer.flatten-dirs', 'editor.buffer-picker', 'editor.buffer-picker.start-position',
  ]);
  editorPaths.add('editor.soft-wrap.max-wrap');
  editorPaths.add('editor.soft-wrap.max-indent-retain');
  editorPaths.add('editor.popup-border');
  editorPaths.add('editor.workspace-lsp-roots');
  editorPaths.add('editor.shell');
  editorPaths.add('editor.atomic-save');
  editorPaths.add('editor.indent-heuristic');
  editorPaths.add('editor.jump-label-alphabet');
  editorPaths.add('editor.continue-comments');
  editorPaths.add('editor.mouse-yank-register');
  editorPaths.add('editor.middle-click-paste');
  editorPaths.add('editor.kitty-keyboard-protocol');
  editorPaths.add('editor.clipboard-provider');
  editorPaths.add('editor.clipboard-provider.custom');
  editorPaths.add('editor.clipboard-provider.custom.yank');
  editorPaths.add('editor.clipboard-provider.custom.yank.command');
  editorPaths.add('editor.clipboard-provider.custom.yank.args');
  editorPaths.add('editor.clipboard-provider.custom.paste');
  editorPaths.add('editor.clipboard-provider.custom.paste.command');
  editorPaths.add('editor.clipboard-provider.custom.paste.args');
  editorPaths.add('editor.clipboard-provider.custom.primary-yank');
  editorPaths.add('editor.clipboard-provider.custom.primary-yank.command');
  editorPaths.add('editor.clipboard-provider.custom.primary-yank.args');
  editorPaths.add('editor.clipboard-provider.custom.primary-paste');
  editorPaths.add('editor.clipboard-provider.custom.primary-paste.command');
  editorPaths.add('editor.clipboard-provider.custom.primary-paste.args');
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
  return path.includes('command') || path.includes('args') || path.includes('formatter') || path.includes('formatters') || path.includes('task') || path.includes('shell');
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
function validYankRegister(value: TomlValue | undefined): value is string { return typeof value === 'string' && /^["0-9A-Za-z+*_\-]$/u.test(value); }
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
    result.push(match[2] === undefined ? unescapeString(key) : key);
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
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return { ok: true, value: trimmed.slice(1, -1) };
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return { ok: true, value: unescapeString(trimmed.slice(1, -1)) };
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
function normalizeKeyToken(value: string): string | undefined {
  if (value.length === 1 && value !== '\u0000') return value;
  const named = new Map([
    ['space', '<Space>'], ['esc', '<Esc>'], ['escape', '<Esc>'], ['enter', '<Enter>'], ['return', '<Enter>'], ['ret', '<Enter>'],
    ['tab', '<Tab>'], ['backspace', '<BS>'], ['bs', '<BS>'], ['up', '<Up>'], ['down', '<Down>'], ['left', '<Left>'], ['right', '<Right>'],
    ['home', '<Home>'], ['end', '<End>'], ['pageup', '<PageUp>'], ['pagedown', '<PageDown>'], ['del', '<Del>'], ['delete', '<Del>'],
    ['ins', '<Insert>'], ['insert', '<Insert>'],
  ]);
  const direct = named.get(value.toLowerCase());
  if (direct !== undefined) return direct;
  const bracket = /^<(.+)>$/u.exec(value);
  const source = bracket?.[1] ?? value;
  const parts = source.split('-');
  const key = parts.pop();
  if (key === undefined || key.length === 0) return undefined;
  const modifiers = parts.map((part) => part.toLowerCase());
  const validModifiers = new Set(['c', 'ctrl', 's', 'shift', 'a', 'alt', 'm', 'meta', 'cmd', 'win']);
  if (modifiers.length > 0 && modifiers.some((part) => !validModifiers.has(part))) return undefined;
  if (modifiers.length > 0) {
    const normalizedKey = named.get(key.toLowerCase())?.slice(1, -1) ?? key;
    const canonicalModifiers = modifiers.map((part) => {
      if (part === 'ctrl') return 'C';
      if (part === 'shift') return 'S';
      // OpenTUI exposes Alt and Meta through the same config lookup token; retain
      // Helix's accepted spellings while canonicalizing both to the workbench token.
      if (part === 'a' || part === 'alt') return 'M';
      if (part === 'meta' || part === 'cmd' || part === 'win') return 'M';
      return part.toUpperCase();
    });
    return `<${canonicalModifiers.join('-')}-${normalizedKey}>`;
  }
  if (bracket !== undefined) return named.get(key.toLowerCase()) ?? (/^(?:f(?:[1-9]|1[0-9]|2[0-4])|[a-z0-9]+)$/iu.test(key) ? `<${key}>` : undefined);
  return undefined;
}
function asRecord(value: TomlValue | undefined): Record<string, TomlValue> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, TomlValue> : undefined; }
function textField(record: Record<string, TomlValue>, key: string): string | undefined { const value = record[key]; return typeof value === 'string' ? value : undefined; }
function stringArrayField(record: Record<string, TomlValue>, key: string): readonly string[] | undefined { const value = record[key]; return Array.isArray(value) && value.every((item) => typeof item === 'string') ? Object.freeze(value as string[]) : undefined; }
function integerArrayField(record: Record<string, TomlValue>, key: string): readonly number[] | undefined { const value = record[key]; return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item > 0) ? Object.freeze(value as number[]) : undefined; }
function statuslineSeverityField(record: Record<string, TomlValue>, key: string, fallback: readonly StatuslineDiagnosticSeverity[], diagnostics: ConfigDiagnostic[], locations: Map<string, SourceLocation>, path: string): readonly StatuslineDiagnosticSeverity[] { const value = record[key]; const allowed: readonly StatuslineDiagnosticSeverity[] = ['hint', 'info', 'warning', 'error']; if (value === undefined) return Object.freeze([...fallback]); if (!Array.isArray(value) || !value.every((item): item is StatuslineDiagnosticSeverity => typeof item === 'string' && allowed.includes(item as StatuslineDiagnosticSeverity))) { diagnostics.push(issue(path, 'invalid-value', `${path} must be an array of hint, info, warning or error`, locations)); return Object.freeze([...fallback]); } return Object.freeze([...value]); }
function integerField(record: Record<string, TomlValue>, key: string): number | undefined { const value = record[key]; return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
function booleanField(record: Record<string, TomlValue>, key: string): boolean | undefined { const value = record[key]; return typeof value === 'boolean' ? value : undefined; }
function boundedInteger(record: Record<string, TomlValue>, key: string, min: number, max: number, fallback: number, diagnostics: ConfigDiagnostic[], locations: Map<string, SourceLocation>, path: string): number { const value = record[key]; if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) { diagnostics.push(issue(path, 'invalid-value', `${path} must be an integer from ${min} to ${max}`, locations)); return fallback; } return value; }
function optionalBoundedInteger(record: Record<string, TomlValue>, key: string, min: number, max: number, diagnostics: ConfigDiagnostic[], locations: Map<string, SourceLocation>, path: string): number | undefined { const value = record[key]; if (value === undefined) return undefined; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) { diagnostics.push(issue(path, 'invalid-value', `${path} must be an integer from ${min} to ${max}`, locations)); return undefined; } return value; }
function enumField<T extends string>(record: Record<string, TomlValue>, key: string, values: readonly T[], fallback: T, diagnostics: ConfigDiagnostic[], locations: Map<string, SourceLocation>, path: string): T { const value = record[key]; if (value === undefined) return fallback; if (typeof value !== 'string' || !values.includes(value as T)) { diagnostics.push(issue(path, 'invalid-value', `${path} must be one of ${values.join(', ')}`, locations)); return fallback; } return value as T; }
function statuslineElementsField(record: Record<string, TomlValue>, key: string, fallback: readonly StatuslineElement[], diagnostics: ConfigDiagnostic[], locations: Map<string, SourceLocation>, path: string): readonly StatuslineElement[] { const value = record[key]; const allowed: readonly StatuslineElement[] = ['mode', 'spinner', 'file-name', 'file-absolute-path', 'file-base-name', 'file-modification-indicator', 'file-encoding', 'file-line-ending', 'file-indent-style', 'read-only-indicator', 'total-line-numbers', 'file-type', 'diagnostics', 'workspace-diagnostics', 'selections', 'primary-selection-length', 'position', 'position-percentage', 'separator', 'spacer', 'version-control', 'register', 'current-working-directory', 'code-action-hint']; if (value === undefined) return Object.freeze([...fallback]); if (!Array.isArray(value) || !value.every((item): item is StatuslineElement => typeof item === 'string' && allowed.includes(item as StatuslineElement))) { diagnostics.push(issue(path, 'invalid-value', `${path} must be an array of supported statusline elements`, locations)); return Object.freeze([...fallback]); } return Object.freeze([...value]); }
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
