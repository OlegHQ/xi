import type { CellColumn, DocumentEdit, DocumentSnapshot, LineIndex, Result, Utf16Column, Utf16Offset } from '../../document/src/index';
import {
  createSelectionSet,
  updateSelectionSet,
  type EndpointInput,
  type DesiredColumn,
  type SelectionEndpoint,
  type SelectionMember,
  type SelectionMemberInput,
  type SelectionSetSnapshot,
  type SelectionId,
} from '../../selections/src/index';
import { defaultCellWidthPolicy } from '../../layout/src/index';
import type { VimNormalizedOperatorRange, VimOperatorRangeInput, VimOperatorRangeKind } from '../ranges/normalize';
import { normalizeVimOperatorRange } from '../ranges/normalize';
import { createVimMotionCursor } from '../motions';
import { wordGhostRange } from './word-ghost';

export type VimVisualKind = 'visual-character' | 'visual-line' | 'visual-block';
export type VimSelectMode = 'select-character' | 'select-line' | 'select-block';

export interface VimVisualCursor {
  readonly documentVersion: DocumentSnapshot['version'];
  /** Zero-based UTF-16 boundary of the semantic Normal-mode character (or empty line). */
  readonly offset: Utf16Offset;
  /** Zero-based logical terminal-cell column; this comes from the active layout frame. */
  readonly displayCellColumn: CellColumn;
  /** Sticky preferred columns are distinct from the cursor's clamped physical position. */
  readonly desiredColumn?: DesiredColumn;
  /** Optional virtual display cells after physical end of line. */
  readonly virtualCells?: number;
}

export interface VimVisualOptions {
  readonly selection?: 'inclusive' | 'exclusive';
  /** `beginVimVisualSelection` only: generation for the new set (callers rebuilding a
   * selection per pointer move pass previous+1 so renderers see it as changed). */
  readonly selectionGeneration?: number;
}

export type VimVisualFailure =
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-selection-kind' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'invalid-selection'; readonly reason: string }
  | { readonly kind: 'missing-selection-member'; readonly id: SelectionId }
  | { readonly kind: 'not-blockwise' }
  | { readonly kind: 'invalid-count' };

export type VimSelectReplacementFailure = VimVisualFailure
  | { readonly kind: 'invalid-replacement-text' }
  | { readonly kind: 'unsupported-select-replacement' };

export interface VimSelectReplacementPlan {
  readonly documentId: DocumentSnapshot['id'];
  readonly expectedVersion: DocumentSnapshot['version'];
  readonly edits: readonly DocumentEdit[];
  /** Insert-mode caret after the replacement payload; the document owner commits edits. */
  readonly cursorOffset: Utf16Offset;
  readonly nextMode: 'insert';
}

export interface VimVisualReplacementPlan {
  readonly documentId: DocumentSnapshot['id'];
  readonly expectedVersion: DocumentSnapshot['version'];
  readonly edits: readonly DocumentEdit[];
  /** Insert-mode caret after the replacement payload; the document owner commits edits. */
  readonly cursorOffset: Utf16Offset;
  readonly nextMode: 'insert';
}

export type VimVisualReplacementFailure = VimVisualFailure
  | { readonly kind: 'invalid-replacement-text' }
  | { readonly kind: 'unsupported-select-replacement' };

/** Xi-only last-motion range. Endpoints are semantic UTF-16 characters, never cells.
 * Normal operators continue to use the Normal cursor; only explicit `v` adopts this set. */
