import { strict as assert } from 'node:assert';
import {
  asDocumentVersion,
  asIdentifier,
  asUndoGroupId,
  asUtf16Offset,
  type DocumentId,
  type DocumentVersion,
  type UndoGroupId,
  type ViewId,
} from '../../packages/primitives/src/index';
import { TextFileDocument, type DocumentEdit } from '../../packages/document/src/index';
import { WorkbenchSession, type WorkbenchLayoutSnapshot, type WorkbenchLayoutStore } from '../../packages/workbench/src/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function document(id: string, text: string): TextFileDocument {
  const endings = Array.from({ length: [...text].filter((char) => char === '\n').length }, () => 'lf' as const);
  const result = TextFileDocument.create(identifier<DocumentId>(id), text, endings, 'lf');
  if (!result.ok) throw new Error(`document:${result.error.kind}`);
  return result.value;
}
function text(session: WorkbenchSession, viewId: ViewId): string {
  const read = session.readView(viewId);
  if (read === undefined) throw new Error(`view:${viewId}`);
  const first = asUtf16Offset(0); const last = asUtf16Offset(read.document.lengthUtf16);
  if (!first.ok || !last.ok) throw new Error('slice offsets');
  const value = read.document.slice(first.value, last.value);
  if (!value.ok) throw new Error(`slice:${value.error.kind}`);
  return value.value;
}
function edit(start: number, end: number, value: string): DocumentEdit {
  const first = asUtf16Offset(start); const last = asUtf16Offset(end);
  if (!first.ok || !last.ok) throw new Error('offset fixture');
  return { start: first.value, end: last.value, text: value };
}
function undoGroup(value: string): UndoGroupId {
  const result = asUndoGroupId(value);
  if (!result.ok) throw new Error('group fixture');
  return result.value;
}

async function e02PreviewSplitClose(): Promise<void> {
  const source = document('T038-e02-source', 'alpha\nbeta\n');
  const preview = document('T038-e02-preview', 'preview\n');
  const replacement = document('T038-e02-replacement', 'replacement\n');
  const session = new WorkbenchSession({ workspaceId: 'T038-workspace' });
  const opened = session.openBuffer(source, { path: '/workspace/main.ts', viewId: identifier<ViewId>('T038-e02-source-view') });
  assert.equal(opened.ok, true, 'E02 source opens');
  if (!opened.ok) return;
  const sourceView = opened.value.viewIds[0] as ViewId;
  const firstPreview = session.replacePreview(preview, { path: '/workspace/preview.ts', viewId: identifier<ViewId>('T038-e02-preview-view') });
  assert.equal(firstPreview.ok, true, 'E02 opens a preview slot');
  if (!firstPreview.ok) return;
  const previewView = firstPreview.value.viewIds[0] as ViewId;
  assert.equal(session.closeView(previewView, 'cancel').ok, true, 'E02 cancel leaves preview available');
  assert.equal(session.buffer(preview.id)?.preview, true, 'E02 cancel preserves preview state');
  assert.equal(session.focus(sourceView).ok, true, 'E02 returns focus to source');
  const secondPreview = session.replacePreview(replacement, { path: '/workspace/replacement.ts', viewId: identifier<ViewId>('T038-e02-replacement-view') });
  assert.equal(secondPreview.ok, true, 'E02 clean preview replacement succeeds');
  assert.equal(session.buffer(preview.id), undefined, 'E02 replaced preview is closed');
  const promoted = session.promoteBuffer(replacement.id);
  assert.equal(promoted.ok, true, 'E02 explicit pin promotes preview');
  assert.equal(session.buffer(replacement.id)?.pinned, true);
  assert.equal(session.focus(sourceView).ok, true, 'E02 source focus returns from preview replacement');

  const split = session.splitView(sourceView, 'vertical', identifier<ViewId>('T038-e02-split-view'));
  assert.equal(split.ok, true, 'E02 creates a source split');
  if (!split.ok) return;
  const splitView = split.value.viewId;
  const withHiddenPinnedPreview = session.restoreLayout(session.layoutSnapshot());
  assert.equal(withHiddenPinnedPreview.ok, true, 'E02 layout restores hidden pinned buffers independently of visible split leaves');
  const changed = await session.applyTextEdits(splitView, [edit(0, 0, 'X')], undoGroup('T038-e02-edit'));
  assert.equal(changed.ok, true, 'E02 edit routes through source coordinator');
  assert.equal(text(session, sourceView), 'Xalpha\nbeta\n', 'E02 source view sees shared edit');
  assert.equal(text(session, splitView), 'Xalpha\nbeta\n', 'E02 split view sees shared edit');
  assert.equal(session.readView(sourceView)?.document.revisionId, session.readView(splitView)?.document.revisionId, 'E02 split views share revision history');
  const undone = source.undo();
  assert.equal(undone.ok, true, 'E02 shared buffer exposes one undo tree');
  assert.equal(text(session, sourceView), 'alpha\nbeta\n', 'E02 undo updates source view');
  assert.equal(text(session, splitView), 'alpha\nbeta\n', 'E02 undo updates split view');
  const changedAgain = await session.applyTextEdits(sourceView, [edit(0, 0, 'X')], undoGroup('T038-e02-edit-again'));
  assert.equal(changedAgain.ok, true, 'E02 can edit after shared undo');

  const cancelled = session.closeView(splitView, 'cancel');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.ok && cancelled.value.closed, false, 'E02 cancel never discards unsaved content');
  assert.equal(session.views().some((view) => view.viewId === splitView), true, 'E02 cancelled close retains focus target');
  const closed = session.closeView(splitView, 'discard');
  assert.equal(closed.ok, true);
  assert.equal(text(session, sourceView), 'Xalpha\nbeta\n', 'E02 discarding a view retains source buffer edits');
  session.dispose();
  console.log('XI_T038_E02_PASS');
}

