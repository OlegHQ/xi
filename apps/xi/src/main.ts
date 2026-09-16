import { asIdentifier, asLineIndex, asUtf16Column, asUtf16Offset, asUndoGroupId, CancellationSource, type DocumentId, type UndoGroupId, type ViewId } from '../../../packages/primitives/src/index';
import type { ClockPort } from '../../../packages/contracts/src/index';
import type { SelectionSetSnapshot } from '../../../packages/selections/src/index';
import type { OutlineReadPort, HoverReadPort, CompletionReadPort, SignatureReadPort, ExCommandLineReadPort, ExCommandLineInput, WorkbenchPointerEvent } from '../../../packages/ui/src/entrypoints/launch';
import type { TextFileDocument } from '../../../packages/document/src/entrypoints/launch';
import type { encodeTextFile, openTextDocument } from '../../../packages/document/src/entrypoints/launch';
import type { DocumentEdit, DocumentSnapshot } from '../../../packages/document/src/index';
import type {
  NodeFilesystemPort,
  NodeProcessPort,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryWatchEvent,
} from '../../../packages/platform/src/entrypoints/launch';
import type {
  BoundedPickerModel,
  createNavigationContributionModule,
  ExplorerNavigationController,
  ExplorerTree,
  FilePathIndex,
  FilePickerProvider,
  PersistenceService,
  RealtimeSearchService,
  RipgrepSearchBackend,
  StaticPickerProvider,
  PickerEntry,
  PickerFailure,
  PickerMode,
  PickerProvider,
  PickerQueryRequest,
  ExplorerDirectoryEntry,
  ExplorerFailure,
  ExplorerFilesystemPort,
  SearchBufferSource,
  SearchMatch,
  WorkspaceReplaceService,
  applyReplacementEdits,
  FormatterPipeline,
  createExternalFormatter,
  HostNavigationController,
  SnippetSession,
  expandSnippet,
  ReplaceApplyPort,
  ReplaceJournal,
  ReplaceTarget,
} from '../../../packages/services/src/entrypoints/launch';
import type { CancellationToken, Result } from '../../../packages/primitives/src/index';
import type { VimPrefixHelpState } from '../../../packages/workbench/src/entrypoints/launch';
import type { PointerEvent } from '../../../packages/workbench/src/entrypoints/launch';

const XI_VERSION = '0.0.1';
let formatterOperationNumber = 0;

type LaunchServices = typeof import('../../../packages/services/src/entrypoints/launch');

interface ActiveSnippetMember {
  readonly memberId: string;
  readonly session: import('../../../packages/services/src/entrypoints/language').SnippetSession;
  baseOffset: number;
}

interface CompletionEditPlan {
  readonly proposalEdits: readonly DocumentEdit[];
  readonly memberEdits: ReadonlyMap<string, DocumentEdit>;
  readonly snippetExpansion: import('../../../packages/services/src/entrypoints/language').SnippetExpansion | undefined;
}