export function createVimMotionGhost(snapshot: DocumentSnapshot, before: SelectionSetSnapshot, after: SelectionSetSnapshot, key?: string, count = 1) {
  if (before.documentId !== snapshot.id || after.documentId !== snapshot.id
    || before.documentVersion !== snapshot.version || after.documentVersion !== snapshot.version
    || before.members.length !== after.members.length) return undefined;
  if (key !== undefined && /^(?:[hjklG0^$|_+\-]|gg|g_|H|M|L|<.*>)$/u.test(key)) return undefined;
  const sources = new Map(before.members.map(member => [member.id, member]));
  const members: SelectionMemberInput[] = [];
  const previewMembers = [];
  let moved = false;
  for (const target of after.members) {
    const source = sources.get(target.id);
    if (source?.kind !== 'normal-cursor' || target.kind !== 'normal-cursor') return undefined;
    const forward = source.head.at.offset <= target.head.at.offset;
    let anchor = endpointInput(source.head);
    let head = endpointInput(target.head);
    let desiredColumn = target.desiredColumn;
    let anchorDesiredColumn = source.desiredColumn;
    let start = Math.min(source.head.at.offset, target.head.at.offset);
    const high = forward ? target.head : source.head;
    let end: number = high.kind === 'character' ? high.after.offset : high.at.offset;
    // Helix word selections stop before the next word and do not carry a newline
    // into the next selection. Keep Vim's actual cursor destination independent.
    if (key === 'w' || key === 'W' || key === 'e' || key === 'E' || key === 'b' || key === 'B') {
      const backward = key === 'b' || key === 'B';
      const sourceEndpoint = endpointFor(snapshot, { documentVersion: snapshot.version, offset: source.head.at.offset, displayCellColumn: 0 as CellColumn }, 'visual-character');
      if (!sourceEndpoint.ok) return undefined;
      const range = wordGhostRange(snapshot, source.head.at.offset, sourceEndpoint.value.kind === 'character' ? sourceEndpoint.value.after : source.head.at.offset, key, count);
      if (range === undefined) return undefined;
      start = range.start;
      end = range.end;
      const line = snapshot.lineIndexAt(start as Utf16Offset);
      const metrics = line.ok ? lineMetrics(snapshot, line.value) : null;
      if (metrics === null) return undefined;
      let last = end - 1;
      while (last > start && !graphemeBoundaryConfirmed(snapshot, last, metrics.start)) last -= 1;
      const low = endpointFor(snapshot, { documentVersion: snapshot.version, offset: start as Utf16Offset, displayCellColumn: 0 as CellColumn }, 'visual-character');
      const high = endpointFor(snapshot, { documentVersion: snapshot.version, offset: last as Utf16Offset, displayCellColumn: 0 as CellColumn }, 'visual-character');
      if (!low.ok || !high.ok) return undefined;
      anchor = backward ? high.value : low.value;
      head = backward ? low.value : high.value;
      const headCursor = createVimMotionCursor(snapshot, (backward ? start : last) as Utf16Offset);
      const anchorCursor = createVimMotionCursor(snapshot, (backward ? last : start) as Utf16Offset);
      if (!headCursor.ok || !anchorCursor.ok) return undefined;
      desiredColumn = { logicalUtf16: ((backward ? start : last) - metrics.start) as Utf16Column, displayCell: headCursor.value.desiredDisplayCellColumn };
      anchorDesiredColumn = { logicalUtf16: ((backward ? last : start) - metrics.start) as Utf16Column, displayCell: anchorCursor.value.desiredDisplayCellColumn };
    }
    const changed = source.head.at.offset !== target.head.at.offset;
    moved ||= changed;
    members.push({ id: target.id, kind: 'visual-character', direction: forward ? 'forward' : 'backward',
      anchor, head, inclusive: true,
      desiredColumn, anchorDesiredColumn });
    previewMembers.push(Object.freeze({ memberId: target.id, source: source.head.at.offset, destination: target.head.at.offset,
      moved: changed, extent: Object.freeze({ kind: 'characterwise' as const,
        start: start as Utf16Offset, end: end as Utf16Offset }) }));
  }
  if (!moved) return undefined;
  const visual = updateSelectionSet(snapshot, after, { primaryId: after.primaryId, members });
  if (!visual.ok) return undefined;
  return Object.freeze({ selection: visual.value.selectionSet, preview: Object.freeze({
    documentId: snapshot.id, documentVersion: snapshot.version, selectionGeneration: after.selectionGeneration,
    members: Object.freeze(previewMembers),
  }) });
}

export type VimMotionGhost = NonNullable<ReturnType<typeof createVimMotionGhost>>;

/** Begin one visual region while keeping selection state in the shared selection owner. */
export function beginVimVisualSelection(
  snapshot: DocumentSnapshot,
  selectionId: SelectionId,
  cursor: VimVisualCursor,
  kind: VimVisualKind,
  options: VimVisualOptions = {},
): Result<SelectionSetSnapshot, VimVisualFailure> {
  if (cursor.documentVersion !== snapshot.version) return visualFailure('stale-document-version');
  if (options.selection !== undefined && options.selection !== 'inclusive' && options.selection !== 'exclusive') {
    return visualFailure('invalid-option');
  }
  const endpoint = endpointFor(snapshot, cursor, kind);
  if (!endpoint.ok) return endpoint;
  const line = snapshot.lineIndexAt(cursor.offset);
  if (!line.ok) return visualFailure('invalid-cursor');
  const lineStart = snapshot.lineStartOffset(line.value);
  if (!lineStart.ok) return visualFailure('invalid-cursor');
  const logicalColumn = ((cursor.offset as number) - (lineStart.value as number)) as Utf16Column;
  const desiredColumn = cursor.desiredColumn ?? { logicalUtf16: logicalColumn, displayCell: cursor.displayCellColumn };
  const member: SelectionMemberInput = kind === 'visual-character'
    ? {
      id: selectionId, kind, direction: 'forward', anchor: endpoint.value, head: endpoint.value,
      inclusive: options.selection !== 'exclusive', desiredColumn, anchorDesiredColumn: desiredColumn,
    }
    : kind === 'visual-line'
      ? { id: selectionId, kind, direction: 'forward', anchor: endpoint.value, head: endpoint.value, desiredColumn, anchorDesiredColumn: desiredColumn }
      : { id: selectionId, kind, direction: 'forward', anchor: endpoint.value, head: endpoint.value, desiredColumn, anchorDesiredColumn: desiredColumn };
  const created = createSelectionSet(snapshot, { primaryId: selectionId, members: [member], ...(options.selectionGeneration === undefined ? {} : { selectionGeneration: options.selectionGeneration }) });
  if (!created.ok) return { ok: false, error: { kind: 'invalid-selection', reason: created.error.kind } };
  return { ok: true, value: created.value.selectionSet };
}

