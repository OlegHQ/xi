import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import type { Disposable, Result } from '../../packages/contracts/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import {
  ProblemsController,
  type DiagnosticsPort,
  type ProblemsDiagnostic,
  type ProblemsDiagnosticPublish,
  type ProblemsReadModel,
  type TaskControllerPort,
  type WorkbenchTaskConfig,
  type WorkbenchTaskMatchedProblem,
  type WorkbenchTaskOutputSnapshot,
  type WorkbenchTaskSpec,
} from '../../packages/workbench/problems/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-problems-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function key(name: string, raw: string): { readonly name: string; readonly raw: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean } {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

// -- A fake diagnostics store recording every publish/clearServer call; `publish` never
// enforces the real DiagnosticStore's per-uri generation guard itself -- this fixture only
// verifies the controller hands it a strictly increasing generation per finished task run,
// which is what lets the real store drop a stale one. --
class FakeDiagnostics implements DiagnosticsPort {
  model: ProblemsReadModel = { generation: 0, all: [] };
  readonly publishes: ProblemsDiagnosticPublish[] = [];
  readonly clearedServers: string[] = [];
  publish(input: ProblemsDiagnosticPublish): boolean {
    this.publishes.push(input);
    return true;
  }
  clearServer(serverId: string): void {
    this.clearedServers.push(serverId);
  }
}

