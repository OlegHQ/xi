/** Module-namespace type aliases shared by the wiring modules -- these mirror the dynamic
 * `import(...)` calls in main.ts, so a wiring module can name the shape of an
 * already-resolved module without re-importing it (and re-triggering its side effects) itself. */

export type LaunchServices = typeof import('../../../../packages/services/src/entrypoints/launch');
export type GitServices = typeof import('../../../../packages/services/src/entrypoints/git');
export type LanguageServices = typeof import('../../../../packages/services/src/entrypoints/language');
export type TasksServices = typeof import('../../../../packages/services/src/entrypoints/tasks');
export type WorkspaceEditResourceExecutor = import('../../../../packages/services/src/entrypoints/language').WorkspaceEditResourceExecutor;