/** Extend each visual member from its stable anchor to its matching layout cursor. */
export function extendVimVisualSelection(
  snapshot: DocumentSnapshot,
  current: SelectionSetSnapshot,
  targets: readonly { readonly id: SelectionId; readonly cursor: VimVisualCursor }[],
  options: VimVisualOptions = {},
): Result<SelectionSetSnapshot, VimVisualFailure> {
  if (current.documentVersion !== snapshot.version) return visualFailure('stale-document-version');
  if (options.selection !== undefined && options.selection !== 'inclusive' && options.selection !== 'exclusive') {
    return visualFailure('invalid-option');
  }
  const byId = new Map(targets.map((target) => [target.id, target.cursor]));
  const members: SelectionMemberInput[] = [];
  for (const source of current.members) {
    const target = byId.get(source.id);
    if (target === undefined) return { ok: false, error: { kind: 'missing-selection-member', id: source.id } };
    if (target.documentVersion !== snapshot.version) return visualFailure('stale-document-version');
    if (source.kind !== 'visual-character' && source.kind !== 'visual-line' && source.kind !== 'visual-block') {
      return visualFailure('invalid-selection-kind');
    }
    const endpoint = endpointFor(snapshot, target, source.kind);
    if (!endpoint.ok) return endpoint;
    const line = snapshot.lineIndexAt(target.offset);
    if (!line.ok) return visualFailure('invalid-cursor');
    const lineStart = snapshot.lineStartOffset(line.value);
    if (!lineStart.ok) return visualFailure('invalid-cursor');
    const headColumn = ((target.offset as number) - (lineStart.value as number)) as Utf16Column;
    const headDesired = target.desiredColumn ?? { logicalUtf16: headColumn, displayCell: target.displayCellColumn };
    const direction = compareEndpointPosition(snapshot, source.anchor, endpoint.value) <= 0 ? 'forward' : 'backward';
    members.push(replaceMemberEndpoints(source, endpointInput(source.anchor), endpoint.value, direction,
      headDesired, source.kind === 'visual-character' ? options.selection !== 'exclusive' : undefined,
      source.anchorDesiredColumn));
  }
  const updated = updateSelectionSet(snapshot, current, { primaryId: current.primaryId, members });
  if (!updated.ok) return { ok: false, error: { kind: 'invalid-selection', reason: updated.error.kind } };
  return { ok: true, value: updated.value.selectionSet };
}

/** Change Visual kind without discarding the stable anchor or any member. */
export function convertVimVisualSelection(snapshot: DocumentSnapshot, current: SelectionSetSnapshot, kind: VimVisualKind): Result<SelectionSetSnapshot, VimVisualFailure> {
  if (current.documentVersion !== snapshot.version) return visualFailure('stale-document-version');
  const members: SelectionMemberInput[] = [];
  for (const member of current.members) {
    if (!isVisualMember(member)) return visualFailure('invalid-selection-kind');
    const endpoints: EndpointInput[] = [];
    for (const [endpoint, desired] of [[member.anchor, member.anchorDesiredColumn], [member.head, member.desiredColumn]] as const) {
      const line = snapshot.lineIndexAt(endpoint.at.offset);
      if (!line.ok) return visualFailure('invalid-cursor');
      const metrics = lineMetrics(snapshot, line.value);
      if (metrics === null) return visualFailure('invalid-cursor');
      let at = endpoint.kind === 'line' ? Math.min(metrics.start + (desired.logicalUtf16 ?? 0), Math.max(metrics.start, metrics.end - 1)) : endpoint.at.offset as number;
      while (at > metrics.start && !graphemeBoundaryConfirmed(snapshot, at, metrics.start)) at -= 1;
      const converted = endpointFor(snapshot, { documentVersion: snapshot.version, offset: at as Utf16Offset, displayCellColumn: (desired.displayCell ?? 0) as CellColumn }, kind);
      if (!converted.ok) return converted;
      endpoints.push(converted.value);
    }
    const base = { id: member.id, kind, direction: member.direction, anchor: endpoints[0]!, head: endpoints[1]!, desiredColumn: member.desiredColumn, anchorDesiredColumn: member.anchorDesiredColumn, creationOrdinal: member.creationOrdinal };
    members.push(kind === 'visual-character' ? { ...base, kind, inclusive: true } : { ...base, kind });
  }
  const updated = updateSelectionSet(snapshot, current, { primaryId: current.primaryId, members });
  return updated.ok ? { ok: true, value: updated.value.selectionSet } : visualFailure('invalid-selection-kind');
}

