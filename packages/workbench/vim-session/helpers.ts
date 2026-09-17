import { asIdentifier, asLineIndex, asUtf16Offset, type DocumentId, type SelectionId, type Utf16Offset, type ViewId } from '../../contracts/src/index';
import type { CommittedDocumentChange, DocumentSnapshot, TextFileDocument } from '../../document/src/index';
import { createSelectionSet, type SelectionSetSnapshot } from '../../selections/src/index';
import {
  createVimMotionCursor,
  createVimParserState,
  type VimCoreOperator,
  type VimDirectChangeKey,
  type VimInsertEntryKey,
  type VimMode,
  type VimMotionCursor,
  type VimMotionKey,
  type VimMultiMotionInvocation,
  type VimParserState,
  type VimRegisterBank,
  type VimRegisterName,
  type VimRegisterType,
  type VimTextObjectKey,
  type VimWordMotionKey,
} from '../../vim/src/entrypoints/launch';
import type { WorkbenchViewSnapshot } from '../src/read-model';
import type { OwnedVimKeyEvent } from './types';

export const KEY_TEXT_ENCODER = new TextEncoder();

export function makeView(viewId: ViewId, documentId: DocumentId, snapshot: DocumentSnapshot, selections: SelectionSetSnapshot, mode: VimMode): WorkbenchViewSnapshot {
  return {
    session: { viewId, documentId, documentVersion: snapshot.version, selections, mode: publicMode(mode) },
    document: snapshot,
    selections,
    // This engine-owned session has no viewport/scroll concept of its own (that is
    // WorkbenchSession's job); its `readView` is a fallback read model, not the UI's
    // authoritative one, so scroll is always reported at the origin.
    scrollTop: 0,
    scrollLeft: 0,
  };
}

export function buildParser(mode: VimMode, selections: SelectionSetSnapshot): VimParserState {
  const created = createVimParserState(mode, selections);
  if (!created.ok) throw new Error(`xi-parser:${created.error.kind}`);
  return created.value;
}

export function publicMode(mode: VimMode): 'normal' | 'insert' | 'replace' | 'visual' {
  if (mode === 'visual-character' || mode === 'visual-line' || mode === 'visual-block' || mode === 'select-character' || mode === 'select-line' || mode === 'select-block') return 'visual';
  if (mode === 'virtual-replace') return 'replace';
  return mode;
}

export function isInsertMode(mode: VimMode): mode is 'insert' | 'replace' | 'virtual-replace' {
  return mode === 'insert' || mode === 'replace' || mode === 'virtual-replace';
}

export function isVisualMode(mode: VimMode): mode is 'visual-character' | 'visual-line' | 'visual-block' {
  return mode === 'visual-character' || mode === 'visual-line' || mode === 'visual-block';
}

export function selectionOffset(member: SelectionSetSnapshot['members'][number] | undefined): Utf16Offset {
  return member?.head.at.offset ?? offset(0);
}

export function coreOperator(name: string): VimCoreOperator | null {
  return name === 'delete' || name === 'change' || name === 'yank' ? name : null;
}

export function isMotionLike(key: string): boolean {
  return isMotionKey(key) || isWordMotionKey(key) || isTextObjectKey(key);
}

export function motionInvocation(key: string, count: number): VimMultiMotionInvocation | null {
  if (isMotionKey(key)) return { key, count };
  if (isWordMotionKey(key)) return { key, count };
  if (isTextObjectKey(key)) return { key, count };
  return null;
}

export function isWordMotionKey(key: string): key is VimWordMotionKey {
  return key === 'w' || key === 'W' || key === 'b' || key === 'B' || key === 'e' || key === 'E' || key === 'ge' || key === 'gE';
}

