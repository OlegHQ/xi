import type { DocumentId, DocumentVersion, LineIndex, Utf16Offset } from '../../../../packages/primitives/src/entrypoints/launch';
import type { TextFileDocument } from '../../../../packages/document/src/entrypoints/launch';
import type { NodeFilesystemPort, NodeProcessPort } from '../../../../packages/platform/src/entrypoints/launch';
import type { LanguageConfig, LanguageServerConfig } from '../../../../packages/services/src/entrypoints/config';
import type { Disposable } from '../../../../packages/primitives/src/entrypoints/launch';
import type { LanguageOverlayController, CompletionSnippetController, WorkspaceEditsController, WorkbenchSessionOptions, StatusMessageController } from '../../../../packages/workbench/src/entrypoints/launch';
import { languageIdForPath } from '../../../../packages/workbench/src/entrypoints/launch';
import type { LaunchServices, LanguageServices } from './types';

// Derived (not imported) from `packages/document` directly: apps/xi may only reach that
// package through its own entrypoint, which does not (yet) export `CommittedDocumentChange`.
// `WorkbenchSessionOptions['onDocumentChange']` already carries the same type and is already
// part of this module's allowed workbench import.
type CommittedDocumentChange = NonNullable<WorkbenchSessionOptions['onDocumentChange']> extends (change: infer C) => void ? C : never;

type DiagnosticStore = InstanceType<LaunchServices['DiagnosticStore']>;
type LanguageServerSession = InstanceType<LanguageServices['LanguageServerRouter']>;
type LanguageNavigationController = InstanceType<LanguageServices['LanguageNavigationController']>;
type CompletionController = InstanceType<LanguageServices['CompletionController']>;
type LanguageServerCompletionProvider = InstanceType<LanguageServices['LanguageServerCompletionProvider']>;
type SignatureController = InstanceType<LanguageServices['SignatureController']>;
type LanguageServerSignatureProvider = InstanceType<LanguageServices['LanguageServerSignatureProvider']>;
type LanguageServerWorkspaceEditProvider = InstanceType<LanguageServices['LanguageServerWorkspaceEditProvider']>;
type WorkspaceEditCoordinator = InstanceType<LanguageServices['WorkspaceEditCoordinator']>;
type WorkspaceEditResourceExecutor = InstanceType<LanguageServices['WorkspaceEditResourceExecutor']>;

export interface LanguageWiringDeps {
  readonly filesystem: NodeFilesystemPort;
  readonly ProcessPort: typeof NodeProcessPort;
  readonly createClock: () => ReturnType<typeof import('../../../../packages/platform/src/entrypoints/launch').createNodeClock>;
  readonly workspaceRoot: string;
  readonly workspaceLspRoots: readonly string[];
  readonly fileUri: (path: string) => string;
  readonly processEnvironment: () => Readonly<Record<string, string>>;
  readonly diagnostics: DiagnosticStore;
  readonly configuredLanguages: readonly LanguageConfig[] | undefined;
  readonly configuredLanguageServers: readonly LanguageServerConfig[] | undefined;
  readonly lspEnabled: () => boolean;
  readonly snippets: boolean;
  readonly displayLspMessages: boolean;
  readonly displayLspProgressMessages: boolean;
  readonly displayInlayHints: boolean;
  readonly inlayHintsLengthLimit: number | undefined;
  readonly displayColorSwatches: boolean;
  readonly autoDocumentHighlight: boolean;
  readonly launchDocument: TextFileDocument;
  readonly launchDocumentPath: string | undefined;
  readonly readDocumentText: (document: TextFileDocument) => string | undefined;
  readonly workbenchBuffers: () => readonly { readonly bufferId: DocumentId; readonly documentId: DocumentId; readonly path: string | undefined }[];
  readonly renameBufferPath: (bufferId: DocumentId, path: string) => void;
  readonly statusMessages: StatusMessageController;
  readonly marker?: (name: string, payload?: unknown) => void;
  readonly notifySurfaceChange: () => void;
}

