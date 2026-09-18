import type { Result } from '../../contracts/src/index';
import type { ExplorerFailure, ExplorerGitDecoration, ExplorerGitState } from '../files/index';
import type { GitStatusEntry, GitStatusSnapshot } from './index';

export type { ExplorerGitDecoration, ExplorerFailure as ExplorerGitDecorationFailure } from '../files/index';

/** Maps a Git status entry onto the explorer's decoration vocabulary; `git.<state>` color
 * tokens follow the same naming already exercised by tests/e2e/t040-explorer.test.ts. */
export function toExplorerGitDecoration(entry: Pick<GitStatusEntry, 'state' | 'staged' | 'unstaged' | 'conflict'>): ExplorerGitDecoration {
  const label = entry.state === 'added' ? 'A' : entry.state === 'deleted' ? 'D' : entry.state === 'renamed' ? 'R' : entry.state === 'untracked' ? 'U' : entry.state === 'ignored' ? 'I' : entry.state === 'conflicted' ? 'C' : 'M';
  const state: ExplorerGitState = entry.conflict ? 'conflicted' : entry.state === 'untracked' ? 'untracked' : entry.state === 'ignored' ? 'ignored' : entry.staged && !entry.unstaged ? 'staged' : 'modified';
  return { state, label, colorToken: `git.${state}` };
}

function indexByPath(snapshot: GitStatusSnapshot): ReadonlyMap<string, GitStatusEntry> {
  const index = new Map<string, GitStatusEntry>();
  for (const entry of snapshot.entries) index.set(entry.path, entry);
  return index;
}

export interface GitDecorationSource {
  readonly snapshot: GitStatusSnapshot | undefined;
}

export interface WorkspaceRelativePathResolver {
  workspaceRelativePath(root: string, path: string): string | undefined;
}

export interface GitDecorationPort {
  read(path: string): Promise<Result<ExplorerGitDecoration | undefined, ExplorerFailure>>;
}

/** Read-only adapter from the polled `GitStatusService` snapshot to ExplorerTree's per-path
 * decoration port; ExplorerTree calls this lazily (on node add/refresh), so a decoration can
 * lag the most recent `git.refresh()` by up to one coalesced refresh window. The by-path index
 * is memoized per snapshot generation so repeated `read()` calls across a tree redecorate are
 * O(1) instead of a linear `entries.find` per node. */
export function createGitDecorationPort(service: GitDecorationSource, root: string, filesystem: WorkspaceRelativePathResolver): GitDecorationPort {
  let indexedGeneration: number | undefined;
  let index: ReadonlyMap<string, GitStatusEntry> | undefined;
  return {
    async read(path: string) {
      const snapshot = service.snapshot;
      if (snapshot === undefined) return { ok: true, value: undefined };
      if (indexedGeneration !== snapshot.generation || index === undefined) {
        index = indexByPath(snapshot);
        indexedGeneration = snapshot.generation;
      }
      const relative = filesystem.workspaceRelativePath(root, path);
      const entry = relative === undefined ? undefined : index.get(relative);
      return { ok: true, value: entry === undefined ? undefined : toExplorerGitDecoration(entry) };
    },
  };
}
