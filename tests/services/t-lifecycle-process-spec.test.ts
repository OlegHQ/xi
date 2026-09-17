import type {
  ClockPort,
  Disposable,
  PlatformFailure,
  ProcessHandle,
  ProcessPort,
  ProcessSpec,
  Result,
} from '../../packages/contracts/src/index';
import { LanguageServerSession } from '../../packages/services/language';
import type { LanguageServerConfig } from '../../packages/services/config';

type TestBody = () => void | Promise<void>;
const cases: { readonly id: string; readonly name: string; readonly body: TestBody }[] = [];

function test(id: string, name: string, body: TestBody): void {
  cases.push({ id, name, body });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

class SpecCapturePort implements ProcessPort {
  readonly specs: ProcessSpec[] = [];

  async spawn(spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
    this.specs.push(spec);
    // Non-retryable so the session disables itself after exactly one spawn attempt.
    return { ok: false, error: { code: 'ENOENT', message: 'fixture: no real language server executable', retryable: false } };
  }
}

class ImmediateClock implements ClockPort {
  monotonicMilliseconds(): number { return 0; }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { callback(); return { dispose() {} }; }
  async sleep(): Promise<Result<void, { readonly kind: 'cancelled' }>> { return { ok: true, value: undefined }; }
}

const config: LanguageServerConfig = Object.freeze({ name: 'fixture', command: 'fixture-lsp', args: [], rootMarkers: ['package.json'] });

test('LIFECYCLE-PROCESS-SPEC-NO-TIMEOUT-01', 'a session spawned with no processTimeoutMilliseconds has no wall-clock lifetime', async () => {
  const port = new SpecCapturePort();
  const session = new LanguageServerSession({
    process: port,
    clock: new ImmediateClock(),
    config,
    root: '/workspace',
    workspaceId: 'workspace-a',
  });
  const ready = await session.waitForReady();
  assert(!ready.ok, 'fixture spawn failure disables the session instead of retrying');
  equal(port.specs.length, 1, 'exactly one spawn attempt was made');
  const spec = port.specs[0];
  assert(spec !== undefined, 'a process spec was captured');
  assert(spec?.timeoutMilliseconds === undefined, 'a language server process spec must not carry a forced wall-clock lifetime by default');
  await session.dispose();
});

test('LIFECYCLE-PROCESS-SPEC-EXPLICIT-TIMEOUT-01', 'an explicit processTimeoutMilliseconds option is still honored', async () => {
  const port = new SpecCapturePort();
  const session = new LanguageServerSession({
    process: port,
    clock: new ImmediateClock(),
    config,
    root: '/workspace',
    workspaceId: 'workspace-b',
    processTimeoutMilliseconds: 1_234,
  });
  const ready = await session.waitForReady();
  assert(!ready.ok, 'fixture spawn failure disables the session instead of retrying');
  const spec = port.specs[0];
  equal(spec?.timeoutMilliseconds, 1_234, 'an explicitly configured process timeout is still passed through');
  await session.dispose();
});

for (const testCase of cases) {
  await testCase.body();
  console.log(`${testCase.id} passed: ${testCase.name}`);
}
console.log(`lifecycle process-spec cases passed: ${cases.length}`);
