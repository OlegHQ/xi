import type { Disposable, Result } from '../../contracts/src/index';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';

export type { OwnedVimKeyEvent as ProblemsKeyEvent };

/** Mirrors `packages/services/language/diagnostics`'s `LanguageDiagnostic` range, subset
 * actually read here -- workbench cannot import `packages/services`, not even types. */
export interface ProblemsDiagnosticRange {
  readonly startLine: number;
  readonly startUtf16: number;
}

/** Mirrors `LanguageDiagnostic`, subset actually used by the panel and by `openProblem`. */
export interface ProblemsDiagnostic {
  readonly id: string;
  readonly uri: string;
  readonly range: ProblemsDiagnosticRange;
}

/** Mirrors `DiagnosticStore`'s `DiagnosticReadModel`. */
export interface ProblemsReadModel {
  readonly generation: number;
  readonly all: readonly ProblemsDiagnostic[];
}

/** One entry of `DiagnosticPublish['diagnostics']`, mirrored structurally. */
export interface ProblemsDiagnosticEntry {
  readonly range: { readonly startLine: number; readonly startUtf16: number; readonly endLine: number; readonly endUtf16: number };
  readonly message: string;
  readonly severity: 1 | 2 | 3 | 4 | undefined;
  readonly source: string | undefined;
  readonly code: string | number | undefined;
}

/** Mirrors `DiagnosticStore`'s `DiagnosticPublish`. */
export interface ProblemsDiagnosticPublish {
  readonly serverId: string;
  readonly uri: string;
  readonly generation: number;
  readonly diagnostics: readonly ProblemsDiagnosticEntry[];
}

/** Narrow port onto the composition root's `DiagnosticStore`: shared with the language
 * feature (LSP diagnostics publish into the same store), so the store itself stays
 * constructed and disposed by `apps/xi/src/main.ts`, not by this controller. */
export interface DiagnosticsPort {
  readonly model: ProblemsReadModel;
  publish(input: ProblemsDiagnosticPublish): boolean;
  clearServer(serverId: string): void;
}

/** Mirrors `packages/services/config`'s `TaskConfig`. */
export interface WorkbenchTaskConfig {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly problemMatcher: 'generic-compiler' | 'none';
}

/** Mirrors `packages/services/tasks`'s `TaskMatchedProblem`. */
export interface WorkbenchTaskMatchedProblem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: 1 | 2 | 3 | 4 | undefined;
}

/** Mirrors `packages/services/tasks`'s `TaskOutputSnapshot`. */
export interface WorkbenchTaskOutputSnapshot {
  readonly taskId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly state: 'idle' | 'running' | 'exited' | 'failed' | 'cancelled';
  readonly exitCode: number | null;
}

/** Mirrors `packages/services/tasks`'s `TaskSpec` (subset this controller builds). */
export interface WorkbenchTaskSpec {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** Mirrors `packages/services/tasks`'s `TaskFailure`. */
export type WorkbenchTaskFailure = { readonly kind: 'spawn' | 'failed' | 'cancelled' | 'output-limit' | 'disposed'; readonly message: string };

/** Narrow port onto `packages/services/tasks`'s `TaskController`: only the members this
 * controller calls, kept structural so workbench never imports the services package. */
export interface TaskControllerPort {
  readonly snapshot: WorkbenchTaskOutputSnapshot;
  subscribe(listener: (snapshot: WorkbenchTaskOutputSnapshot) => void): Disposable;
  start(spec: WorkbenchTaskSpec): Promise<Result<WorkbenchTaskOutputSnapshot, WorkbenchTaskFailure>>;
  cancel(): Promise<void>;
}

export interface ProblemsControllerOptions {
  readonly host: BufferHost;
  readonly diagnostics: DiagnosticsPort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly workspaceRoot: string;
  /** `filesystem.resolvePath`'s subset this controller needs for a configured task's `cwd`
   * and for resolving a problem matcher's relative file path against it. */
  readonly resolvePath: (base: string, relative: string) => string;
  readonly fileUri: (path: string) => string;
  readonly workspacePathFromUri: (uri: string) => string | undefined;
  readonly processEnvironment: () => Readonly<Record<string, string>>;
  /** Reads and parses `<workspaceRoot>/.xi/tasks.toml`; a missing file resolves `ok: true`
   * with an empty list (no configured tasks is the common case, not an error). Composition-root
   * work (file IO + the services-owned TOML parser) this controller cannot do itself. */
  readonly readTasksConfig: (path: string) => Promise<Result<readonly WorkbenchTaskConfig[], { readonly message: string }>>;
  /** Runs the generic compiler problem matcher over a finished task's retained output.
   * Synchronous: always called after `ensureTaskController` has already resolved once for
   * the same task run, so the services-owned matcher module is already loaded. */
  readonly matchTaskProblems: (text: string) => readonly WorkbenchTaskMatchedProblem[];
  /** Lazily constructs (memoized) the services-owned `TaskController`, wiring its own
   * `host.notifySurfaceChange()` forwarding -- composition-root work, never duplicated here. */
  readonly ensureTaskController: () => Promise<TaskControllerPort>;
}

/**
 * Owns the Problems and Output panels and the configured-tasks feature that connects them:
 * open/close/selection/key handling for both panels, task discovery/caching from
 * `.xi/tasks.toml`, running a configured task, and publishing a finished task's matched
 * problems into the shared `DiagnosticStore` under a task-specific `serverId`. Moved out of
 * `apps/xi/src/main.ts`'s `main()` closure; kept as one controller (rather than split by
 * panel) because task output and task-sourced diagnostics are one feature sharing state
 * (`taskDiagnosticGeneration`, the configured-tasks cache) across both panels.
 */
export class ProblemsController {
  #problemsOpen = false;
  #problemSelectedIndex = 0;
  #outputOpen = false;
  #configuredTasksCache: readonly WorkbenchTaskConfig[] | undefined;
  #taskDiagnosticGeneration = 0;
  #taskController: TaskControllerPort | undefined;
  readonly #options: ProblemsControllerOptions;