// -- A fake task controller: `start()` synchronously drives straight to `exited`, notifying
// subscribers before returning, mirroring the real controller's eventual terminal-state
// notification closely enough for `runConfiguredTask`'s one-shot subscription to react. --
class FakeTaskController implements TaskControllerPort {
  #snapshot: WorkbenchTaskOutputSnapshot = { taskId: '', stdout: '', stderr: '', bytes: 0, truncated: false, state: 'idle', exitCode: null };
  readonly #listeners = new Set<(snapshot: WorkbenchTaskOutputSnapshot) => void>();
  readonly starts: WorkbenchTaskSpec[] = [];
  get snapshot(): WorkbenchTaskOutputSnapshot { return this.#snapshot; }
  subscribe(listener: (snapshot: WorkbenchTaskOutputSnapshot) => void): Disposable {
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }
  async start(spec: WorkbenchTaskSpec): Promise<Result<WorkbenchTaskOutputSnapshot, { readonly kind: 'spawn' | 'failed' | 'cancelled' | 'output-limit' | 'disposed'; readonly message: string }>> {
    this.starts.push(spec);
    this.#snapshot = { taskId: spec.id, stdout: 'ok', stderr: '', bytes: 2, truncated: false, state: 'exited', exitCode: 0 };
    for (const listener of [...this.#listeners]) listener(this.#snapshot);
    return { ok: true, value: this.#snapshot };
  }
  async cancel(): Promise<void> {
    this.#snapshot = { ...this.#snapshot, state: 'cancelled' };
  }
}

const launchDocumentId = id<DocumentId>('T116-problems-launch-document');
const launchDocument = document(launchDocumentId, 'alpha\n');
const session = new WorkbenchSession({ workspaceId: 'T116-problems' });
const launchViewId = id<ViewId>('T116-problems-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId });
const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

// A second, already-open buffer that a problem's uri resolves to -- exercising the same
// "reuse an already-open buffer" flow `openBufferAtPath` uses everywhere.
const problemDocumentId = id<DocumentId>('T116-problems-buffer-document');
const problemDocument = document(problemDocumentId, 'one\ntwo\nthree\n');
const problemViewId = id<ViewId>('T116-problems-buffer-view');
const openedProblemBuffer = session.openBuffer(problemDocument, { path: '/workspace/a.txt', viewId: problemViewId });
if (!openedProblemBuffer.ok) throw new Error(`T116-problems-open-buffer:${openedProblemBuffer.error.kind}`);
host.documents.set(problemDocument.id, problemDocument);
host.createSession(problemDocument, problemViewId);

const diagnostics = new FakeDiagnostics();
const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
const errors: string[] = [];
let taskControllerRequests = 0;
const fakeTaskController = new FakeTaskController();
const matchedByTask = new Map<string, readonly WorkbenchTaskMatchedProblem[]>([
  ['first', [{ file: 'a.txt', line: 3, column: 1, message: 'first failure', severity: 1 }]],
  ['second', [{ file: 'a.txt', line: 5, column: 2, message: 'second failure', severity: 1 }]],
]);
let currentTaskId = 'first';
const configs: readonly WorkbenchTaskConfig[] = Object.freeze([
  { id: 'first', argv: ['echo', 'first'] as const, env: {}, problemMatcher: 'generic-compiler' },
  { id: 'second', argv: ['echo', 'second'] as const, env: {}, problemMatcher: 'generic-compiler' },
]);

const controller = new ProblemsController({
  host,
  diagnostics,
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: (message) => { errors.push(message); },
  workspaceRoot: '/workspace',
  shell: ['test-shell', '-c'],
  resolvePath: (base, relative) => `${base}/${relative}`,
  fileUri: (path) => `file://${path}`,
  workspacePathFromUri: (uri) => (uri.startsWith('file:///workspace/') ? uri.slice('file://'.length) : undefined),
  processEnvironment: () => ({}),
  readTasksConfig: async () => ({ ok: true, value: configs }),
  matchTaskProblems: () => matchedByTask.get(currentTaskId) ?? [],
  ensureTaskController: async () => { taskControllerRequests += 1; return fakeTaskController; },
});

// T116-PROBLEMS-01: selection clamps to [0, count - 1] and Enter opens the selected problem
// through the host port (reusing the already-open buffer at its resolved path).
diagnostics.model = { generation: 1, all: [
  { id: 'p0', uri: 'file:///workspace/a.txt', range: { startLine: 0, startUtf16: 0 } },
  { id: 'p1', uri: 'file:///workspace/a.txt', range: { startLine: 2, startUtf16: 1 } },
] };
controller.openProblems();
assert.equal(controller.isProblemsOpen, true, 'T116-PROBLEMS-01a openProblems() marks the controller open');
assert.ok(markers.some((entry) => entry.name === 'XI_PROBLEMS_OPEN'), 'T116-PROBLEMS-01b an open marker was emitted');
assert.equal(controller.selectedProblemId(), 'p0', 'T116-PROBLEMS-01c selection starts at 0');
controller.handleProblemsKeypress(key('down', ''));
assert.equal(controller.selectedProblemId(), 'p1', 'T116-PROBLEMS-01d moving down selects the next problem');
controller.handleProblemsKeypress(key('down', ''));
assert.equal(controller.selectedProblemId(), 'p1', 'T116-PROBLEMS-01e moving down past the last problem clamps');
controller.handleProblemsKeypress(key('up', ''));
controller.handleProblemsKeypress(key('up', ''));
assert.equal(controller.selectedProblemId(), 'p0', 'T116-PROBLEMS-01f moving up past the first problem clamps at 0');
controller.setSelectedProblemIndex(1);
const selected = diagnostics.model.all[1];
if (selected === undefined) throw new Error('sanity: fixture problem missing');
await controller.openProblem(selected);
assert.equal(session.activeViewId, problemViewId, 'T116-PROBLEMS-01g opening the problem focused the already-open buffer through the host port');
assert.equal(controller.isProblemsOpen, false, 'T116-PROBLEMS-01h opening a problem closes the panel');

// T116-PROBLEMS-02: escape closes the problems panel without opening anything.
controller.openProblems();
assert.equal(controller.isProblemsOpen, true, 'sanity: reopened before escape');
controller.handleProblemsKeypress(key('escape', ''));
assert.equal(controller.isProblemsOpen, false, 'T116-PROBLEMS-02a escape closes the problems panel');
assert.ok(markers.some((entry) => entry.name === 'XI_PROBLEMS_CLOSED'), 'T116-PROBLEMS-02b a closed marker was emitted');

// T116-PROBLEMS-03: escape closes the output panel too, independently of the problems panel.
controller.openOutput();
assert.equal(controller.isOutputOpen, true, 'sanity: output panel opened');
controller.handleOutputKeypress(key('escape', ''));
assert.equal(controller.isOutputOpen, false, 'T116-PROBLEMS-03a escape closes the output panel');
assert.ok(markers.some((entry) => entry.name === 'XI_OUTPUT_CLOSED'), 'T116-PROBLEMS-03b a closed marker was emitted');

// T116-PROBLEMS-04: running a configured task publishes its matched problems into the shared
// diagnostics store with a strictly increasing generation per run -- the guard the real
// DiagnosticStore relies on to drop a stale run's diagnostics behind a fresher one.
currentTaskId = 'first';
await controller.runConfiguredTask('first');
assert.equal(taskControllerRequests, 1, 'T116-PROBLEMS-04a the task controller is constructed lazily, once');
assert.equal(diagnostics.clearedServers.at(-1), 'task:first', 'T116-PROBLEMS-04b the task-specific server is cleared before it (re)publishes');
assert.equal(diagnostics.publishes.length, 1, 'T116-PROBLEMS-04c the first run published once');
const firstGeneration = diagnostics.publishes[0]?.generation;
assert.equal(diagnostics.publishes[0]?.serverId, 'task:first', 'T116-PROBLEMS-04d published under the task-specific serverId');
assert.ok(markers.some((entry) => entry.name === 'XI_TASK_EXITED'), 'T116-PROBLEMS-04e an exited marker was emitted');

currentTaskId = 'second';
await controller.runConfiguredTask('second');
assert.equal(diagnostics.publishes.length, 2, 'T116-PROBLEMS-04f the second run published again');
const secondGeneration = diagnostics.publishes[1]?.generation;
assert.equal(typeof firstGeneration, 'number', 'sanity: first generation recorded');
assert.equal(typeof secondGeneration, 'number', 'sanity: second generation recorded');
assert.ok((secondGeneration as number) > (firstGeneration as number), 'T116-PROBLEMS-04g the second run used a strictly higher generation than the first');

await controller.runShellCommand('printf shell-ok');
const shellStart = fakeTaskController.starts.at(-1);
assert.deepEqual(shellStart?.argv, ['test-shell', '-c', 'printf shell-ok'], 'T116-PROBLEMS-05a :sh uses the configured shell argv');
assert.ok(markers.some((entry) => entry.name === 'XI_SHELL_STARTED'), 'T116-PROBLEMS-05b shell execution emits a start marker');

const beforeStaleJump = session.readView(problemViewId)?.selections;
await controller.openProblem({ ...selected, documentVersion: Number(problemDocument.version) + 1, range: { startLine: 0, startUtf16: 0 } });
assert.equal(session.readView(problemViewId)?.selections, beforeStaleJump, 'stale diagnostics cannot move the cursor');
assert.match(errors.at(-1) ?? '', /diagnostic is stale/u);
controller.dispose();

console.log('T116 ProblemsController passed selection-clamp/open-through-host, escape-close and increasing-task-generation fixtures');
