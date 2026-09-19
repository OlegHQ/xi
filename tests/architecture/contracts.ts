import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { createApplication, TerminalStartupError } from '../../apps/xi/src/composition';
import { decodeJsonAtBoundary, type Decoder, type PlatformPorts, type RequestId } from '../../packages/contracts/src/index';
import { asIdentifier, DisposableScope, ScopedSignal, type Disposable } from '../../packages/primitives/src/index';
import type { WorkbenchReadPort } from '../../packages/workbench/src/index';
import type { TerminalAdapter } from '../../packages/ui/src/index';
import { analyzePackageSources } from '../../tools/check-import-graph';

type FailureStage = 'platform' | 'services' | 'workbench' | 'terminal-create' | 'terminal-start' | 'ui-mount';

export async function verifyArchitectureContracts(): Promise<readonly string[]> {
  const failures: string[] = [];
  await verifyHeadlessComposition(failures);
  await verifyPartialStartupUnwinds(failures);
  await verifyTerminalRestoreOnShutdown(failures);
  await verifySubscriptionDisposal(failures);
  verifyUiDocumentOwnershipBoundary(failures);
  verifyScopedLanguageProtocolDependencies(failures);
  verifyScopedTreeSitterDependency(failures);
  verifyAppEntrypointOnlyImports(failures);
  verifyServicesFeatureBoundary(failures);
  verifyUnknownDataValidation(failures);
  verifyCompositionRootOwnership(failures);
  await verifyWiringModulesCompose(failures);
  return failures;
}

/** ARCH-COMPOSITION-ROOT-01 follow-up: the language and git/explorer/search wiring modules
 * apps/xi/src/wiring/* extracted from `main()` must compose headlessly with fakes -- exactly
 * the "no module-level mutable state, explicit deps" contract the ticket requires -- and must
 * not leak disposables when the state they own is never actually populated (language wiring
 * with no resolvable launch file) or once it is populated and disposed (git wiring). */