  constructor(options: ProblemsControllerOptions) {
    this.#options = options;
  }

  get isProblemsOpen(): boolean { return this.#problemsOpen; }
  get problemSelectedIndex(): number { return this.#problemSelectedIndex; }
  get isOutputOpen(): boolean { return this.#outputOpen; }

  selectedProblemId(): string | undefined {
    return this.#options.diagnostics.model.all[this.#problemSelectedIndex]?.id;
  }

  openProblems(): void {
    this.#options.host.closeAllPanels('problems');
    this.#problemsOpen = true;
    this.#problemSelectedIndex = Math.min(this.#problemSelectedIndex, Math.max(0, this.#options.diagnostics.model.all.length - 1));
    this.#options.marker('XI_PROBLEMS_OPEN', { count: this.#options.diagnostics.model.all.length });
  }

  closeProblems(): void {
    this.#problemsOpen = false;
    this.#options.marker('XI_PROBLEMS_CLOSED');
  }

  /** Direct pointer-driven selection, mirroring `handleProblemsKeypress`'s up/down clamp
   * bypassed -- the caller has already validated `index` against the current model's
   * generation. */
  setSelectedProblemIndex(index: number): void {
    this.#problemSelectedIndex = index;
  }

  handleProblemsKeypress(event: OwnedVimKeyEvent): boolean {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') {
      this.closeProblems();
      return true;
    }
    if (key === 'up' || key === 'k' || key === 'down' || key === 'j') {
      const count = this.#options.diagnostics.model.all.length;
      if (count > 0) this.#problemSelectedIndex = Math.max(0, Math.min(count - 1, this.#problemSelectedIndex + (key === 'up' || key === 'k' ? -1 : 1)));
      return true;
    }
    if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const problem = this.#options.diagnostics.model.all[this.#problemSelectedIndex];
      if (problem !== undefined) void this.openProblem(problem);
    }
    return true;
  }

  async openProblem(problem: ProblemsDiagnostic): Promise<void> {
    const path = this.#options.workspacePathFromUri(problem.uri);
    if (path === undefined) return;
    const opened = await this.#options.host.openBufferAtPath(path);
    if (opened === undefined) return;
    const session = this.#options.host.sessions.get(opened.viewId);
    const positioned = session?.setCursorPosition(problem.range.startLine, problem.range.startUtf16) ?? false;
    if (!positioned && session !== undefined) {
      await session.handleKey({ name: 'Escape', raw: '', shift: false, option: false, ctrl: false, meta: false });
      session.setCursorPosition(problem.range.startLine, problem.range.startUtf16);
    }
    this.closeProblems();
  }

  openOutput(): void {
    this.#options.host.closeAllPanels('output');
    this.#outputOpen = true;
    this.#options.marker('XI_OUTPUT_OPEN', {});
  }

  closeOutput(): void {
    this.#outputOpen = false;
    this.#options.marker('XI_OUTPUT_CLOSED');
  }

  handleOutputKeypress(event: OwnedVimKeyEvent): boolean {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') {
      this.closeOutput();
      return true;
    }
    if (key === 'c' && this.#taskController?.snapshot.state === 'running') {
      void this.#taskController.cancel();
      this.#options.marker('XI_TASK_CANCELLED', {});
    }
    return true;
  }