/** `o` exchanges active and anchor endpoints while preserving each selection's geometry. */
export function exchangeVimVisualEndpoints(
  snapshot: DocumentSnapshot,
  current: SelectionSetSnapshot,
): Result<SelectionSetSnapshot, VimVisualFailure> {
  if (current.documentVersion !== snapshot.version) return visualFailure('stale-document-version');
  const members = current.members.map((member) => {
    if (!isVisualMember(member)) return null;
    return replaceMemberEndpoints(member, endpointInput(member.head), endpointInput(member.anchor),
      member.direction === 'forward' ? 'backward' : 'forward', member.anchorDesiredColumn,
      member.kind === 'visual-character' ? member.inclusive : undefined,
      member.desiredColumn);
  });
  if (members.some((member) => member === null)) return visualFailure('invalid-selection-kind');
  const updated = updateSelectionSet(snapshot, current, { primaryId: current.primaryId, members: members as SelectionMemberInput[] });
  if (!updated.ok) return { ok: false, error: { kind: 'invalid-selection', reason: updated.error.kind } };
  return { ok: true, value: updated.value.selectionSet };
}

/** `O` exchanges the horizontal corners of a block but keeps both selected rows fixed. */
export function exchangeVimVisualBlockColumns(
  snapshot: DocumentSnapshot,
  current: SelectionSetSnapshot,
): Result<SelectionSetSnapshot, VimVisualFailure> {
  if (current.documentVersion !== snapshot.version) return visualFailure('stale-document-version');
  const members: SelectionMemberInput[] = [];
  for (const member of current.members) {
    if (member.kind !== 'visual-block' || member.anchor.kind !== 'block-cell' || member.head.kind !== 'block-cell') {
      return visualFailure('not-blockwise');
    }
    const anchor = blockEndpointWithColumn(member.anchor, member.head);
    const head = blockEndpointWithColumn(member.head, member.anchor);
    const direction = member.anchor.lineIndex !== member.head.lineIndex
      ? member.anchor.lineIndex < member.head.lineIndex ? 'forward' : 'backward'
      : member.anchor.displayCellColumn <= member.head.displayCellColumn ? 'forward' : 'backward';
    members.push(replaceMemberEndpoints(member, anchor, head,
      direction,
      { logicalUtf16: member.anchor.logicalUtf16Column, displayCell: member.anchor.displayCellColumn }, undefined,
      { logicalUtf16: member.head.logicalUtf16Column, displayCell: member.head.displayCellColumn }));
  }
  const updated = updateSelectionSet(snapshot, current, { primaryId: current.primaryId, members });
  if (!updated.ok) return { ok: false, error: { kind: 'invalid-selection', reason: updated.error.kind } };
  return { ok: true, value: updated.value.selectionSet };
}

/** `gv` restores the exact prior selection; a stale document must be mapped by the session owner first. */
export function reselectVimVisualSelection(
  snapshot: DocumentSnapshot,
  previous: SelectionSetSnapshot,
  count = 1,
): Result<SelectionSetSnapshot, VimVisualFailure> {
  if (!Number.isSafeInteger(count) || count < 1) return visualFailure('invalid-count');
  if (previous.documentId !== snapshot.id || previous.documentVersion !== snapshot.version) {
    return visualFailure('stale-document-version');
  }
  if (!previous.members.every(isVisualMember)) return visualFailure('invalid-selection-kind');
  return { ok: true, value: previous };
}

/** Adapt stored selection geometry to the shared half-open Vim operator normalizer. */
export function vimVisualSelectionMotion(
  snapshot: DocumentSnapshot,
  selection: SelectionSetSnapshot,
  operator: 'delete' | 'change' | 'yank',
  options: { readonly tabSize?: number } = {},
): Result<Omit<VimOperatorRangeInput, 'operator'>, VimVisualFailure> {
  if (selection.documentId !== snapshot.id || selection.documentVersion !== snapshot.version) {
    return visualFailure('stale-document-version');
  }
  const member = selection.members.find((candidate) => candidate.id === selection.primaryId);
  if (member === undefined || !isVisualMember(member)) return visualFailure('invalid-selection-kind');
  if (options.tabSize !== undefined && (!Number.isSafeInteger(options.tabSize) || options.tabSize < 1 || options.tabSize > 1000)) {
    return visualFailure('invalid-option');
  }
  const origin = member.anchor;
  const target = member.head;
  const originOffset = origin.at.offset;
  const targetOffset = target.at.offset;
  const motionKind: VimOperatorRangeKind = member.kind === 'visual-line' ? 'linewise' : 'characterwise';
  const forceKind: VimOperatorRangeKind | undefined = member.kind === 'visual-block' ? 'blockwise'
    : member.kind === 'visual-line' ? 'linewise' : undefined;
  const originDisplayCellColumn = origin.kind === 'block-cell' ? origin.displayCellColumn : member.desiredColumn.displayCell;
  const targetDisplayCellColumn = target.kind === 'block-cell' ? target.displayCellColumn : member.desiredColumn.displayCell;
  return {
    ok: true,
    value: {
      origin: { documentVersion: snapshot.version, offset: originOffset, ...(originDisplayCellColumn === null ? {} : { displayCellColumn: originDisplayCellColumn as number }) },
      target: { documentVersion: snapshot.version, offset: targetOffset, ...(targetDisplayCellColumn === null ? {} : { displayCellColumn: targetDisplayCellColumn as number }) },
      direction: member.direction,
      motionKind,
      inclusive: member.kind === 'visual-character' ? member.inclusive : true,
      motionKey: 'visual',
      ...(forceKind === undefined ? {} : { forceKind }),
      ...(member.kind === 'visual-block' ? { blockTabPolicy: 'preserve' as const } : {}),
      ...(options.tabSize === undefined ? {} : { tabSize: options.tabSize }),
    },
  };
}

