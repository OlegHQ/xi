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
  FilePathIndex,
  FilePickerProvider,
  StaticPickerProvider,
  createNavigationContributionModule,
} from '../../navigation';
export { DiagnosticStore } from '../../language/diagnostics';
