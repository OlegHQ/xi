import type { DocumentEdit, DocumentSnapshot, Result, SerializedSelectionValue } from '../../document/src/index';
import type { SelectionMember, SelectionMemberInput } from '../../selections/src/index';
import type { VimMode } from '../parser/index';

export type AtomicEditConflict =
  | 'different-inserts-at-same-position'
  | 'overlapping-replacements'
  | 'delete-overlaps-replacement'
  | 'insertion-touches-replacement'
  | 'invalid-edit';

/** Merge edits which can be given one unambiguous meaning on their shared base. */
export function normalizeAtomicEdits(
  snapshot: DocumentSnapshot,
  edits: readonly DocumentEdit[],
): Result<readonly DocumentEdit[], { readonly kind: 'edit-conflict'; readonly conflict: AtomicEditConflict }> {
  if (!Array.isArray(edits)) return { ok: false, error: { kind: 'edit-conflict', conflict: 'invalid-edit' } };
  const unique: DocumentEdit[] = [];
  const exact = new Map<number, Map<number, Set<string>>>();
  for (const candidate of edits as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) {
      return { ok: false, error: { kind: 'edit-conflict', conflict: 'invalid-edit' } };
    }
    const edit = candidate as DocumentEdit;
    const start = edit.start as number;
    const end = edit.end as number;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
      || end > snapshot.lengthUtf16 || typeof edit.text !== 'string') {
      return { ok: false, error: { kind: 'edit-conflict', conflict: 'invalid-edit' } };
    }
    if (!snapshot.lineIndexAt(edit.start).ok || !snapshot.lineIndexAt(edit.end).ok) {
      return { ok: false, error: { kind: 'edit-conflict', conflict: 'invalid-edit' } };
    }
    if (end - start === edit.text.length) {
      const oldText = snapshot.slice(edit.start, edit.end);
      if (!oldText.ok) return { ok: false, error: { kind: 'edit-conflict', conflict: 'invalid-edit' } };
      if (oldText.value === edit.text) continue;
    }
    const byEnd = exact.get(start) ?? new Map<number, Set<string>>();
    const texts = byEnd.get(end) ?? new Set<string>();
    if (texts.has(edit.text)) continue;
    texts.add(edit.text);
    byEnd.set(end, texts);
    exact.set(start, byEnd);
    unique.push(Object.freeze({ start: edit.start, end: edit.end, text: edit.text }));
  }

  unique.sort((left, right) => (left.start as number) - (right.start as number)
    || (left.end as number) - (right.end as number)
    || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));

  const merged: DocumentEdit[] = [];
  for (const edit of unique) {
    const previous = merged[merged.length - 1];
    if (previous === undefined) {
      merged.push(edit);
      continue;
    }
    const start = edit.start as number;
    const end = edit.end as number;
    const priorStart = previous.start as number;
    const priorEnd = previous.end as number;
    const editIsInsert = start === end;
    const priorIsInsert = priorStart === priorEnd;
    const editIsDelete = !editIsInsert && edit.text.length === 0;
    const priorIsDelete = !priorIsInsert && previous.text.length === 0;

    if (editIsInsert && priorIsInsert && start === priorStart) {
      if (edit.text === previous.text) continue;
      return conflict('different-inserts-at-same-position');
    }
    if ((editIsInsert && !priorIsInsert && start >= priorStart && start <= priorEnd)
      || (priorIsInsert && !editIsInsert && priorStart >= start && priorStart <= end)) {
      return conflict('insertion-touches-replacement');
    }
    if (start < priorEnd) {
      if (editIsDelete && priorIsDelete) {
        merged[merged.length - 1] = Object.freeze({
          start: previous.start,
          end: Math.max(priorEnd, end) as DocumentEdit['end'],
          text: '',
        });
        continue;
      }
      return conflict(editIsDelete || priorIsDelete ? 'delete-overlaps-replacement' : 'overlapping-replacements');
    }
    merged.push(edit);
  }
  return { ok: true, value: Object.freeze(merged) };
}

export interface AtomicMemberIntent {
  /** This member's complete next semantic selection, expressed against the candidate snapshot. */
  readonly nextSelection: SelectionMemberInput;
  /** Edits use zero-based UTF-16 half-open offsets in the one captured base version. */
  readonly edits: readonly DocumentEdit[];
}

export interface AtomicResolvedMember extends AtomicMemberIntent {
  readonly source: SelectionMember;
}

export interface AtomicRegisterWrite {
  readonly name: string;
  readonly value: SerializedSelectionValue;
}

/** Shared semantic state returned by Vim after all per-member outcomes resolve. */
export interface AtomicSessionDelta {
  readonly mode?: VimMode;
  readonly repeatTarget?: SerializedSelectionValue;
  readonly registerWrites?: readonly AtomicRegisterWrite[];
}

function conflict(conflictKind: AtomicEditConflict): Result<never, { readonly kind: 'edit-conflict'; readonly conflict: AtomicEditConflict }> {
  return { ok: false, error: { kind: 'edit-conflict', conflict: conflictKind } };
}