async function verifyWiringModulesCompose(failures: string[]): Promise<void> {
  const { createLanguageWiring } = await import('../../apps/xi/src/wiring/language');
  const { createOptionalServicesWiring } = await import('../../apps/xi/src/wiring/optional-services');
  const { NodeFilesystemPort } = await import('../../packages/platform/src/entrypoints/launch');
  const { DiagnosticStore } = await import('../../packages/services/src/entrypoints/launch');
  const { openTextDocument } = await import('../../packages/document/src/entrypoints/launch');
  const { StatusMessageController } = await import('../../packages/workbench/src/entrypoints/launch');

  class FakeProcessPort {
    spawn(): ReturnType<import('../../packages/contracts/src/index').ProcessPort['spawn']> {
      return Promise.resolve({ ok: false, error: { code: 'fake-process-unavailable', message: 'architecture smoke: no process is ever actually spawned', retryable: false } });
    }
  }

  // Language wiring: a launch document with no resolvable languageId (no configured
  // languages, path undefined) never dials out -- `ensureLanguage()` must resolve cleanly
  // and every disposable-shaped getter must stay `undefined` (nothing was ever created, so
  // there is nothing to leak).
  const opened = openTextDocument(asDocumentId('architecture:wiring:language'), new TextEncoder().encode(''));
  if (opened.kind !== 'editable') { failures.push('ARCH-WIRING-COMPOSE-01: fake launch document failed to open'); return; }
  const diagnostics = new DiagnosticStore();
  const languageWiring = createLanguageWiring({
    filesystem: new NodeFilesystemPort(),
    ProcessPort: FakeProcessPort as unknown as typeof import('../../packages/platform/src/entrypoints/launch').NodeProcessPort,
    createClock: () => ({ monotonicMilliseconds: () => 0, schedule: () => ({ dispose() {} }), sleep: async () => ({ ok: true, value: undefined }) }),
    workspaceRoot: '/architecture-smoke',
    fileUri: (path) => `file://${path}`,
    processEnvironment: () => ({}),
    diagnostics,
    configuredLanguages: undefined,
    configuredLanguageServers: undefined,
    launchDocument: opened.document,
    launchDocumentPath: undefined,
    readDocumentText: () => '',
    workbenchBuffers: () => [],
    renameBufferPath: () => {},
    statusMessages: new StatusMessageController(),
  });
  await languageWiring.ensureLanguage();
  await languageWiring.ensureLanguage();
  if (languageWiring.session !== undefined || languageWiring.navigationController !== undefined || languageWiring.workspaceEditCoordinator !== undefined) {
    failures.push('ARCH-WIRING-COMPOSE-01: language wiring created language-server state with no launch file to admit');
  }
  diagnostics.dispose();

  // Git/explorer/search wiring: the one lazy `ensure()` promise must construct every service
  // exactly once (idempotent under concurrent callers) using only the injected process/filesystem
  // ports (never a real `git`/`rg` invocation), and every constructed disposable must accept
  // `.dispose()` without throwing.
  const explorerOpenCalls: unknown[] = [];
  const attachTreeCalls: unknown[] = [];
  const optionalServices = createOptionalServicesWiring({
    filesystem: new NodeFilesystemPort(),
    ProcessPort: FakeProcessPort as unknown as typeof import('../../packages/platform/src/entrypoints/launch').NodeProcessPort,
    workspaceRoot: '/architecture-smoke',
    fileUri: (path) => `file://${path}`,
    processEnvironment: () => ({}),
    notifySurfaceChange: () => {},
    createExplorerFilesystem: () => ({
      enumerateDirectory: async () => ({ ok: true, value: [] }),
      watchDirectory: async () => ({ ok: true, value: { dispose() {} } }),
    }),
    createGitDecorationPort: () => ({ read: async () => ({ ok: true, value: undefined }) }),
    getExplorerFeature: () => ({
      openNode: (node) => { explorerOpenCalls.push(node); },
      attachTree: (tree, controller) => { attachTreeCalls.push([tree, controller]); return { dispose() {} }; },
    }),
    getSearchFeature: () => ({
      readBuffers: () => [],
      // Never exercised by this smoke (no replace flow runs): only its construction/wiring is checked.
      createReplacePort: () => ({
        apply: (): Promise<never> => { throw new Error('architecture smoke never calls the replace port'); },
        readTarget: (): Promise<never> => { throw new Error('architecture smoke never calls the replace port'); },
        restore: (): Promise<never> => { throw new Error('architecture smoke never calls the replace port'); },
      }),
      attachServices: () => {},
    }),
  });
  const [first, second] = await Promise.all([optionalServices.ensure(), optionalServices.ensure()]);
  if (first.gitStatusService === undefined || first.explorerTree === undefined || first.searchService === undefined || first !== second) {
    failures.push('ARCH-WIRING-COMPOSE-01: optional-services wiring did not construct git/explorer/search under a single ensure()');
  }
  try {
    first.explorerSubscription.dispose();
    first.searchService.dispose();
    first.replaceService.dispose();
    first.hostNavigation.dispose();
    first.explorerController.dispose();
    first.explorerTree.dispose();
  } catch (error: unknown) {
    failures.push(`ARCH-WIRING-COMPOSE-01: optional-services disposables threw on dispose: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asDocumentId(value: string): import('../../packages/primitives/src/index').DocumentId {
  const result = asIdentifier<import('../../packages/primitives/src/index').DocumentId>(value, 'architecture-smoke-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function verifyHeadlessComposition(failures: string[]): Promise<void> {
  const trace: string[] = [];
  const application = await createApplication({
    requestId: id('architecture:headless'),
    platform: { create: async (scope) => { scope.add(resource(trace, 'platform')); return fakePorts(); } },
    createServices: async ({ scope }) => { scope.add(resource(trace, 'services')); return { name: 'fake-services' }; },
    createWorkbench: async ({ scope }) => {
      scope.add(resource(trace, 'workbench'));
      return fakeWorkbench();
    },
  });

  if (application.services.name !== 'fake-services' || application.workbench.activeViewId !== undefined) {
    failures.push('ARCH-FAKE-COMPOSE-01: injected headless services did not compose');
  }
  await application.dispose();
  if (trace.join(',') !== 'workbench,services,platform') {
    failures.push(`ARCH-FAKE-COMPOSE-01: unexpected headless cleanup order ${trace.join(',')}`);
  }
}

async function verifyPartialStartupUnwinds(failures: string[]): Promise<void> {
  const cases: readonly { readonly stage: FailureStage; readonly expected: readonly string[] }[] = [
    { stage: 'platform', expected: ['platform'] },
    { stage: 'services', expected: ['services', 'platform'] },
    { stage: 'workbench', expected: ['workbench', 'services', 'platform'] },
    { stage: 'terminal-create', expected: ['terminal-partial', 'workbench', 'services', 'platform'] },
    { stage: 'terminal-start', expected: ['terminal-restore', 'terminal-dispose', 'workbench', 'services', 'platform'] },
    { stage: 'ui-mount', expected: ['ui-partial', 'terminal-restore', 'terminal-dispose', 'workbench', 'services', 'platform'] },
  ];

  for (const testCase of cases) {
    const trace: string[] = [];
    const originalFailure = new Error(`injected-${testCase.stage}`);
    let observedFailure: unknown;
    try {
      await createApplication({
        requestId: id(`architecture:${testCase.stage}`),
        platform: {
          create: async (scope) => {
            scope.add(resource(trace, 'platform'));
            if (testCase.stage === 'platform') throw originalFailure;
            return fakePorts();
          },
        },
        createServices: async ({ scope }) => {
          scope.add(resource(trace, 'services'));
          if (testCase.stage === 'services') throw originalFailure;
          return { name: 'fake-services' };
        },
        createWorkbench: async ({ scope }) => {
          scope.add(resource(trace, 'workbench'));
          if (testCase.stage === 'workbench') throw originalFailure;
          return fakeWorkbench();
        },
        ui: {
          terminal: {
            create: async (scope) => {
              if (testCase.stage === 'terminal-create') {
                scope.add(resource(trace, 'terminal-partial'));
                throw originalFailure;
              }
              return terminalAdapter(trace, testCase.stage === 'terminal-start');
            },
          },
          mount: async ({ scope }) => {
            scope.add(resource(trace, 'ui-partial'));
            if (testCase.stage === 'ui-mount') throw originalFailure;
            return resource(trace, 'ui');
          },
        },
      });
      failures.push(`ARCH-PARTIAL-START-01: ${testCase.stage} failure did not abort startup`);
    } catch (error: unknown) {
      observedFailure = error;
    }

    const rightError = testCase.stage === 'terminal-start'
      ? observedFailure instanceof TerminalStartupError
      : observedFailure === originalFailure;
    if (!rightError) failures.push(`ARCH-PARTIAL-START-01: ${testCase.stage} did not preserve the startup failure`);
    if (trace.join(',') !== testCase.expected.join(',')) {
      failures.push(`ARCH-PARTIAL-START-01: ${testCase.stage} cleanup was ${trace.join(',')}, expected ${testCase.expected.join(',')}`);
    }
  }
}

async function verifySubscriptionDisposal(failures: string[]): Promise<void> {
  const startedAt = performance.now();
  for (let cycle = 0; cycle < 1_000; cycle += 1) {
    const scope = new DisposableScope();
    const signal = scope.add(new ScopedSignal<number>());
    let received = 0;
    signal.subscribe(() => { received += 1; }, scope);
    signal.emit(1);
    await scope.dispose();
    signal.emit(2);
    if (received !== 1 || signal.subscriberCount !== 0) {
      failures.push(`ARCH-LEAK-SUBSCRIPTION-1000-01: cycle ${cycle} fired after disposal or retained a listener`);
      return;
    }
  }
  console.log(`ARCH-LEAK-SUBSCRIPTION-1000-01 passed: 1,000 create/subscribe/dispose cycles in ${(performance.now() - startedAt).toFixed(3)} ms.`);
}

function verifyUiDocumentOwnershipBoundary(failures: string[]): void {
  const injectedUiDocumentImport = analyzePackageSources([
    {
      path: 'packages/ui/src/t015-negative-fixture.ts',
      text: "import type { DocumentReadPort } from '../../document/src/index.ts';\n",
    },
    { path: 'packages/document/src/index.ts', text: 'export interface DocumentReadPort {}\n' },
  ]);
  if (!injectedUiDocumentImport.some((failure) => failure.includes('forbidden dependency ui -> document'))) {
    failures.push('ARCH-UI-DOCUMENT-01: graph checker accepted a UI-to-document import');
  }
}

function verifyScopedLanguageProtocolDependencies(failures: string[]): void {
  const allowedServicesImports = analyzePackageSources([
    {
      path: 'packages/services/language/index.ts',
      text: "import { createMessageConnection } from 'vscode-jsonrpc/browser';\nimport { createProtocolConnection } from 'vscode-languageserver-protocol/browser';\n",
    },
  ]);
  if (allowedServicesImports.length !== 0) {
    failures.push(`ARCH-LSP-OWNER-01: language service dependencies were rejected (${allowedServicesImports.join('; ')})`);
  }

  const forbiddenImports = analyzePackageSources([
    {
      path: 'packages/vim/src/index.ts',
      text: "import { createMessageConnection } from 'vscode-jsonrpc/browser';\nimport { createProtocolConnection } from 'vscode-languageserver-protocol/browser';\n",
    },
    {
      path: 'packages/services/search/index.ts',
      text: "import { createMessageConnection } from 'vscode-jsonrpc/browser';\nimport { createProtocolConnection } from 'vscode-languageserver-protocol/browser';\n",
    },
  ]);
  const rejectedBothOutsideLanguage = ['vscode-jsonrpc/browser', 'vscode-languageserver-protocol/browser']
    .every((specifier) => forbiddenImports.some((failure) => failure.includes(`undeclared external dependency ${specifier} in vim`))
      && forbiddenImports.some((failure) => failure.includes(`only allowed in packages/services/language`)));
  if (!rejectedBothOutsideLanguage) {
    failures.push('ARCH-LSP-OWNER-01: an owner outside services/language was allowed to import an LSP protocol dependency');
  }
}

/** `web-tree-sitter` is restricted to packages/services/syntax, mirroring the LSP-owner rule above. */
function verifyScopedTreeSitterDependency(failures: string[]): void {
  const allowedSyntaxImport = analyzePackageSources([
    { path: 'packages/services/syntax/index.ts', text: "import type { Parser } from 'web-tree-sitter';\n" },
  ]);
  if (allowedSyntaxImport.length !== 0) {
    failures.push(`ARCH-TREE-SITTER-OWNER-01: syntax's own tree-sitter dependency was rejected (${allowedSyntaxImport.join('; ')})`);
  }

  const forbiddenTreeSitterImport = analyzePackageSources([
    { path: 'packages/services/search/index.ts', text: "import type { Parser } from 'web-tree-sitter';\n" },
  ]);
  if (!forbiddenTreeSitterImport.some((failure) => failure.includes('only allowed in packages/services/syntax'))) {
    failures.push('ARCH-TREE-SITTER-OWNER-01: an owner outside services/syntax was allowed to import web-tree-sitter');
  }
}

/** `apps/xi` may only reach another owner through that owner's `src/entrypoints/` path, never its plain `src/index.ts`. */
function verifyAppEntrypointOnlyImports(failures: string[]): void {
  const deepIndexImport = analyzePackageSources([
    { path: 'apps/xi/src/t122-negative-fixture.ts', text: "import type { WorkbenchReadPort } from '../../../packages/workbench/src/index.ts';\n" },
    { path: 'packages/workbench/src/index.ts', text: 'export interface WorkbenchReadPort {}\n' },
  ]);
  if (!deepIndexImport.some((failure) => failure.includes('apps/xi must import workbench via a packages/workbench/src/entrypoints/ path'))) {
    failures.push('ARCH-APP-ENTRYPOINT-01: graph checker accepted an apps/xi import of a package index.ts instead of its entrypoints/ path');
  }

  const entrypointImport = analyzePackageSources([
    { path: 'apps/xi/src/t122-positive-fixture.ts', text: "import type { WorkbenchReadPort } from '../../../packages/workbench/src/entrypoints/launch.ts';\n" },
    { path: 'packages/workbench/src/entrypoints/launch.ts', text: 'export interface WorkbenchReadPort {}\n' },
  ]);
  if (entrypointImport.length !== 0) {
    failures.push(`ARCH-APP-ENTRYPOINT-01: apps/xi's entrypoints/ import was rejected (${entrypointImport.join('; ')})`);
  }
}

/** Within packages/services, one feature reaches another only through that feature's public `index.ts`. */
function verifyServicesFeatureBoundary(failures: string[]): void {
  const deepFeatureImport = analyzePackageSources([
    { path: 'packages/services/language/t122-negative-fixture.ts', text: "import type { ConfigSnapshot } from '../config/somefile.ts';\n" },
    { path: 'packages/services/config/somefile.ts', text: 'export interface ConfigSnapshot {}\n' },
    { path: 'packages/services/config/index.ts', text: 'export interface ConfigSnapshot {}\n' },
  ]);
  if (!deepFeatureImport.some((failure) => failure.includes('deep cross-feature import into services/config'))) {
    failures.push('ARCH-SERVICES-FEATURE-01: graph checker accepted a deep cross-feature services import');
  }

  const indexFeatureImport = analyzePackageSources([
    { path: 'packages/services/language/t122-positive-fixture.ts', text: "import type { ConfigSnapshot } from '../config/index.ts';\n" },
    { path: 'packages/services/config/index.ts', text: 'export interface ConfigSnapshot {}\n' },
  ]);
  if (indexFeatureImport.length !== 0) {
    failures.push(`ARCH-SERVICES-FEATURE-01: a services feature's own index.ts import was rejected (${indexFeatureImport.join('; ')})`);
  }
}

async function verifyTerminalRestoreOnShutdown(failures: string[]): Promise<void> {
  const trace: string[] = [];
  const application = await createApplication({
    requestId: id('architecture:terminal-shutdown'),
    platform: { create: async (scope) => { scope.add(resource(trace, 'platform')); return fakePorts(); } },
    createServices: async ({ scope }) => { scope.add(resource(trace, 'services')); return { name: 'fake-services' }; },
    createWorkbench: async ({ scope }) => { scope.add(resource(trace, 'workbench')); return fakeWorkbench(); },
    ui: {
      terminal: { create: async () => terminalAdapter(trace, false) },
      mount: async () => resource(trace, 'ui'),
    },
  });
  await application.dispose();
  const expected = 'ui,terminal-restore,terminal-dispose,workbench,services,platform';
  if (trace.join(',') !== expected) {
    failures.push(`ARCH-TERMINAL-RESTORE-01: shutdown trace was ${trace.join(',')}, expected ${expected}`);
  }
}

function verifyUnknownDataValidation(failures: string[]): void {
  const knownKind: Decoder<{ readonly kind: 'known' }> = {
    decode(input: unknown) {
      if (typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'known') {
        return { ok: true as const, value: { kind: 'known' as const } };
      }
      return { ok: false as const, error: [{ path: 'kind', code: 'unknown-discriminant' as const, message: 'unsupported message kind' }] };
    },
  };
  const valid = decodeJsonAtBoundary(asciiBytes('{"kind":"known"}'), knownKind);
  const unknown = decodeJsonAtBoundary(asciiBytes('{"kind":"future-version"}'), knownKind);
  const invalidJson = decodeJsonAtBoundary(asciiBytes('{not-json'), knownKind);
  const invalidUtf8 = decodeJsonAtBoundary(new Uint8Array([0xff]), knownKind);
  if (!valid.ok || unknown.ok || (unknown.ok === false && unknown.error.kind !== 'schema')) {
    failures.push('ARCH-UNKNOWN-DISCRIMINANT-01: schema failed open on unknown data');
  }
  if (invalidJson.ok || (invalidJson.ok === false && invalidJson.error.kind !== 'invalid-json')) {
    failures.push('ARCH-BOUNDARY-JSON-01: malformed JSON was not rejected at the boundary');
  }
  if (invalidUtf8.ok || (invalidUtf8.ok === false && invalidUtf8.error.kind !== 'invalid-utf8')) {
    failures.push('ARCH-BOUNDARY-UTF8-01: malformed UTF-8 was not rejected at the boundary');
  }
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

/**
 * `apps/xi` (the composition root) may only construct, wire, start, stop and parse CLI
 * arguments (01-architecture's ownership table); it must never re-grow feature state or
 * per-key/per-pointer/per-command handlers that belong to a workbench feature controller
 * (T116 S4-S9). Checked structurally over the real AST (via `oxc-parser`, already a
 * devDependency used by `tools/lint/check.ts`) rather than by regex over source text, per
 * the ticket's own requirement.
 */
const FORBIDDEN_HANDLER_NAME = /^handle\w*(Keypress|Pointer|Command)$/u;
const FORBIDDEN_OPEN_CLOSE_NAME = /^(open|close)\w+$/u;
const FORBIDDEN_LET_SUFFIXES = ['Open', 'Pending', 'Query', 'SelectedIndex', 'Draft', 'Generation', 'Serial'];
const MAIN_FUNCTION_LINE_BUDGET = 120;
const MAIN_OWN_LINE_BUDGET = 200;
const MAIN_LET_BUDGET = 0;

interface OxcNode { readonly type?: string; readonly [key: string]: unknown }

function walkAst(node: unknown, visit: (node: OxcNode) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit);
    return;
  }
  const record = node as OxcNode;
  if (typeof record.type === 'string') visit(record);
  for (const key of Object.keys(record)) {
    if (key === 'type') continue;
    const value = record[key];
    if (value !== null && typeof value === 'object') walkAst(value, visit);
  }
}