type WorkspacePathPort = Pick<NodeFilesystemPort, 'workspaceAbsolutePath' | 'workspaceRelativePath'>;

function pathFromFileUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  try {
    const path = decodeURIComponent(uri.slice('file://'.length));
    return path.startsWith('/') ? path : `/${path}`;
  } catch {
    return undefined;
  }
}

/** Selects the deepest configured Helix LSP root containing a document. */
export function workspaceLspRootForDocument(filesystem: WorkspacePathPort, workspaceRoot: string, roots: readonly string[], uri: string): string {
  const documentPath = pathFromFileUri(uri);
  if (documentPath === undefined) return workspaceRoot;
  let selected = workspaceRoot;
  for (const relativeRoot of roots) {
    const candidate = filesystem.workspaceAbsolutePath(workspaceRoot, relativeRoot);
    if (candidate === undefined || filesystem.workspaceRelativePath(candidate, documentPath) === undefined) continue;
    if (candidate.length > selected.length) selected = candidate;
  }
  return selected;
}

/** Late-bound: constructed after `host`/`overlayFeature`/`completionFeature`/`workspaceEditsFeature`
 * exist, but `ensureLanguage()` (this cluster's only externally triggered entry point) is only
 * ever invoked afterward too -- from a user action once startup has finished wiring. */
export interface LanguageWiringConnection {
  readonly getBufferDocument: (documentId: DocumentId) => TextFileDocument | undefined;
  readonly overlayFeature: LanguageOverlayController;
  readonly completionFeature: CompletionSnippetController;
  readonly workspaceEditsFeature: WorkspaceEditsController;
}

export interface LanguageWiring {
  connect(connection: LanguageWiringConnection): void;
  resolveLanguageId(path: string | undefined): string | undefined;
  hasServerForPath(path: string | undefined): boolean;
  admitBufferToLanguageSession(path: string | undefined, documentId: DocumentId, document: TextFileDocument): void;
  ensureLanguage(): Promise<void>;
  reconcileTrust(): Promise<void>;
  /** Mirrors the composition root's onDocumentChange wiring for the launch WorkbenchSession. */
  changeDocument(change: CommittedDocumentChange): void;
  /** Mirrors BufferHost's onBufferClosed language-session teardown. */
  releaseBufferFromLanguageSession(path: string | undefined): void;
  refreshDocumentHighlights(documentId: string, line: number, utf16: number): void;
  documentHighlights(documentId: string, documentVersion: number): readonly { readonly startLine: number; readonly startUtf16: number; readonly endLine: number; readonly endUtf16: number }[];
  inlayHints(documentId: string, documentVersion: number): readonly { readonly id: string; readonly documentVersion: DocumentVersion; readonly lineIndex: LineIndex; readonly offset: Utf16Offset; readonly text: string }[];
  virtualAnnotations(documentId: string, documentVersion: number): readonly { readonly id: string; readonly documentVersion: DocumentVersion; readonly lineIndex: LineIndex; readonly offset: Utf16Offset; readonly text: string; readonly background?: string }[];
  readonly session: LanguageServerSession | undefined;
  readonly navigationController: LanguageNavigationController | undefined;
  readonly outlineController: LanguageNavigationController | undefined;
  readonly navigationSubscription: Disposable | undefined;
  readonly completionController: CompletionController | undefined;
  readonly signatureController: SignatureController | undefined;
  readonly completionSubscription: Disposable | undefined;
  readonly signatureSubscription: Disposable | undefined;
  readonly workspaceEditCoordinator: WorkspaceEditCoordinator | undefined;
  readonly workspaceEditProvider: LanguageServerWorkspaceEditProvider | undefined;
  readonly workspaceEditExecutor: WorkspaceEditResourceExecutor | undefined;
  readonly inlaySubscription: Disposable | undefined;
}