/** Keep the composition root limited to CLI, ports, lifecycle and renderer wiring. */
async function main(): Promise<void> {
  const startupStarted = process.hrtime.bigint();
  const startupTrace = (label: string): void => {
    if (process.env.XI_STARTUP_TRACE === '1') process.stderr.write(`XI_STARTUP_TRACE ${label} ${Number(process.hrtime.bigint() - startupStarted) / 1_000_000}\n`);
  };
  startupTrace('main');
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Xi editor\n\nUsage: xi [options] [file[:line]]\n\nOptions:\n  --help       Show this help\n  --version    Show the version\n  --health     Check the local runtime\n');
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`xi ${XI_VERSION}\n`);
    return;
  }
  if (args.includes('--health')) {
    process.stdout.write(`xi ${XI_VERSION} health: OpenTUI workbench available\n`);
    return;
  }

  const fileArgument = args.find((arg) => !arg.startsWith('-'));
  const filePath = fileArgument === undefined ? undefined : resolveFileArgument(fileArgument);
  const languageId = languageIdForPath(filePath?.path);
  // Keep CLI startup free of the optional service barrel. The small persistence
  // entrypoint, OpenTUI, Vim and the service graph can load concurrently.
  const persistenceModule = import('../../../packages/services/src/entrypoints/persistence');
  const coreServicesModule = import('../../../packages/services/src/entrypoints/launch-core');
  const platformModule = import('../../../packages/platform/src/entrypoints/launch');
  const documentModule = import('../../../packages/document/src/entrypoints/launch');
  // Loading OpenTUI can briefly occupy the event loop while its native module
  // is evaluated. For an explicit file, finish the small open first so that
  // the launch read is not serialized behind native renderer startup.
  const earlyUi = filePath?.path === undefined ? import('../../../packages/ui/src/entrypoints/launch') : undefined;
  const vimSession = import('../../../packages/workbench/src/entrypoints/launch');
  const [{ PersistenceService }, { NodeFilesystemPort, NodeProcessPort }, { openTextDocument, encodeTextFile, positionToOffset }] = await Promise.all([persistenceModule, platformModule, documentModule]);
  startupTrace('base-modules');
  const filesystem = new NodeFilesystemPort();
  const persistence = new PersistenceService(filesystem);
  const document = await openDocument(openTextDocument, persistence, filePath?.path, id<DocumentId>('xi-launch-document'));
  if (document === undefined) return;
  startupTrace('document');
  const launchDocument = document;
  const ui = earlyUi ?? import('../../../packages/ui/src/entrypoints/launch');
  const renderer = ui.then(({ createOpenTuiRenderer }) => createOpenTuiRenderer());
  const coreServices = await coreServicesModule;
  const [{ createOwnedVimSession, WorkbenchSession, CommandRegistry, ContributionRegistry, DEFAULT_NATIVE_EX_COMMANDS, buildPrefixHelpReadModel, ExCommandLineSession, PrefixHelpController, WorkbenchPointerCapture, WorkbenchControlRegistry, SplitterDragController }, { runOpenTuiWorkbench }] = await Promise.all([vimSession, ui]);
  startupTrace('core-modules');
  const {
    BoundedPickerModel,
    createNavigationContributionModule,
    DiagnosticStore,
    FilePathIndex,
    FilePickerProvider,
    StaticPickerProvider,
  } = coreServices;
  const documents = new Map<DocumentId, TextFileDocument>([[document.id, document]]);
  const sessions = new Map<ViewId, ReturnType<typeof createOwnedVimSession>>();
  const sessionDocuments = new Map<ViewId, TextFileDocument>();
  let nextDocumentNumber = 1;
  let languageSession: import('../../../packages/services/src/entrypoints/language').LanguageServerSession | undefined;
  let navigationController: import('../../../packages/services/src/entrypoints/language').LanguageNavigationController | undefined;
  let completionController: import('../../../packages/services/src/entrypoints/language').CompletionController | undefined;
  let completionProvider: import('../../../packages/services/src/entrypoints/language').LanguageServerCompletionProvider | undefined;
  let signatureController: import('../../../packages/services/src/entrypoints/language').SignatureController | undefined;
  let signatureProvider: import('../../../packages/services/src/entrypoints/language').LanguageServerSignatureProvider | undefined;
  let workspaceEditProvider: import('../../../packages/services/src/entrypoints/language').LanguageServerWorkspaceEditProvider | undefined;
  let workspaceEditCoordinator: import('../../../packages/services/src/entrypoints/language').WorkspaceEditCoordinator | undefined;
  let languageInitialization: Promise<void> | undefined;
  let snippetSession: import('../../../packages/services/src/entrypoints/language').SnippetSession | undefined;
  let snippetMembers = new Map<string, ActiveSnippetMember>();
  let snippetViewId: ViewId | undefined;
  let snippetUndoGroup: UndoGroupId | undefined;
  let snippetApplying = false;
  const workbench = new WorkbenchSession({
    saveBuffer: async (buffer) => {
      const bufferDocument = documents.get(buffer.documentId);
      if (bufferDocument === undefined) return { ok: false, error: 'document is no longer open' };
      const saved = await requestSave(bufferDocument, buffer.path, undefined);
      return saved ? { ok: true, value: undefined } : { ok: false, error: 'save failed' };
    },
    onDocumentChange: (change) => {
      const admitted = languageSession?.changeDocument(change);
      if (admitted !== undefined && !admitted.ok) process.stderr.write(`xi: language sync unavailable: ${admitted.error.message}\n`);
      // Vim-originated commits already advanced their owning session during
      // command execution. Remapping those sessions would add avoidable work
      // to every typed character; external LSP/workspace commits still map
      // every live session sharing the document.
      if (change.origin !== 'vim') for (const session of sessions.values()) session.applyExternalChange(change);
      if (snippetSession !== undefined && !snippetApplying) finishSnippet();
    },
  });
  const opened = workbench.openBuffer(document, {
    ...(filePath?.path === undefined ? {} : { path: filePath.path }),
    viewId: id<ViewId>('xi-launch-view'),
  });
  if (!opened.ok) throw new Error(`xi-workbench-open:${opened.error.kind}`);
  startupTrace('workbench');
  const controlRegistry = new WorkbenchControlRegistry();
  const splitterDrag = new SplitterDragController(12);
  let activeSplitter: { readonly nodeId: string; readonly availableCells: number } | undefined;
  controlRegistry.publish([
    { id: 'sidebar.files', kind: 'tree', enabled: true, activate: () => openExplorer() },
    { id: 'sidebar.search', kind: 'button', enabled: true, activate: () => openSearch() },
    { id: 'sidebar.git', kind: 'button', enabled: true, activate: () => openProblems() },
    { id: 'status', kind: 'button', enabled: true, activate: () => {} },
    { id: 'tab.active', kind: 'tab', enabled: true, activate: () => { const active = workbench.activeViewId; if (active !== undefined) void workbench.focus(active); } },
  ]);
  const workspaceRoot = process.cwd();
  const formatOnSave = process.env.XI_FORMAT_ON_SAVE === '1';
  const pendingSaves = new Map<string, Promise<boolean>>();
  const diagnostics = new DiagnosticStore();
  let hostNavigation: InstanceType<LaunchServices['HostNavigationController']> | undefined;
  let formatterPipeline: InstanceType<LaunchServices['FormatterPipeline']> | undefined;
  let explorerTree: InstanceType<LaunchServices['ExplorerTree']> | undefined;
  let explorerController: InstanceType<LaunchServices['ExplorerNavigationController']> | undefined;
  let searchService: InstanceType<LaunchServices['RealtimeSearchService']> | undefined;
  let replaceService: InstanceType<LaunchServices['WorkspaceReplaceService']> | undefined;
  let expandSnippet: LaunchServices['expandSnippet'] | undefined;
  let SnippetSession: LaunchServices['SnippetSession'] | undefined;
  let executeLanguageCodeAction: LaunchServices['executeLanguageCodeAction'] | undefined;
  let applyReplacementEdits: LaunchServices['applyReplacementEdits'] | undefined;
  let explorerSubscription: import('../../../packages/contracts/src/index').Disposable | undefined;
  let searchSubscription: import('../../../packages/contracts/src/index').Disposable | undefined;
  let optionalServicesInitialization: Promise<void> | undefined;
  const surfaceChangeListeners = new Set<() => void>();
  async function initializeLanguage(): Promise<void> {
    if (languageId === undefined || filePath?.path === undefined) return;
    const text = readDocumentText(launchDocument);
    if (text === undefined) return;
    const language = await import('../../../packages/services/src/entrypoints/language');
    languageSession = new language.LanguageServerSession({
      process: new NodeProcessPort(),
      clock: createNodeClock(),
      config: { name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], rootMarkers: ['tsconfig.json', 'package.json', '.git'] },
      root: workspaceRoot,
      workspaceId: 'xi-workspace',
      workspaceFolders: [{ uri: fileUri(workspaceRoot), name: workspaceRoot }],
      environment: processEnvironment(),
      diagnostics,
    });
    const admitted = languageSession.openDocument({ uri: fileUri(filePath.path), documentId: String(launchDocument.id), languageId, version: launchDocument.version, text });
    if (!admitted.ok) process.stderr.write(`xi: language document unavailable: ${admitted.error.message}\n`);
    navigationController = new language.LanguageNavigationController(new language.LanguageServerNavigationProvider(languageSession));
    completionController = new language.CompletionController();
    completionProvider = new language.LanguageServerCompletionProvider(languageSession);
    signatureProvider = new language.LanguageServerSignatureProvider(languageSession);
    signatureController = new language.SignatureController(signatureProvider);
    workspaceEditProvider = new language.LanguageServerWorkspaceEditProvider({
      session: languageSession,
      document: resolveWorkspaceEditDocument,
    });
    workspaceEditCoordinator = new language.WorkspaceEditCoordinator(createWorkspaceEditPort());
    navigationSubscription = navigationController.subscribe((model) => {
      if (process.env.XI_UI_TEST_MARKERS !== '1') return;
      if (outlineOpen) process.stderr.write(`XI_OUTLINE_STATE ${JSON.stringify({ state: model.state, generation: model.generation, symbols: model.symbols.length, message: model.message })}\r\n`);
      if (hoverOpen) process.stderr.write(`XI_HOVER_STATE ${JSON.stringify({ state: model.state, generation: model.generation, hasText: model.hover !== undefined && model.hover.length > 0, message: model.message })}\r\n`);
    });
    completionSubscription = completionController.subscribe((model) => {
      if (process.env.XI_UI_TEST_MARKERS === '1' && completionOpen) process.stderr.write(`XI_COMPLETION_STATE ${JSON.stringify({ state: model.state, items: model.items.length, selectedId: model.selectedId, documentation: model.documentation !== undefined, message: model.message })}\r\n`);
    });
    signatureSubscription = signatureController.subscribe((model) => {
      if (process.env.XI_UI_TEST_MARKERS === '1' && signatureOpen) process.stderr.write(`XI_SIGNATURE_STATE ${JSON.stringify({ state: model.state, signatures: model.signatures.length, message: model.message })}\r\n`);
    });
  }
  async function ensureLanguage(): Promise<void> {
    if (languageSession !== undefined) return;
    languageInitialization ??= initializeLanguage();
    await languageInitialization;
  }

  const explorerCancellation = new CancellationSource();
  async function initializeOptionalServices(): Promise<void> {
    if (optionalServicesInitialization !== undefined) return optionalServicesInitialization;
    optionalServicesInitialization = (async () => {
      const services = await import('../../../packages/services/src/entrypoints/launch');
      const {
        HostNavigationController,
        ExplorerTree,
        ExplorerNavigationController,
        RealtimeSearchService,
        RipgrepSearchBackend,
        WorkspaceReplaceService,
      } = services;
      hostNavigation = new HostNavigationController({
        async file(path, line) {
          if (path.length === 0 || path.includes('\0') || !path.startsWith('/')) return { ok: false, error: { kind: 'missing', message: `file target is invalid: ${path}` } };
          const cancellation = new CancellationSource();
          try {
            const info = await filesystem.stat(path, cancellation.token);
            if (!info.ok) return { ok: false, error: { kind: 'missing', message: `file target is unavailable: ${path}` } };
            if (info.value.kind !== 'file' && info.value.kind !== 'symlink') return { ok: false, error: { kind: 'missing', message: `file target is not a file: ${path}` } };
            const safeLine = line === undefined ? 0 : line;
            if (!Number.isSafeInteger(safeLine) || safeLine < 0) return { ok: false, error: { kind: 'unavailable', message: 'file line is invalid' } };
            return { ok: true, value: Object.freeze({ uri: fileUri(path), line: safeLine, utf16: 0 }) };
          } finally {
            cancellation.dispose();
          }
        },
        async tag(name) {
          if (name.length === 0 || name.length > 4096 || name.includes('\0') || /\s/u.test(name)) return { ok: false, error: { kind: 'missing', message: `tag ${name} was not found` } };
          const results: Array<{ readonly uri: string; readonly line: number; readonly utf16: number }> = [];
          for (const tagsPath of [filesystem.resolvePath(workspaceRoot, 'tags'), filesystem.resolvePath(workspaceRoot, '.tags')]) {
            const cancellation = new CancellationSource();
            try {
              const info = await filesystem.stat(tagsPath, cancellation.token);
              if (!info.ok || info.value.kind !== 'file' || info.value.sizeBytes > 4 * 1024 * 1024) continue;
              const bytes = await filesystem.readFile(tagsPath, cancellation.token);
              if (!bytes.ok) continue;
              let content: string;
              try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value); } catch { continue; }
              for (const row of content.split('\n')) {
                if (row.length === 0 || row.startsWith('!_TAG_')) continue;
                const fields = row.replace(/\r$/u, '').split('\t');
                if (fields[0] !== name || fields[1] === undefined || fields[2] === undefined) continue;
                const targetPath = fields[1].startsWith('/') ? fields[1] : filesystem.resolvePath(filesystem.directoryPath(tagsPath), fields[1]);
                if (targetPath.includes('\0')) continue;
                const lineMatch = /(?:^|;)line:([1-9][0-9]*)/.exec(fields[2]);
                const numericMatch = /^(?:[?/]?(\d+))(?:;"|[/?])?$/u.exec(fields[2]);
                const lineNumber = lineMatch?.[1] ?? numericMatch?.[1];
                const line = lineNumber === undefined ? 0 : Number(lineNumber) - 1;
                if (!Number.isSafeInteger(line) || line < 0) continue;
                results.push(Object.freeze({ uri: fileUri(targetPath), line, utf16: 0 }));
              }
            } finally {
              cancellation.dispose();
            }
          }
          return { ok: true, value: Object.freeze(results) };
        },
      });
      const nextExplorer = new ExplorerTree(createExplorerFilesystem(filesystem, workspaceRoot));
      const explorerRoot = nextExplorer.addRoot({ id: 'workspace', label: workspaceRoot, path: workspaceRoot });
      if (!explorerRoot.ok) throw new Error(`xi-explorer-root:${explorerRoot.error.kind}`);
      explorerTree = nextExplorer;
      searchService = new RealtimeSearchService({
        backend: new RipgrepSearchBackend({ process: new NodeProcessPort(), environment: processEnvironment() }),
        debounceMilliseconds: 40,
        defaultLimit: 10_000,
        bufferSourceProvider: readSearchBuffers,
      });
      replaceService = new WorkspaceReplaceService(createReplacePort());
      explorerOpenGeneration = nextExplorer.model.generation;
      searchOpenGeneration = searchService.model.generation;
      explorerSubscription = nextExplorer.subscribe((model) => {
        if (process.env.XI_UI_TEST_MARKERS === '1' && explorerOpen && model.generation > explorerOpenGeneration) {
          const selected = model.selectedId === undefined ? undefined : nextExplorer.readNode(model.selectedId);
          process.stderr.write(`XI_EXPLORER_REFRESH ${JSON.stringify({ generation: model.generation, selectedId: model.selectedId, selectedPath: selected?.relativePath, state: model.state })}\r\n`);
        }
      });
      searchSubscription = searchService.subscribe((model) => {
        if (process.env.XI_UI_TEST_MARKERS !== '1' || !searchOpen || model.generation <= searchOpenGeneration) return;
        const first = model.matches[0];
        process.stderr.write(`XI_SEARCH_RESULT ${JSON.stringify({ generation: model.generation, query: model.query.query, state: model.state, totalMatches: model.totalMatches, firstPath: first?.path, firstSource: first?.source, message: model.message })}\r\n`);
      });
      explorerController = new ExplorerNavigationController({ tree: nextExplorer, onOpen: openExplorerNode });
      expandSnippet = services.expandSnippet;
      SnippetSession = services.SnippetSession;
      executeLanguageCodeAction = services.executeLanguageCodeAction;
      applyReplacementEdits = services.applyReplacementEdits;
      for (const listener of surfaceChangeListeners) listener();
    })();
    return optionalServicesInitialization;
  }

  let formattingInitialization: Promise<void> | undefined;
  function ensureFormatting(): Promise<void> {
    formattingInitialization ??= (async () => {
      const { FormatterPipeline, createExternalFormatter } = await import('../../../packages/services/src/entrypoints/formatting');
      formatterPipeline = createFormatterPipelineFromEnvironment(workspaceRoot, FormatterPipeline, createExternalFormatter, NodeProcessPort);
    })();
    return formattingInitialization;
  }

  function requestSave(sessionDocument: TextFileDocument, path: string, viewId: ViewId | undefined): Promise<boolean> {
    const key = String(sessionDocument.id);
    const existing = pendingSaves.get(key);
    if (existing !== undefined) return existing;
    const save = (): Promise<boolean> => saveWithConfiguredFormatter(sessionDocument, persistence, path, formatterPipeline, formatOnSave, workbench, viewId);
    const pending = formatOnSave ? ensureFormatting().then(save) : save();
    pendingSaves.set(key, pending);
    void pending.then(
      () => { if (pendingSaves.get(key) === pending) pendingSaves.delete(key); },
      () => { if (pendingSaves.get(key) === pending) pendingSaves.delete(key); },
    );
    return pending;
  }

  const unavailableOutline = Object.freeze({
    model: Object.freeze({ state: 'unavailable' as const, symbols: Object.freeze([]), message: 'No language server available' }),
    subscribe: (_listener: (model: OutlineReadPort['model']) => void) => Object.freeze({ dispose: () => {} }),
  });
  const outlineRead: OutlineReadPort = {
    get model() { return navigationController?.model ?? unavailableOutline.model; },
    subscribe(listener) {
      return navigationController?.subscribe(() => listener(outlineRead.model)) ?? unavailableOutline.subscribe(listener);
    },
  };
  const unavailableHover = Object.freeze({
    model: Object.freeze({ state: 'unavailable' as const, hover: undefined, message: 'No language server available' }),
    subscribe: (_listener: (model: HoverReadPort['model']) => void) => Object.freeze({ dispose: () => {} }),
  });
  const hoverRead: HoverReadPort = {
    get model() { return navigationController?.model ?? unavailableHover.model; },
    subscribe(listener) {
      return navigationController?.subscribe(() => listener(hoverRead.model)) ?? unavailableHover.subscribe(listener);
    },
  };
  const unavailableCompletion = Object.freeze({
    model: Object.freeze({ state: 'error' as const, items: Object.freeze([]), selectedId: undefined, documentation: undefined, documentationOffset: 0, message: 'No language server available' }),
    subscribe: (_listener: (model: CompletionReadPort['model']) => void) => Object.freeze({ dispose: () => {} }),
  });
  const completionRead: CompletionReadPort = {
    get model() {
      const model = completionController?.model;
      return model === undefined ? unavailableCompletion.model : Object.freeze({ state: model.state, items: model.items, selectedId: model.selectedId, documentation: model.documentation, documentationOffset: model.documentationOffset, message: model.message });
    },
    subscribe(listener) {
      return completionController?.subscribe(() => listener(completionRead.model)) ?? unavailableCompletion.subscribe(listener);
    },
  };
  const unavailableSignature = Object.freeze({
    model: Object.freeze({ state: 'error' as const, label: undefined, documentation: undefined, activeParameter: undefined, message: 'No language server available' }),
    subscribe: (_listener: (model: SignatureReadPort['model']) => void) => Object.freeze({ dispose: () => {} }),
  });
  const signatureRead: SignatureReadPort = {
    get model() {
      const model = signatureController?.model;
      const signature = model?.signatures[model.activeSignature];
      return model === undefined
        ? unavailableSignature.model
        : Object.freeze({ state: model.state, label: signature?.label, documentation: signature?.documentation, activeParameter: model.activeParameter, message: model.message });
    },
    subscribe(listener) {
      return signatureController?.subscribe(() => listener(signatureRead.model)) ?? unavailableSignature.subscribe(listener);
    },
  };
  let explorerOpen = false;
  let explorerFiltering = false;
  let explorerPendingG = false;
  let explorerOpenGeneration = 0;
  let searchOpen = false;
  let searchQuery = '';
  let searchRegex = false;
  let searchCaseSensitive = false;
  let searchWholeWord = false;
  let searchIncludeHidden = false;
  let searchSelectedIndex = 0;
  let replaceInput = '';
  let replaceInputActive = false;
  let replaceOperationNumber = 0;
  let problemsOpen = false;
  let outlineOpen = false;
  let hoverOpen = false;
  let completionOpen = false;
  let signatureOpen = false;
  let completionSerial = 0;
  let completionOperationNumber = 0;
  let workspaceResourceOperationNumber = 0;
  let navigationSubscription: import('../../../packages/contracts/src/index').Disposable | undefined;
  let completionSubscription: import('../../../packages/contracts/src/index').Disposable | undefined;
  let signatureSubscription: import('../../../packages/contracts/src/index').Disposable | undefined;
  let searchOpenGeneration = 0;
  const fileIndex = new FilePathIndex({ maxEntries: 120_000 });
  let fileIndexPopulation: Promise<void> | undefined;
  const rootAdded = fileIndex.addRoot({ id: 'workspace', label: workspaceRoot, path: workspaceRoot });
  if (!rootAdded.ok) throw new Error(`xi-file-index-root:${rootAdded.error.kind}`);
  const commandRegistry = new CommandRegistry({ nativeExNames: DEFAULT_NATIVE_EX_COMMANDS.map((command) => command.name) });
  const contributionRegistry = new ContributionRegistry({
    commands: commandRegistry,
    host: { read: { read: () => ({ ready: true }) }, selectionGeneration: 0 as never },
  });
  const navigationActivation = await contributionRegistry.activate(createNavigationContributionModule({ fileIndex }));
  if (!navigationActivation.ok) throw new Error(`xi-navigation-contributions:${navigationActivation.error.kind}`);

  const bufferProvider: PickerProvider = {
    id: 'xi.navigation.buffers',
    mode: 'buffer',
    async query(request: PickerQueryRequest, cancellation: CancellationToken): Promise<Result<readonly PickerEntry[], PickerFailure>> {
      const query = request.query.normalize('NFKC').toLocaleLowerCase('en-US');
      const entries: PickerEntry[] = [];
      for (const buffer of workbench.buffers()) {
        if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
        const label = buffer.path;
        if (query.length > 0 && !label.normalize('NFKC').toLocaleLowerCase('en-US').includes(query)) continue;
        entries.push(Object.freeze({
          id: String(buffer.bufferId), mode: 'buffer', kind: 'buffer', label,
          detail: buffer.dirty ? 'modified' : 'saved', value: String(buffer.bufferId),
          rootId: undefined, relativePath: undefined, hidden: false, score: query.length === 0 ? 0 : 1,
        }));
      }
      return { ok: true, value: Object.freeze(entries.slice(0, request.limit ?? 100)) };
    },
  };
  const pickerModel = new BoundedPickerModel({ providers: [
    new FilePickerProvider(fileIndex),
    bufferProvider,
    new StaticPickerProvider('xi.navigation.commands', 'command', [
      { id: 'files.pick', mode: 'command', label: 'Files', detail: 'Open file picker', value: 'file' },
      { id: 'buffers.pick', mode: 'command', label: 'Buffers', detail: 'Switch open buffer', value: 'buffer' },
      { id: 'theme.pick', mode: 'command', label: 'Themes', detail: 'Choose a theme', value: 'theme' },
      { id: 'config.open', mode: 'command', label: 'Config', detail: 'Open configuration', value: 'config' },
    ]),
    new StaticPickerProvider('xi.navigation.themes', 'theme', [{ id: 'xi-light', mode: 'theme', label: 'Xi Light', value: 'xi-light' }]),
    new StaticPickerProvider('xi.navigation.config', 'config', [{ id: 'config.open', mode: 'config', label: 'Open config', value: 'config.open' }]),
  ]});
  let pickerOpen = false;
  let pickerMode: PickerMode = 'file';
  let pickerQuery = '';
  let previewViewId: ViewId | undefined;
  let pickerGeneration = 0;
  let leaderPending = false;
  let leaderPanelPending = false;
  let prefixGeneration = 0;
  let exCommandLineSession: InstanceType<typeof ExCommandLineSession> | undefined;
  const commandLineListeners = new Set<(model: ReturnType<InstanceType<typeof ExCommandLineSession>['readModel']> | undefined) => void>();
  const commandLineRead: ExCommandLineReadPort = {
    get model() { return exCommandLineSession?.readModel(); },
    subscribe(listener: (model: ReturnType<InstanceType<typeof ExCommandLineSession>['readModel']> | undefined) => void) {
      commandLineListeners.add(listener);
      return Object.freeze({ dispose: () => { commandLineListeners.delete(listener); } });
    },
  };
  const prefixHelp = new PrefixHelpController({
    readGenerations: () => ({ registryGeneration: commandRegistry.snapshot.generation, configGeneration: prefixGeneration, focusGeneration: prefixGeneration }),
    readPrefixHelp: (request: import('../../../packages/workbench/src/entrypoints/launch').PrefixHelpRequest) => buildPrefixHelpReadModel({
      request,
      registry: commandRegistry,
      registrySnapshot: commandRegistry.snapshot,
      focusGeneration: prefixGeneration,
      bindings: [],
    }),
  });

  const createSession = (sessionDocument: TextFileDocument, viewId: ViewId, initialSelections?: SelectionSetSnapshot, initialLine?: number): ReturnType<typeof createOwnedVimSession> => {
    const session = createOwnedVimSession(sessionDocument, {
      viewId,
      ...(initialSelections === undefined ? {} : { initialSelections }),
      ...(initialLine !== undefined ? { initialLine } : viewId === id<ViewId>('xi-launch-view') && filePath?.line !== undefined ? { initialLine: filePath.line } : {}),
      onMessage: (message) => process.stderr.write(message),
      onSave: async (target) => {
        const buffer = workbench.views().find((view) => view.viewId === viewId);
        const path = target ?? (buffer === undefined ? undefined : workbench.buffer(buffer.bufferId)?.path);
        if (path === undefined) {
          process.stderr.write('xi: no file name\n');
          return false;
        }
        return requestSave(sessionDocument, path, viewId);
      },
      onExCommand: (source) => handleWorkbenchCommand(source, viewId),
      onPrefixStateChange: (state) => {
        if (workbench.activeViewId === viewId) schedulePrefixHelp(viewId, state.pendingKeys, state.parserContinuations);
      },
      onCommandLineChange: (state) => {
        if (state === undefined) {
          exCommandLineSession?.dispose();
          exCommandLineSession = undefined;
        } else if (exCommandLineSession === undefined) {
          exCommandLineSession = new ExCommandLineSession({ registry: commandRegistry, source: state.source, cursorOffset: state.cursorOffset });
        } else {
          exCommandLineSession.setSource(state.source, state.cursorOffset);
        }
        for (const listener of [...commandLineListeners]) listener(commandLineRead.model);
        if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_EX_COMMANDLINE_STATE ${JSON.stringify(state)}\r\n`);
      },
      onStateChange: (state) => {
        workbench.syncViewSession(viewId, state.selections, state.mode);
        const view = workbench.views().find((candidate) => candidate.viewId === viewId);
        if (view !== undefined && workbench.buffer(view.bufferId)?.dirty === true) workbench.promoteBuffer(view.bufferId);
      },
      onHostCommand: (command) => handleVimHostCommand(command, viewId),
    });
    sessions.set(viewId, session);
    sessionDocuments.set(viewId, sessionDocument);
    return session;
  };
  createSession(document, id<ViewId>('xi-launch-view'));
  const pointerCapture = new WorkbenchPointerCapture({
    cancelPendingOperator: () => { activeSession()?.cancelPendingOperator(); },
    place: (intent) => {
      const session = sessions.get(intent.viewId as ViewId);
      const applied = session?.placePointer(intent) ?? false;
      if (process.env.XI_UI_TEST_MARKERS === '1') {
        const state = session?.readView(intent.viewId as ViewId);
        process.stderr.write(`XI_POINTER_STATE ${JSON.stringify({ kind: intent.kind, applied, viewId: intent.viewId, row: intent.head.row, column: intent.head.column, target: intent.head.target, mode: state?.session.mode, selectionCount: state?.selections.members.length, selectionKinds: state?.selections.members.map((member) => member.kind) })}\r\n`);
      }
    },
    scroll: (viewId, delta) => {
      const view = workbench.views().find((candidate) => String(candidate.viewId) === viewId);
      if (view !== undefined) workbench.setViewScroll(view.viewId, Math.max(0, view.scrollTop + delta), view.scrollLeft);
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_POINTER_SCROLL ${JSON.stringify({ viewId, delta })}\r\n`);
    },
  });

  let fileIndexStartTimer: ReturnType<typeof setTimeout> | undefined;
  const runWorkbench = runOpenTuiWorkbench(workbench, filePath?.label ?? '[No Name]', {
    renderer,
    subscribeSurfaceChanges: (listener) => {
      surfaceChangeListeners.add(listener);
      return { dispose: () => { surfaceChangeListeners.delete(listener); } };
    },
    onPointer: (event: WorkbenchPointerEvent) => {
      if (event.control !== undefined) return handleWorkbenchControl(event);
      return pointerCapture.dispatch({
        ...event,
        cell: { ...event.cell, ...(event.target === undefined ? {} : { target: event.target }) },
      } as PointerEvent);
    },
    onPointerCancel: (reason) => {
      if (reason === 'resize') pointerCapture.cancel('resize');
      else if (reason === 'dispose') pointerCapture.dispose();
      else if (reason === 'suspend') pointerCapture.cancel('focus-loss');
      else pointerCapture.cancel('escape');
      cancelSplitterDrag();
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_POINTER_CANCEL ${JSON.stringify({ reason })}\r\n`);
    },
    onFrame: () => {
      if (process.env.XI_PERF_TRACE === '1') process.stderr.write(`XI_FRAME ${process.hrtime.bigint().toString()}\r\n`);
    },
    prefixHelp,
    commandLine: {
      read: commandLineRead,
      isOpen: () => activeSession()?.commandLineActive === true,
      onKeypress: handleCommandLineKeypress,
    },
    onReady: () => {
      startupTrace('ready-callback');
      // Directory enumeration, watching and picker indexing are background
      // work. Starting them before the first frame makes the editor compete
      // with filesystem streams during the user's first interaction.
      fileIndexStartTimer = setTimeout(() => {
        void startFileIndexPopulation();
      }, 1000);
    },
    onKeypress: (event) => {
      // Preserve focus and queued keys while the first panel's services load.
      if (explorerOpen && explorerTree === undefined) return initializeOptionalServices().then(async () => { await handleExplorerKeypress(event); return true; });
      if (searchOpen && searchService === undefined) return initializeOptionalServices().then(async () => { await handleSearchKeypress(event); return true; });
      const activeCommandSession = activeSession();
      if (activeCommandSession?.commandLineActive === true) return activeCommandSession.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
      if (isCompletionTrigger(event, workbench)) return openCompletion();
      if (isSignatureTrigger(event, workbench)) return openSignature();
      if (snippetSession !== undefined) return handleSnippetKeypress(event);
      if (isNormalSpace(event, workbench)) {
        leaderPending = true;
        leaderPanelPending = false;
        scheduleLeaderHelp();
        return true;
      }
      if (leaderPending) return handleLeaderKeypress(event);
      const active = workbench.activeViewId === undefined ? undefined : sessions.get(workbench.activeViewId);
      if (active === undefined) return false;
      return active.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
    },
    picker: {
      read: pickerModel,
      isOpen: () => pickerOpen,
      onKeypress: handlePickerKeypress,
    },
    get explorer() {
      return explorerTree === undefined ? undefined : {
        read: explorerTree,
        isOpen: () => explorerOpen,
        onKeypress: handleExplorerKeypress,
      };
    },
    get search() {
      return searchService === undefined ? undefined : {
        read: searchService,
        isOpen: () => searchOpen,
        selectedId: () => searchService?.model.matches[searchSelectedIndex]?.id,
        onKeypress: handleSearchKeypress,
      };
    },
    problems: {
      read: diagnostics,
      isOpen: () => problemsOpen,
      onKeypress: handleProblemsKeypress,
    },
    outline: {
      read: outlineRead,
      isOpen: () => outlineOpen,
      onKeypress: handleOutlineKeypress,
    },
    hover: {
      read: hoverRead,
      isOpen: () => hoverOpen,
      onKeypress: handleHoverKeypress,
    },
    completion: {
      read: completionRead,
      isOpen: () => completionOpen,
      onKeypress: handleCompletionKeypress,
    },
    signature: {
      read: signatureRead,
      isOpen: () => signatureOpen,
      onKeypress: handleSignatureKeypress,
    },
  } as Parameters<typeof runOpenTuiWorkbench>[2]);
  startupTrace('renderer-call');
  await runWorkbench;
  clearTimeout(fileIndexStartTimer);
  await optionalServicesInitialization;
  controlRegistry.dispose();
  splitterDrag.dispose();

  function handleWorkbenchControl(event: WorkbenchPointerEvent): boolean {
    const control = event.control;
    if (control?.kind === 'splitter') {
      const nodeId = control.id.startsWith('splitter:') ? control.id.slice('splitter:'.length) : '';
      if (nodeId.length === 0 || control.firstSize === undefined || control.secondSize === undefined || control.availableCells === undefined) return true;
      if (control.action === 'begin' && event.button === 0) {
        if (splitterDrag.begin({ firstSize: control.firstSize, secondSize: control.secondSize })) {
          activeSplitter = { nodeId, availableCells: control.availableCells };
          if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_SPLITTER ${JSON.stringify({ action: 'begin', nodeId, firstSize: control.firstSize, secondSize: control.secondSize })}\r\n`);
        }
        return true;
      }
      if (activeSplitter?.nodeId !== nodeId || activeSplitter.availableCells !== control.availableCells) return true;
      if (control.action === 'move') {
        if (splitterDrag.move(control.firstSize, control.secondSize)) {
          const resized = workbench.resizeSplit(nodeId, control.firstSize / control.availableCells, control.availableCells);
          if (!resized.ok) splitterDrag.cancel();
          if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_SPLITTER ${JSON.stringify({ action: 'move', nodeId, firstSize: control.firstSize, secondSize: control.secondSize, resized: resized.ok })}\r\n`);
        }
        return true;
      }
      if (control.action === 'commit') {
        const committed = splitterDrag.commit();
        activeSplitter = undefined;
        if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_SPLITTER ${JSON.stringify({ action: 'commit', nodeId, committed: committed !== undefined })}\r\n`);
        return true;
      }
      return true;
    }
    if (event.phase === 'down' && event.button === 0) {
      const activated = controlRegistry.activate(control?.id ?? '');
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_CONTROL ${JSON.stringify({ id: control?.id, action: control?.action, activated })}\r\n`);
      return activated;
    }
    return event.phase === 'up' || event.phase === 'move';
  }

  function cancelSplitterDrag(): void {
    const capture = activeSplitter;
    if (capture === undefined) return;
    const initial = splitterDrag.cancel();
    activeSplitter = undefined;
    if (initial !== undefined) {
      workbench.resizeSplit(capture.nodeId, initial.firstSize / capture.availableCells, capture.availableCells);
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_SPLITTER ${JSON.stringify({ action: 'cancel', nodeId: capture.nodeId, firstSize: initial.firstSize, secondSize: initial.secondSize })}\r\n`);
    }
  }

  async function handleLeaderKeypress(event: LauncherKeyEvent): Promise<boolean> {
    prefixHelp.cancel();
    prefixGeneration += 1;
    if (!leaderPanelPending && event.name.toLowerCase() === 'v') {
      leaderPanelPending = true;
      return true;
    }
    const panelPrefix = leaderPanelPending;
    leaderPending = false;
    leaderPanelPending = false;
    if (panelPrefix && event.name.toLowerCase() === 'f') {
      if (pickerOpen) await closePicker(true);
      if (searchOpen) closeSearch();
      openExplorer();
      return true;
    }
    if (panelPrefix && event.name.toLowerCase() === 's') {
      if (pickerOpen) await closePicker(true);
      if (explorerOpen) closeExplorer();
      openSearch();
      return true;
    }
    if (panelPrefix && event.name.toLowerCase() === 'p') {
      if (pickerOpen) await closePicker(true);
      if (explorerOpen) closeExplorer();
      if (searchOpen) closeSearch();
      openProblems();
      return true;
    }
    if (panelPrefix && event.name.toLowerCase() === 'o') {
      if (pickerOpen) await closePicker(true);
      if (explorerOpen) closeExplorer();
      if (searchOpen) closeSearch();
      openOutline();
      return true;
    }
    if (!panelPrefix && event.name.toLowerCase() === 'k') {
      if (pickerOpen) await closePicker(true);
      if (explorerOpen) closeExplorer();
      if (searchOpen) closeSearch();
      openHover();
      return true;
    }
    if (!panelPrefix && event.name.toLowerCase() === 'a') return requestCodeActions();
    if (!panelPrefix && (event.name.toLowerCase() === 'd' || event.name.toLowerCase() === 'e')) {
      if (pickerOpen) await closePicker(true);
      if (explorerOpen) closeExplorer();
      if (searchOpen) closeSearch();
      openProblems();
      return true;
    }
    if (!panelPrefix && event.name === '/') {
      if (pickerOpen) await closePicker(true);
      if (explorerOpen) closeExplorer();
      openSearch();
      return true;
    }
    if (!panelPrefix && event.name.toLowerCase() === 'r') {
      if (!searchOpen) openSearch();
      replaceInputActive = true;
      replaceInput = '';
      return true;
    }
    const mode = pickerModeForLeader(event);
    if (mode !== undefined) {
      if (explorerOpen) closeExplorer();
      if (searchOpen) closeSearch();
      openPicker(mode);
      return true;
    }
    const activeBeforeLeader = activeSession();
    if (activeBeforeLeader !== undefined) await activeBeforeLeader.handleKey(keyEvent(' ', event));
    return true;
  }

  function schedulePrefixHelp(viewId: ViewId, pendingKeys: readonly string[], parserContinuations: VimPrefixHelpState['parserContinuations']): void {
    prefixGeneration += 1;
    prefixHelp.schedule({
      targetId: String(viewId),
      pendingKeys: Object.freeze([...pendingKeys]),
      parserContinuations: Object.freeze([...parserContinuations]),
      configGeneration: prefixGeneration,
    });
  }

  function scheduleLeaderHelp(): void {
    const targetViewId = workbench.activeViewId ?? id<ViewId>('xi-launch-view');
    schedulePrefixHelp(targetViewId, ['<Space>'], [{ kind: 'keys', keys: ['v', 'f', 'b', 's', 'p', 'o', 'k', 'a', 'd', 'e', '/', 'r'], label: 'Leader workbench command' }]);
  }

  async function handleCommandLineKeypress(event: LauncherKeyEvent): Promise<boolean | 'quit'> {
    const active = activeSession();
    const line = exCommandLineSession;
    if (active === undefined || line === undefined) return false;
    const input = toExCommandLineInput(event);
    if (input === undefined) return true;
    const result = line.handleInput(input);
    if (result.kind === 'cancel') {
      await active.handleKey(event);
      return true;
    }
    if (result.kind === 'execute' || result.kind === 'error') {
      return active.submitCommandLine(result.source);
    }
    active.setCommandLineSource(result.source, result.cursorOffset);
    return true;
  }

  pickerModel.dispose();
  fileIndex.dispose();
  explorerSubscription?.dispose();
  searchSubscription?.dispose();
  completionSubscription?.dispose();
  signatureSubscription?.dispose();
  searchService?.dispose();
  replaceService?.dispose();
  formatterPipeline?.dispose();
  await languageSession?.dispose();
  hostNavigation?.dispose();
  navigationController?.dispose();
  navigationSubscription?.dispose();
  completionController?.dispose();
  signatureController?.dispose();
  workspaceEditCoordinator?.dispose();
  diagnostics.dispose();
  explorerController?.dispose();
  explorerTree?.dispose();
  explorerCancellation.dispose();
  await contributionRegistry.dispose();
  commandRegistry.dispose();
  finishSnippet();
  prefixHelp.dispose();
  exCommandLineSession?.dispose();
  pointerCapture.dispose();

  function activeSession(): ReturnType<typeof createOwnedVimSession> | undefined {
    return workbench.activeViewId === undefined ? undefined : sessions.get(workbench.activeViewId);
  }

  function openPicker(mode: PickerMode): void {
    if (searchOpen) closeSearch();
    pickerMode = mode;
    pickerQuery = '';
    pickerOpen = true;
    if (mode === 'file') void startFileIndexPopulation();
    queryPicker();
  }

  function openExplorer(): void {
    if (searchOpen) closeSearch();
    explorerOpen = true;
    if (explorerTree === undefined) {
      void initializeOptionalServices().then(() => { if (explorerOpen) openExplorer(); });
      return;
    }
    explorerFiltering = false;
    explorerPendingG = false;
    explorerOpenGeneration = explorerTree.model.generation;
    explorerTree.focus();
    const root = explorerTree.model.roots[0];
    if (root !== undefined) {
      void explorerTree.expand(root, false, explorerCancellation.token);
      void explorerTree.watchRoot('workspace', explorerCancellation.token);
    }
    const activeViewId = workbench.activeViewId;
    const activeView = activeViewId === undefined ? undefined : workbench.views().find((view) => view.viewId === activeViewId);
    const activeBuffer = activeView === undefined ? undefined : workbench.buffer(activeView.bufferId);
    const activeRelativePath = activeBuffer === undefined ? undefined : filesystem.workspaceRelativePath(workspaceRoot, activeBuffer.path);
    if (activeRelativePath !== undefined) void explorerTree.reveal('workspace', activeRelativePath, explorerCancellation.token);
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_EXPLORER_OPEN ${JSON.stringify({ selectedId: explorerTree.model.selectedId })}\r\n`);
  }

  function closeExplorer(): void {
    explorerOpen = false;
    explorerFiltering = false;
    explorerPendingG = false;
    explorerTree?.blur();
  }

  function openSearch(): void {
    searchOpen = true;
    searchSelectedIndex = 0;
    if (searchService === undefined) {
      void initializeOptionalServices().then(() => { if (searchOpen) openSearch(); });
      return;
    }
    searchOpenGeneration = searchService.model.generation;
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_SEARCH_OPEN ${JSON.stringify({ rootId: 'workspace' })}\r\n`);
    querySearch();
  }

  function openProblems(): void {
    if (searchOpen) closeSearch();
    outlineOpen = false;
    hoverOpen = false;
    problemsOpen = true;
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_PROBLEMS_OPEN ${JSON.stringify({ count: diagnostics.model.all.length })}\r\n`);
  }

  function openOutline(): void {
    problemsOpen = false;
    hoverOpen = false;
    outlineOpen = true;
    if (navigationController === undefined) {
      if (languageId !== undefined && filePath?.path !== undefined) void ensureLanguage().then(() => { if (outlineOpen) requestOutline(); });
    } else requestOutline();
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_OUTLINE_OPEN {"state":"loading"}\r\n');
  }

  function requestOutline(): void {
    const request = currentNavigationRequest();
    const controller = navigationController;
    const session = languageSession;
    if (controller === undefined || request === undefined || session === undefined) return;
    void session.waitForReady().then((ready) => {
      if (outlineOpen && ready.ok === true) void controller.loadOutline(request);
    });
  }

  function closeOutline(): void {
    outlineOpen = false;
    navigationController?.returnToOrigin();
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_OUTLINE_CLOSED\r\n');
  }

  function openHover(): void {
    outlineOpen = false;
    problemsOpen = false;
    hoverOpen = true;
    if (navigationController === undefined) {
      if (languageId !== undefined && filePath?.path !== undefined) void ensureLanguage().then(() => { if (hoverOpen) requestHover(); });
    } else requestHover();
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_HOVER_OPEN ${JSON.stringify({ state: 'loading' })}\r\n`);
  }

  function requestHover(): void {
    const request = currentNavigationRequest();
    const controller = navigationController;
    const session = languageSession;
    if (controller === undefined || request === undefined || session === undefined) return;
    void session.waitForReady().then((ready) => {
      if (hoverOpen && ready.ok === true) void controller.requestHover(request);
    });
  }

  function openCompletion(trigger: 'invoked' | 'retrigger' = 'invoked'): boolean {
    const request = currentCompletionRequest(trigger);
    const controller = completionController;
    const provider = completionProvider;
    if (request === undefined || controller === undefined || provider === undefined || languageSession === undefined) {
      if (request !== undefined && languageId !== undefined && filePath?.path !== undefined) {
        completionOpen = true;
        void Promise.all([initializeOptionalServices(), ensureLanguage()]).then(() => { if (completionOpen) openCompletion(trigger); });
        return true;
      }
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_COMPLETION_STATE {"state":"unavailable","items":0}\r\n');
      return true;
    }
    signatureOpen = false;
    completionOpen = true;
    completionSerial = controller.begin(request);
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_COMPLETION_OPEN ${JSON.stringify({ version: request.documentVersion, selectionGeneration: request.selectionGeneration })}\r\n`);
    void (async () => {
      const ready = await languageSession.waitForReady();
      if (!completionOpen || ready.ok === false || completionSerial === 0) {
        if (completionOpen && ready.ok === false) controller.fail(completionSerial, request, { kind: 'unavailable', message: ready.error.message });
        return;
      }
      const result = await provider.complete(request);
      if (!completionOpen) return;
      if (result.ok) controller.publish(completionSerial, request, result.value);
      else controller.fail(completionSerial, request, result.error);
    })();
    return true;
  }

  function openSignature(): boolean {
    const request = currentSignatureRequest();
    const controller = signatureController;
    if (request === undefined) return true;
    if (controller === undefined || languageSession === undefined) {
      if (languageId !== undefined && filePath?.path !== undefined) {
        signatureOpen = true;
        void ensureLanguage().then(() => { if (signatureOpen) openSignature(); });
      }
      return true;
    }
    completionOpen = false;
    signatureOpen = true;
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_SIGNATURE_OPEN\r\n');
    void (async () => {
      const ready = await languageSession.waitForReady();
      if (!signatureOpen || ready.ok === false) return;
      await controller.request(request);
    })();
    return true;
  }

  async function handleCompletionKeypress(event: LauncherKeyEvent): Promise<boolean> {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\u001b') { closeCompletion(); return true; }
    if (event.ctrl && key === 'e') { closeCompletion(); return true; }
    if (event.ctrl && (key === 'n' || key === 'p')) {
      const direction = key === 'n' ? 1 : -1;
      completionController?.move(direction);
      void resolveSelectedCompletion();
      return true;
    }
    if (event.ctrl && (key === 'd' || key === 'u')) {
      completionController?.scrollDocumentation(key === 'd' ? 1 : -1);
      return true;
    }
    if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1) {
      const controller = completionController;
      const request = controller?.model.request;
      const selected = controller?.model.selectedId === undefined ? undefined : controller.model.items.find((item) => item.id === controller?.model.selectedId);
      if (controller !== undefined && request !== undefined && selected?.commitCharacters?.includes(event.raw) === true) {
        const accepted = controller.accept('tab');
        closeCompletion(false);
        if (accepted.ok && accepted.value.kind === 'insert') await applyCompletion(request, accepted.value.item, accepted.value.edits, false);
        const active = activeSession();
        if (active !== undefined) await active.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
        return true;
      }
    }
    if (key === 'tab' || key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const controller = completionController;
      const request = controller?.model.request;
      if (controller === undefined || request === undefined) { closeCompletion(); return true; }
      const accepted = controller.accept(key === 'tab' ? 'tab' : 'enter');
      if (!accepted.ok) { process.stderr.write(`xi: completion acceptance failed: ${accepted.error.message}\n`); closeCompletion(); return true; }
      closeCompletion(false);
      if (accepted.value.kind === 'newline') {
        const active = activeSession();
        if (active !== undefined) await active.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
      } else if (accepted.value.kind === 'insert') {
        await applyCompletion(request, accepted.value.item, accepted.value.edits, event.shift);
      }
      return true;
    }
    const active = activeSession();
    const retrigger = completionController?.model.isIncomplete === true && !event.ctrl && !event.meta && !event.option && event.raw.length === 1;
    closeCompletion();
    if (active !== undefined) await active.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
    const activeView = workbench.activeViewId === undefined ? undefined : workbench.readView(workbench.activeViewId);
    if (retrigger && active !== undefined && isInsertMode(activeView?.session.mode)) openCompletion('retrigger');
    return true;
  }

  async function resolveSelectedCompletion(): Promise<void> {
    const controller = completionController;
    const provider = completionProvider;
    const request = controller?.model.request;
    const item = controller?.model.selectedId === undefined ? undefined : controller.model.items.find((candidate) => candidate.id === controller?.model.selectedId);
    if (controller === undefined || provider === undefined || request === undefined || item === undefined || provider.resolve === undefined) return;
    const resolved = await provider.resolve(item);
    if (resolved.ok) controller.publishResolved(request, resolved.value);
  }

  async function applyCompletion(request: import('../../../packages/services/src/entrypoints/language').CompletionRequest, item: import('../../../packages/services/src/entrypoints/language').CompletionItem, edits: readonly import('../../../packages/services/src/entrypoints/language').CompletionTextEdit[], primaryOnly: boolean): Promise<void> {
    const expand = expandSnippet;
    const Snippet = SnippetSession;
    if (expand === undefined || Snippet === undefined) {
      await initializeOptionalServices();
      if (expandSnippet === undefined || SnippetSession === undefined) return;
    }
    const activeViewId = workbench.activeViewId;
    const view = activeViewId === undefined ? undefined : workbench.readView(activeViewId);
    const current = currentCompletionRequest();
    const document = view === undefined ? undefined : documents.get(view.document.id);
    if (activeViewId === undefined || view === undefined || document === undefined || current === undefined || !sameCompletionRequest(request, current)) {
      process.stderr.write('xi: completion result is stale\n');
      return;
    }
    const plan = planCompletionEdits(document.snapshot(), view.selections, request, item, edits, positionToOffset, expand ?? expandSnippet!, primaryOnly);
    if (!plan.ok) {
      process.stderr.write(`xi: completion ${plan.error}\n`);
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_COMPLETION_REJECTED ${JSON.stringify({ reason: plan.error, primaryOnly })}\r\n`);
      return;
    }
    const proposalEdits = plan.value.proposalEdits;
    const group = asUndoGroupId(`xi-completion-${completionOperationNumber += 1}`);
    if (!group.ok) { process.stderr.write('xi: completion undo group is invalid\n'); return; }
    const vim = activeSession();
    if (vim !== undefined && !vim.closeInsertUndoGroup()) {
      process.stderr.write('xi: completion could not close the active Vim insert group\n');
      return;
    }
    finishSnippet();
    const openedGroup = workbench.beginUndoGroup(activeViewId, group.value, 'lsp');
    if (!openedGroup.ok) {
      process.stderr.write(`xi: completion undo group could not open: ${openedGroup.error.kind}\n`);
      return;
    }
    snippetApplying = true;
    const applied = await workbench.applyTextEdits(activeViewId, proposalEdits, group.value, 'lsp', true);
    snippetApplying = false;
    if (!applied.ok) {
      process.stderr.write(`xi: completion edit failed: ${applied.error.kind}\n`);
      void workbench.endUndoGroup(activeViewId, group.value);
      return;
    }
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_COMPLETION_APPLIED ${JSON.stringify({ version: applied.value.version, edits: proposalEdits.length, members: plan.value.memberEdits.size, selectionCount: view.selections.members.length, primaryOnly })}\r\n`);
    if (plan.value.snippetExpansion !== undefined && plan.value.snippetExpansion.tabstops.length > 0 && plan.value.memberEdits.size > 0) {
      const active = plan.value.snippetExpansion.tabstops.find((tabstop) => tabstop.mirror !== true);
      const session = activeSession();
      if (active !== undefined && session !== undefined) {
        const entries = new Map<string, ActiveSnippetMember>();
        const cursorOffsets = new Map<string, number>();
        for (const [memberId, memberEdit] of plan.value.memberEdits) {
          const base = mapPointThroughEdits(Number(memberEdit.start), proposalEdits.filter((edit) => edit !== memberEdit));
          const memberSession = new (Snippet ?? SnippetSession!)(plan.value.snippetExpansion, Number(view.selections.selectionGeneration));
          entries.set(memberId, { memberId, session: memberSession, baseOffset: base });
          cursorOffsets.set(memberId, base + active.start);
        }
        if (session.setInsertCursors(cursorOffsets)) {
          const afterView = workbench.readView(activeViewId);
          const generation = afterView === undefined ? undefined : Number(afterView.session.selections.selectionGeneration);
          if (generation !== undefined) {
            snippetMembers = entries;
            snippetSession = entries.get(String(view.selections.primaryId))?.session ?? entries.values().next().value?.session;
            snippetViewId = activeViewId;
            snippetUndoGroup = group.value;
            for (const entry of entries.values()) entry.session.reanchor(generation);
            if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_SNIPPET_MULTI_OPEN ${JSON.stringify({ members: entries.size, primaryOnly, generation })}\r\n`);
          } else {
            for (const entry of entries.values()) entry.session.dispose();
          }
        } else {
          for (const entry of entries.values()) entry.session.dispose();
        }
      }
    }
    if (snippetSession === undefined) void workbench.endUndoGroup(activeViewId, group.value);
  }

  async function handleSnippetKeypress(event: LauncherKeyEvent): Promise<boolean | 'quit'> {
    const viewId = snippetViewId;
    const activeView = viewId === undefined ? undefined : workbench.readView(viewId);
    const vim = activeSession();
    const members = snippetMembers;
    if (snippetSession === undefined || members.size === 0 || viewId === undefined || activeView === undefined || vim === undefined || workbench.activeViewId !== viewId) {
      finishSnippet();
      return vim === undefined ? false : vim.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
    }
    const generation = Number(activeView.session.selections.selectionGeneration);
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\u001b') {
      finishSnippet();
      return vim.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
    }
    if (key === 'tab' || event.raw === '\t') {
      const moved = new Map<string, import('../../../packages/services/src/entrypoints/language').SnippetTabstop>();
      for (const [memberId, entry] of members) {
        const result = event.shift ? entry.session.previous(generation) : entry.session.next(generation);
        if (!result.ok) return cancelSnippetAndForward(vim, event);
        if (result.value !== undefined) moved.set(memberId, result.value);
      }
      if (moved.size === 0) {
        finishSnippet();
        return true;
      }
      const cursorOffsets = new Map<string, number>();
      for (const [memberId, field] of moved) {
        const entry = members.get(memberId);
        if (entry === undefined) return cancelSnippetAndForward(vim, event);
        cursorOffsets.set(memberId, entry.baseOffset + field.start);
      }
      if (!vim.setInsertCursors(cursorOffsets)) return cancelSnippetAndForward(vim, event);
      const nextView = workbench.readView(viewId);
      const nextGeneration = nextView === undefined ? undefined : Number(nextView.session.selections.selectionGeneration);
      if (nextGeneration === undefined) return cancelSnippetAndForward(vim, event);
      for (const entry of members.values()) if (!entry.session.reanchor(nextGeneration).ok) return cancelSnippetAndForward(vim, event);
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_SNIPPET_MULTI_TAB ${JSON.stringify({ members: moved.size, direction: event.shift ? 'previous' : 'next' })}\r\n`);
      return true;
    }
    const fields = new Map<string, import('../../../packages/services/src/entrypoints/language').SnippetEdit[]>();
    if (event.ctrl || event.meta || event.option || event.raw.length !== 1 || event.raw === '\r' || event.raw === '\n') {
      finishSnippet();
      return vim.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
    }
    const documentEdits: DocumentEdit[] = [];
    for (const [memberId, entry] of members) {
      const planned = entry.session.replaceActive(event.raw, generation);
      if (!planned.ok) return cancelSnippetAndForward(vim, event);
      const translated: import('../../../packages/services/src/entrypoints/language').SnippetEdit[] = [];
      for (const edit of planned.value) {
        const start = asUtf16Offset(entry.baseOffset + edit.start);
        const end = asUtf16Offset(entry.baseOffset + edit.end);
        if (!start.ok || !end.ok) return cancelSnippetAndForward(vim, event);
        const translatedEdit = { start: start.value, end: end.value, text: edit.text } satisfies DocumentEdit;
        translated.push({ start: Number(translatedEdit.start), end: Number(translatedEdit.end), text: translatedEdit.text });
        documentEdits.push(translatedEdit);
      }
      fields.set(memberId, translated);
    }
    if (!nonOverlappingDocumentEdits(documentEdits)) return cancelSnippetAndForward(vim, event);
    const group = snippetUndoGroup === undefined ? asUndoGroupId(`xi-snippet-${completionOperationNumber += 1}`) : { ok: true as const, value: snippetUndoGroup };
    if (!group.ok) return cancelSnippetAndForward(vim, event);
    snippetApplying = true;
    const applied = await workbench.applyTextEdits(viewId, documentEdits, group.value, 'lsp', true);
    snippetApplying = false;
    if (!applied.ok) return cancelSnippetAndForward(vim, event);
    const cursorOffsets = new Map<string, number>();
    for (const [memberId, entry] of members) {
      const own = fields.get(memberId) ?? [];
      const external = documentEdits.filter((edit) => !own.some((candidate) => candidate.start === edit.start && candidate.end === edit.end && candidate.text === edit.text));
      const oldBase = entry.baseOffset;
      entry.baseOffset = mapPointThroughEdits(oldBase, external);
      const afterBase = external.filter((edit) => edit.start >= oldBase);
      if (afterBase.length > 0) {
        const relative = afterBase.map((edit) => ({ start: edit.start - oldBase, end: edit.end - oldBase, text: edit.text }));
        if (!entry.session.mapExternalEdits(relative, generation).ok) return cancelSnippetAndForward(vim, event);
      }
      const field = entry.session.active;
      if (field !== undefined) cursorOffsets.set(memberId, entry.baseOffset + field.end);
    }
    if (!vim.setInsertCursors(cursorOffsets)) return cancelSnippetAndForward(vim, event);
    const nextView = workbench.readView(viewId);
    const nextGeneration = nextView === undefined ? undefined : Number(nextView.session.selections.selectionGeneration);
    if (nextGeneration === undefined) return cancelSnippetAndForward(vim, event);
    for (const entry of members.values()) if (!entry.session.reanchor(nextGeneration).ok) return cancelSnippetAndForward(vim, event);
    return true;
  }

  function cancelSnippetAndForward(vim: ReturnType<typeof createOwnedVimSession>, event: LauncherKeyEvent): Promise<boolean | 'quit'> {
    finishSnippet();
    return Promise.resolve(vim.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta }));
  }

  function finishSnippet(): void {
    const viewId = snippetViewId;
    const undoGroup = snippetUndoGroup;
    if (viewId !== undefined && undoGroup !== undefined) void workbench.endUndoGroup(viewId, undoGroup);
    for (const entry of snippetMembers.values()) entry.session.dispose();
    snippetMembers = new Map();
    snippetSession = undefined;
    snippetViewId = undefined;
    snippetUndoGroup = undefined;
  }

  function closeCompletion(cancel = true): void {
    completionOpen = false;
    if (cancel) completionController?.cancel();
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_COMPLETION_CLOSED\r\n');
  }

  async function handleSignatureKeypress(event: LauncherKeyEvent): Promise<boolean> {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\u001b') { signatureOpen = false; signatureController?.cancel(); if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_SIGNATURE_CLOSED\r\n'); return true; }
    signatureOpen = false;
    signatureController?.cancel();
    const active = activeSession();
    if (active !== undefined) await active.handleKey({ name: event.name, raw: event.raw, shift: event.shift, option: event.option, ctrl: event.ctrl, meta: event.meta });
    return true;
  }

  function currentCompletionRequest(trigger: 'invoked' | 'retrigger' = 'invoked'): import('../../../packages/services/src/entrypoints/language').CompletionRequest | undefined {
    const request = currentNavigationRequest();
    return request === undefined ? undefined : { ...request, trigger };
  }

  function currentSignatureRequest(): import('../../../packages/services/src/entrypoints/language').SignatureRequest | undefined {
    const request = currentNavigationRequest();
    return request === undefined ? undefined : { documentId: request.documentId, documentVersion: request.documentVersion, selectionGeneration: request.selectionGeneration, position: request.position, ...(request.uri === undefined ? {} : { uri: request.uri }) };
  }

  async function resolveWorkspaceEditDocument(uri: string): Promise<import('../../../packages/services/src/entrypoints/language').WorkspaceEditDocument | undefined> {
    const path = workspaceRelativePathFromUri(uri);
    if (path === undefined) return undefined;
    const openBuffer = workbench.buffers().find((buffer) => fileUri(buffer.path) === uri);
    const openDocument = openBuffer === undefined ? undefined : documents.get(openBuffer.documentId);
    if (openBuffer !== undefined && openDocument !== undefined) {
      const snapshot = openDocument.snapshot();
      return { target: { uri, version: snapshot.version, textLength: snapshot.lengthUtf16 }, offset: (position) => workspaceOffset(snapshot, position) };
    }
    const loaded = await readWorkspaceEditFile(path);
    if (loaded === undefined) return undefined;
    const snapshot = loaded.document.snapshot();
    return { target: { uri, version: 0, textLength: snapshot.lengthUtf16, contentHash: textHash(loaded.bytes) }, offset: (position) => workspaceOffset(snapshot, position) };
  }

  function workspaceRelativePathFromUri(uri: string): string | undefined {
    const absolute = workspacePathFromUri(uri);
    return absolute === undefined ? undefined : filesystem.workspaceRelativePath(workspaceRoot, absolute);
  }

  async function readWorkspaceEditFile(path: string): Promise<{ readonly bytes: Uint8Array; readonly document: TextFileDocument } | undefined> {
    const absolute = filesystem.workspaceAbsolutePath(workspaceRoot, path);
    if (absolute === undefined) return undefined;
    const cancellation = new CancellationSource();
    try {
      const read = await filesystem.readFile(absolute, cancellation.token);
      if (!read.ok) return undefined;
      const opened = openTextDocument(nextDocumentId(), read.value);
      return opened.kind === 'editable' ? { bytes: read.value, document: opened.document } : undefined;
    } finally { cancellation.dispose(); }
  }

  function workspaceOffset(snapshot: DocumentSnapshot, position: import('../../../packages/services/src/entrypoints/language').WorkspaceEditPosition): Result<number, import('../../../packages/services/src/entrypoints/language').WorkspaceEditProviderFailure> {
    const line = asLineIndex(position.line);
    const column = asUtf16Column(position.utf16);
    if (!line.ok || !column.ok) return { ok: false, error: { kind: 'invalid', message: 'workspace edit position is invalid' } };
    const offsetResult = positionToOffset(snapshot, { version: snapshot.version, line: line.value, encoding: 'utf-16', character: column.value });
    return offsetResult.ok ? { ok: true, value: offsetResult.value as number } : { ok: false, error: { kind: 'invalid', message: `workspace edit position is invalid: ${offsetResult.error.kind}` } };
  }

  type WorkspaceResource = import('../../../packages/services/src/entrypoints/language').WorkspaceResourceOperation;
  type WorkspaceEditFailure = import('../../../packages/services/src/entrypoints/language').WorkspaceEditFailure;
  type WorkspacePathState =
    | { readonly kind: 'missing' }
    | { readonly kind: 'present'; readonly info: import('../../../packages/contracts/src/index').FileInfo }
    | { readonly kind: 'error'; readonly message: string };
  interface WorkspaceResourcePlanItem {
    readonly resource: WorkspaceResource;
    readonly sourcePath: string;
    readonly sourceState: WorkspacePathState;
    readonly destinationPath?: string;
    readonly destinationState?: WorkspacePathState;
    readonly skip: boolean;
  }

  function createWorkspaceEditPort(): import('../../../packages/services/src/entrypoints/language').WorkspaceEditPort {
    return {
      preflight: async (targets, resources) => {
        const targetCheck = await verifyWorkspaceEditTargets(targets);
        if (!targetCheck.ok) return targetCheck;
        return verifyWorkspaceResources(resources);
      },
      apply: async (edits, resources, targets = []) => {
        const targetCheck = await verifyWorkspaceEditTargets(targets);
        if (!targetCheck.ok) return targetCheck;
        const resourcePlan = await planWorkspaceResources(resources);
        if (!resourcePlan.ok) return resourcePlan;
        const byUri = new Map<string, import('../../../packages/services/src/entrypoints/language').WorkspaceTextEdit[]>();
        for (const edit of edits) (byUri.get(edit.uri) ?? (byUri.set(edit.uri, []), byUri.get(edit.uri)!)).push(edit);
        for (const [uri, uriEdits] of byUri) {
          const applied = await applyWorkspaceDocumentEdits(uri, uriEdits);
          if (!applied.ok) return applied;
        }
        return applyWorkspaceResources(resourcePlan.value);
      },
    };
  }

  async function verifyWorkspaceEditTargets(targets: readonly import('../../../packages/services/src/entrypoints/language').WorkspaceEditTarget[]): Promise<Result<void, import('../../../packages/services/src/entrypoints/language').WorkspaceEditFailure>> {
    for (const target of targets) {
      const current = await resolveWorkspaceEditDocument(target.uri);
      if (current === undefined || current.target.version !== target.version || current.target.textLength !== target.textLength || target.contentHash !== undefined && current.target.contentHash !== target.contentHash) {
        return workspaceEditFailure('stale', `workspace edit target changed: ${target.uri}`, target.uri);
      }
    }
    return { ok: true, value: undefined };
  }

  async function verifyWorkspaceResources(resources: readonly WorkspaceResource[]): Promise<Result<void, WorkspaceEditFailure>> {
    const planned = await planWorkspaceResources(resources);
    return planned.ok ? { ok: true, value: undefined } : planned;
  }

  async function planWorkspaceResources(resources: readonly WorkspaceResource[]): Promise<Result<readonly WorkspaceResourcePlanItem[], WorkspaceEditFailure>> {
    const sourceUris = new Set<string>();
    const renameSources = new Set<string>();
    const resolved: Array<{ readonly resource: WorkspaceResource; readonly sourcePath: string; readonly sourceState: WorkspacePathState; readonly destinationPath?: string; readonly destinationState?: WorkspacePathState }> = [];
    const states = new Map<string, Promise<WorkspacePathState>>();
    const stateFor = (path: string): Promise<WorkspacePathState> => {
      const existing = states.get(path);
      if (existing !== undefined) return existing;
      const pending = statWorkspacePath(path);
      states.set(path, pending);
      return pending;
    };
    for (const resource of resources) {
      if (sourceUris.has(resource.uri)) return workspaceEditFailure('collision', `workspace resource source is duplicated: ${resource.uri}`, resource.uri);
      sourceUris.add(resource.uri);
      const source = workspaceRelativePathFromUri(resource.uri);
      if (source === undefined) return workspaceEditFailure('stale', `workspace resource is outside the workspace: ${resource.uri}`, resource.uri);
      const sourcePath = filesystem.workspaceAbsolutePath(workspaceRoot, source);
      if (sourcePath === undefined) return workspaceEditFailure('stale', `workspace resource path is invalid: ${source}`, resource.uri);
      const sourceState = await stateFor(sourcePath);
      if (sourceState.kind === 'error') return workspaceEditFailure('stale', `cannot inspect workspace resource ${source}: ${sourceState.message}`, resource.uri);
      if (resource.kind === 'rename') {
        const destination = workspaceRelativePathFromUri(resource.newUri ?? '');
        if (destination === undefined) return workspaceEditFailure('stale', `workspace rename destination is outside the workspace: ${resource.newUri ?? ''}`, resource.uri);
        const destinationPath = filesystem.workspaceAbsolutePath(workspaceRoot, destination);
        if (destinationPath === undefined || destinationPath === sourcePath) return workspaceEditFailure('collision', `workspace rename destination is invalid: ${destination}`, resource.uri);
        renameSources.add(sourcePath);
        resolved.push({ resource, sourcePath, sourceState, destinationPath, destinationState: await stateFor(destinationPath) });
      } else {
        resolved.push({ resource, sourcePath, sourceState });
      }
    }
    const destinations = new Set<string>();
    const plan: WorkspaceResourcePlanItem[] = [];
    for (const item of resolved) {
      const { resource, sourcePath, sourceState, destinationPath, destinationState } = item;
      if (resource.kind === 'create') {
        if (sourceState.kind === 'error') return workspaceEditFailure('stale', `cannot inspect workspace create target: ${sourceState.message}`, resource.uri);
        const skip = sourceState.kind === 'present' && resource.options?.ignoreIfExists === true;
        if (sourceState.kind === 'present' && !skip) return workspaceEditFailure('collision', `workspace create target exists: ${resource.uri}`, resource.uri);
        plan.push({ ...item, skip });
        continue;
      }
      if (sourceState.kind === 'missing') {
        if (resource.kind === 'delete' && resource.options?.ignoreIfNotExists === true) { plan.push({ ...item, skip: true }); continue; }
        return workspaceEditFailure('stale', `workspace resource is missing: ${resource.uri}`, resource.uri);
      }
      if (resource.kind === 'delete') {
        if (sourceState.kind !== 'present') return workspaceEditFailure('stale', `cannot inspect workspace delete target: ${sourceState.message}`, resource.uri);
        if (sourceState.info.kind === 'directory' && resource.options?.recursive !== true) return workspaceEditFailure('apply', `workspace directory delete requires recursive=true: ${resource.uri}`, resource.uri);
        plan.push({ ...item, skip: false });
        continue;
      }
      if (destinationPath === undefined || destinationState === undefined) return workspaceEditFailure('collision', `workspace rename destination is invalid: ${resource.newUri ?? ''}`, resource.uri);
      if (destinationState.kind === 'error') return workspaceEditFailure('stale', `cannot inspect workspace rename destination: ${destinationState.message}`, resource.uri);
      if (destinations.has(destinationPath)) return workspaceEditFailure('collision', `workspace rename destination collides: ${resource.newUri ?? ''}`, resource.uri);
      destinations.add(destinationPath);
      if (destinationState.kind === 'present' && !renameSources.has(destinationPath) && resource.options?.overwrite !== true) return workspaceEditFailure('collision', `workspace rename destination exists: ${resource.newUri ?? ''}`, resource.uri);
      plan.push({ ...item, skip: false });
    }
    return { ok: true, value: Object.freeze(plan) };
  }

  async function statWorkspacePath(path: string): Promise<WorkspacePathState> {
    const cancellation = new CancellationSource();
    try {
      const result = await filesystem.stat(path, cancellation.token);
      if (result.ok) return { kind: 'present', info: result.value };
      return result.error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', message: result.error.message };
    } finally { cancellation.dispose(); }
  }

  async function applyWorkspaceResources(plan: readonly WorkspaceResourcePlanItem[]): Promise<Result<void, WorkspaceEditFailure>> {
    const renamePlan = plan.filter((item) => item.resource.kind === 'rename' && !item.skip);
    const occupied = new Set<string>();
    const pending = new Map<string, WorkspaceResourcePlanItem>();
    for (const item of renamePlan) {
      occupied.add(item.sourcePath);
      if (item.destinationState?.kind === 'present') occupied.add(item.destinationPath as string);
      pending.set(item.sourcePath, item);
    }
    while (pending.size > 0) {
      let progressed = false;
      for (const [sourcePath, item] of pending) {
        const destinationPath = item.destinationPath as string;
        if (occupied.has(destinationPath)) continue;
        const moved = await renameWorkspacePath(sourcePath, destinationPath, item.resource.uri);
        if (!moved.ok) return moved;
        occupied.delete(sourcePath);
        occupied.add(destinationPath);
        pending.delete(sourcePath);
        await updateOpenBufferResourcePath(sourcePath, destinationPath);
        progressed = true;
        break;
      }
      if (progressed) continue;
      const first = pending.entries().next().value as [string, WorkspaceResourcePlanItem] | undefined;
      if (first === undefined) break;
      const [sourcePath, item] = first;
      const temporary = await workspaceRenameTemporaryPath(occupied);
      const moved = await renameWorkspacePath(sourcePath, temporary, item.resource.uri);
      if (!moved.ok) return moved;
      occupied.delete(sourcePath);
      occupied.add(temporary);
      pending.delete(sourcePath);
      pending.set(temporary, { ...item, sourcePath });
      await updateOpenBufferResourcePath(sourcePath, temporary);
    }
    for (const item of plan) {
      if (item.skip || item.resource.kind === 'rename') continue;
      const cancellation = new CancellationSource();
      try {
        const result = item.resource.kind === 'create'
          ? await filesystem.writeFileAtomic(item.sourcePath, new Uint8Array(), cancellation.token)
          : await filesystem.removePath(item.sourcePath, item.resource.options?.recursive === true, cancellation.token);
        if (!result.ok) return workspaceEditFailure('apply', result.error.message, item.resource.uri);
      } finally { cancellation.dispose(); }
    }
    return { ok: true, value: undefined };
  }

  async function renameWorkspacePath(sourcePath: string, destinationPath: string, uri: string): Promise<Result<void, WorkspaceEditFailure>> {
    const cancellation = new CancellationSource();
    try {
      const result = await filesystem.renamePath(sourcePath, destinationPath, cancellation.token);
      return result.ok ? { ok: true, value: undefined } : workspaceEditFailure('apply', result.error.message, uri);
    } finally { cancellation.dispose(); }
  }

  async function workspaceRenameTemporaryPath(occupied: ReadonlySet<string>): Promise<string> {
    while (true) {
      const relative = `.xi-workspace-edit-${process.pid}-${workspaceResourceOperationNumber += 1}`;
      const path = filesystem.workspaceAbsolutePath(workspaceRoot, relative);
      if (path !== undefined && !occupied.has(path) && (await statWorkspacePath(path)).kind === 'missing') return path;
    }
  }

  async function updateOpenBufferResourcePath(sourcePath: string, destinationPath: string): Promise<void> {
    const sourceBuffer = workbench.buffers().find((buffer) => fileUri(buffer.path) === fileUri(sourcePath));
    if (sourceBuffer !== undefined) workbench.renameBufferPath(sourceBuffer.bufferId, destinationPath);
  }

  async function applyWorkspaceDocumentEdits(uri: string, edits: readonly import('../../../packages/services/src/entrypoints/language').WorkspaceTextEdit[]): Promise<Result<void, import('../../../packages/services/src/entrypoints/language').WorkspaceEditFailure>> {
    const path = workspaceRelativePathFromUri(uri);
    if (path === undefined) return workspaceEditFailure('stale', `workspace edit is outside the workspace: ${uri}`, uri);
    const openBuffer = workbench.buffers().find((buffer) => fileUri(buffer.path) === uri);
    const openDocument = openBuffer === undefined ? undefined : documents.get(openBuffer.documentId);
    if (openBuffer !== undefined && openDocument !== undefined) {
      const converted = workspaceDocumentEdits(openDocument.snapshot(), edits);
      if (!converted.ok) return workspaceEditFailure('invalid-range', converted.error, uri);
      const group = asUndoGroupId(`xi-lsp-${Date.now()}-${completionOperationNumber += 1}`);
      if (!group.ok) return workspaceEditFailure('apply', group.error.message, uri);
      const applied = await workbench.applyDocumentEdits(openDocument.id, converted.value, group.value, 'lsp');
      return applied.ok ? { ok: true, value: undefined } : workspaceEditFailure('apply', applied.error.kind, uri);
    }
    const loaded = await readWorkspaceEditFile(path);
    if (loaded === undefined) return workspaceEditFailure('stale', `workspace edit target is unavailable: ${uri}`, uri);
    const converted = workspaceDocumentEdits(loaded.document.snapshot(), edits);
    if (!converted.ok) return workspaceEditFailure('invalid-range', converted.error, uri);
    const group = asUndoGroupId(`xi-lsp-${Date.now()}-${completionOperationNumber += 1}`);
    if (!group.ok) return workspaceEditFailure('apply', group.error.message, uri);
    const committed = loaded.document.commit({ documentId: loaded.document.id, expectedVersion: loaded.document.version, edits: converted.value, origin: 'lsp', undoGroup: group.value });
    if (!committed.ok) return workspaceEditFailure('apply', committed.error.kind, uri);
    const encoded = encodeTextFile(loaded.document.snapshot());
    if (!encoded.ok) return workspaceEditFailure('apply', encoded.error.kind, uri);
    const cancellation = new CancellationSource();
    try {
      const written = await filesystem.writeFileAtomic(filesystem.workspaceAbsolutePath(workspaceRoot, path) ?? path, encoded.value, cancellation.token);
      return written.ok ? { ok: true, value: undefined } : workspaceEditFailure('apply', written.error.message, uri);
    } finally { cancellation.dispose(); }
  }

  function workspaceDocumentEdits(snapshot: DocumentSnapshot, edits: readonly import('../../../packages/services/src/entrypoints/language').WorkspaceTextEdit[]): Result<readonly DocumentEdit[], string> {
    const converted: DocumentEdit[] = [];
    for (const edit of edits) {
      const start = asUtf16Offset(edit.start);
      const end = asUtf16Offset(edit.end);
      if (!start.ok || !end.ok) return { ok: false, error: 'workspace edit offset is invalid' };
      if (edit.end > snapshot.lengthUtf16 || edit.start < 0 || edit.end < edit.start) return { ok: false, error: 'workspace edit range is outside the document' };
      converted.push({ start: start.value, end: end.value, text: edit.newText });
    }
    return { ok: true, value: Object.freeze(converted) };
  }

  function workspaceEditFailure(kind: import('../../../packages/services/src/entrypoints/language').WorkspaceEditFailure['kind'], message: string, uri?: string): Result<never, import('../../../packages/services/src/entrypoints/language').WorkspaceEditFailure> {
    return { ok: false, error: { kind, message, ...(uri === undefined ? {} : { uri }) } };
  }

  async function requestCodeActions(): Promise<boolean> {
    const request = currentNavigationRequest();
    if (request === undefined) {
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_CODE_ACTION_STATE {"state":"unavailable"}\r\n');
      return true;
    }
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_CODE_ACTION_OPEN\r\n');
    await ensureLanguage();
    const provider = workspaceEditProvider;
    const session = languageSession;
    if (provider === undefined || session === undefined) {
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_CODE_ACTION_STATE {"state":"unavailable"}\r\n');
      return true;
    }
    const ready = await session.waitForReady();
    if (!ready.ok) { if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_CODE_ACTION_STATE ${JSON.stringify({ state: 'error', message: ready.error.message })}\r\n`); return true; }
    if (request.uri === undefined) return true;
    const workspaceRequest = { documentId: request.documentId, uri: request.uri, version: request.documentVersion, position: request.position };
    const result = await provider.codeActions({ ...workspaceRequest, diagnostics: diagnostics.model.all });
    if (!result.ok) { if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_CODE_ACTION_STATE ${JSON.stringify({ state: 'error', message: result.error.message })}\r\n`); return true; }
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_CODE_ACTION_STATE ${JSON.stringify({ state: 'ready', actions: result.value.length })}\r\n`);
    let action = result.value.find((candidate) => candidate.disabledReason === undefined);
    if (action?.data !== undefined && provider.resolveCodeAction !== undefined) {
      const resolved = await provider.resolveCodeAction(action);
      if (!resolved.ok) { process.stderr.write(`xi: code action resolve failed: ${resolved.error.message}\n`); return true; }
      action = resolved.value;
    }
    if (action !== undefined) {
      const execute = executeLanguageCodeAction;
      if (execute === undefined) {
        await initializeOptionalServices();
        if (executeLanguageCodeAction === undefined) return true;
      }
      const executed = await (execute ?? executeLanguageCodeAction!)(action, {
        apply: applyWorkspaceProposal,
        execute: async (command) => {
          process.stderr.write(`xi: unsupported language command: ${command.command}\n`);
          return { ok: false, error: { kind: 'unsupported', message: `unsupported language command: ${command.command}` } };
        },
      });
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_CODE_ACTION_APPLIED ${JSON.stringify({ title: action.title, ok: executed.ok, editApplied: action.edit !== undefined, command: action.command?.command })}\r\n`);
    }
    return true;
  }

  async function renameCurrent(newName: string): Promise<boolean> {
    const request = currentNavigationRequest();
    if (request === undefined) return false;
    await ensureLanguage();
    const provider = workspaceEditProvider;
    const session = languageSession;
    if (provider === undefined || session === undefined) return false;
    const ready = await session.waitForReady();
    if (!ready.ok) { process.stderr.write(`xi: rename unavailable: ${ready.error.message}\n`); return false; }
    if (request.uri === undefined) return false;
    const workspaceRequest = { documentId: request.documentId, uri: request.uri, version: request.documentVersion, position: request.position };
    if (session.supportsRequest('textDocument/prepareRename', request.uri)) {
      const prepared = await provider.prepareRename(workspaceRequest);
      if (!prepared.ok || prepared.value === undefined) { process.stderr.write(`xi: rename unavailable${prepared.ok ? '' : `: ${prepared.error.message}`}\n`); return false; }
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_RENAME_PREPARED ${JSON.stringify({ start: prepared.value.start, end: prepared.value.end })}\r\n`);
    } else if (process.env.XI_UI_TEST_MARKERS === '1') {
      process.stderr.write('XI_RENAME_PREPARE_SKIPPED {"reason":"unsupported"}\r\n');
    }
    let result = await provider.rename(workspaceRequest, newName);
    // TypeScript can answer a rename while its project graph is still being
    // populated with only the open file. A bounded retry lets the normal
    // request settle without imposing indexing latency on ordinary typing.
    for (let attempt = 0; languageId === 'typescript' && result.ok && result.value.edits.length > 0 && result.value.edits.every((edit) => edit.uri === request.uri) && attempt < 5; attempt += 1) {
      await delayMilliseconds(100);
      result = await provider.rename(workspaceRequest, newName);
    }
    if (!result.ok) { process.stderr.write(`xi: rename failed: ${result.error.message}\n`); return false; }
    const applied = await applyWorkspaceProposal(result.value);
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_RENAME_APPLIED ${JSON.stringify({ name: newName, ok: applied.ok, edits: result.value.edits.length, files: [...new Set(result.value.edits.map((edit) => edit.uri))] })}\r\n`);
    return applied.ok;
  }

  async function delayMilliseconds(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  async function applyWorkspaceProposal(proposal: import('../../../packages/services/src/entrypoints/language').WorkspaceEditProposal): Promise<Result<void, import('../../../packages/services/src/entrypoints/language').WorkspaceEditFailure>> {
    const coordinator = workspaceEditCoordinator;
    const provider = workspaceEditProvider;
    const session = languageSession;
    if (coordinator === undefined || provider === undefined || session === undefined) return workspaceEditFailure('disposed', 'workspace edit coordinator is unavailable');
    let combined = proposal;
    const resources = proposal.resources ?? [];
    for (const kind of ['create', 'rename', 'delete'] as const) {
      const group = resources.filter((resource) => resource.kind === kind);
      if (group.length === 0 || !serverSupportsFileOperation(session, kind, 'will')) continue;
      const will = await provider.willFileOperation(kind, group);
      if (!will.ok) return workspaceEditFailure('apply', `language server file-operation preflight failed: ${will.error.message}`);
      if (will.value !== undefined) combined = Object.freeze({
        requestId: `${proposal.requestId}:will:${kind}`,
        edits: Object.freeze([...combined.edits, ...will.value.edits]),
        resources: Object.freeze([...(combined.resources ?? []), ...(will.value.resources ?? [])]),
      });
    }
    const uris = [...new Set(combined.edits.map((edit) => edit.uri))];
    const resolved = await Promise.all(uris.map((uri) => resolveWorkspaceEditDocument(uri)));
    if (resolved.some((document) => document === undefined)) return workspaceEditFailure('stale', 'workspace edit target is unavailable');
    const targets = resolved.map((document) => document?.target).filter((target): target is import('../../../packages/services/src/entrypoints/language').WorkspaceEditTarget => target !== undefined);
    const applied = await coordinator.apply(combined, targets);
    if (!applied.ok) process.stderr.write(`xi: workspace edit failed: ${applied.error.message}\n`);
    else {
      for (const kind of ['create', 'rename', 'delete'] as const) {
        const group = resources.filter((resource) => resource.kind === kind);
        if (group.length === 0 || !serverSupportsFileOperation(session, kind, 'did')) continue;
        const did = await provider.didFileOperation(kind, group);
        if (!did.ok) process.stderr.write(`xi: language server file-operation notification failed: ${did.error.message}\n`);
      }
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKSPACE_EDIT_APPLIED ${JSON.stringify({ edits: combined.edits.length, resources: combined.resources?.length ?? 0 })}\r\n`);
    }
    return applied;
  }

  function closeHover(): void {
    hoverOpen = false;
    navigationController?.returnToOrigin();
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_HOVER_CLOSED\r\n');
  }

  function handleHoverKeypress(event: LauncherKeyEvent): boolean {
    if (event.name.toLowerCase() === 'escape' || event.raw === '\u001b') {
      closeHover();
      return true;
    }
    return true;
  }

  function handleOutlineKeypress(event: LauncherKeyEvent): boolean {
    if (event.name.toLowerCase() === 'escape' || event.raw === '\u001b') {
      closeOutline();
      return true;
    }
    return true;
  }

  function closeProblems(): void {
    problemsOpen = false;
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write('XI_PROBLEMS_CLOSED\r\n');
  }

  function handleProblemsKeypress(event: LauncherKeyEvent): boolean {
    if (event.name.toLowerCase() === 'escape' || event.raw === '\u001b') {
      closeProblems();
      return true;
    }
    return true;
  }

  function currentNavigationRequest(): import('../../../packages/services/src/entrypoints/language').NavigationRequest | undefined {
    const activeViewId = workbench.activeViewId;
    if (activeViewId === undefined) return undefined;
    const view = workbench.readView(activeViewId);
    const layoutView = workbench.views().find((candidate) => candidate.viewId === activeViewId);
    const buffer = layoutView === undefined ? undefined : workbench.buffer(layoutView.bufferId);
    const primary = view?.selections.members.find((member) => member.id === view.selections.primaryId) ?? view?.selections.members[0];
    if (view === undefined || buffer === undefined || primary === undefined) return undefined;
    const line = view.document.lineIndexAt(primary.head.at.offset);
    if (!line.ok) return undefined;
    const start = view.document.lineStartOffset(line.value);
    if (!start.ok) return undefined;
    return {
      documentId: String(view.document.id),
      documentVersion: view.document.version,
      selectionGeneration: view.selections.selectionGeneration as number,
      uri: fileUri(buffer.path),
      position: { line: line.value as number, utf16: (primary.head.at.offset as number) - (start.value as number) },
    };
  }

  function closeSearch(): void {
    searchService?.cancel();
    searchOpen = false;
    replaceInputActive = false;
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_SEARCH_CANCELLED ${JSON.stringify({ generation: searchService?.model.generation })}\r\n`);
  }

  async function handleSearchKeypress(event: LauncherKeyEvent): Promise<boolean> {
    if (searchService === undefined) {
      await initializeOptionalServices();
      return true;
    }
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\u001b') {
      if (replaceInputActive) { replaceInputActive = false; replaceInput = ''; return true; }
      closeSearch();
      return true;
    }
    if (replaceInputActive) {
      if (event.ctrl && (key === 'x' || key === 'r')) { replaceInputActive = false; return true; }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') { await applyWorkspaceReplacement(false); return true; }
      if (key === 'backspace' || key === 'backspace2' || event.raw === '\u007f') { replaceInput = replaceInput.slice(0, -1); return true; }
      if (event.ctrl || event.meta || event.option) return true;
      if (event.raw.length === 1 && event.raw >= ' ' && event.raw !== '\u007f') { replaceInput += event.raw; return true; }
      return true;
    }
    if (event.ctrl) {
      if (key === 'r') { searchRegex = !searchRegex; searchSelectedIndex = 0; querySearch(); return true; }
      if (key === 'i') { searchCaseSensitive = !searchCaseSensitive; searchSelectedIndex = 0; querySearch(); return true; }
      if (key === 'w') { searchWholeWord = !searchWholeWord; searchSelectedIndex = 0; querySearch(); return true; }
      if (key === 'h') { searchIncludeHidden = !searchIncludeHidden; searchSelectedIndex = 0; querySearch(); return true; }
      if (key === 'n' || key === 'p') {
        moveSearchSelection(key === 'n' ? 1 : -1);
        return true;
      }
    }
    if (key === 'down' || key === 'j') { moveSearchSelection(1); return true; }
    if (key === 'up' || key === 'k') { moveSearchSelection(-1); return true; }
    if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const match = searchService.model.matches[searchSelectedIndex];
      if (match !== undefined) await openSearchMatch(match);
      return true;
    }
    if (key === 'backspace' || key === 'backspace2' || event.raw === '\u007f') {
      searchQuery = searchQuery.slice(0, -1);
      searchSelectedIndex = 0;
      querySearch();
      return true;
    }
    if (event.ctrl || event.meta || event.option) return true;
    if (event.raw.length === 1 && event.raw >= ' ' && event.raw !== '\u007f') {
      searchQuery += event.raw;
      searchSelectedIndex = 0;
      querySearch();
    }
    return true;
  }

  function querySearch(): void {
    const service = searchService;
    if (service === undefined) {
      void initializeOptionalServices().then(() => { if (searchOpen) querySearch(); });
      return;
    }
    void service.query({
      rootId: 'workspace',
      rootPath: workspaceRoot,
      query: searchQuery,
      regex: searchRegex,
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      includeHidden: searchIncludeHidden,
      maxResults: 10_000,
    });
  }

  async function applyWorkspaceReplacement(selectedOnly: boolean): Promise<void> {
    if (searchService === undefined || replaceService === undefined) {
      await initializeOptionalServices();
      if (searchService === undefined || replaceService === undefined) return;
    }
    const service = searchService;
    const replacement = replaceService;
    const model = service.model;
    if (model.state !== 'ready' || model.matches.length === 0 || replaceInput.length === 0) {
      process.stderr.write('xi: replace requires a ready search result and a non-empty replacement\n');
      return;
    }
    const matches = selectedOnly ? [model.matches[searchSelectedIndex]].filter((match): match is SearchMatch => match !== undefined) : model.matches;
    const paths = [...new Set(matches.map((match) => `${match.rootId}\0${match.path}`))];
    const targets: ReplaceTarget[] = [];
    for (const key of paths) {
      const separator = key.indexOf('\0');
      const path = key.slice(separator + 1);
      const target = await readReplaceTarget(path);
      if (!target.ok) { process.stderr.write(`xi: replace preview failed for ${path}: ${target.error.message}\n`); return; }
      targets.push(target.value);
    }
    const plan = replacement.preview(model.query, replaceInput, targets, matches, model.generation);
    if (!plan.ok) { process.stderr.write(`xi: replace preview failed: ${plan.error.message}\n`); return; }
    const applied = await replacement.apply(plan.value);
    if (!applied.ok) {
      process.stderr.write(`xi: replace failed${applied.error.path === undefined ? '' : ` at ${applied.error.path}`}: ${applied.error.message}\n`);
      return;
    }
    const journal = applied.value.journal;
    process.stderr.write(`xi: replaced ${String(journal.entries.filter((entry) => entry.applied).length)} file(s)\n`);
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_REPLACE_APPLIED ${JSON.stringify({ operationId: journal.operationId, files: journal.entries.filter((entry) => entry.applied).length, edits: plan.value.edits.length })}\r\n`);
    replaceInputActive = false;
    querySearch();
  }

  async function readReplaceTarget(path: string): Promise<Result<ReplaceTarget, { readonly kind: 'failed'; readonly message: string }>> {
    const buffer = workbench.buffers().find((candidate) => filesystem.workspaceRelativePath(workspaceRoot, candidate.path) === path);
    if (buffer?.dirty === true) {
      const documentForBuffer = documents.get(buffer.documentId);
      if (documentForBuffer === undefined) return { ok: false, error: { kind: 'failed', message: 'dirty buffer is no longer open' } };
      const snapshot = documentForBuffer.snapshot();
      const text = fullDocumentText(snapshot);
      if (!text.ok) return { ok: false, error: { kind: 'failed', message: `cannot read dirty buffer: ${text.error.kind}` } };
      return { ok: true, value: { path, rootId: 'workspace', text: text.value, source: 'buffer', version: buffer.documentVersion } };
    }
    const absolute = filesystem.workspaceAbsolutePath(workspaceRoot, path);
    if (absolute === undefined) return { ok: false, error: { kind: 'failed', message: 'replace path escapes workspace' } };
    const cancellation = new CancellationSource();
    try {
      const read = await filesystem.readFile(absolute, cancellation.token);
      if (!read.ok) return { ok: false, error: { kind: 'failed', message: read.error.message } };
      try {
        return { ok: true, value: { path, rootId: 'workspace', text: new TextDecoder('utf-8', { fatal: true }).decode(read.value), source: 'disk', diskHash: textHash(read.value) } };
      } catch { return { ok: false, error: { kind: 'failed', message: `replace target is not valid UTF-8 (${String(read.value.byteLength)} bytes)` } }; }
    } finally { cancellation.dispose(); }
  }

  function createReplacePort(): ReplaceApplyPort {
    return {
      readTarget: async (path) => readReplaceTarget(path),
      apply: async (plan) => {
        const cancellation = new CancellationSource();
        const entries: import('../../../packages/services/src/entrypoints/launch').ReplaceJournalEntry[] = [];
        try {
          // Revalidate every source before the first mutation, including the
          // disk hash and the open-buffer version captured by the preview.
          for (const target of plan.targets) {
            const current = await readReplaceTarget(target.path);
            if (!current.ok) return { ok: false, error: { kind: 'failed', message: current.error.message, path: target.path } };
            if (current.value.text !== target.text || current.value.source !== target.source || current.value.version !== target.version || current.value.diskHash !== target.diskHash) {
              return { ok: false, error: { kind: 'conflict', message: `replace target changed: ${target.path}`, path: target.path } };
            }
          }
          const byPath = new Map<string, typeof plan.edits[number][]>();
          for (const edit of plan.edits) (byPath.get(edit.path) ?? (byPath.set(edit.path, []), byPath.get(edit.path)!)).push(edit);
          for (const target of plan.targets) {
            const edits = byPath.get(target.path) ?? [];
            const applyEdits = applyReplacementEdits;
            if (applyEdits === undefined) return { ok: false, error: { kind: 'failed', message: 'replace service is still loading', path: target.path } };
            const after = applyEdits(target.text, edits);
            if (!after.ok) return { ok: false, error: after.error };
            const buffer = workbench.buffers().find((candidate) => filesystem.workspaceRelativePath(workspaceRoot, candidate.path) === target.path);
            if (target.source === 'buffer' && buffer !== undefined) {
              const documentForBuffer = documents.get(buffer.documentId);
              if (documentForBuffer === undefined || target.version === undefined) return { ok: false, error: { kind: 'failed', message: `dirty buffer is unavailable: ${target.path}`, path: target.path } };
              const group = asUndoGroupId(`xi-replace-${Date.now()}-${replaceOperationNumber += 1}`);
              if (!group.ok) return { ok: false, error: { kind: 'failed', message: group.error.message, path: target.path } };
              const documentEdits: DocumentEdit[] = [];
              for (const edit of edits) {
                const start = asUtf16Offset(edit.startUtf16);
                const end = asUtf16Offset(edit.endUtf16);
                if (!start.ok || !end.ok) return partialReplaceFailure(entries, target, after.value, 'replacement range is invalid');
                documentEdits.push({ start: start.value, end: end.value, text: edit.replacement });
              }
              const committed = documentForBuffer.commit({
                documentId: documentForBuffer.id,
                expectedVersion: documentForBuffer.version,
                edits: documentEdits,
                origin: 'workspace-replace',
                undoGroup: group.value,
              });
              if (!committed.ok) return partialReplaceFailure(entries, target, after.value, committed.error.kind);
            } else {
              const absolute = filesystem.workspaceAbsolutePath(workspaceRoot, target.path);
              if (absolute === undefined) return partialReplaceFailure(entries, target, after.value, 'path escaped workspace');
              const written = await filesystem.writeFileAtomic(absolute, new TextEncoder().encode(after.value), cancellation.token);
              if (!written.ok) return partialReplaceFailure(entries, target, after.value, written.error.message);
            }
            entries.push(Object.freeze({ path: target.path, source: target.source, before: target.text, after: after.value, applied: true }));
          }
          const journal: ReplaceJournal = Object.freeze({ schemaVersion: 1, operationId: `xi-replace-${Date.now()}-${replaceOperationNumber += 1}`, generation: plan.generation, entries: Object.freeze(entries), status: 'applied' });
          return { ok: true, value: { journal, restored: false } };
        } finally { cancellation.dispose(); }
      },
      restore: async (journal) => {
        const cancellation = new CancellationSource();
        try {
          for (const entry of [...journal.entries].reverse()) {
            if (!entry.applied) continue;
            const buffer = workbench.buffers().find((candidate) => filesystem.workspaceRelativePath(workspaceRoot, candidate.path) === entry.path);
            if (entry.source === 'buffer' && buffer !== undefined) {
              const documentForBuffer = documents.get(buffer.documentId);
              if (documentForBuffer === undefined) return { ok: false, error: { kind: 'failed', message: `cannot restore closed buffer: ${entry.path}`, path: entry.path } };
              const snapshot = documentForBuffer.snapshot();
              const current = fullDocumentText(snapshot);
              if (!current.ok || current.value !== entry.after) return { ok: false, error: { kind: 'conflict', message: `buffer changed after replace: ${entry.path}`, path: entry.path } };
              const group = asUndoGroupId(`xi-restore-${Date.now()}-${replaceOperationNumber += 1}`);
              if (!group.ok) return { ok: false, error: { kind: 'failed', message: group.error.message, path: entry.path } };
              const start = asUtf16Offset(0);
              const end = asUtf16Offset(snapshot.lengthUtf16);
              if (!start.ok || !end.ok) return { ok: false, error: { kind: 'failed', message: `cannot restore invalid buffer range: ${entry.path}`, path: entry.path } };
              const restored = documentForBuffer.commit({ documentId: documentForBuffer.id, expectedVersion: snapshot.version, edits: [{ start: start.value, end: end.value, text: entry.before }], origin: 'workspace-replace', undoGroup: group.value });
              if (!restored.ok) return { ok: false, error: { kind: 'failed', message: restored.error.kind, path: entry.path } };
              continue;
            }
            const absolute = filesystem.workspaceAbsolutePath(workspaceRoot, entry.path);
            if (absolute === undefined) return { ok: false, error: { kind: 'failed', message: `restore path escaped workspace: ${entry.path}`, path: entry.path } };
            const current = await readReplaceTarget(entry.path);
            if (!current.ok || current.value.text !== entry.after) return { ok: false, error: { kind: 'conflict', message: `file changed after replace: ${entry.path}`, path: entry.path } };
            const restored = await filesystem.writeFileAtomic(absolute, new TextEncoder().encode(entry.before), cancellation.token);
            if (!restored.ok) return { ok: false, error: { kind: 'failed', message: restored.error.message, path: entry.path } };
          }
          return { ok: true, value: undefined };
        } finally { cancellation.dispose(); }
      },
    };
  }

  function partialReplaceFailure(entries: readonly import('../../../packages/services/src/entrypoints/launch').ReplaceJournalEntry[], target: ReplaceTarget, after: string, message: string): { ok: false; error: import('../../../packages/services/src/entrypoints/launch').ReplaceFailure } {
    const journal: ReplaceJournal = Object.freeze({ schemaVersion: 1, operationId: `xi-replace-${Date.now()}-${replaceOperationNumber += 1}`, generation: 0, entries: Object.freeze([...entries, Object.freeze({ path: target.path, source: target.source, before: target.text, after, applied: false, error: message })]), status: 'partial' });
    return { ok: false, error: { kind: 'failed', message: `partial replacement: ${message}`, path: target.path, journal } };
  }

  function moveSearchSelection(delta: number): void {
    const count = searchService?.model.matches.length ?? 0;
    if (count === 0) { searchSelectedIndex = 0; return; }
    searchSelectedIndex = Math.max(0, Math.min(count - 1, searchSelectedIndex + delta));
  }

  function readSearchBuffers(): readonly SearchBufferSource[] {
    const sources: SearchBufferSource[] = [];
    for (const buffer of workbench.buffers()) {
      if (!buffer.dirty) continue;
      const documentForBuffer = documents.get(buffer.documentId);
      if (documentForBuffer === undefined) continue;
      const snapshot = documentForBuffer.snapshot();
      const content = fullDocumentText(snapshot);
      if (!content.ok) continue;
      const relativePath = filesystem.workspaceRelativePath(workspaceRoot, buffer.path);
      if (relativePath === undefined) continue;
      sources.push({ rootId: 'workspace', path: relativePath, version: buffer.documentVersion, text: content.value });
    }
    return Object.freeze(sources);
  }

  async function openSearchMatch(match: SearchMatch): Promise<void> {
    if (match.path.startsWith('base64:')) return;
    const relativePath = filesystem.workspaceRelativePath(workspaceRoot, match.path);
    if (relativePath === undefined) return;
    const absolutePath = filesystem.workspaceAbsolutePath(workspaceRoot, relativePath);
    if (absolutePath === undefined) return;
    const existing = workbench.buffers().find((buffer) => filesystem.workspaceRelativePath(workspaceRoot, buffer.path) === relativePath);
    if (existing !== undefined) {
      const viewId = existing.viewIds[0];
      if (viewId !== undefined) workbench.focus(viewId);
      closeSearch();
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_SEARCH_OPENED ${JSON.stringify({ path: relativePath, source: match.source })}\r\n`);
      return;
    }
    const openedFile = await openDocument(openTextDocument, persistence, absolutePath, nextDocumentId());
    if (openedFile === undefined) return;
    documents.set(openedFile.id, openedFile);
    const openedBuffer = workbench.openBuffer(openedFile, { path: absolutePath });
    if (!openedBuffer.ok) {
      documents.delete(openedFile.id);
      return;
    }
    const viewId = openedBuffer.value.viewIds[0];
    if (viewId === undefined) return;
    createSession(openedFile, viewId);
    workbench.focus(viewId);
    closeSearch();
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_SEARCH_OPENED ${JSON.stringify({ path: relativePath, source: match.source })}\r\n`);
  }

  async function handleExplorerKeypress(event: LauncherKeyEvent): Promise<boolean> {
    if (explorerTree === undefined || explorerController === undefined) {
      await initializeOptionalServices();
      return explorerTree === undefined || explorerController === undefined ? true : handleExplorerKeypress(event);
    }
    const tree = explorerTree;
    const controller = explorerController;
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\u001b') {
      if (explorerFiltering || tree.model.filter.length > 0) {
        explorerFiltering = false;
        tree.setFilter('');
      } else {
        closeExplorer();
      }
      return true;
    }
    if (explorerFiltering) {
      if (key === 'backspace' || key === 'backspace2' || event.raw === '\u007f') {
        tree.setFilter(tree.model.filter.slice(0, -1));
        return true;
      }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
        explorerFiltering = false;
        await controller.handle('open');
        return true;
      }
      if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1 && event.raw >= ' ' && event.raw !== '\u007f') {
        tree.setFilter(`${tree.model.filter}${event.raw}`);
      }
      return true;
    }
    if (key === '/' || event.raw === '/') {
      explorerFiltering = true;
      tree.setFilter('');
      return true;
    }
    if (event.ctrl && key === 'd') {
      for (let index = 0; index < 5; index += 1) await controller.handle('down');
      return true;
    }
    if (event.ctrl && key === 'u') {
      for (let index = 0; index < 5; index += 1) await controller.handle('up');
      return true;
    }
    if (key === 'g' && !event.shift) {
      if (explorerPendingG) {
        explorerPendingG = false;
        await controller.handle('first');
      } else {
        explorerPendingG = true;
        setTimeout(() => { explorerPendingG = false; }, 500);
      }
      return true;
    }
    if (event.shift && key === 'g') {
      explorerPendingG = false;
      await controller.handle('last');
      return true;
    }
    explorerPendingG = false;
    const action = key === 'up' || key === 'k' ? 'up'
      : key === 'down' || key === 'j' ? 'down'
      : key === 'left' || key === 'h' ? 'left'
      : key === 'right' || key === 'l' ? 'right'
      : key === 'space' || event.raw === ' ' ? 'toggle'
      : key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n' ? 'open'
      : undefined;
    if (action !== undefined) await controller.handle(action);
    return true;
  }

  async function openExplorerNode(node: import('../../../packages/services/src/entrypoints/launch').ExplorerNode): Promise<void> {
    if (node.kind === 'directory' || node.kind === 'root') return;
    const existing = workbench.buffers().find((buffer) => buffer.path === node.path);
    if (existing !== undefined) {
      const viewId = existing.viewIds[0];
      if (viewId !== undefined) workbench.focus(viewId);
      closeExplorer();
      return;
    }
    const openedFile = await openDocument(openTextDocument, persistence, node.path, nextDocumentId());
    if (openedFile === undefined) return;
    documents.set(openedFile.id, openedFile);
    const openedBuffer = workbench.openBuffer(openedFile, { path: node.path });
    if (!openedBuffer.ok) {
      documents.delete(openedFile.id);
      return;
    }
    const viewId = openedBuffer.value.viewIds[0];
    if (viewId === undefined) return;
    createSession(openedFile, viewId);
    workbench.focus(viewId);
    closeExplorer();
  }

  async function handlePickerKeypress(event: LauncherKeyEvent): Promise<void> {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\u001b') {
      await closePicker(true);
      return;
    }
    if (key === 'up' || key === 'down') {
      const entries = pickerModel.model.entries;
      const selected = entries.findIndex((entry) => entry.id === pickerModel.model.selectedId);
      const next = Math.max(0, Math.min(entries.length - 1, selected + (key === 'up' ? -1 : 1)));
      const entry = entries[next];
      if (entry !== undefined && pickerModel.select(entry.id)) void previewSelected(entry);
      return;
    }
    if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const selected = pickerModel.model.entries.find((entry) => entry.id === pickerModel.model.selectedId);
      if (selected !== undefined) await activatePickerEntry(selected);
      return;
    }
    if (key === 'backspace' || key === 'backspace2' || event.raw === '\u007f') {
      pickerQuery = pickerQuery.slice(0, -1);
      queryPicker();
      return;
    }
    if (event.ctrl || event.meta || event.option) return;
    const raw = event.raw;
    if (raw.length === 1 && raw >= ' ' && raw !== '\u007f') {
      pickerQuery += raw;
      queryPicker();
    }
  }

  function queryPicker(): void {
    const generation = ++pickerGeneration;
    const query = pickerQuery;
    const mode = pickerMode;
    void pickerModel.query(mode, query).then((result) => {
      if (generation !== pickerGeneration) return;
      if (!result.ok) {
        // Workspace enumeration is deliberately background work. Retry the
        // active query after the index announces readiness without blocking
        // the editor input queue.
        if (result.error.kind === 'not-ready' && pickerOpen) {
          setTimeout(() => { if (generation === pickerGeneration && pickerOpen) queryPicker(); }, 50);
        }
        return;
      }
      void previewSelected(result.value.entries[0]);
    });
  }

  function startFileIndexPopulation(): Promise<void> {
    fileIndexPopulation ??= populateFileIndex(fileIndex, filesystem, workspaceRoot);
    return fileIndexPopulation;
  }

  async function activatePickerEntry(entry: PickerEntry): Promise<void> {
    if (entry.mode === 'command') {
      const mode = entry.value as PickerMode;
      if (mode === 'file' || mode === 'buffer' || mode === 'command' || mode === 'theme' || mode === 'config') {
        openPicker(mode);
      }
      return;
    }
    if (entry.mode === 'file') {
      await openFileFromPicker(entry, true);
      return;
    }
    if (entry.mode === 'buffer') {
      const buffer = workbench.buffers().find((candidate) => String(candidate.bufferId) === entry.value);
      const viewId = buffer?.viewIds[0];
      if (viewId !== undefined) {
        workbench.focus(viewId);
        closePicker(false);
      }
      return;
    }
    closePicker(false);
  }

  async function previewSelected(entry: PickerEntry | undefined): Promise<void> {
    if (!pickerOpen || entry === undefined || entry.mode !== 'file') return;
    await openFileFromPicker(entry, false);
  }

  async function openFileFromPicker(entry: PickerEntry, commit: boolean): Promise<void> {
    const path = entry.value;
    const existing = workbench.buffers().find((buffer) => buffer.path === path);
    if (existing !== undefined) {
      const viewId = existing.viewIds[0];
      if (viewId !== undefined) workbench.focus(viewId);
      if (commit) await closePicker(false);
      return;
    }
    const openedFile = await openDocument(openTextDocument, persistence, path, nextDocumentId());
    if (openedFile === undefined) return;
    documents.set(openedFile.id, openedFile);
    const openedBuffer = workbench.openBuffer(openedFile, { path, preview: !commit });
    if (!openedBuffer.ok) {
      documents.delete(openedFile.id);
      return;
    }
    const viewId = openedBuffer.value.viewIds[0];
    if (viewId === undefined) return;
    createSession(openedFile, viewId);
    if (commit) {
      workbench.promoteBuffer(openedFile.id);
      await closePicker(false);
    } else {
      previewViewId = viewId;
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_PICKER_PREVIEW ${JSON.stringify({ viewId, path })}\r\n`);
    }
  }

  async function closePicker(cancelPreview: boolean): Promise<void> {
    ++pickerGeneration;
    pickerOpen = false;
    pickerModel.cancel();
    if (cancelPreview && previewViewId !== undefined) {
      const viewId = previewViewId;
      previewViewId = undefined;
      const view = workbench.views().find((candidate) => candidate.viewId === viewId);
      const bufferId = view?.bufferId;
      const closed = workbench.closeView(viewId, 'discard');
      sessions.delete(viewId);
      sessionDocuments.delete(viewId);
      if (closed.ok && bufferId !== undefined) documents.delete(bufferId);
      if (closed.ok && process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_PICKER_CANCELLED ${JSON.stringify({ viewId, activeViewId: closed.value.activeViewId })}\r\n`);
    }
  }

  function nextDocumentId(): DocumentId {
    const value = id<DocumentId>(`xi-picker-document-${nextDocumentNumber}`);
    nextDocumentNumber += 1;
    return value;
  }

  async function formatCurrentDocument(viewId: ViewId): Promise<boolean> {
    await ensureFormatting();
    if (formatterPipeline === undefined) {
      reportFormatterFailure('failed', 'no formatter is configured');
      return false;
    }
    const view = workbench.views().find((candidate) => candidate.viewId === viewId);
    const document = view === undefined ? undefined : documents.get(view.bufferId);
    const path = view === undefined ? undefined : workbench.buffer(view.bufferId)?.path;
    if (document === undefined || path === undefined) {
      reportFormatterFailure('failed', 'active buffer is unavailable');
      return false;
    }
    return applyConfiguredFormatter(document, path, formatterPipeline, workbench, viewId);
  }

  async function handleVimHostCommand(
    command: import('../../../packages/vim/src/entrypoints/launch').VimHostCommand,
    sourceViewId: ViewId,
  ): Promise<void> {
    if (hostNavigation === undefined) {
      await initializeOptionalServices();
      if (hostNavigation === undefined) return;
    }
    const navigation = hostNavigation;
    if (command.kind === 'open-file') {
      const source = workbench.views().find((candidate) => candidate.viewId === sourceViewId);
      const sourcePath = source === undefined ? undefined : workbench.buffer(source.bufferId)?.path;
      const targetPath = await resolveHostFilePath(command.target, sourcePath);
      if (targetPath === undefined) {
        process.stderr.write(`xi: file target not found: ${command.target}\n`);
        return;
      }
      const opened = await navigation.openFile(targetPath, command.line);
      if (!opened.ok) {
        process.stderr.write(`xi: file navigation ${opened.error.kind}: ${opened.error.message}\n`);
        return;
      }
      await openHostLocation(opened.value.location, command.split, sourceViewId);
      return;
    }
    if (command.kind === 'open-tag') {
      const opened = await navigation.openTag(command.name);
      if (!opened.ok) {
        process.stderr.write(`xi: tag navigation ${opened.error.kind}: ${opened.error.message}\n`);
        return;
      }
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_NATIVE_TAG ${JSON.stringify({ uri: opened.value.location.uri, line: opened.value.location.line })}\r\n`);
      await openHostLocation(opened.value.location, command.split, sourceViewId);
      return;
    }
    if (command.kind === 'include') {
      if (command.list) {
        process.stderr.write(`xi: include search list is unavailable without an include provider\n`);
        return;
      }
      const source = workbench.views().find((candidate) => candidate.viewId === sourceViewId);
      const sourcePath = source === undefined ? undefined : workbench.buffer(source.bufferId)?.path;
      const targetPath = await resolveHostFilePath(command.target, sourcePath);
      if (targetPath === undefined) {
        process.stderr.write(`xi: include target not found: ${command.target}\n`);
        return;
      }
      const opened = await navigation.openFile(targetPath);
      if (!opened.ok) {
        process.stderr.write(`xi: include navigation ${opened.error.kind}: ${opened.error.message}\n`);
        return;
      }
      await openHostLocation(opened.value.location, false, sourceViewId);
      return;
    }
    if (command.kind === 'lookup') {
      const detail = command.lookup === 'definition' ? 'definition provider' : command.lookup === 'keyword' ? 'keyword provider' : 'command output history';
      process.stderr.write(`xi: native lookup unavailable: ${detail}\n`);
      return;
    }
    if (command.kind === 'tag-back') {
      const location = navigation.back();
      if (location !== undefined) await openHostLocation(location, false, sourceViewId);
      return;
    }
    await handleVimWindowCommand(command.action, command.count, sourceViewId);
  }

  async function resolveHostFilePath(target: string, sourcePath: string | undefined): Promise<string | undefined> {
    if (target.length === 0 || target.includes('\0')) return undefined;
    const normalized = target.replaceAll('\\', '/');
    const candidates = new Set<string>();
    if (normalized.startsWith('/')) candidates.add(filesystem.resolvePath('/', normalized));
    else {
      const base = sourcePath !== undefined && sourcePath.startsWith('/') ? filesystem.directoryPath(sourcePath) : workspaceRoot;
      candidates.add(filesystem.resolvePath(base, normalized));
      candidates.add(filesystem.resolvePath(workspaceRoot, normalized));
      candidates.add(filesystem.resolvePath(workspaceRoot, `include/${normalized}`));
      candidates.add(filesystem.resolvePath(workspaceRoot, `includes/${normalized}`));
    }
    const cancellation = new CancellationSource();
    try {
      for (const candidate of candidates) {
        const info = await filesystem.stat(candidate, cancellation.token);
        if (info.ok && (info.value.kind === 'file' || info.value.kind === 'symlink')) return candidate;
      }
      return undefined;
    } finally {
      cancellation.dispose();
    }
  }

  async function openHostLocation(
    location: import('../../../packages/services/src/entrypoints/launch').HostLocation,
    split: boolean,
    sourceViewId: ViewId,
  ): Promise<void> {
    const path = workspacePathFromUri(location.uri);
    if (path === undefined) {
      process.stderr.write(`xi: cannot open non-file host location: ${location.uri}\n`);
      return;
    }
    const existing = workbench.buffers().find((buffer) => fileUri(buffer.path) === location.uri);
    if (existing !== undefined) {
      const targetViewId = existing.viewIds[0];
      const targetSession = targetViewId === undefined ? undefined : sessions.get(targetViewId);
      if (targetViewId !== undefined) workbench.focus(targetViewId);
      targetSession?.setCursorPosition(location.line, location.utf16);
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_NATIVE_JUMP ${JSON.stringify({ path, line: location.line, split })}\r\n`);
      return;
    }
    const openedFile = await openDocument(openTextDocument, persistence, path, nextDocumentId());
    if (openedFile === undefined) return;
    documents.set(openedFile.id, openedFile);
    if (split) {
      const createdSplit = workbench.splitView(sourceViewId, 'horizontal');
      if (!createdSplit.ok) {
        documents.delete(openedFile.id);
        process.stderr.write(`xi: ${createdSplit.error.kind}\n`);
        return;
      }
      const splitDocument = documents.get(createdSplit.value.session.documentId);
      if (splitDocument !== undefined && !sessions.has(createdSplit.value.viewId)) createSession(splitDocument, createdSplit.value.viewId, createdSplit.value.session.selections);
    }
    const openedBuffer = workbench.openBuffer(openedFile, { path });
    if (!openedBuffer.ok) {
      documents.delete(openedFile.id);
      process.stderr.write(`xi: ${openedBuffer.error.kind}\n`);
      return;
    }
    const targetViewId = openedBuffer.value.viewIds[0];
    if (targetViewId === undefined) return;
    createSession(openedFile, targetViewId, undefined, location.line + 1);
    sessions.get(targetViewId)?.setCursorPosition(location.line, location.utf16);
    workbench.focus(targetViewId);
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_NATIVE_JUMP ${JSON.stringify({ path, line: location.line, split })}\r\n`);
  }

  async function handleVimWindowCommand(
    action: Extract<import('../../../packages/vim/src/entrypoints/launch').VimHostCommand, { readonly kind: 'window' }>['action'],
    count: number,
    sourceViewId: ViewId,
  ): Promise<void> {
    const repeats = Math.max(1, Math.min(100, Number.isSafeInteger(count) ? count : 1));
    const direction = action === 'focus-left' ? 'left' : action === 'focus-right' ? 'right' : action === 'focus-up' ? 'up' : action === 'focus-down' ? 'down' : action === 'focus-next' ? 'next' : action === 'focus-previous' ? 'previous' : action === 'focus-first' ? 'first' : action === 'focus-last' ? 'last' : undefined;
    if (direction !== undefined) {
      let current = sourceViewId;
      for (let index = 0; index < repeats; index += 1) {
        const moved = workbench.focusAdjacent(current, direction);
        if (!moved.ok) break;
        current = moved.value;
      }
      return;
    }
    if (action === 'split-horizontal' || action === 'split-vertical' || action === 'new-window') {
      await handleWorkbenchCommand(action === 'split-vertical' ? 'vsplit' : 'split', sourceViewId);
      return;
    }
    if (action === 'close') {
      await handleWorkbenchCommand('q!', sourceViewId);
      return;
    }
    if (action === 'only') {
      const reduced = workbench.closeOtherViews(sourceViewId, 'discard');
      if (!reduced.ok) process.stderr.write(`xi: ${reduced.error.kind}\n`);
      return;
    }
    process.stderr.write(`xi: native window command unavailable: ${action}\n`);
  }

  function handleWorkbenchCommand(source: string, viewId: ViewId): 'handled' | 'unhandled' | Promise<'handled' | 'unhandled' | 'quit'> {
    const normalized = source.trim();
    const command = normalized.toLowerCase();
    const rename = /^xi\s+rename\s+(\S+)$/iu.exec(normalized);
    if (rename?.[1] !== undefined) return renameCurrent(rename[1]).then(() => 'handled');
    if (command === 'xi code-action') return requestCodeActions().then(() => 'handled');
    if (command === 'format') return formatCurrentDocument(viewId).then(() => 'handled');
    const tag = /^(?:tag|tjump|tj)\s+(\S+)$/iu.exec(normalized);
    if (tag?.[1] !== undefined) return handleVimHostCommand({ kind: 'open-tag', name: tag[1], split: false }, viewId).then(() => 'handled');
    if (command !== 'split' && command !== 'vsplit' && command !== 'q' && command !== 'q!') return 'unhandled';
    if (command === 'split' || command === 'vsplit') {
      const split = workbench.splitView(viewId, command === 'split' ? 'horizontal' : 'vertical');
      if (!split.ok) {
        process.stderr.write(`xi: ${split.error.kind}\n`);
        return 'handled';
      }
      const splitDocument = documents.get(split.value.session.documentId);
      if (splitDocument !== undefined) createSession(splitDocument, split.value.viewId, split.value.session.selections);
      if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_SPLIT ${JSON.stringify({ viewId: split.value.viewId })}\r\n`);
      return 'handled';
    }
    const current = workbench.views().find((view) => view.viewId === viewId);
    const buffer = current === undefined ? undefined : workbench.buffer(current.bufferId);
    if (command === 'q' && buffer?.dirty === true) return 'unhandled';
    if (sessions.size === 1) return 'unhandled';
    const closed = workbench.closeView(viewId, 'discard');
    if (!closed.ok) {
      process.stderr.write(`xi: ${closed.error.kind}\n`);
      return 'handled';
    }
    sessions.delete(viewId);
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_VIEW_CLOSED ${JSON.stringify({ activeViewId: closed.value.activeViewId })}\r\n`);
    return 'handled';
  }
}

async function openDocument(
  openTextDocument: typeof import('../../../packages/document/src/entrypoints/launch').openTextDocument,
  persistence: PersistenceService,
  path: string | undefined,
  documentId: DocumentId,
): Promise<TextFileDocument | undefined> {
  if (path === undefined) {
    const opened = openTextDocument(documentId, new TextEncoder().encode('// Xi editor\n// Press q or Ctrl-C to quit\n'));
    if (opened.kind !== 'editable') throw new Error(`xi cannot edit this input: ${opened.kind}`);
    return opened.document;
  }
  const cancellation = new CancellationSource();
  try {
    const opened = await persistence.openFile(path, documentId, cancellation.token);
    if (!opened.ok) {
      process.stderr.write(`xi: cannot open ${path}: ${opened.error.kind}\n`);
      return undefined;
    }
    if (opened.value.kind !== 'editable') {
      process.stderr.write(`xi: cannot edit ${path}: ${opened.value.document.reason}\n`);
      return undefined;
    }
    return opened.value.document;
  } finally {
    cancellation.dispose();
  }
}

async function populateFileIndex(index: FilePathIndex, filesystem: NodeFilesystemPort, root: string): Promise<void> {
  const cancellation = new CancellationSource();
  try {
    await filesystem.enumerateFiles(root, cancellation.token, (entries) => {
      const indexed = entries.map((entry) => ({ rootId: 'workspace' as const, relativePath: entry.relativePath, absolutePath: entry.absolutePath, hidden: entry.hidden }));
      index.addPaths('workspace', indexed);
    }, { maxEntries: 120_000 });
  } finally {
    index.markReady();
    cancellation.dispose();
  }
}

/** Compose the platform adapter into the service-owned Explorer contract. */
function createExplorerFilesystem(filesystem: NodeFilesystemPort, root: string): ExplorerFilesystemPort {
  return {
    async enumerateDirectory(path, cancellation): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
      const result = await filesystem.enumerateDirectory(path, root, cancellation);
      if (!result.ok) return { ok: false, error: toExplorerFailure(result.error, path) };
      return { ok: true, value: Object.freeze(result.value.map(toExplorerEntry)) };
    },
    async watchDirectory(path, listener, cancellation) {
      const watched = await filesystem.watchDirectory(path, (event) => listener(toExplorerWatchEvent(event, root)), cancellation);
      if (!watched.ok) return { ok: false, error: toExplorerFailure(watched.error, path) };
      return watched;
    },
  };
}

function toExplorerEntry(entry: WorkspaceDirectoryEntry): ExplorerDirectoryEntry {
  return {
    name: entry.name,
    relativePath: entry.relativePath,
    kind: entry.kind,
    hidden: entry.hidden,
    ignored: entry.ignored,
    ...(entry.stableIdentity === undefined ? {} : { stableIdentity: entry.stableIdentity }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
    ...(entry.modifiedMilliseconds === undefined ? {} : { modifiedMilliseconds: entry.modifiedMilliseconds }),
    ...(entry.symlinkTarget === undefined ? {} : { symlinkTarget: entry.symlinkTarget }),
  };
}

function toExplorerWatchEvent(event: WorkspaceDirectoryWatchEvent, root: string): import('../../../packages/services/src/entrypoints/launch').ExplorerWatchEvent {
  const relativePath = relativeWorkspacePath(root, event.path);
  return { kind: 'changed', rootId: 'workspace', relativePath };
}

function relativeWorkspacePath(root: string, path: string): string {
  if (path === root) return '';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length).replaceAll('\\', '/') : '';
}

function toExplorerFailure(error: { readonly code: string; readonly message: string }, path: string): ExplorerFailure {
  if (error.code === 'EACCES' || error.code === 'EPERM') return { kind: 'permission-denied', path, message: error.message };
  if (error.code === 'ABORT_ERR' || error.code === 'ECANCELED' || error.code === 'cancelled') return { kind: 'cancelled', message: error.message };
  return { kind: 'filesystem', path, message: error.message };
}

function isNormalSpace(event: { readonly name: string; readonly raw: string }, workbench: { readonly activeViewId: ViewId | undefined; readView(viewId: ViewId): { readonly session: { readonly mode: string } } | undefined }): boolean {
  if (event.raw !== ' ' && event.name.toLowerCase() !== 'space') return false;
  const viewId = workbench.activeViewId;
  return viewId !== undefined && workbench.readView(viewId)?.session.mode === 'normal';
}

function isInsertMode(mode: string | undefined): boolean { return mode === 'insert' || mode === 'replace'; }

function isCompletionTrigger(event: { readonly name: string; readonly raw: string; readonly ctrl: boolean; readonly shift: boolean }, workbench: { readonly activeViewId: ViewId | undefined; readView(viewId: ViewId): { readonly session: { readonly mode: string } } | undefined }): boolean {
  if (!event.ctrl || (event.raw !== ' ' && event.raw !== '\u0000' && event.name.toLowerCase() !== 'space')) return false;
  const viewId = workbench.activeViewId;
  const mode = viewId === undefined ? undefined : workbench.readView(viewId)?.session.mode;
  return mode === 'insert' || mode === 'replace';
}

function isSignatureTrigger(event: { readonly name: string; readonly raw: string; readonly ctrl: boolean; readonly shift: boolean }, workbench: { readonly activeViewId: ViewId | undefined; readView(viewId: ViewId): { readonly session: { readonly mode: string } } | undefined }): boolean {
  if (!event.ctrl || !event.shift || event.name.toLowerCase() !== 's') return false;
  const viewId = workbench.activeViewId;
  const mode = viewId === undefined ? undefined : workbench.readView(viewId)?.session.mode;
  return mode === 'insert' || mode === 'replace';
}

function sameCompletionRequest(left: import('../../../packages/services/src/entrypoints/language').CompletionRequest, right: import('../../../packages/services/src/entrypoints/language').CompletionRequest): boolean {
  return left.documentId === right.documentId
    && left.documentVersion === right.documentVersion
    && left.selectionGeneration === right.selectionGeneration
    && left.position.line === right.position.line
    && left.position.utf16 === right.position.utf16
    && left.uri === right.uri;
}

function completionEdit(
  snapshot: DocumentSnapshot,
  edit: import('../../../packages/services/src/entrypoints/language').CompletionTextEdit,
  positionToOffset: typeof import('../../../packages/document/src/entrypoints/launch').positionToOffset,
): Result<DocumentEdit, string> {
  const startLine = asLineIndex(edit.start.line);
  const startColumn = asUtf16Column(edit.start.utf16);
  const endLine = asLineIndex(edit.end.line);
  const endColumn = asUtf16Column(edit.end.utf16);
  if (!startLine.ok || !startColumn.ok || !endLine.ok || !endColumn.ok) return { ok: false, error: 'completion position is invalid' };
  const start = positionToOffset(snapshot, { version: snapshot.version, line: startLine.value, encoding: 'utf-16', character: startColumn.value });
  const end = positionToOffset(snapshot, { version: snapshot.version, line: endLine.value, encoding: 'utf-16', character: endColumn.value });
  if (!start.ok || !end.ok || (end.value as number) < (start.value as number)) return { ok: false, error: 'completion range is invalid' };
  return { ok: true, value: { start: start.value, end: end.value, text: edit.newText } };
}

function planCompletionEdits(
  snapshot: DocumentSnapshot,
  selections: SelectionSetSnapshot,
  request: import('../../../packages/services/src/entrypoints/language').CompletionRequest,
  item: import('../../../packages/services/src/entrypoints/language').CompletionItem,
  edits: readonly import('../../../packages/services/src/entrypoints/language').CompletionTextEdit[],
  positionToOffset: typeof import('../../../packages/document/src/entrypoints/launch').positionToOffset,
  expandSnippet: typeof import('../../../packages/services/src/entrypoints/language').expandSnippet,
  primaryOnly: boolean,
): Result<CompletionEditPlan, string> {
  let snippetExpansion: import('../../../packages/services/src/entrypoints/language').SnippetExpansion | undefined;
  const converted: Array<{ readonly source: import('../../../packages/services/src/entrypoints/language').CompletionTextEdit; readonly edit: DocumentEdit }> = [];
  for (const source of edits) {
    let candidate = source;
    if (item.insertTextFormat === 'snippet' && item.textEdit !== undefined && source === item.textEdit) {
      const expanded = expandSnippet(source.newText);
      if (!expanded.ok) return { ok: false, error: `snippet is invalid: ${expanded.error.message}` };
      snippetExpansion = expanded.value;
      candidate = { ...source, newText: expanded.value.text };
    }
    const convertedEdit = completionEdit(snapshot, candidate, positionToOffset);
    if (!convertedEdit.ok) return convertedEdit;
    converted.push({ source, edit: convertedEdit.value });
  }
  const primarySource = item.textEdit === undefined ? undefined : converted.find((candidate) => candidate.source === item.textEdit)?.edit;
  const additional: DocumentEdit[] = [];
  const seenAdditional = new Set<string>();
  for (const candidate of converted) {
    if (candidate.source === item.textEdit) continue;
    const key = editKey(candidate.edit);
    if (seenAdditional.has(key)) continue;
    seenAdditional.add(key);
    additional.push(candidate.edit);
  }
  if (primarySource === undefined) {
    const proposalEdits = additional.slice();
    if (!nonOverlappingDocumentEdits(proposalEdits)) return { ok: false, error: 'additional edits overlap' };
    return { ok: true, value: { proposalEdits: Object.freeze(proposalEdits), memberEdits: new Map(), snippetExpansion: undefined } };
  }

  const primaryMember = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
  if (primaryMember === undefined || primaryMember.kind !== 'insert-caret') return { ok: false, error: 'active selection is incompatible with completion' };
  const requestLine = asLineIndex(request.position.line);
  const requestColumn = asUtf16Column(request.position.utf16);
  if (!requestLine.ok || !requestColumn.ok) return { ok: false, error: 'completion request position is invalid' };
  const requestOffset = positionToOffset(snapshot, { version: snapshot.version, line: requestLine.value, encoding: 'utf-16', character: requestColumn.value });
  if (!requestOffset.ok) return { ok: false, error: 'completion request is stale' };
  const primaryOffset = Number(requestOffset.value);
  const primaryStart = Number(primarySource.start);
  const primaryEnd = Number(primarySource.end);
  const primaryText = snapshot.slice(primarySource.start, primarySource.end);
  if (!primaryText.ok) return { ok: false, error: 'completion range is outside the current document' };
  const memberEdits = new Map<string, DocumentEdit>();
  const proposalEdits: DocumentEdit[] = [];
  for (const member of selections.members) {
    if (primaryOnly && member.id !== selections.primaryId) continue;
    if (member.kind !== 'insert-caret') return { ok: false, error: 'completion requires insert carets' };
    const memberOffset = Number(member.head.at.offset);
    const start = asUtf16Offset(memberOffset + primaryStart - primaryOffset);
    const end = asUtf16Offset(memberOffset + primaryEnd - primaryOffset);
    if (!start.ok || !end.ok || Number(end.value) < Number(start.value)) return { ok: false, error: 'completion replacement topology is incompatible' };
    const localText = snapshot.slice(start.value, end.value);
    if (!localText.ok || localText.value !== primaryText.value) return { ok: false, error: 'completion replacement context differs between carets' };
    const local = member.id === primaryMember.id ? primarySource : { start: start.value, end: end.value, text: primarySource.text };
    if (!nonOverlappingDocumentEdits([...proposalEdits, local])) return { ok: false, error: 'completion replacements overlap' };
    memberEdits.set(String(member.id), local);
    proposalEdits.push(local);
  }
  if (memberEdits.size === 0) return { ok: false, error: 'completion has no applicable selection' };
  const filteredAdditional = primaryOnly ? [] : additional.filter((edit) => ![...proposalEdits].some((candidate) => editKey(candidate) === editKey(edit)));
  const combined = [...proposalEdits, ...filteredAdditional];
  if (!nonOverlappingDocumentEdits(combined)) return { ok: false, error: 'additional edits overlap a selection replacement' };
  return { ok: true, value: { proposalEdits: Object.freeze(combined), memberEdits, snippetExpansion } };
}

function nonOverlappingDocumentEdits(edits: readonly DocumentEdit[]): boolean {
  const ordered = [...edits].sort((left, right) => Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end));
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1];
    const current = ordered[index];
    if (prior === undefined || current === undefined) continue;
    if (Number(current.start) < Number(prior.end) || (Number(current.start) === Number(prior.start) && Number(current.end) === Number(prior.end) && current.text !== prior.text)) return false;
  }
  return true;
}

function editKey(edit: DocumentEdit): string {
  return `${Number(edit.start)}:${Number(edit.end)}:${edit.text}`;
}

function mapPointThroughEdits(point: number, edits: readonly DocumentEdit[]): number {
  let delta = 0;
  const ordered = [...edits].sort((left, right) => Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end));
  for (const edit of ordered) {
    const start = Number(edit.start);
    const end = Number(edit.end);
    if (point < start) break;
    if (point >= end) delta += edit.text.length - (end - start);
  }
  return point + delta;
}

function pickerModeForLeader(event: { readonly name: string }): PickerMode | undefined {
  switch (event.name.toLowerCase()) {
    case 'f': return 'file';
    case 'b': return 'buffer';
    case ';': return 'command';
    case 't': return 'theme';
    case 'c': return 'config';
    default: return undefined;
  }
}

function keyEvent(raw: string, source: { readonly name: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean }): { readonly name: string; readonly raw: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean } {
  return { name: raw === ' ' ? '<Space>' : raw, raw, shift: source.shift, option: source.option, ctrl: source.ctrl, meta: source.meta };
}

function toExCommandLineInput(event: LauncherKeyEvent): ExCommandLineInput | undefined {
  const name = event.name.toLowerCase();
  if (name === 'enter' || name === 'return' || event.raw === '\r' || event.raw === '\n') return { kind: 'key', key: 'Enter' };
  if (name === 'tab' || event.raw === '\t') return { kind: 'key', key: 'Tab' };
  if (name === 'escape' || event.raw === '\u001b') return { kind: 'key', key: 'Escape' };
  if (name === 'backspace') return { kind: 'key', key: 'Backspace' };
  if (name === 'delete') return { kind: 'key', key: 'Delete' };
  if (name === 'arrowleft') return { kind: 'key', key: 'ArrowLeft' };
  if (name === 'arrowright') return { kind: 'key', key: 'ArrowRight' };
  if (name === 'arrowup') return { kind: 'key', key: 'ArrowUp' };
  if (name === 'arrowdown') return { kind: 'key', key: 'ArrowDown' };
  if (!event.ctrl && !event.meta && !event.option) {
    const text = event.raw.length === 0 && name === 'space' ? ' ' : event.raw;
    if (text.length === 1) return { kind: 'text', text };
  }
  return undefined;
}

interface LauncherKeyEvent {
  readonly name: string;
  readonly raw: string;
  readonly shift: boolean;
  readonly option: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

async function saveDocument(document: TextFileDocument, persistence: PersistenceService, path: string): Promise<boolean> {
  const cancellation = new CancellationSource();
  try {
    const saved = await persistence.saveFile(document, path, cancellation.token);
    if (!saved.ok) {
      process.stderr.write(`xi: cannot save ${path}: ${saved.error.kind}\n`);
      return false;
    }
    return true;
  } finally {
    cancellation.dispose();
  }
}

interface FormatterWorkbenchPort {
  applyTextEdits(
    viewId: ViewId,
    edits: readonly DocumentEdit[],
    undoGroup: UndoGroupId,
    origin: 'formatter',
    focus?: boolean,
  ): Promise<Result<unknown, unknown>>;
  applyDocumentEdits(
    documentId: DocumentId,
    edits: readonly DocumentEdit[],
    undoGroup: UndoGroupId,
    origin: 'formatter',
  ): Promise<Result<unknown, unknown>>;
}

async function saveWithConfiguredFormatter(
  document: TextFileDocument,
  persistence: PersistenceService,
  path: string,
  pipeline: FormatterPipeline | undefined,
  formatOnSave: boolean,
  workbench: FormatterWorkbenchPort,
  viewId: ViewId | undefined,
): Promise<boolean> {
  if (formatOnSave && pipeline !== undefined && !(await applyConfiguredFormatter(document, path, pipeline, workbench, viewId))) return false;
  const saved = await saveDocument(document, persistence, path);
  if (!saved) reportFormatterFailure('failed', `save failed for ${path}`);
  return saved;
}

async function applyConfiguredFormatter(
  document: TextFileDocument,
  path: string,
  pipeline: FormatterPipeline,
  workbench: FormatterWorkbenchPort,
  viewId: ViewId | undefined,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = document.snapshot();
    const text = fullDocumentText(snapshot);
    if (!text.ok) {
      reportFormatterFailure('failed', `cannot read document for formatting: ${text.error.kind}`);
      return false;
    }
    const cancellation = new CancellationSource();
    const result = await pipeline.formatTwiceStable({
      documentId: String(document.id),
      version: snapshot.version as number,
      text: text.value,
      path,
    }, () => document.version as number, cancellation.token);
    cancellation.dispose();
    if (!result.ok) {
      if (result.error.kind === 'stale' && attempt < 3) continue;
      reportFormatterFailure(result.error.kind, result.error.message);
      return false;
    }
    if (!result.value.changed) return true;
    const start = asUtf16Offset(0);
    const end = asUtf16Offset(snapshot.lengthUtf16 as number);
    if (!start.ok || !end.ok) {
      reportFormatterFailure('failed', 'formatter document range is invalid');
      return false;
    }
    const group = asUndoGroupId(`xi-formatter-${Date.now()}-${formatterOperationNumber += 1}`);
    if (!group.ok) {
      reportFormatterFailure('failed', group.error.message);
      return false;
    }
    const edit: DocumentEdit = { start: start.value, end: end.value, text: result.value.text };
    const applied = viewId === undefined
      ? await workbench.applyDocumentEdits(document.id, [edit], group.value, 'formatter')
      : await workbench.applyTextEdits(viewId, [edit], group.value, 'formatter', true);
    if (!applied.ok) {
      if (attempt < 3) continue;
      reportFormatterFailure('stale', `formatted document could not be applied: ${String(applied.error)}`);
      return false;
    }
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_FORMAT_APPLIED ${JSON.stringify({ documentId: String(document.id), version: result.value.expectedVersion, formatterIds: result.value.formatterIds })}\r\n`);
    return true;
  }
  reportFormatterFailure('stale', 'document kept changing while formatting');
  return false;
}