export function isTextObjectKey(key: string): key is VimTextObjectKey {
  return /^([ia])(?:w|W|s|p|["'`()[\]{}<>bBit])$/u.test(key);
}

export function applyRegisterEffect(bank: VimRegisterBank, effect: { readonly operation: string; readonly destination: string; readonly lines: readonly string[]; readonly type: string }): VimRegisterBank {
  const type: VimRegisterType = effect.type === 'V' || effect.type === 'linewise'
    ? 'linewise'
    : effect.type === 'blockwise' || effect.type === ''
      ? 'blockwise'
      : 'characterwise';
  const value = { lines: effect.lines, type };
  const destination = effect.destination as VimRegisterName;
  const result = effect.operation === 'yank'
    ? bank.yank(value, destination)
    : bank.delete(value, { destination, small: destination === '-' });
  return result.ok ? result.value : bank;
}

export function makeMotionCursor(snapshot: DocumentSnapshot, selections: SelectionSetSnapshot): VimMotionCursor | undefined {
  const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
  if (primary === undefined || primary.kind !== 'normal-cursor') return undefined;
  const created = createVimMotionCursor(snapshot, primary.anchor.at.offset);
  return created.ok ? created.value : undefined;
}

export function makeSelection(snapshot: DocumentSnapshot, lineNumber?: number): SelectionSetSnapshot {
  const selectionId = id<SelectionId>('xi-launch-selection');
  return makeNormalSelection(snapshot, lineStart(snapshot, lineNumber), 0, selectionId);
}

export function lineStart(snapshot: DocumentSnapshot, lineNumber?: number): Utf16Offset {
  if (lineNumber === undefined || !Number.isSafeInteger(lineNumber)) return offset(0);
  const requested = Math.max(1, lineNumber) - 1;
  const line = asLineIndex(Math.min(requested, Math.max(0, snapshot.lineCount - 1)));
  if (!line.ok) return offset(0);
  const start = snapshot.lineStartOffset(line.value);
  return start.ok ? start.value : offset(0);
}

export function makeNormalSelection(snapshot: DocumentSnapshot, value: Utf16Offset, generation: number, selectionId = id<SelectionId>('xi-launch-selection')): SelectionSetSnapshot {
  let at = Math.min(Math.max(value as number, 0), Math.max(0, snapshot.lengthUtf16 - 1));
  while (at > 0) {
    const character = snapshot.slice(at as Utf16Offset, (at + 1) as Utf16Offset);
    if (!character.ok || character.value !== '\n') break;
    at -= 1;
  }
  const endpoint = snapshot.lengthUtf16 === 0
    ? { kind: 'eof' as const }
    : (() => {
      const offset = asUtf16Offset(at);
      const after = asUtf16Offset(Math.min(at + 1, snapshot.lengthUtf16));
      if (!offset.ok || !after.ok) throw new Error('xi selection offset');
      return { kind: 'character' as const, offset: offset.value, after: after.value };
    })();
  const created = createSelectionSet(snapshot, {
    primaryId: selectionId,
    selectionGeneration: generation,
    members: [{ id: selectionId, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint }],
  });
  if (!created.ok) throw new Error(`xi selection: ${created.error.kind}`);
  return created.value.selectionSet;
}

export function nonEmptyTuple<T>(values: readonly T[]): readonly [T, ...T[]] {
  const first = values[0];
  if (first === undefined) throw new Error('xi-empty-tuple');
  return [first, ...values.slice(1)];
}

export function notifyCommitted(result: ReturnType<TextFileDocument['commit']>, listener: ((change: CommittedDocumentChange) => void) | undefined): void {
  if (listener !== undefined && result.ok && result.value.kind === 'committed') listener(result.value.change);
}

export function isInsertEntryKey(key: string): key is VimInsertEntryKey {
  return key === 'i' || key === 'I' || key === 'a' || key === 'A' || key === 'o' || key === 'O' || key === 'R' || key === 'gR' || key === 'gi' || key === 'gI';
}

export function isDirectChangeKey(key: string): key is VimDirectChangeKey {
  return key === 's' || key === 'S' || key === 'C' || key === 'x' || key === 'X' || key === 'D' || key === '~';
}

export function isMotionKey(key: string): key is VimMotionKey {
  return key === 'h' || key === 'l' || key === 'j' || key === 'k' || key === '0' || key === '^' || key === '$'
    || key === 'g_' || key === '|' || key === '+' || key === '-' || key === '_' || key === 'gg' || key === 'G'
    || key === '<Left>' || key === '<Right>' || key === '<Up>' || key === '<Down>' || key === '<Home>' || key === '<End>'
    || key === '<C-Home>' || key === '<C-End>' || key === '<BS>' || key === '<C-H>' || key === '<Space>'
    || key === '<NL>' || key === '<CR>' || key === '<C-M>' || key === '<C-J>' || key === '<C-N>' || key === '<C-P>';
}

export function keyName(event: OwnedVimKeyEvent): string {
  switch (event.name) {
    case 'ESC':
    case 'Escape':
    case 'escape': return '<Esc>';
    case 'return': return '<CR>';
    case 'linefeed': return '<NL>';
    case 'space': return '<Space>';
    case 'backspace': return '<BS>';
    default: return event.name;
  }
}

export function encodeKeyBytes(raw: string): Uint8Array {
  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code <= 0x7f) return Uint8Array.of(code);
  }
  return KEY_TEXT_ENCODER.encode(raw);
}

export function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error('xi-offset');
  return result.value;
}

export function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'xi-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