/** Owns the language-server session, navigation/completion/signature/workspace-edit controllers
 * and the lazy `ensureLanguage()` boot sequence -- previously ~11 top-level `let`s in `main()`
 * plus their tightly-coupled init closures (T116's language-init cluster). */
// The language server command/args/rootMarkers a resolved languageId should launch, from
// languages.toml's [[language]].language-servers -> [language-server.<name>] indirection.
// Undefined means "no server": the hardcoded typescript-language-server fallback applies
// only to the languages it serves, never to one Xi merely highlights (json/toml/markdown).
function resolveLanguageServerConfig(deps: LanguageWiringDeps, resolvedLanguageId: string): { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly rootMarkers: readonly string[] } | undefined {
  const language = deps.configuredLanguages?.find((entry) => entry.name === resolvedLanguageId);
  const serverName = language?.languageServers[0];
  const server = serverName === undefined ? undefined : deps.configuredLanguageServers?.find((entry) => entry.name === serverName);
  if (server !== undefined) return server;
  if (resolvedLanguageId !== 'typescript' && resolvedLanguageId !== 'javascript') return undefined;
  return { name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], rootMarkers: ['tsconfig.json', 'package.json', '.git'] };
}

function createLspNotificationHandlers(deps: LanguageWiringDeps) {
  return {
    onWindowMessage: (message: { readonly type: 1 | 2 | 3 | 4; readonly message: string }) => {
      if (!deps.displayLspMessages) return;
      deps.marker?.('XI_LSP_MESSAGE', { type: message.type, message: message.message });
      deps.statusMessages.publish(`LSP: ${message.message}`, message.type <= 2 ? 'error' : 'info');
    },
    onProgress: (event: { readonly token: string | number; readonly value: unknown }) => {
      if (!deps.displayLspProgressMessages) return;
      const value = event.value !== null && typeof event.value === 'object' && !Array.isArray(event.value) ? event.value as Record<string, unknown> : undefined;
      const title = typeof value?.title === 'string' ? value.title : 'LSP';
      const message = typeof value?.message === 'string' ? value.message : undefined;
      const percentage = typeof value?.percentage === 'number' && Number.isFinite(value.percentage) ? ` ${Math.round(value.percentage)}%` : '';
      if (value?.kind === 'end') return;
      deps.marker?.('XI_LSP_PROGRESS', { token: event.token, title, ...(message === undefined ? {} : { message }), ...(percentage.length === 0 ? {} : { percentage: percentage.trim() }) });
      deps.statusMessages.publish(`${title}${message === undefined ? '' : `: ${message}`}${percentage}`, 'info');
    },
  };
}

type LanguagePresentation = InstanceType<LanguageServices['LanguagePresentationFeatures']>;

interface InlayHintRuntime {
  readonly deps: LanguageWiringDeps;
  readonly session: () => LanguageServerSession | undefined;
  readonly presentation: () => LanguagePresentation | undefined;
  readonly documents: Map<string, { readonly uri: string; readonly version: number; readonly lineCount: number }>;
  readonly highlightPositions: Map<string, { readonly line: number; readonly utf16: number }>;
  readonly resolveLanguageId: (path: string | undefined) => string | undefined;
  readonly warnedDocumentIds: Set<DocumentId>;
}

function createInlayRuntime(
  deps: LanguageWiringDeps,
  state: {
    readonly session: () => LanguageServerSession | undefined;
    readonly presentation: () => LanguagePresentation | undefined;
  },
  resolveLanguageId: (path: string | undefined) => string | undefined,
): InlayHintRuntime {
  return {
    deps,
    session: state.session,
    presentation: state.presentation,
    documents: new Map(),
    highlightPositions: new Map(),
    resolveLanguageId,
    warnedDocumentIds: new Set(),
  };
}