function reportFormatterFailure(kind: string, message: string): void {
  process.stderr.write(`xi: formatter ${kind}: ${message}\n`);
  if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_FORMAT_ERROR ${JSON.stringify({ kind, message })}\r\n`);
}

function createFormatterPipelineFromEnvironment(
  workspaceRoot: string,
  Pipeline: typeof import('../../../packages/services/src/entrypoints/launch').FormatterPipeline,
  createExternal: typeof import('../../../packages/services/src/entrypoints/launch').createExternalFormatter,
  Process: typeof import('../../../packages/platform/src/entrypoints/launch').NodeProcessPort,
): FormatterPipeline | undefined {
  const command = process.env.XI_FORMATTER_COMMAND?.trim();
  if (command === undefined || command.length === 0) return undefined;
  const rawArgs = process.env.XI_FORMATTER_ARGS;
  let args: string[] = [];
  if (rawArgs !== undefined) {
    try {
      const decoded: unknown = JSON.parse(rawArgs);
      if (!Array.isArray(decoded) || !decoded.every((value): value is string => typeof value === 'string')) throw new TypeError('formatter args must be a JSON string array');
      args = [...decoded];
    } catch (error: unknown) {
      reportFormatterFailure('failed', error instanceof Error ? error.message : 'formatter args are invalid');
      return undefined;
    }
  }
  return new Pipeline([createExternal({
    id: 'xi.environment-formatter',
    command,
    args,
    process: new Process(),
    cwd: workspaceRoot,
    env: processEnvironment(),
  })]);
}

function resolveFileArgument(argument: string): { readonly path: string; readonly label: string; readonly line?: number } {
  const match = /^(.*):(\d+)$/u.exec(argument);
  const path = match?.[1] ?? argument;
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return match === null
    ? { path, label: path.slice(separator + 1) || path }
    : { path, label: path.slice(separator + 1) || path, line: Number(match[2]) };
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'xi-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function languageIdForPath(path: string | undefined): string | undefined {
  const extension = path?.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  return undefined;
}

function serverSupportsFileOperation(
  session: { readonly health: { readonly capabilities: unknown }; supportsRequest?(method: string, uri?: string): boolean },
  kind: 'create' | 'rename' | 'delete',
  phase: 'will' | 'did',
): boolean {
  const method = `workspace/${phase}${kind === 'create' ? 'Create' : kind === 'rename' ? 'Rename' : 'Delete'}Files`;
  if (session.supportsRequest !== undefined) return session.supportsRequest(method);
  const capabilities = record(session.health.capabilities);
  const workspace = record(capabilities?.workspace);
  const fileOperations = record(workspace?.fileOperations);
  const key = `${phase}${kind === 'create' ? 'Create' : kind === 'rename' ? 'Rename' : 'Delete'}`;
  return fileOperations?.[key] !== undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function fileUri(path: string): string {
  const absolute = path.startsWith('/') ? path : `${process.cwd()}/${path}`;
  return `file://${absolute.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function workspacePathFromUri(uri: string): string | undefined {
  if (!uri.startsWith('file:///')) return undefined;
  try {
    const path = decodeURIComponent(uri.slice('file://'.length));
    return path.startsWith('/') && !path.includes('\0') ? path : undefined;
  } catch {
    return undefined;
  }
}