/**
 * Prepare the first printable-key effect for character Select mode. This is a
 * pure transaction proposal; the document/session dispatcher owns committing
 * it and transitioning into Insert mode.
 */
export function planVimSelectReplacement(
  snapshot: DocumentSnapshot,
  selection: SelectionSetSnapshot,
  text: string,
): Result<VimSelectReplacementPlan, VimSelectReplacementFailure> {
  if (selection.documentId !== snapshot.id || selection.documentVersion !== snapshot.version) {
    return visualFailure('stale-document-version');
  }
  if (!isWellFormedUtf16(text)) return { ok: false, error: { kind: 'invalid-replacement-text' } };
  if (selection.members.length !== 1 || selection.members[0]?.kind !== 'visual-character') {
    return { ok: false, error: { kind: 'unsupported-select-replacement' } };
  }
  const motion = vimVisualSelectionMotion(snapshot, selection, 'change');
  if (!motion.ok) return motion;
  const normalized = normalizeVimOperatorRange(snapshot, { ...motion.value, operator: 'change' });
  if (!normalized.ok) return { ok: false, error: { kind: 'invalid-selection', reason: normalized.error.kind } };
  if (normalized.value.kind !== 'characterwise' || normalized.value.ranges.length !== 1) {
    return { ok: false, error: { kind: 'unsupported-select-replacement' } };
  }
  const range = normalized.value.ranges[0];
  if (range === undefined) return { ok: false, error: { kind: 'unsupported-select-replacement' } };
  return {
    ok: true,
    value: Object.freeze({
      documentId: snapshot.id,
      expectedVersion: snapshot.version,
      edits: Object.freeze([Object.freeze({ start: range.start, end: range.end, text })]),
      cursorOffset: ((range.start as number) + text.length) as Utf16Offset,
      nextMode: 'insert',
    }),
  };
}