async function refreshDocumentHighlights(runtime: InlayHintRuntime, documentId: string, line: number, utf16: number): Promise<void> {
  if (!runtime.deps.autoDocumentHighlight || !Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(utf16) || utf16 < 0) return;
  const previousPosition = runtime.highlightPositions.get(documentId);
  runtime.highlightPositions.set(documentId, { line, utf16 });
  const session = runtime.session();
  const presentation = runtime.presentation();
  const document = runtime.documents.get(documentId);
  if (session === undefined || presentation === undefined || document === undefined) return;
  if (previousPosition?.line === line && previousPosition.utf16 === utf16 && presentation.documentHighlights(documentId)?.documentVersion === document.version) return;
  await presentation.refreshDocumentHighlights(session, { id: documentId, ...document }, line, utf16, () => runtime.documents.get(documentId)?.version, (result) => {
    runtime.deps.marker?.('XI_LSP_DOCUMENT_HIGHLIGHTS', { documentId, version: document.version, count: result.ranges.length, ranges: result.ranges });
    runtime.deps.notifySurfaceChange();
  });
}

async function refreshInlayHints(runtime: InlayHintRuntime, documentId: string): Promise<void> {
  const session = runtime.session();
  const presentation = runtime.presentation();
  const document = runtime.documents.get(documentId);
  if (!runtime.deps.displayInlayHints || session === undefined || presentation === undefined || document === undefined) return;
  await presentation.refreshInlayHints(session, { id: documentId, ...document }, runtime.deps.inlayHintsLengthLimit, () => runtime.documents.get(documentId)?.version, (result) => {
    runtime.deps.marker?.('XI_LSP_INLAY_HINTS', { documentId, version: document.version, count: result.hints.length, labels: result.hints.map((hint) => hint.label) });
    runtime.deps.notifySurfaceChange();
  });
}

async function refreshDocumentColors(runtime: InlayHintRuntime, documentId: string): Promise<void> {
  const session = runtime.session();
  const presentation = runtime.presentation();
  const document = runtime.documents.get(documentId);
  if (!runtime.deps.displayColorSwatches || session === undefined || presentation === undefined || document === undefined) return;
  await presentation.refreshDocumentColors(session, { id: documentId, ...document }, () => runtime.documents.get(documentId)?.version, (result) => {
    runtime.deps.marker?.('XI_LSP_COLOR_SWATCHES', { documentId, version: document.version, count: result.colors.length, colors: result.colors.map((color) => color.color) });
    runtime.deps.notifySurfaceChange();
  });
}

async function refreshAllInlayHints(runtime: InlayHintRuntime): Promise<void> {
  await Promise.all([...runtime.documents.keys()].map(async (documentId) => {
    await refreshInlayHints(runtime, documentId);
    await refreshDocumentColors(runtime, documentId);
  }));
}

function changeLanguageDocument(runtime: InlayHintRuntime, change: CommittedDocumentChange): void {
  const session = runtime.session();
  if (session?.hasDocument(String(change.documentId)) !== true) return;
  const admitted = session.changeDocument(change);
  const current = runtime.documents.get(String(change.documentId));
  if (current !== undefined) {
    runtime.documents.set(String(change.documentId), { ...current, version: change.snapshot.version, lineCount: change.snapshot.lineCount });
    void refreshInlayHints(runtime, String(change.documentId));
    void refreshDocumentColors(runtime, String(change.documentId));
  }
  if (admitted !== undefined && !admitted.ok && !runtime.warnedDocumentIds.has(change.documentId)) {
    runtime.warnedDocumentIds.add(change.documentId);
    runtime.deps.statusMessages.publish(`xi: language sync unavailable: ${admitted.error.message}`);
  }
}

function releaseLanguageDocument(runtime: InlayHintRuntime, path: string | undefined): void {
  const session = runtime.session();
  if (session === undefined || path === undefined || runtime.resolveLanguageId(path) === undefined) return;
  const uri = runtime.deps.fileUri(path);
  for (const [documentId, document] of runtime.documents) {
    if (document.uri !== uri) continue;
    runtime.documents.delete(documentId);
    runtime.highlightPositions.delete(documentId);
    runtime.presentation()?.clear(documentId);
  }
  session.closeDocument(uri);
}