function readDocumentText(document: TextFileDocument): string | undefined {
  const content = fullDocumentText(document.snapshot());
  return content.ok ? content.value : undefined;
}

function fullDocumentText(snapshot: DocumentSnapshot): Result<string, { readonly kind: string }> {
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(snapshot.lengthUtf16);
  if (!start.ok || !end.ok) return { ok: false, error: { kind: 'invalid-range' } };
  const content = snapshot.slice(start.value, end.value);
  return content.ok ? content : { ok: false, error: { kind: content.error.kind } };
}

function createNodeClock(): ClockPort {
  return {
    monotonicMilliseconds: () => performance.now(),
    schedule: (delayMilliseconds, callback) => {
      const timer = setTimeout(callback, Math.max(0, delayMilliseconds));
      return { dispose: () => clearTimeout(timer) };
    },
    sleep: async (delayMilliseconds, cancellation) => {
      if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMilliseconds)));
      return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: undefined };
    },
  };
}

function processEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}

function textHash(bytes: Uint8Array): string {
  let first = 0xcbf29ce484222325n;
  let second = 0x9e3779b185ebca87n;
  for (const byte of bytes) {
    first ^= BigInt(byte);
    first = BigInt.asUintN(64, first * 0x100000001b3n);
    second ^= first >> 29n;
    second = BigInt.asUintN(64, second * 0x9e3779b185ebca87n);
  }
  return `${first.toString(16).padStart(16, '0')}${second.toString(16).padStart(16, '0')}`;
}

await main();
