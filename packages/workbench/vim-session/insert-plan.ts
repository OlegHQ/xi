import { type UndoGroupId, type Utf16Offset } from '../../contracts/src/index';
import type { CommittedDocumentChange, DocumentEdit, DocumentSnapshot, TextFileDocument } from '../../document/src/index';
import { createSelectionSet, type SelectionSetSnapshot } from '../../selections/src/index';
import type { VimMultiInsertPlan, VimMultiInsertSession } from '../../vim/src/entrypoints/launch';
import { id, nonEmptyTuple, notifyCommitted, offset } from './helpers';

export const INSERT_GROUP = id<UndoGroupId>('xi-workbench-insert');

export function makeInsertSelections(snapshot: DocumentSnapshot, session: VimMultiInsertSession, generation: number): SelectionSetSnapshot {
  const members = session.members.map((member) => ({
    id: member.id,
    kind: 'insert-caret' as const,
    direction: 'forward' as const,
    anchor: { kind: 'gap' as const, offset: member.session.cursorOffset },
    head: { kind: 'gap' as const, offset: member.session.cursorOffset },
  }));
  const primaryId = session.members[0]?.id;
  if (primaryId === undefined) throw new Error('xi-empty-insert-session');
  const created = createSelectionSet(snapshot, { primaryId, selectionGeneration: generation, members });
  if (!created.ok) throw new Error(`xi-insert-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

export function commitPlan(document: TextFileDocument, plan: VimMultiInsertPlan, undoOpen: boolean, setUndoOpen: (value: boolean) => void, onDocumentChange?: (change: CommittedDocumentChange) => void): void {
  if (plan.undoAction === 'open' && !undoOpen) {
    const opened = document.beginUndoGroup(INSERT_GROUP, 'vim');
    if (!opened.ok) throw new Error(`xi-undo-open:${opened.error.kind}`);
    setUndoOpen(true);
  }
  if (plan.edits.length > 0) {
    const committed = document.commit({
      documentId: plan.documentId,
      expectedVersion: plan.expectedVersion,
      edits: plan.edits.map((edit) => ({ start: edit.start, end: edit.end, text: edit.text } satisfies DocumentEdit)),
      origin: 'vim',
      undoGroup: INSERT_GROUP,
    });
    if (!committed.ok) throw new Error(`xi-commit:${committed.error.kind}`);
    notifyCommitted(committed, onDocumentChange);
  }
  if (plan.undoAction === 'close' && undoOpen) {
    const closed = document.endUndoGroup(INSERT_GROUP);
    if (!closed.ok) throw new Error(`xi-undo-close:${closed.error.kind}`);
    setUndoOpen(false);
  }
}

export function mapExternalInsertSession(session: VimMultiInsertSession, edits: readonly DocumentEdit[]): VimMultiInsertSession {
  const map = (value: Utf16Offset, affinity: 'left' | 'right'): Utf16Offset => offset(mapExternalInsertOffset(value as number, edits, affinity));
  return Object.freeze({
    ...session,
    members: nonEmptyTuple(session.members.map((member) => Object.freeze({
      ...member,
      session: Object.freeze({
        ...member.session,
        cursorOffset: map(member.session.cursorOffset, 'right'),
        entryOffset: map(member.session.entryOffset, 'left'),
        autoIndentSpan: member.session.autoIndentSpan === null
          ? null
          : Object.freeze({ start: map(member.session.autoIndentSpan.start, 'left'), end: map(member.session.autoIndentSpan.end, 'right') }),
        replaceStack: Object.freeze(member.session.replaceStack.map((frame) => Object.freeze({
          ...frame,
          start: map(frame.start, 'left'),
          cursorBefore: map(frame.cursorBefore, 'left'),
        }))),
      }),
    }))),
  });
}

export function mapExternalInsertOffset(value: number, edits: readonly DocumentEdit[], affinity: 'left' | 'right'): number {
  let delta = 0;
  for (const edit of edits) {
    const start = edit.start as number;
    const end = edit.end as number;
    if (start === end && value === start) return start + delta + (affinity === 'right' ? edit.text.length : 0);
    if (value >= end) {
      delta += edit.text.length - (end - start);
      continue;
    }
    if (value >= start) return start + delta + (affinity === 'right' ? edit.text.length : 0);
    break;
  }
  return value + delta;
}