function annotationOffset(document: TextFileDocument | undefined, documentVersion: number, line: number, column: number): Utf16Offset | undefined {
  if (document === undefined || !Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 0 || column < 0) return undefined;
  const snapshot = document.snapshot();
  if (Number(snapshot.version) !== documentVersion || line >= snapshot.lineCount) return undefined;
  const start = snapshot.lineStartOffset(line as LineIndex);
  if (!start.ok) return undefined;
  const offset = Number(start.value) + column;
  const next = line + 1 < snapshot.lineCount ? snapshot.lineStartOffset((line + 1) as LineIndex) : undefined;
  const end = next?.ok ? Number(next.value) - 1 : snapshot.lengthUtf16;
  if (offset > end) return undefined;
  const boundary = snapshot.slice(offset as Utf16Offset, offset as Utf16Offset);
  return boundary.ok ? offset as Utf16Offset : undefined;
}

function readInlayHints(runtime: InlayHintRuntime, documentId: string, documentVersion: number, document: TextFileDocument | undefined): readonly { readonly id: string; readonly documentVersion: DocumentVersion; readonly lineIndex: LineIndex; readonly offset: Utf16Offset; readonly text: string }[] {
  const result = runtime.presentation()?.hints(documentId);
  if (result === undefined || result.documentVersion !== documentVersion) return Object.freeze([]);
  return Object.freeze(result.hints.flatMap((hint) => {
    const offset = annotationOffset(document, documentVersion, hint.line, hint.utf16);
    return offset === undefined || hint.label.length < 1 || hint.label.length > 256 || /[\r\n\t]/u.test(hint.label) ? [] : [Object.freeze({ id: hint.id, documentVersion: result.documentVersion as DocumentVersion, lineIndex: hint.line as LineIndex, offset, text: hint.label })];
  }));
}

function readColorSwatches(runtime: InlayHintRuntime, documentId: string, documentVersion: number, document: TextFileDocument | undefined): readonly { readonly id: string; readonly documentVersion: DocumentVersion; readonly lineIndex: LineIndex; readonly offset: Utf16Offset; readonly text: string; readonly background: string }[] {
  const result = runtime.presentation()?.colors(documentId);
  if (result === undefined || result.documentVersion !== documentVersion) return Object.freeze([]);
  return Object.freeze(result.colors.flatMap((color) => {
    const offset = annotationOffset(document, documentVersion, color.line, color.utf16);
    return offset === undefined ? [] : [Object.freeze({ id: color.id, documentVersion: result.documentVersion as DocumentVersion, lineIndex: color.line as LineIndex, offset, text: ' ', background: color.color })];
  }));
}

function readVirtualAnnotations(runtime: InlayHintRuntime, documentId: string, documentVersion: number, document: TextFileDocument | undefined): readonly { readonly id: string; readonly documentVersion: DocumentVersion; readonly lineIndex: LineIndex; readonly offset: Utf16Offset; readonly text: string; readonly background?: string }[] {
  return Object.freeze([...readInlayHints(runtime, documentId, documentVersion, document), ...readColorSwatches(runtime, documentId, documentVersion, document)]);
}

export function resolveConfiguredLanguageId(configuredLanguages: readonly LanguageConfig[] | undefined, path: string | undefined): string | undefined {
  if (path !== undefined && configuredLanguages !== undefined) {
    const fileName = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
    const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
    const configured = configuredLanguages.find((entry) => entry.fileTypes.some((type) => type.toLowerCase() === extension || type.toLowerCase() === fileName));
    if (configured !== undefined) return configured.name;
  }
  return languageIdForPath(path);
}

function hasLanguageServerForPath(deps: LanguageWiringDeps, path: string | undefined): boolean {
  const languageId = resolveConfiguredLanguageId(deps.configuredLanguages, path);
  return languageId !== undefined && resolveLanguageServerConfig(deps, languageId) !== undefined;
}