/** Prepare a replacement for one characterwise or blockwise Visual selection. */
export function planVimVisualReplacement(
  snapshot: DocumentSnapshot,
  selection: SelectionSetSnapshot,
  text: string,
  options: { readonly tabSize?: number } = {},
): Result<VimVisualReplacementPlan, VimVisualReplacementFailure> {
  if (selection.documentId !== snapshot.id || selection.documentVersion !== snapshot.version) {
    return visualFailure('stale-document-version');
  }
  if (!isWellFormedUtf16(text)) return { ok: false, error: { kind: 'invalid-replacement-text' } };
  if (selection.members.length !== 1) return { ok: false, error: { kind: 'unsupported-select-replacement' } };
  const member = selection.members[0];
  if (member === undefined || (member.kind !== 'visual-character' && member.kind !== 'visual-block')) {
    return { ok: false, error: { kind: 'unsupported-select-replacement' } };
  }
  const tabSize = options.tabSize ?? 8;
  if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 1000) return visualFailure('invalid-option');
  const motion = vimVisualSelectionMotion(snapshot, selection, 'change', { tabSize });
  if (!motion.ok) return motion;
  const normalized = normalizeVimOperatorRange(snapshot, { ...motion.value, operator: 'change' });
  if (!normalized.ok) return { ok: false, error: { kind: 'invalid-selection', reason: normalized.error.kind } };
  if (normalized.value.kind === 'characterwise') {
    const range = normalized.value.ranges[0];
    if (range === undefined || normalized.value.ranges.length !== 1) {
      return { ok: false, error: { kind: 'unsupported-select-replacement' } };
    }
    return {
      ok: true,
      value: replacementPlan(snapshot, [{ start: range.start, end: range.end, text }],
        (range.start as number) + text.length),
    };
  }
  if (normalized.value.kind !== 'blockwise' || member.kind !== 'visual-block'
    || member.anchor.kind !== 'block-cell' || member.head.kind !== 'block-cell') {
    return { ok: false, error: { kind: 'unsupported-select-replacement' } };
  }
  const left = Math.min(member.anchor.displayCellColumn as number, member.head.displayCellColumn as number);
  const top = Math.min(member.anchor.lineIndex as number, member.head.lineIndex as number);
  const bottom = Math.max(member.anchor.lineIndex as number, member.head.lineIndex as number);
  const rangeByLine = new Map<number, VimNormalizedOperatorRange['ranges'][number]>();
  for (const range of normalized.value.ranges) {
    const line = snapshot.lineIndexAt(range.start);
    if (!line.ok) return visualFailure('invalid-cursor');
    rangeByLine.set(line.value as number, range);
  }
  const widthPolicy = defaultCellWidthPolicy();
  const edits: DocumentEdit[] = [];
  let cursorOffset: Utf16Offset | undefined;
  for (let lineIndex = top; lineIndex <= bottom; lineIndex += 1) {
    const bounds = lineBounds(snapshot, lineIndex as LineIndex);
    if (bounds === null) return visualFailure('invalid-cursor');
    const range = rangeByLine.get(lineIndex);
    if (range === undefined) {
      const virtualPrefix = Math.max(0, left - measureCells(bounds.text, tabSize, widthPolicy));
      const editText = `${' '.repeat(virtualPrefix)}${text}`;
      edits.push(Object.freeze({ start: bounds.end as Utf16Offset, end: bounds.end as Utf16Offset, text: editText }));
      if (cursorOffset === undefined) cursorOffset = (bounds.end + virtualPrefix + text.length) as Utf16Offset;
      continue;
    }
    const selectedSource = snapshot.slice(range.start, range.end);
    if (!selectedSource.ok) return visualFailure('invalid-cursor');
    let editText = text;
    let prefixCells = 0;
    if (range.replacementText !== undefined) {
      const prefix = range.replacementPrefix ?? '';
      const suffix = range.replacementSuffix ?? '';
      prefixCells = prefix.length;
      editText = `${prefix}${text}${suffix}`;
    }
    edits.push(Object.freeze({ start: range.start, end: range.end, text: editText }));
    if (cursorOffset === undefined) cursorOffset = ((range.start as number) + prefixCells + text.length) as Utf16Offset;
  }
  if (cursorOffset === undefined || edits.length === 0) return { ok: false, error: { kind: 'unsupported-select-replacement' } };
  return { ok: true, value: replacementPlan(snapshot, edits, cursorOffset) };
}

function endpointFor(
  snapshot: DocumentSnapshot,
  cursor: VimVisualCursor,
  kind: VimVisualKind,
): Result<EndpointInput, VimVisualFailure> {
  if (cursor.documentVersion !== snapshot.version) return visualFailure('stale-document-version');
  if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || (cursor.offset as number) > snapshot.lengthUtf16
    || !Number.isSafeInteger(cursor.displayCellColumn) || (cursor.displayCellColumn as number) < 0
    || (cursor.virtualCells !== undefined && (!Number.isSafeInteger(cursor.virtualCells) || cursor.virtualCells < 0))) {
    return visualFailure('invalid-cursor');
  }
  const line = snapshot.lineIndexAt(cursor.offset);
  if (!line.ok) return visualFailure('invalid-cursor');
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return visualFailure('invalid-cursor');
  if (kind === 'visual-line') return { ok: true, value: { kind: 'line', lineIndex: line.value } };
  if (kind === 'visual-block') {
    const logicalColumn = ((cursor.offset as number) - (start.value as number)) as Utf16Column;
    return {
      ok: true,
      value: {
        kind: 'block-cell', offset: cursor.offset,
        logicalUtf16Column: logicalColumn,
        displayCellColumn: cursor.displayCellColumn,
        virtualCells: cursor.virtualCells ?? 0,
      },
    };
  }
  const metrics = lineMetrics(snapshot, line.value);
  if (metrics === null) return visualFailure('invalid-cursor');
  if (metrics.start === metrics.end) return { ok: true, value: { kind: 'empty-line', lineIndex: line.value } };
  const cursorAbs = cursor.offset as number;
  if (cursorAbs < metrics.start || cursorAbs >= metrics.end) return visualFailure('invalid-cursor');
  // Bounded: confirming the boundary and measuring the cluster only ever
  // reads a small window around the cursor, never the whole (possibly huge) line.
  if (!graphemeBoundaryConfirmed(snapshot, cursorAbs, metrics.start)) return visualFailure('invalid-cursor');
  const length = graphemeLengthAt(snapshot, cursorAbs, metrics.end);
  if (length === null) return visualFailure('invalid-cursor');
  return { ok: true, value: { kind: 'character', offset: cursor.offset, after: (cursorAbs + length) as Utf16Offset } };
}

/** Base window size (UTF-16 units) for the bounded grapheme scans below; doubles toward the line bounds. */
const GRAPHEME_WINDOW_BASE = 64;

