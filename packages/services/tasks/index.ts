import type { CancellationToken, Disposable, ProcessPort, Result } from '../../contracts/src/index';

export interface TaskSpec { readonly id: string; readonly argv: readonly [string, ...string[]]; readonly cwd: string; readonly env?: Readonly<Record<string, string>>; readonly maxOutputBytes?: number; }
export interface TaskProcess extends Disposable { readonly exit: Promise<Result<{ readonly code: number | null; readonly signal: string | null }, TaskFailure>>; onStdout(listener: (bytes: Uint8Array) => void): Disposable; onStderr(listener: (bytes: Uint8Array) => void): Disposable; terminate(): Promise<void>; }
export interface TaskProcessFactory { spawn(spec: TaskSpec): Promise<Result<TaskProcess, TaskFailure>>; }

const DEFAULT_TASK_TIMEOUT_MILLISECONDS = 24 * 60 * 60 * 1000;

/** A real, argv-only child-process-backed TaskProcessFactory. Every process effect stays
 * behind the pre-existing ProcessPort (Bun.spawn adapter); this only adapts its
 * async-iterable stdout/stderr streams into TaskProcess's callback-listener shape. */
export function createSpawnTaskProcessFactory(process: ProcessPort, cancellation: CancellationToken, timeoutMilliseconds = DEFAULT_TASK_TIMEOUT_MILLISECONDS): TaskProcessFactory {
  return {
    async spawn(spec: TaskSpec): Promise<Result<TaskProcess, TaskFailure>> {
      const spawned = await process.spawn({
        argv: spec.argv,
        cwd: spec.cwd,
        env: spec.env ?? {},
        stdin: 'ignore',
        timeoutMilliseconds,
        cancellation,
      });
      if (!spawned.ok) return { ok: false, error: { kind: 'spawn', message: spawned.error.message } };
      const handle = spawned.value;
      const stdoutListeners = new Set<(bytes: Uint8Array) => void>();
      const stderrListeners = new Set<(bytes: Uint8Array) => void>();
      // A stream error here (e.g. the pipe torn down after termination) must not
      // become an unhandled rejection; the process's own exit result already
      // reports whether the run failed, so a pump failure is otherwise inert.
      void pump(handle.stdout, stdoutListeners).catch(() => {});
      void pump(handle.stderr, stderrListeners).catch(() => {});
      return {
        ok: true,
        value: {
          exit: handle.exit.then((exit) => exit.ok ? exit : { ok: false, error: { kind: 'failed' as const, message: exit.error.message } }),
          onStdout(listener) { stdoutListeners.add(listener); return { dispose: () => { stdoutListeners.delete(listener); } }; },
          onStderr(listener) { stderrListeners.add(listener); return { dispose: () => { stderrListeners.delete(listener); } }; },
          async terminate() { await handle.terminate(250); },
          dispose() { handle.dispose(); },
        },
      };
    },
  };
}

async function pump(stream: AsyncIterable<Uint8Array>, listeners: Set<(bytes: Uint8Array) => void>): Promise<void> {
  for await (const chunk of stream) for (const listener of listeners) listener(chunk);
}

/** Strip ANSI/VT escape sequences (CSI/OSC and bare control bytes) from task output before
 * it is retained -- a bounded scrollback of raw ANSI is not a terminal emulator (per
 * docs/plan/04-services.md), so task output is sanitized to plain text at ingestion. */
export function stripAnsiEscapes(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** One line-oriented problem-matcher rule: a regex whose named capture groups (or
 * fixed indices) locate a file/line/message triple in one line of task output. */
export interface TaskProblemMatcher {
  readonly pattern: RegExp;
  readonly file: number;
  readonly line: number;
  readonly column?: number;
  readonly message: number;
  /** Capture group holding the literal word "error"/"warning"; falls back to `severity`. */
  readonly severityGroup?: number;
  readonly severity?: 1 | 2 | 3 | 4;
}

export interface TaskMatchedProblem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: 1 | 2 | 3 | 4 | undefined;
}

/** A generic compiler-style "file:line:col: message" matcher (tsc, gcc, eslint --format unix, ...). */
export const GENERIC_COMPILER_PROBLEM_MATCHER: TaskProblemMatcher = {
  pattern: /^(.+?)[:(](\d+)[,:](\d+)\)?:?\s*(?:(error|warning)\s*(?:[A-Z0-9]+)?:?)?\s*(.+)$/,
  file: 1,
  line: 2,
  column: 3,
  message: 5,
  severityGroup: 4,
};