function admitLanguageBuffer(deps: LanguageWiringDeps, runtime: InlayHintRuntime, session: LanguageServerSession | undefined, path: string | undefined, documentId: DocumentId, document: TextFileDocument): void {
  if (session === undefined || path === undefined) return;
  const languageId = resolveConfiguredLanguageId(deps.configuredLanguages, path);
  if (languageId === undefined || resolveLanguageServerConfig(deps, languageId) === undefined) return;
  const text = deps.readDocumentText(document);
  if (text === undefined) return;
  const uri = deps.fileUri(path);
  runtime.documents.set(String(documentId), { uri, version: document.version, lineCount: text.split('\n').length });
  const admitted = session.openDocument({ uri, documentId: String(documentId), languageId, version: document.version, text });
  if (!admitted.ok) deps.statusMessages.publish(`xi: language document unavailable: ${admitted.error.message}`);
  else deps.marker?.('XI_LANGUAGE_STARTED', { languageId, path });
  if (admitted.ok) {
    void refreshInlayHints(runtime, String(documentId));
    void refreshDocumentColors(runtime, String(documentId));
    const position = runtime.highlightPositions.get(String(documentId));
    if (position !== undefined) void refreshDocumentHighlights(runtime, String(documentId), position.line, position.utf16);
  }
}

function clearLanguageRuntime(runtime: InlayHintRuntime, presentation: LanguagePresentation | undefined, connection: LanguageWiringConnection | undefined, disposables: readonly (Disposable | undefined)[]): void {
  presentation?.dispose();
  runtime.documents.clear();
  runtime.highlightPositions.clear();
  connection?.completionFeature.detachLanguage();
  connection?.overlayFeature.detachNavigation();
  connection?.workspaceEditsFeature.dispose();
  for (const disposable of disposables) disposable?.dispose();
}

function admitExistingLanguageBuffers(deps: LanguageWiringDeps, connection: LanguageWiringConnection, admit: (path: string | undefined, documentId: DocumentId, document: TextFileDocument) => void): void {
  admit(deps.launchDocumentPath, deps.launchDocument.id, deps.launchDocument);
  for (const buffer of deps.workbenchBuffers()) {
    if (buffer.documentId === deps.launchDocument.id) continue;
    const document = connection.getBufferDocument(buffer.documentId);
    if (document !== undefined) admit(buffer.path, buffer.documentId, document);
  }
}

function subscribeLanguagePresentation(session: LanguageServerSession, runtime: InlayHintRuntime): Disposable {
  return session.onStateChange((change) => {
    if (change.current === 'ready') runtime.deps.marker?.('XI_LSP_READY', { server: change.health.identity.configName });
    if (change.current === 'ready') void refreshAllInlayHints(runtime);
    if (change.current === 'ready') for (const [documentId, position] of runtime.highlightPositions) void refreshDocumentHighlights(runtime, documentId, position.line, position.utf16);
  });
}

