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
  verifyUnknownDataValidation(failures);
  return failures;
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
  console.log('Architecture contracts passed: ARCH-FAKE-COMPOSE-01, ARCH-PARTIAL-START-01, ARCH-TERMINAL-RESTORE-01, ARCH-UI-DOCUMENT-01, ARCH-LSP-OWNER-01, ARCH-UNKNOWN-DISCRIMINANT-01, ARCH-BOUNDARY-JSON-01, ARCH-BOUNDARY-UTF8-01.');
}

if (import.meta.main) await runArchitectureContractCheck();
