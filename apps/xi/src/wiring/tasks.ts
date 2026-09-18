import { CancellationSource } from '../../../../packages/primitives/src/entrypoints/launch';
import type { Result } from '../../../../packages/primitives/src/entrypoints/launch';
import { NodeProcessPort } from '../../../../packages/platform/src/entrypoints/launch';
import type { NodeFilesystemPort } from '../../../../packages/platform/src/entrypoints/launch';

type TasksModule = typeof import('../../../../packages/services/src/entrypoints/tasks');
type TaskController = InstanceType<TasksModule['TaskController']>;
type TaskConfig = import('../../../../packages/services/src/entrypoints/tasks').TaskConfig;
type TaskMatchedProblem = import('../../../../packages/services/src/entrypoints/tasks').TaskMatchedProblem;

export interface TaskWiringDeps {
  readonly filesystem: NodeFilesystemPort;
  readonly ProcessPort: typeof NodeProcessPort;
  readonly notifySurfaceChange: () => void;
}

export interface TaskWiring {
  readonly taskController: TaskController | undefined;
  ensureTaskController(): Promise<TaskController>;
  readTasksConfig(path: string): Promise<Result<readonly TaskConfig[], { readonly message: string }>>;
  matchTaskProblems(text: string): readonly TaskMatchedProblem[];
  dispose(): void;
}

/** Owns the lazily-loaded `tasks` module, the task process controller and `.xi/tasks.toml`
 * reading/matching -- one cohesive cluster the composition root previously held as four
 * top-level `let`/`const` bindings plus their closures. */
export function createTaskWiring(deps: TaskWiringDeps): TaskWiring {
  let taskController: TaskController | undefined;
  let tasksModuleCache: TasksModule | undefined;
  const taskCancellation = new CancellationSource();

  async function loadTasksModule(): Promise<TasksModule> {
    tasksModuleCache ??= await import('../../../../packages/services/src/entrypoints/tasks');
    return tasksModuleCache;
  }

  async function ensureTaskController(): Promise<TaskController> {
    if (taskController !== undefined) return taskController;
    const tasksModule = await loadTasksModule();
    const controller = new tasksModule.TaskController(tasksModule.createSpawnTaskProcessFactory(new deps.ProcessPort(), taskCancellation.token));
    // The output panel reads live stdout/stderr as it streams in; wake a frame on every
    // snapshot, not just the terminal one the problems feature's own completion subscription
    // reacts to.
    controller.subscribe(() => deps.notifySurfaceChange());
    taskController = controller;
    return controller;
  }

  async function readTasksConfig(path: string): Promise<Result<readonly TaskConfig[], { readonly message: string }>> {
    const read = await deps.filesystem.readFile(path, taskCancellation.token);
    if (!read.ok) return { ok: true, value: [] };
    const { parseTasksConfig } = await loadTasksModule();
    const parsed = parseTasksConfig(new TextDecoder('utf-8').decode(read.value), '.xi/tasks.toml');
    if (!parsed.ok) return { ok: false, error: { message: `xi: .xi/tasks.toml is invalid: ${parsed.error.diagnostics.map((entry) => entry.message).join('; ')}\n` } };
    return { ok: true, value: parsed.value };
  }

  /** Synchronous: `runConfiguredTask` always awaits `ensureTaskController` (which loads this
   * same module) before a task can reach the terminal state that triggers this. */
  function matchTaskProblems(text: string): readonly TaskMatchedProblem[] {
    if (tasksModuleCache === undefined) throw new Error('xi: tasks module unavailable');
    return tasksModuleCache.matchTaskProblems(text, tasksModuleCache.GENERIC_COMPILER_PROBLEM_MATCHER);
  }

  return {
    get taskController() { return taskController; },
    ensureTaskController,
    readTasksConfig,
    matchTaskProblems,
    dispose(): void {
      taskController?.dispose();
      taskCancellation.dispose();
    },
  };
}