async function dirtyPreviewAndStaleRestore(): Promise<void> {
  const dirtyPreview = document('T038-dirty-preview', 'dirty');
  assert.equal(dirtyPreview.apply(edit(0, 0, 'X'), dirtyPreview.version).ok, true);
  const replacement = document('T038-dirty-replacement', 'replacement');
  const session = new WorkbenchSession({ workspaceId: 'T038-failure' });
  assert.equal(session.openBuffer(dirtyPreview, { path: '/workspace/dirty', preview: true }).ok, true);
  const blocked = session.replacePreview(replacement, { path: '/workspace/replacement' });
  assert.equal(blocked.ok, false, 'T038-DIRTY-PREVIEW-01 replacement is blocked');
  if (!blocked.ok) assert.equal(blocked.error.kind, 'dirty-preview-replacement');
  const original = session.layoutSnapshot();
  const malformed: WorkbenchLayoutSnapshot = {
    ...original,
    buffers: [...original.buffers, { bufferId: identifier<DocumentId>('T038-missing'), path: '/workspace/missing', preview: false, pinned: true, viewIds: [] }],
  };
  const missing = session.restoreLayout(malformed);
  assert.equal(missing.ok, false, 'T038-MISSING-RESTORE-01 reports missing restored buffer');
  if (!missing.ok) assert.equal(missing.error.kind, 'missing-restored-buffer');
  assert.deepEqual(session.layoutSnapshot().buffers.map((buffer) => buffer.bufferId), original.buffers.map((buffer) => buffer.bufferId), 'missing restore does not erase open content');
  session.dispose();
  console.log('XI_T038_FAILURES_PASS');
}

async function e11ResizeAndLayoutPersistence(): Promise<void> {
  const source = document('T038-e11-source', 'one\ntwo\nthree');
  let saved: WorkbenchLayoutSnapshot | undefined;
  const store: WorkbenchLayoutStore = {
    write(layout) { saved = layout; return { ok: true, value: undefined }; },
    read() { return saved === undefined ? { ok: false, error: 'no saved layout' } : { ok: true, value: saved }; },
  };
  const session = new WorkbenchSession({ workspaceId: 'T038-e11-workspace', layoutStore: store, minimumPaneSize: 12 });
  const opened = session.openBuffer(source, { path: '/workspace/e11.ts', viewId: identifier<ViewId>('T038-e11-main') });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const split = session.splitView(opened.value.viewIds[0] as ViewId, 'horizontal', identifier<ViewId>('T038-e11-second'));
  assert.equal(split.ok, true);
  const root = session.splitSnapshot().root;
  if (root?.kind !== 'split') throw new Error('T038 split root');
  for (const width of [160, 80, 60]) {
    const resized = session.resizeSplit(root.nodeId, 0.5, width);
    assert.equal(resized.ok, true, `E11 resize ${width} retains both panes`);
    assert.equal(text(session, opened.value.viewIds[0] as ViewId), 'one\ntwo\nthree', `E11 resize ${width} retains text`);
  }
  assert.equal(session.setViewScroll(opened.value.viewIds[0] as ViewId, 7, 3).ok, true, 'E11 keeps per-view scroll state');
  const tooSmall = session.resizeSplit(root.nodeId, 0.9, 60);
  assert.equal(tooSmall.ok, false, 'T038-SPLIT-MIN-01 rejects pane below minimum');
  if (!tooSmall.ok) assert.equal(tooSmall.error.kind, 'split-too-small');
  const before = session.serializeLayout();
  assert.equal((await session.saveLayout()).ok, true, 'layout persistence hook stores geometry');
  const restored = await session.loadLayout();
  assert.equal(restored.ok, true, 'layout persistence reloads geometry');
  assert.equal(session.serializeLayout(), before, 'layout restore is deterministic');
  assert.equal(session.views().find((view) => view.viewId === (opened.value.viewIds[0] as ViewId))?.scrollTop, 7, 'layout restore preserves view scroll state');
  assert.equal(text(session, opened.value.viewIds[0] as ViewId), 'one\ntwo\nthree', 'layout restore never replaces recovery text');
  session.dispose();
  assert.equal(session.openBuffer(document('T038-after-dispose', ''), { path: '/tmp/no' }).ok, false, 'disposed session rejects new buffers');
  console.log('XI_T038_E11_PASS');
}

await e02PreviewSplitClose();
await dirtyPreviewAndStaleRestore();
await e11ResizeAndLayoutPersistence();
console.log('T038 session fixtures passed E02 preview/split/close, shared history, stale restore and E11 resize/layout persistence');
