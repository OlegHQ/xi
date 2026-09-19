/** Git status/mutations load only when the workspace exposes a `.git` and the sidebar/save
 * path actually needs them; the launcher imports this lazily rather than at startup. */
export {
  GitStatusCache,
  GitStatusService,
  GitMutationCoordinator,
  GitHistoryController,
  createProcessGitMutationExecutor,
  parsePorcelainV2Z,
} from '../../git/index';
export type {
  GitEntryState,
  GitStatusEntry,
  GitStatusSnapshot,
  GitFailure,
  GitStatusServiceOptions,
  GitMutationExecutor,
  GitMutationContext,
  GitMutationFailure,
  GitHistoryEntry,
  GitConflictState,
} from '../../git/index';
export { toExplorerGitDecoration, createGitDecorationPort } from '../../git/decorations';
export type { ExplorerGitDecoration, ExplorerGitDecorationFailure, GitDecorationPort } from '../../git/decorations';
export { computeLineDiff, GitDiffService } from '../../git/diff';
export type {
  DiffLine,
  DiffLineKind,
  DiffHunk,
  LineDiff,
  GitDiffTarget,
  GitDiffSideKind,
  GitDiffSide,
  GitDiffReady,
  GitDiffBinary,
  GitDiffUnavailable,
  GitDiffResult,
  GitDiffLoadOptions,
  GitDiffServiceOptions,
} from '../../git/diff';
