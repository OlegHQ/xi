/** Task config/process wiring loads only when a workspace task is discovered or run, off the first-frame path. */
export { parseTasksConfig, type TaskConfig } from '../../config/index';
export {
  TaskController,
  createSpawnTaskProcessFactory,
  matchTaskProblems,
  GENERIC_COMPILER_PROBLEM_MATCHER,
  type TaskSpec,
  type TaskOutputSnapshot,
  type TaskMatchedProblem,
} from '../../tasks/index';