export function matchTaskProblems(text: string, matcher: TaskProblemMatcher): readonly TaskMatchedProblem[] {
  const problems: TaskMatchedProblem[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = matcher.pattern.exec(line);
    if (match === null) continue;
    const file = match[matcher.file];
    const lineNumber = Number(match[matcher.line]);
    const message = match[matcher.message];
    if (file === undefined || message === undefined || !Number.isSafeInteger(lineNumber) || lineNumber < 1) continue;
    const columnRaw = matcher.column === undefined ? undefined : match[matcher.column];
    const column = columnRaw === undefined ? 1 : Number(columnRaw);
    const severityWord = matcher.severityGroup === undefined ? undefined : match[matcher.severityGroup];
    const severity: 1 | 2 | 3 | 4 | undefined = severityWord === 'error' ? 1 : severityWord === 'warning' ? 2 : matcher.severity;
    problems.push(Object.freeze({ file, line: lineNumber, column: Number.isSafeInteger(column) && column >= 1 ? column : 1, message, severity }));
  }
  return Object.freeze(problems);
}
export interface TaskOutputSnapshot { readonly taskId: string; readonly stdout: string; readonly stderr: string; readonly bytes: number; readonly truncated: boolean; readonly state: 'idle' | 'running' | 'exited' | 'failed' | 'cancelled'; readonly exitCode: number | null; }
export type TaskFailure = { readonly kind: 'spawn' | 'failed' | 'cancelled' | 'output-limit' | 'disposed'; readonly message: string };

export class TaskController implements Disposable {
  readonly #factory: TaskProcessFactory; readonly #maxOutputBytes: number; #process: TaskProcess | undefined; #snapshot: TaskOutputSnapshot; #disposed = false; #out: Disposable[] = [];
  // One streaming decoder per pipe, kept across chunks so a multibyte UTF-8
  // sequence split across a chunk boundary decodes correctly instead of
  // producing U+FFFD replacement characters. Reset per run in start().
  #stdoutDecoder = new TextDecoder();
  #stderrDecoder = new TextDecoder();
  readonly #listeners = new Set<(snapshot: TaskOutputSnapshot) => void>();
  constructor(factory: TaskProcessFactory, maxOutputBytes = 1_048_576) { this.#factory = factory; this.#maxOutputBytes = Math.max(1024, Math.trunc(maxOutputBytes)); this.#snapshot = Object.freeze({ taskId: '', stdout: '', stderr: '', bytes: 0, truncated: false, state: 'idle', exitCode: null }); }
  get snapshot(): TaskOutputSnapshot { return this.#snapshot; }
  get model(): TaskOutputSnapshot { return this.#snapshot; }
  subscribe(listener: (snapshot: TaskOutputSnapshot) => void): Disposable { this.#listeners.add(listener); return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } }); }
  private notify(): void { for (const listener of [...this.#listeners]) listener(this.#snapshot); }
  async start(spec: TaskSpec): Promise<Result<TaskOutputSnapshot, TaskFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'task controller disposed' } };
    await this.cancel();
    const spawned = await this.#factory.spawn(spec);
    if (!spawned.ok) { this.#snapshot = Object.freeze({ ...this.#snapshot, taskId: spec.id, state: 'failed' }); this.notify(); return spawned; }
    this.#stdoutDecoder = new TextDecoder();
    this.#stderrDecoder = new TextDecoder();
    this.#process = spawned.value;
    this.#snapshot = Object.freeze({ taskId: spec.id, stdout: '', stderr: '', bytes: 0, truncated: false, state: 'running', exitCode: null });
    this.notify();
    this.#out = [this.#process.onStdout((bytes) => this.append('stdout', bytes)), this.#process.onStderr((bytes) => this.append('stderr', bytes))];
    void this.#process.exit.then((exit) => {
      // The process has already exited; clear it so a later cancel() (called either directly,
      // or from the next start()) sees nothing to terminate and does not overwrite this run's
      // real final state below.
      this.#process = undefined;
      if (!exit.ok) { this.#snapshot = Object.freeze({ ...this.#snapshot, state: 'failed' }); this.notify(); return; }
      this.#snapshot = Object.freeze({ ...this.#snapshot, state: exit.value.code === null ? 'cancelled' : 'exited', exitCode: exit.value.code });
      this.notify();
    });
    return { ok: true, value: this.#snapshot };
  }
  async cancel(): Promise<void> {
    const process = this.#process;
    if (process === undefined) return;
    this.#process = undefined;
    for (const subscription of this.#out) subscription.dispose();
    this.#out = [];
    await process.terminate();
    // Only a run still in flight becomes 'cancelled'; a run that had already reached a
    // terminal state (e.g. 'exited') by the time this resolves must keep reporting that real
    // outcome, not have it overwritten by the cancel that raced it.
    if (this.#snapshot.state === 'running') {
      this.#snapshot = Object.freeze({ ...this.#snapshot, state: 'cancelled' });
      this.notify();
    }
    process.dispose();
  }
  private append(kind: 'stdout' | 'stderr', bytes: Uint8Array): void {
    if (this.#disposed || this.#snapshot.state !== 'running') return;
    const remaining = this.#maxOutputBytes - this.#snapshot.bytes;
    const accepted = bytes.slice(0, Math.max(0, remaining));
    const decoder = kind === 'stdout' ? this.#stdoutDecoder : this.#stderrDecoder;
    const text = stripAnsiEscapes(decoder.decode(accepted, { stream: true }));
    this.#snapshot = Object.freeze({ ...this.#snapshot, [kind]: `${this.#snapshot[kind]}${text}`, bytes: this.#snapshot.bytes + accepted.byteLength, truncated: this.#snapshot.truncated || accepted.byteLength !== bytes.byteLength });
    this.notify();
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#listeners.clear(); void this.cancel(); }
}