  async listConfiguredTasks(): Promise<void> {
    const configs = await this.#ensureConfiguredTasks();
    if (configs.length === 0) { this.#options.onError('xi: no tasks configured (add [[task]] entries to .xi/tasks.toml)\n'); return; }
    this.#options.onError(`xi: configured tasks: ${configs.map((config) => config.id).join(', ')}\n`);
  }

  /** Start (or restart) a configured task, opening the output panel and wiring a one-shot
   * subscription that runs the task's own problem matcher once it reaches a terminal state. */
  async runConfiguredTask(taskId: string): Promise<void> {
    const configs = await this.#ensureConfiguredTasks();
    const config = configs.find((candidate) => candidate.id === taskId);
    if (config === undefined) { this.#options.onError(`xi: unknown task '${taskId}' (see :tasks)\n`); return; }
    const controller = await this.#options.ensureTaskController();
    this.#taskController = controller;
    this.#options.diagnostics.clearServer(`task:${config.id}`);
    this.openOutput();
    const subscription = controller.subscribe((snapshot) => {
      if (snapshot.state !== 'exited' && snapshot.state !== 'failed') return;
      subscription.dispose();
      if (config.problemMatcher !== 'none') this.#publishTaskProblems(config, snapshot);
      this.#options.marker('XI_TASK_EXITED', { id: config.id, state: snapshot.state, exitCode: snapshot.exitCode });
    });
    const started = await controller.start({
      id: config.id,
      argv: config.argv,
      cwd: config.cwd === undefined ? this.#options.workspaceRoot : this.#options.resolvePath(this.#options.workspaceRoot, config.cwd),
      // A configured task must inherit the same base environment (PATH, HOME, ...)
      // LSP/ripgrep/formatter spawns already use; explicit [task].env keys are applied
      // last so they still override it.
      env: { ...this.#options.processEnvironment(), ...config.env },
    });
    this.#options.marker('XI_TASK_STARTED', { id: config.id, ok: started.ok });
  }

  /** For `:taskstop`: cancels the running task, if any, without requiring the output panel
   * to be open. */
  async cancelTask(): Promise<void> {
    if (this.#taskController !== undefined) await this.#taskController.cancel();
  }

  dispose(): void {
    this.#configuredTasksCache = undefined;
  }

  #tasksConfigPath(): string {
    return `${this.#options.workspaceRoot}/.xi/tasks.toml`;
  }

  /** Discover project-configured tasks from `<workspaceRoot>/.xi/tasks.toml`, cached after
   * first discovery -- tasks are read once per session, matching the custom-theme pattern. */
  async #ensureConfiguredTasks(): Promise<readonly WorkbenchTaskConfig[]> {
    this.#configuredTasksCache ??= await this.#discoverProjectTasks();
    return this.#configuredTasksCache;
  }

  async #discoverProjectTasks(): Promise<readonly WorkbenchTaskConfig[]> {
    const result = await this.#options.readTasksConfig(this.#tasksConfigPath());
    if (!result.ok) { this.#options.onError(result.error.message); return []; }
    return result.value;
  }

  /** Run one line-oriented problem matcher over a finished task's retained output and publish
   * matches into the shared `DiagnosticStore` under a task-specific serverId (`task:<id>`) --
   * `DiagnosticStore` already keys entries by (serverId, uri), so this can never overwrite an
   * LSP server's own diagnostics for the same file; it only adds a distinct, independent source. */
  #publishTaskProblems(config: WorkbenchTaskConfig, snapshot: WorkbenchTaskOutputSnapshot): void {
    const matched = this.#options.matchTaskProblems(`${snapshot.stdout}\n${snapshot.stderr}`);
    const cwd = config.cwd === undefined ? this.#options.workspaceRoot : this.#options.resolvePath(this.#options.workspaceRoot, config.cwd);
    const byUri = new Map<string, WorkbenchTaskMatchedProblem[]>();
    for (const problem of matched) {
      const absolute = problem.file.startsWith('/') ? problem.file : this.#options.resolvePath(cwd, problem.file);
      const uri = this.#options.fileUri(absolute);
      const existing = byUri.get(uri);
      if (existing === undefined) byUri.set(uri, [problem]); else existing.push(problem);
    }
    this.#taskDiagnosticGeneration += 1;
    for (const [uri, problems] of byUri) {
      this.#options.diagnostics.publish({
        serverId: `task:${config.id}`,
        uri,
        generation: this.#taskDiagnosticGeneration,
        diagnostics: problems.map((problem) => ({
          range: { startLine: Math.max(0, problem.line - 1), startUtf16: Math.max(0, problem.column - 1), endLine: Math.max(0, problem.line - 1), endUtf16: Math.max(0, problem.column - 1) },
          message: problem.message,
          severity: problem.severity,
          source: config.id,
          code: undefined,
        })),
      });
    }
  }
}
