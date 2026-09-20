import type { DocumentId } from '../../../../packages/primitives/src/entrypoints/launch';
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
  readonly fileUri: (path: string) => string;
  readonly processEnvironment: () => Readonly<Record<string, string>>;
  readonly diagnostics: DiagnosticStore;
  readonly configuredLanguages: readonly LanguageConfig[] | undefined;
  readonly configuredLanguageServers: readonly LanguageServerConfig[] | undefined;
  readonly launchDocument: TextFileDocument;
  readonly launchDocumentPath: string | undefined;
  readonly readDocumentText: (document: TextFileDocument) => string | undefined;
  readonly workbenchBuffers: () => readonly { readonly bufferId: DocumentId; readonly documentId: DocumentId; readonly path: string | undefined }[];
  readonly renameBufferPath: (bufferId: DocumentId, path: string) => void;
  readonly statusMessages: StatusMessageController;
  readonly marker?: (name: string, payload?: unknown) => void;
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
  admitBufferToLanguageSession(path: string | undefined, documentId: DocumentId, document: TextFileDocument): void;
  ensureLanguage(): Promise<void>;
  /** Mirrors the composition root's onDocumentChange wiring for the launch WorkbenchSession. */
  changeDocument(change: CommittedDocumentChange): void;
  /** Mirrors BufferHost's onBufferClosed language-session teardown. */
  releaseBufferFromLanguageSession(path: string | undefined): void;
  readonly session: LanguageServerSession | undefined;
  readonly navigationController: LanguageNavigationController | undefined;
  readonly navigationSubscription: Disposable | undefined;
  readonly completionController: CompletionController | undefined;
  readonly signatureController: SignatureController | undefined;
  readonly completionSubscription: Disposable | undefined;
  readonly signatureSubscription: Disposable | undefined;
  readonly workspaceEditCoordinator: WorkspaceEditCoordinator | undefined;
  readonly workspaceEditProvider: LanguageServerWorkspaceEditProvider | undefined;
  readonly workspaceEditExecutor: WorkspaceEditResourceExecutor | undefined;
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

