import { asCellColumn, asLineIndex, asUtf16Offset, type SelectionId } from '../../contracts/src/index';
import type { DocumentSnapshot } from '../../document/src/index';
import { updateSelectionSet, type EndpointInput, type SelectionSetSnapshot, type SelectionMemberInput } from '../../selections/src/index';
import type { PointerCell, VimVisualCursor } from '../../vim/src/entrypoints/launch';
import { id, makeNormalSelection } from './helpers';

export function addPointerCaret(
  snapshot: DocumentSnapshot,
  target: PointerCell['target'],
  current: SelectionSetSnapshot,
  install: (next: SelectionSetSnapshot) => void,
): boolean {
  if (target === undefined || current.members.some((member) => member.kind !== 'normal-cursor')) return false;
  const nextId = id<SelectionId>(`xi-pointer-selection-${current.selectionGeneration as number}-${current.members.length}`);
  const targetOffset = asUtf16Offset(target.offset);
  if (!targetOffset.ok) return false;
  const single = makeNormalSelection(snapshot, targetOffset.value, current.selectionGeneration as number, nextId);
  const member = single.members[0];
  if (member === undefined || member.kind !== 'normal-cursor') return false;
  const existing: SelectionMemberInput[] = current.members.map((source): SelectionMemberInput => {
    if (source.kind !== 'normal-cursor') throw new Error('xi-pointer-mixed-selection');
    return {
      id: source.id,
      kind: source.kind,
      direction: source.direction,
      anchor: pointerNormalEndpoint(source.anchor),
      head: pointerNormalEndpoint(source.head),
      desiredColumn: source.desiredColumn,
      creationOrdinal: source.creationOrdinal,
    };
  });
  const updated = updateSelectionSet(snapshot, current, {
    primaryId: nextId,
    members: [...existing, pointerNormalEndpointMember(member, false)],
  });
  if (!updated.ok) return false;
  install(updated.value.selectionSet);
  return true;
}

export function pointerNormalEndpointMember(member: Extract<SelectionSetSnapshot['members'][number], { readonly kind: 'normal-cursor' }>, preserveOrdinal = true): SelectionMemberInput {
  return {
    id: member.id,
    kind: member.kind,
    direction: member.direction,
    anchor: pointerNormalEndpoint(member.anchor),
    head: pointerNormalEndpoint(member.head),
    desiredColumn: member.desiredColumn,
    ...(preserveOrdinal ? { creationOrdinal: member.creationOrdinal } : {}),
  };
}

export function pointerNormalEndpoint(endpoint: Extract<SelectionSetSnapshot['members'][number], { readonly kind: 'normal-cursor' }>['anchor']): EndpointInput {
  switch (endpoint.kind) {
    case 'character': return { kind: 'character', offset: endpoint.at.offset, after: endpoint.after.offset, affinity: endpoint.at.affinity, afterAffinity: endpoint.after.affinity };
    case 'empty-line': return { kind: 'empty-line', lineIndex: endpoint.lineIndex, affinity: endpoint.at.affinity };
    case 'eof': return { kind: 'eof', affinity: endpoint.at.affinity };
  }
}

export function pointerVisualCursor(snapshot: DocumentSnapshot, target: NonNullable<PointerCell['target']>): VimVisualCursor | undefined {
  if (!Number.isSafeInteger(target.lineIndex) || target.lineIndex < 0
    || !Number.isSafeInteger(target.offset) || target.offset < 0 || target.offset > snapshot.lengthUtf16
    || !Number.isSafeInteger(target.displayCellColumn) || target.displayCellColumn < 0
    || !Number.isSafeInteger(target.virtualCell) || target.virtualCell < 0) return undefined;
  const safeOffset = target.cellPart === 'padding' ? pointerPreviousCharacter(snapshot, target.offset) : target.offset;
  const offsetValue = asUtf16Offset(safeOffset);
  const displayValue = asCellColumn(target.displayCellColumn);
  if (!offsetValue.ok || !displayValue.ok) return undefined;
  return {
    documentVersion: snapshot.version,
    offset: offsetValue.value,
    displayCellColumn: displayValue.value,
    virtualCells: target.virtualCell,
  };
}