export function createLanguageWiring(deps: LanguageWiringDeps): LanguageWiring {
  let languageSession: LanguageServerSession | undefined;
  let navigationController: LanguageNavigationController | undefined;
  let outlineController: LanguageNavigationController | undefined;
  let completionController: CompletionController | undefined;
  let completionProvider: LanguageServerCompletionProvider | undefined;
  let signatureController: SignatureController | undefined;
  let signatureProvider: LanguageServerSignatureProvider | undefined;
  let workspaceEditProvider: LanguageServerWorkspaceEditProvider | undefined;
  let workspaceEditCoordinator: WorkspaceEditCoordinator | undefined;
  let workspaceEditExecutor: WorkspaceEditResourceExecutor | undefined;
  let navigationSubscription: Disposable | undefined;
  let completionSubscription: Disposable | undefined;
  let signatureSubscription: Disposable | undefined;
  let inlaySubscription: Disposable | undefined;
  let languageInitialization: Promise<void> | undefined;
  let lastEnabled = deps.lspEnabled();
  let connection: LanguageWiringConnection | undefined;
  let presentation: InstanceType<LanguageServices['LanguagePresentationFeatures']> | undefined;
  const resolveLanguageId = (path: string | undefined): string | undefined => resolveConfiguredLanguageId(deps.configuredLanguages, path);
  const inlayRuntime = createInlayRuntime(deps, {
    session: () => languageSession,
    presentation: () => presentation,
  }, resolveLanguageId);
  const admitBufferToLanguageSession = (path: string | undefined, documentId: DocumentId, document: TextFileDocument): void => admitLanguageBuffer(deps, inlayRuntime, languageSession, path, documentId, document);

  async function initializeLanguage(): Promise<void> {
    if (connection === undefined) return;
    const activeConnection = connection;
    const language = await import('../../../../packages/services/src/entrypoints/language');
    if (!deps.lspEnabled()) return;
    presentation = new language.LanguagePresentationFeatures();
    const notificationHandlers = createLspNotificationHandlers(deps);
    languageSession = new language.LanguageServerRouter({
      resolveServer: (resolvedLanguageId) => resolveLanguageServerConfig(deps, resolvedLanguageId),
      sessionKey: (serverConfig, document) => `${serverConfig.name}\u0000${workspaceLspRootForDocument(deps.filesystem, deps.workspaceRoot, deps.workspaceLspRoots, document.uri)}`,
      createSession: (serverConfig, document) => {
        const root = workspaceLspRootForDocument(deps.filesystem, deps.workspaceRoot, deps.workspaceLspRoots, document?.uri ?? '');
        deps.marker?.('XI_LSP_SESSION_ROOT', { server: serverConfig.name, root });
        return new language.LanguageServerSession({
          process: new deps.ProcessPort(),
          clock: deps.createClock(),
          config: serverConfig,
          root,
          workspaceId: 'xi-workspace',
          workspaceFolders: [{ uri: deps.fileUri(root), name: root }],
          environment: deps.processEnvironment(),
          snippetSupport: deps.snippets,
          diagnostics: deps.diagnostics,
          ...notificationHandlers,
        });
      },
    });
    inlaySubscription = subscribeLanguagePresentation(languageSession, inlayRuntime);
    // Lazy initialization and re-grants must admit every already-open buffer.
    admitExistingLanguageBuffers(deps, activeConnection, admitBufferToLanguageSession);
    const navigationProvider = new language.LanguageServerNavigationProvider(languageSession);
    navigationController = new language.LanguageNavigationController(navigationProvider);
    // The Outline refreshes in the background; its own controller keeps those requests from
    // cancelling hover/definition/reference requests that share a request generation.
    outlineController = new language.LanguageNavigationController(navigationProvider);
    completionController = new language.CompletionController();
    completionProvider = new language.LanguageServerCompletionProvider(languageSession);
    signatureProvider = new language.LanguageServerSignatureProvider(languageSession);
    signatureController = new language.SignatureController(signatureProvider);
    workspaceEditExecutor = new language.WorkspaceEditResourceExecutor({
      workspaceRoot: deps.workspaceRoot,
      filesystem: deps.filesystem,
      openDocument: (uri) => activeConnection.workspaceEditsFeature.openWorkspaceEditDocument(uri),
      loadUnopenedFile: (uri) => activeConnection.workspaceEditsFeature.loadUnopenedWorkspaceFile(uri),
      onResourcePathRenamed: (sourcePath, destinationPath) => {
        const sourceBuffer = deps.workbenchBuffers().find((buffer) => buffer.path !== undefined && deps.fileUri(buffer.path) === deps.fileUri(sourcePath));
        if (sourceBuffer !== undefined) deps.renameBufferPath(sourceBuffer.bufferId, destinationPath);
      },
    });
    workspaceEditProvider = new language.LanguageServerWorkspaceEditProvider({
      session: languageSession,
      document: (uri) => workspaceEditExecutor?.resolveDocument(uri),
    });
    workspaceEditCoordinator = new language.WorkspaceEditCoordinator(workspaceEditExecutor.asPort());
    navigationSubscription = activeConnection.overlayFeature.attachNavigation(navigationController, languageSession, outlineController);
    const completionSubscriptions = activeConnection.completionFeature.attachLanguage(languageSession, completionController, completionProvider, signatureController);
    completionSubscription = completionSubscriptions.completionSubscription;
    signatureSubscription = completionSubscriptions.signatureSubscription;
    activeConnection.workspaceEditsFeature.attachLanguage(languageSession, workspaceEditProvider);
  }
  async function ensureLanguage(): Promise<void> {
    if (!deps.lspEnabled()) { deps.marker?.('XI_LANGUAGE_DISABLED', { reason: 'editor.lsp.enable' }); return; }
    if (languageSession !== undefined) return;
    languageInitialization ??= initializeLanguage();
    await languageInitialization;
  }
  async function reconcileTrust(): Promise<void> {
    if (languageInitialization !== undefined) await languageInitialization;
    const enabled = deps.lspEnabled();
    const wasEnabled = lastEnabled;
    lastEnabled = enabled;
    if (enabled) {
      if (!wasEnabled && languageSession === undefined) {
        languageInitialization = undefined;
        await ensureLanguage();
      }
      return;
    }
    const session = languageSession;
    if (session === undefined) return;
    languageSession = undefined;
    languageInitialization = undefined;
    clearLanguageRuntime(inlayRuntime, presentation, connection, [completionSubscription, signatureSubscription, navigationSubscription, inlaySubscription, completionController, signatureController, navigationController, outlineController, workspaceEditCoordinator]);
    completionSubscription = undefined; signatureSubscription = undefined; navigationSubscription = undefined; inlaySubscription = undefined;
    completionController = undefined; signatureController = undefined; navigationController = undefined; outlineController = undefined; workspaceEditCoordinator = undefined;
    completionProvider = undefined; signatureProvider = undefined;
    workspaceEditProvider = undefined; workspaceEditExecutor = undefined; presentation = undefined;
    await session.dispose();
    deps.notifySurfaceChange();
  }
  return {
    connect(next) { connection = next; },
    resolveLanguageId,
    hasServerForPath: (path) => hasLanguageServerForPath(deps, path),
    admitBufferToLanguageSession,
    ensureLanguage,
    reconcileTrust,
    changeDocument: (change) => changeLanguageDocument(inlayRuntime, change),
    releaseBufferFromLanguageSession: (path) => releaseLanguageDocument(inlayRuntime, path),
    refreshDocumentHighlights: (documentId: string, line: number, utf16: number) => { void refreshDocumentHighlights(inlayRuntime, documentId, line, utf16); },
    documentHighlights: (documentId, documentVersion) => {
      const result = presentation?.documentHighlights(documentId);
      if (result === undefined || result.documentVersion !== documentVersion) return Object.freeze([]);
      return result.ranges;
    },
    inlayHints: (documentId, documentVersion) => readInlayHints(inlayRuntime, documentId, documentVersion, connection?.getBufferDocument(documentId as DocumentId)),
    virtualAnnotations: (documentId, documentVersion) => readVirtualAnnotations(inlayRuntime, documentId, documentVersion, connection?.getBufferDocument(documentId as DocumentId)),
    get session() { return languageSession; },
    get navigationController() { return navigationController; },
    get outlineController() { return outlineController; },
    get navigationSubscription() { return navigationSubscription; },
    get completionController() { return completionController; },
    get signatureController() { return signatureController; },
    get completionSubscription() { return completionSubscription; },
    get signatureSubscription() { return signatureSubscription; },
    get workspaceEditCoordinator() { return workspaceEditCoordinator; },
    get workspaceEditProvider() { return workspaceEditProvider; },
    get workspaceEditExecutor() { return workspaceEditExecutor; },
    get inlaySubscription() { return inlaySubscription; },
  };
}
