import type { DocumentReadPort, DocumentSnapshot } from '../../document/src/index.ts';
import type { ViewId } from '../../contracts/src/index.ts';
import type { SelectionSetSnapshot } from '../../selections/src/index.ts';
import type { VimSessionReader, VimSessionSnapshot } from '../../vim/src/index.ts';

export interface WorkbenchViewSnapshot {
  readonly session: VimSessionSnapshot;
  readonly document: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  /** Viewport scroll offset, in document line index (0-based). */
  readonly scrollTop: number;
  /** Viewport scroll offset, in terminal cell columns (0-based). */
  readonly scrollLeft: number;
}

/** Immutable pane geometry and view identities published for multi-pane UI. */
export interface WorkbenchLayoutRead {
  readonly split: WorkbenchSplitRead;
}

export type WorkbenchSplitReadNode = WorkbenchSplitReadLeaf | WorkbenchSplitReadBranch;
export interface WorkbenchSplitReadLeaf {
  readonly kind: 'leaf';
  readonly nodeId: string;
  readonly viewId: ViewId;
}
export interface WorkbenchSplitReadBranch {
  readonly kind: 'split';
  readonly nodeId: string;
  readonly orientation: 'horizontal' | 'vertical';
  readonly ratio: number;
  readonly first: WorkbenchSplitReadNode;
  readonly second: WorkbenchSplitReadNode;
}
export interface WorkbenchSplitRead {
  readonly root: WorkbenchSplitReadNode | undefined;
  readonly minimumPaneSize: number;
}

/** UI-facing immutable reads; dispatch and mutation remain workbench-owned. */
export interface WorkbenchReadPort {
  readonly activeViewId: ViewId | undefined;
  readView(viewId: ViewId): WorkbenchViewSnapshot | undefined;
  readDocument(viewId: ViewId): DocumentReadPort | undefined;
  readonly readLayout?: () => WorkbenchLayoutRead;
}

export interface WorkbenchSessionPort extends WorkbenchReadPort, VimSessionReader {}