export function pointerWordRange(
  snapshot: DocumentSnapshot,
  anchor: VimVisualCursor,
  head: VimVisualCursor,
): { readonly anchor: VimVisualCursor; readonly head: VimVisualCursor } | undefined {
  const anchorRange = pointerWordAt(snapshot, anchor.offset as number);
  const headRange = pointerWordAt(snapshot, head.offset as number);
  if (anchorRange === undefined || headRange === undefined) return undefined;
  const forward = (anchor.offset as number) <= (head.offset as number);
  const anchorOffset = forward ? anchorRange.start : pointerLastCharacter(snapshot, anchorRange.end);
  const headOffset = forward ? pointerLastCharacter(snapshot, headRange.end) : headRange.start;
  const anchorTarget = pointerTargetAt(snapshot, anchorOffset);
  const headTarget = pointerTargetAt(snapshot, headOffset);
  if (anchorTarget === undefined || headTarget === undefined) return undefined;
  const anchorCursor = pointerVisualCursor(snapshot, anchorTarget);
  const headCursor = pointerVisualCursor(snapshot, headTarget);
  return anchorCursor === undefined || headCursor === undefined ? undefined : { anchor: anchorCursor, head: headCursor };
}

export function pointerWordAt(snapshot: DocumentSnapshot, offsetValue: number): { readonly start: number; readonly end: number } | undefined {
  const safeOffset = asUtf16Offset(Math.max(0, Math.min(offsetValue, snapshot.lengthUtf16)));
  if (!safeOffset.ok) return undefined;
  const line = snapshot.lineIndexAt(safeOffset.value);
  if (!line.ok) return undefined;
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return undefined;
  const next = (line.value as number) + 1;
  const nextLine = asLineIndex(next);
  const end = next < snapshot.lineCount && nextLine.ok ? snapshot.lineStartOffset(nextLine.value) : asUtf16Offset(snapshot.lengthUtf16);
  if (!end.ok) return undefined;
  const text = snapshot.slice(start.value, end.value);
  if (!text.ok) return undefined;
  const units = [...text.value].map((value, index) => ({ value, start: index, end: index + value.length }));
  if (units.length === 0) return undefined;
  let local = Math.max(0, offsetValue - (start.value as number));
  let selected = units.findIndex((unit) => local >= unit.start && local < unit.end);
  if (selected < 0) selected = units.length - 1;
  const kind = pointerWordKind(units[selected]?.value ?? '');
  let first = selected;
  while (first > 0 && pointerWordKind(units[first - 1]?.value ?? '') === kind) first -= 1;
  let last = selected;
  while (last + 1 < units.length && pointerWordKind(units[last + 1]?.value ?? '') === kind) last += 1;
  return { start: (start.value as number) + (units[first]?.start ?? 0), end: (start.value as number) + (units[last]?.end ?? 0) };
}

export function pointerWordKind(value: string): 'space' | 'keyword' | 'punctuation' {
  if (/\s/u.test(value)) return 'space';
  return /^[\p{L}\p{N}_]$/u.test(value) ? 'keyword' : 'punctuation';
}

export function pointerTargetAt(snapshot: DocumentSnapshot, offsetValue: number): NonNullable<PointerCell['target']> | undefined {
  const safeOffset = asUtf16Offset(offsetValue);
  if (!safeOffset.ok) return undefined;
  const line = snapshot.lineIndexAt(safeOffset.value);
  if (!line.ok) return undefined;
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return undefined;
  return {
    lineIndex: line.value as number,
    offset: offsetValue,
    displayCellColumn: pointerDisplayColumn(snapshot, offsetValue, start.value as number),
    virtualCell: 0,
    cellPart: 'glyph',
  };
}

export function pointerDisplayColumn(snapshot: DocumentSnapshot, offsetValue: number, lineStartValue: number): number {
  const start = asUtf16Offset(lineStartValue);
  const end = asUtf16Offset(Math.max(lineStartValue, offsetValue));
  if (!start.ok || !end.ok) return 0;
  const prefix = snapshot.slice(start.value, end.value);
  if (!prefix.ok) return 0;
  let column = 0;
  for (const cluster of prefix.value) column += cluster === '\t' ? 8 - (column % 8) : pointerClusterWidth(cluster);
  return column;
}

export function pointerClusterWidth(cluster: string): number {
  const codePoint = cluster.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(cluster) || codePoint === 0x200d) return 0;
  return codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint >= 0x2e80) ? 2 : 1;
}

export function pointerPreviousCharacter(snapshot: DocumentSnapshot, offsetValue: number): number {
  if (offsetValue <= 0) return 0;
  const candidate = offsetValue - 1;
  const start = asUtf16Offset(candidate);
  const end = asUtf16Offset(offsetValue);
  if (!start.ok || !end.ok) return candidate;
  const unit = snapshot.slice(start.value, end.value);
  if (unit.ok && unit.value.length === 1) {
    const code = unit.value.charCodeAt(0);
    if (code >= 0xdc00 && code <= 0xdfff) return Math.max(0, offsetValue - 2);
  }
  return candidate;
}

export function pointerLastCharacter(snapshot: DocumentSnapshot, endValue: number): number {
  return pointerPreviousCharacter(snapshot, endValue);
}