export function createLanguageWiring(deps: LanguageWiringDeps): LanguageWiring {
  let languageSession: LanguageServerSession | undefined;
  let navigationController: LanguageNavigationController | undefined;
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
  let languageInitialization: Promise<void> | undefined;
  let connection: LanguageWiringConnection | undefined;
  const languageSyncWarnedDocumentIds = new Set<DocumentId>();

  // Configured languages.toml [[language]] entries take priority over the hardcoded ts/js
  // defaults in `languageIdForPath` -- a language a config maps to a file-type Xi has no
  // built-in mapping for still resolves, and a remapped extension follows the config.
  function resolveLanguageId(path: string | undefined): string | undefined {
    if (path !== undefined && deps.configuredLanguages !== undefined) {
      const fileName = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
      const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
      const configured = deps.configuredLanguages.find((entry) => entry.fileTypes.some((type) => type.toLowerCase() === extension || type.toLowerCase() === fileName));
      if (configured !== undefined) return configured.name;
    }
    return languageIdForPath(path);
  }

  // Shared by the launch document and by BufferHost's onBufferOpened, so every buffer -- not
  // only the one opened at process launch -- gets a didOpen once a language session exists,
  // whether it was already open before the session started (backfilled below) or opened
  // afterward.
  function admitBufferToLanguageSession(path: string | undefined, documentId: DocumentId, document: TextFileDocument): void {
    if (languageSession === undefined || path === undefined) return;
    const bufferLanguageId = resolveLanguageId(path);
    // Languages Xi only highlights (json/toml/markdown) have no server: skip silently.
    if (bufferLanguageId === undefined || resolveLanguageServerConfig(deps, bufferLanguageId) === undefined) return;
    const text = deps.readDocumentText(document);
    if (text === undefined) return;
    const admitted = languageSession.openDocument({ uri: deps.fileUri(path), documentId: String(documentId), languageId: bufferLanguageId, version: document.version, text });
    if (!admitted.ok) deps.statusMessages.publish(`xi: language document unavailable: ${admitted.error.message}`);
    else deps.marker?.('XI_LANGUAGE_STARTED', { languageId: bufferLanguageId, path });
  }

  // One router for the whole workbench, with one server session per configured server
  // (typescript-language-server, pyright, ...) created lazily by the first buffer of a
  // language it serves. Previously a single session was created for the launch document's
  // language only, so `xi` started with no file (or on a .md) never got a server for any
  // .ts/.py buffer opened later, and a .py buffer opened after `xi main.ts` was sent to the
  // TypeScript server.
  async function initializeLanguage(): Promise<void> {
    if (connection === undefined) return;
    const activeConnection = connection;
    const language = await import('../../../../packages/services/src/entrypoints/language');
    languageSession = new language.LanguageServerRouter({
      resolveServer: (resolvedLanguageId) => resolveLanguageServerConfig(deps, resolvedLanguageId),
      createSession: (serverConfig) => new language.LanguageServerSession({
        process: new deps.ProcessPort(),
        clock: deps.createClock(),
        config: serverConfig,
        root: deps.workspaceRoot,
        workspaceId: 'xi-workspace',
        workspaceFolders: [{ uri: deps.fileUri(deps.workspaceRoot), name: deps.workspaceRoot }],
        environment: deps.processEnvironment(),
        diagnostics: deps.diagnostics,
      }),
    });
    admitBufferToLanguageSession(deps.launchDocumentPath, deps.launchDocument.id, deps.launchDocument);
    // Buffers opened before the session existed (e.g. via the explorer/picker before any
    // LSP-triggering action) never received a didOpen otherwise, since language init is lazy.
    for (const buffer of deps.workbenchBuffers()) {
      if (buffer.documentId === deps.launchDocument.id) continue;
      const bufferDocument = activeConnection.getBufferDocument(buffer.documentId);
      if (bufferDocument === undefined) continue;
      admitBufferToLanguageSession(buffer.path, buffer.documentId, bufferDocument);
    }
    navigationController = new language.LanguageNavigationController(new language.LanguageServerNavigationProvider(languageSession));
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
    navigationSubscription = activeConnection.overlayFeature.attachNavigation(navigationController, languageSession);
    const completionSubscriptions = activeConnection.completionFeature.attachLanguage(languageSession, completionController, completionProvider, signatureController);
    completionSubscription = completionSubscriptions.completionSubscription;
    signatureSubscription = completionSubscriptions.signatureSubscription;
    activeConnection.workspaceEditsFeature.attachLanguage(languageSession, workspaceEditProvider);
  }

  async function ensureLanguage(): Promise<void> {
    if (languageSession !== undefined) return;
    languageInitialization ??= initializeLanguage();
    await languageInitialization;
  }

  function changeDocument(change: CommittedDocumentChange): void {
    if (languageSession?.hasDocument(String(change.documentId)) !== true) return;
    const admitted = languageSession.changeDocument(change);
    if (admitted !== undefined && !admitted.ok && !languageSyncWarnedDocumentIds.has(change.documentId)) {
      languageSyncWarnedDocumentIds.add(change.documentId);
      deps.statusMessages.publish(`xi: language sync unavailable: ${admitted.error.message}`);
    }
  }

  function releaseBufferFromLanguageSession(path: string | undefined): void {
    if (languageSession === undefined || path === undefined) return;
    if (resolveLanguageId(path) === undefined) return;
    languageSession.closeDocument(deps.fileUri(path));
  }

  return {
    connect(next) { connection = next; },
    resolveLanguageId,
    admitBufferToLanguageSession,
    ensureLanguage,
    changeDocument,
    releaseBufferFromLanguageSession,
    get session() { return languageSession; },
    get navigationController() { return navigationController; },
    get navigationSubscription() { return navigationSubscription; },
    get completionController() { return completionController; },
    get signatureController() { return signatureController; },
    get completionSubscription() { return completionSubscription; },
    get signatureSubscription() { return signatureSubscription; },
    get workspaceEditCoordinator() { return workspaceEditCoordinator; },
    get workspaceEditProvider() { return workspaceEditProvider; },
    get workspaceEditExecutor() { return workspaceEditExecutor; },
  };
}