const VISUAL_SEGMENTER_CTOR = (Intl as typeof Intl & {
  readonly Segmenter?: new (locales?: string | readonly string[], options?: { readonly granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>;
  };
}).Segmenter;
const VISUAL_GRAPHEME_SEGMENTER = typeof VISUAL_SEGMENTER_CTOR === 'function' ? new VISUAL_SEGMENTER_CTOR(undefined, { granularity: 'grapheme' }) : undefined;

/** True when `offset` is where a grapheme cluster starts (or the line start itself). */
function graphemeBoundaryConfirmed(snapshot: DocumentSnapshot, offset: number, lineStart: number): boolean {
  if (offset <= lineStart) return true;
  const segmenter = VISUAL_GRAPHEME_SEGMENTER;
  if (segmenter === undefined) return true;
  let window = GRAPHEME_WINDOW_BASE;
  for (;;) {
    const windowStart = Math.max(lineStart, offset - window);
    const text = snapshot.slice(windowStart as Utf16Offset, offset as Utf16Offset);
    if (!text.ok) return false;
    let previous: { readonly segment: string; readonly index: number } | undefined;
    let last: { readonly segment: string; readonly index: number } | undefined;
    for (const part of segmenter.segment(text.value)) { previous = last; last = part; }
    if (last === undefined) return windowStart <= lineStart;
    if (previous !== undefined || windowStart <= lineStart) {
      return windowStart + last.index + last.segment.length === offset;
    }
    window *= 2;
  }
}

/** Length in UTF-16 units of the grapheme cluster starting at `offset`, or null if none. */
function graphemeLengthAt(snapshot: DocumentSnapshot, offset: number, lineEnd: number): number | null {
  if (offset >= lineEnd) return null;
  const segmenter = VISUAL_GRAPHEME_SEGMENTER;
  if (segmenter === undefined) {
    const text = snapshot.slice(offset as Utf16Offset, Math.min(lineEnd, offset + 2) as Utf16Offset);
    if (!text.ok) return null;
    const scalar = Array.from(text.value)[0];
    return scalar === undefined ? null : scalar.length;
  }
  let window = GRAPHEME_WINDOW_BASE;
  for (;;) {
    const windowEnd = Math.min(lineEnd, offset + window);
    const text = snapshot.slice(offset as Utf16Offset, windowEnd as Utf16Offset);
    if (!text.ok) return null;
    let first: { readonly segment: string; readonly index: number } | undefined;
    let second: { readonly segment: string; readonly index: number } | undefined;
    for (const part of segmenter.segment(text.value)) {
      if (first === undefined) { first = part; continue; }
      second = part;
      break;
    }
    if (first === undefined || first.index !== 0) return null;
    if (second !== undefined || windowEnd >= lineEnd) return first.segment.length;
    window *= 2;
  }
}

/** Cheap line start/end (no text read); mirrors `lineBounds` without materializing the line's text. */
function lineMetrics(snapshot: DocumentSnapshot, line: LineIndex): { readonly start: number; readonly end: number } | null {
  const start = snapshot.lineStartOffset(line);
  if (!start.ok) return null;
  const next = (line as number) + 1 < snapshot.lineCount
    ? snapshot.lineStartOffset(((line as number) + 1) as LineIndex)
    : null;
  if (next !== null && !next.ok) return null;
  let end = next?.ok === true ? (next.value as number) - 1 : snapshot.lengthUtf16;
  if (next === null && end > (start.value as number)) {
    const final = snapshot.slice((end - 1) as Utf16Offset, end as Utf16Offset);
    if (!final.ok) return null;
    if (final.value === '\n') end -= 1;
  }
  if (end < (start.value as number)) return null;
  return { start: start.value as number, end };
}

function lineBounds(snapshot: DocumentSnapshot, line: LineIndex): { readonly start: number; readonly end: number; readonly text: string } | null {
  const start = snapshot.lineStartOffset(line);
  if (!start.ok) return null;
  const next = (line as number) + 1 < snapshot.lineCount
    ? snapshot.lineStartOffset(((line as number) + 1) as LineIndex)
    : null;
  if (next !== null && !next.ok) return null;
  let end = next?.ok === true ? (next.value as number) - 1 : snapshot.lengthUtf16;
  if (next === null && end > (start.value as number)) {
    const final = snapshot.slice((end - 1) as Utf16Offset, end as Utf16Offset);
    if (!final.ok) return null;
    if (final.value === '\n') end -= 1;
  }
  if (end < (start.value as number)) return null;
  const endOffset = end as Utf16Offset;
  const text = snapshot.slice(start.value, endOffset);
  if (!text.ok) return null;
  return { start: start.value as number, end, text: text.value };
}

function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function replacementPlan(
  snapshot: DocumentSnapshot,
  edits: readonly DocumentEdit[],
  cursorOffset: number,
): VimVisualReplacementPlan {
  return Object.freeze({
    documentId: snapshot.id,
    expectedVersion: snapshot.version,
    edits: Object.freeze([...edits]),
    cursorOffset: cursorOffset as Utf16Offset,
    nextMode: 'insert',
  });
}

function measureCells(
  text: string,
  tabSize: number,
  widthPolicy: ReturnType<typeof defaultCellWidthPolicy>,
): number {
  let cells = 0;
  for (const cluster of graphemeTexts(text)) {
    if (cluster === '\t') cells += tabSize - (cells % tabSize);
    else cells += widthPolicy.widthOfCluster(cluster);
  }
  return cells;
}

function graphemeTexts(text: string): readonly string[] {
  if (VISUAL_GRAPHEME_SEGMENTER !== undefined) return [...VISUAL_GRAPHEME_SEGMENTER.segment(text)].map((part) => part.segment);
  return Array.from(text);
}

function replaceMemberEndpoints(
  member: SelectionMember,
  anchor: EndpointInput,
  head: EndpointInput,
  direction: 'forward' | 'backward',
  desiredColumn: { readonly logicalUtf16: Utf16Column | null; readonly displayCell: CellColumn | null },
  inclusive: boolean | undefined,
  anchorDesiredColumn?: { readonly logicalUtf16: Utf16Column | null; readonly displayCell: CellColumn | null },
): SelectionMemberInput {
  const base = {
    id: member.id, direction, anchor, head, desiredColumn,
    creationOrdinal: member.creationOrdinal as number,
  };
  switch (member.kind) {
    case 'visual-character': return { ...base, kind: member.kind, inclusive: inclusive ?? member.inclusive, anchorDesiredColumn: anchorDesiredColumn ?? member.anchorDesiredColumn };
    case 'visual-line': return { ...base, kind: member.kind, anchorDesiredColumn: anchorDesiredColumn ?? member.anchorDesiredColumn };
    case 'visual-block': return { ...base, kind: member.kind, anchorDesiredColumn: anchorDesiredColumn ?? member.anchorDesiredColumn };
    case 'normal-cursor': return { ...base, kind: member.kind };
    case 'insert-caret': return { ...base, kind: member.kind };
  }
}

function endpointInput(endpoint: SelectionEndpoint): EndpointInput {
  const affinity = endpoint.at.affinity;
  switch (endpoint.kind) {
    case 'character': return {
      kind: 'character', offset: endpoint.at.offset, after: endpoint.after.offset,
      affinity, afterAffinity: endpoint.after.affinity,
    };
    case 'empty-line': return { kind: 'empty-line', lineIndex: endpoint.lineIndex, affinity };
    case 'eof': return { kind: 'eof', affinity };
    case 'gap': return { kind: 'gap', offset: endpoint.at.offset, affinity };
    case 'line': return { kind: 'line', lineIndex: endpoint.lineIndex, affinity };
    case 'block-cell': return {
      kind: 'block-cell', offset: endpoint.at.offset,
      logicalUtf16Column: endpoint.logicalUtf16Column,
      displayCellColumn: endpoint.displayCellColumn,
      virtualCells: endpoint.virtualCells,
      affinity,
    };
  }
}

function blockEndpointWithColumn(endpoint: Extract<SelectionEndpoint, { readonly kind: 'block-cell' }>, source: Extract<SelectionEndpoint, { readonly kind: 'block-cell' }>): EndpointInput {
  return {
    kind: 'block-cell', offset: endpoint.at.offset,
    logicalUtf16Column: source.logicalUtf16Column,
    displayCellColumn: source.displayCellColumn,
    virtualCells: source.virtualCells,
    affinity: endpoint.at.affinity,
  };
}

function compareEndpointPosition(snapshot: DocumentSnapshot, left: SelectionEndpoint, right: EndpointInput): number {
  if (left.kind === 'block-cell' && right.kind === 'block-cell') {
    const rightLine = snapshot.lineIndexAt(right.offset);
    if (!rightLine.ok) return 0;
    return left.lineIndex !== rightLine.value
      ? (left.lineIndex as number) - (rightLine.value as number)
      : (left.displayCellColumn as number) - (right.displayCellColumn as number);
  }
  if (left.kind === 'line' && right.kind === 'line') return (left.lineIndex as number) - (right.lineIndex as number);
  if (left.kind === 'empty-line' && right.kind === 'empty-line') return (left.lineIndex as number) - (right.lineIndex as number);
  const rightOffset = 'offset' in right ? right.offset as number : left.at.offset as number;
  return (left.at.offset as number) - rightOffset;
}

function isVisualMember(member: SelectionMember): member is Extract<SelectionMember, { readonly kind: VimVisualKind }> {
  return member.kind === 'visual-character' || member.kind === 'visual-line' || member.kind === 'visual-block';
}

type SimpleVisualFailure = Extract<VimVisualFailure, { readonly kind: 'stale-document-version' | 'invalid-cursor' | 'invalid-selection-kind' | 'invalid-option' | 'not-blockwise' | 'invalid-count' }>;

function visualFailure(kind: SimpleVisualFailure['kind']): { readonly ok: false; readonly error: VimVisualFailure } {
  return { ok: false, error: { kind } };
}
