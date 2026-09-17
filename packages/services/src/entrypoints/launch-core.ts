/**
 * First-frame service surface for the standalone launcher.
 *
 * Keep this entrypoint limited to models that must exist before the first
 * editable frame. Search, Explorer, formatting, language, syntax, task and
 * Git implementations have their own lazy entrypoints and must not be pulled
 * into the launch critical path by the all-services compatibility barrel.
 */
export {
  BoundedPickerModel,
  BufferPickerProvider,
  FilePathIndex,
  FilePickerProvider,
  StaticPickerProvider,
  createNavigationContributionModule,
} from '../../navigation';
export type { BufferPickerEntry } from '../../navigation';
export { DiagnosticStore } from '../../language/diagnostics';
// Pure `file://` URI <-> path helpers with no LSP/session dependencies (see
// ../../language/workspace-edit-resources.ts) -- safe for the launch critical path since callers
// need them before a language server has ever been started.
export { fileUri, workspacePathFromUri, workspaceRelativePathFromUri } from '../../language/workspace-edit-resources';