function functionLikeName(node: OxcNode): string | undefined {
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
    const id = node.id as OxcNode | null | undefined;
    return id?.type === 'Identifier' ? (id as { readonly name: string }).name : undefined;
  }
  return undefined;
}

function namedFunctionLikeDeclarations(program: OxcNode): readonly { readonly name: string; readonly node: OxcNode }[] {
  const results: { readonly name: string; readonly node: OxcNode }[] = [];
  walkAst(program, (node) => {
    const declaredName = functionLikeName(node);
    if (declaredName !== undefined) { results.push({ name: declaredName, node }); return; }
    if (node.type === 'VariableDeclarator') {
      const id = node.id as OxcNode;
      const init = node.init as OxcNode | null | undefined;
      if (id.type === 'Identifier' && (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression')) {
        results.push({ name: (id as { readonly name: string }).name, node: init });
      }
      return;
    }
    if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      // Class members only -- deliberately excludes plain `ObjectExpression` `Property`
      // wiring fields (e.g. `openFile: (path) => host.openBufferAtPath(path)` passed into a
      // controller's options), which are pass-through callbacks the ownership table
      // explicitly wants (constructing/wiring), not a declared handler owned by `main()`.
      const key = node.key as OxcNode | undefined;
      if (key?.type === 'Identifier') results.push({ name: (key as { readonly name: string }).name, node });
    }
  });
  return results;
}

function letDeclaredNames(program: OxcNode): readonly string[] {
  const names: string[] = [];
  walkAst(program, (node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'let') return;
    for (const declarator of node.declarations as readonly OxcNode[]) {
      const id = declarator.id as OxcNode;
      if (id.type === 'Identifier') names.push((id as { readonly name: string }).name);
    }
  });
  return names;
}

function nodeLineSpan(sourceText: string, node: OxcNode): number {
  const start = node.start as number;
  const end = node.end as number;
  const startLine = countNewlines(sourceText, 0, start);
  const endLine = countNewlines(sourceText, 0, end);
  return endLine - startLine + 1;
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function collectSourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(path));
    else if (/\.[cm]?tsx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

/** Finds a top-level (module-scope) `function main(...)` declaration, if this file has one. */
function findTopLevelMainFunction(program: OxcNode): OxcNode | undefined {
  const body = program.body as readonly OxcNode[] | undefined;
  for (const statement of body ?? []) {
    if (statement.type !== 'FunctionDeclaration') continue;
    const id = statement.id as OxcNode | null | undefined;
    if (id?.type === 'Identifier' && (id as { readonly name: string }).name === 'main') return statement;
  }
  return undefined;
}

function verifyCompositionRootOwnership(failures: string[]): void {
  const root = 'apps/xi';
  let mainFileChecked = false;
  for (const file of collectSourceFiles(root)) {
    const sourceText = readFileSync(file, 'utf8');
    const parsed = parseSync(file, sourceText);
    const program = parsed.program as unknown as OxcNode;
    // Module-scope composition helpers (e.g. `openDocument`, `resolveFileArgument`) are
    // stateless utility functions the ownership table explicitly allows; (a)/(b) instead
    // target closure state hidden *inside* the composition root's own `main()`, matching
    // what T116 S4-S9 actually moved out. A file with no top-level `main` has nothing to
    // scope to, so nothing here is exempt for it.
    const scope = findTopLevelMainFunction(program) ?? program;

    for (const { name } of namedFunctionLikeDeclarations(scope)) {
      if (FORBIDDEN_HANDLER_NAME.test(name) || FORBIDDEN_OPEN_CLOSE_NAME.test(name)) {
        failures.push(`ARCH-COMPOSITION-ROOT-01: ${file} declares forbidden handler-shaped name '${name}' inside main() (feature state belongs in a workbench controller)`);
      }
    }

    for (const name of letDeclaredNames(scope)) {
      if (FORBIDDEN_LET_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
        failures.push(`ARCH-COMPOSITION-ROOT-01: ${file} declares forbidden feature-state 'let ${name}' inside main() (belongs in a workbench controller)`);
      }
    }

    if (file.endsWith('/main.ts')) {
      mainFileChecked = true;
      walkAst(program, (node) => {
        if (node.type !== 'FunctionDeclaration') return;
        const id = node.id as OxcNode | null | undefined;
        const name = id?.type === 'Identifier' ? (id as { readonly name: string }).name : undefined;
        if (name === 'main') return;
        const lines = nodeLineSpan(sourceText, node);
        if (lines > MAIN_FUNCTION_LINE_BUDGET) {
          failures.push(`ARCH-COMPOSITION-ROOT-01: ${file} declares function '${name ?? '<anonymous>'}' spanning ${lines} lines (budget ${MAIN_FUNCTION_LINE_BUDGET}; only 'main' is exempt)`);
        }
      });

      // `main()` itself: bounded so state-heavy clusters (language/git/tasks/theme/controller/
      // pointer/UI wiring) stay pushed out into apps/xi/src/wiring/* modules instead of
      // accreting back into the composition root as `let`s and inline init logic (T116
      // follow-up). The budgets are calibrated against the composition-root-cleanup result
      // (main() reads as parse CLI -> construct ports -> construct services -> construct
      // workbench controllers (one call) -> wire UI (one call) -> start -> await shutdown,
      // ~135 lines / 0 `let`s), far below the pre-refactor shapes this replaces (928 lines /
      // 36 `let`s originally; 765 lines / 5 `let`s after T116 S4-S9).
      const mainNode = findTopLevelMainFunction(program);
      if (mainNode !== undefined) {
        const mainLines = nodeLineSpan(sourceText, mainNode);
        if (mainLines > MAIN_OWN_LINE_BUDGET) {
          failures.push(`ARCH-COMPOSITION-ROOT-01: ${file} main() spans ${mainLines} lines (budget ${MAIN_OWN_LINE_BUDGET}; push state-heavy clusters into apps/xi/src/wiring/*)`);
        }
        const mainLetCount = letDeclaredNames(mainNode).length;
        if (mainLetCount > MAIN_LET_BUDGET) {
          failures.push(`ARCH-COMPOSITION-ROOT-01: ${file} main() declares ${mainLetCount} 'let's (budget ${MAIN_LET_BUDGET}; feature/service state belongs in a wiring module or controller)`);
        }
      }
    }
  }
  if (!mainFileChecked) failures.push(`ARCH-COMPOSITION-ROOT-01: ${root}/src/main.ts was not found to check`);
}

function fakeWorkbench(): WorkbenchReadPort {
  return {
    activeViewId: undefined,
    readView: () => undefined,
    readDocument: () => undefined,
  };
}

function fakePorts(): PlatformPorts {
  return {
    process: { spawn: async () => ({ ok: false, error: { code: 'not-used', message: 'fake process', retryable: false } }) },
    filesystem: {
      readFile: async () => ({ ok: false, error: { code: 'not-used', message: 'fake fs', retryable: false } }),
      writeFileAtomic: async () => ({ ok: false, error: { code: 'not-used', message: 'fake fs', retryable: false } }),
      stat: async () => ({ ok: false, error: { code: 'not-used', message: 'fake fs', retryable: false } }),
      watch: async () => ({ ok: false, error: { code: 'not-used', message: 'fake fs', retryable: false } }),
    },
    clock: {
      monotonicMilliseconds: () => 0,
      schedule: () => ({ dispose() {} }),
      sleep: async (_delay, cancellation) => cancellation.isCancelled
        ? { ok: false, error: { kind: 'cancelled' } }
        : { ok: true, value: undefined },
    },
    clipboard: {
      readText: async () => ({ ok: false, error: { code: 'not-used', message: 'fake clipboard', retryable: false } }),
      writeText: async () => ({ ok: false, error: { code: 'not-used', message: 'fake clipboard', retryable: false } }),
    },
  };
}

function terminalAdapter(trace: string[], failStart: boolean): TerminalAdapter {
  const adapter: TerminalAdapter = {
    start: async () => failStart
      ? { ok: false, error: { code: 'injected-terminal-failure', message: 'terminal start failed', retryable: false } }
      : { ok: true, value: undefined },
    suspend: async () => ({ ok: true, value: undefined }),
    resume: async () => ({ ok: true, value: undefined }),
    restore: async () => { trace.push('terminal-restore'); },
    dispose: async () => { trace.push('terminal-dispose'); },
  };
  return adapter;
}

function resource(trace: string[], name: string): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) throw new Error(`double-dispose:${name}`);
      disposed = true;
      trace.push(name);
    },
  };
}

function id(value: string): RequestId {
  const result = asIdentifier<RequestId>(value, 'requestId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export async function runArchitectureContractCheck(): Promise<void> {
  const failures = await verifyArchitectureContracts();
  if (failures.length > 0) throw new Error(failures.join('\n'));
  console.log('Architecture contracts passed: ARCH-FAKE-COMPOSE-01, ARCH-PARTIAL-START-01, ARCH-TERMINAL-RESTORE-01, ARCH-UI-DOCUMENT-01, ARCH-LSP-OWNER-01, ARCH-TREE-SITTER-OWNER-01, ARCH-APP-ENTRYPOINT-01, ARCH-SERVICES-FEATURE-01, ARCH-UNKNOWN-DISCRIMINANT-01, ARCH-BOUNDARY-JSON-01, ARCH-BOUNDARY-UTF8-01, ARCH-COMPOSITION-ROOT-01.');
}

if (import.meta.main) await runArchitectureContractCheck();
