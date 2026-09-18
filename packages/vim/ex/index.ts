import type { Result } from '../../contracts/src/index';
import type { DocumentEdit, DocumentSnapshot, DocumentVersion, LineIndex, Utf16Offset, Utf32Offset, Utf8ByteOffset } from '../../document/src/index';
import {
  compilePattern,
  createPatternEvaluation,
  patternSnapshotFromDocument,
  PatternEvaluationError,
  type PatternMatch,
  type PatternOptions,
} from '../pattern/index';
import {
  EMPTY_VIM_SEARCH_STATE,
  prepareVimSubstitute,
  type VimSearchState,
  type VimSubstitutePlan,
} from '../search/index';

/** Native Ex commands owned by the Vim parser. */
export type VimExCommandName =
  | 'substitute' | 'global' | 'vglobal' | 'normal'
  | 'move' | 'copy' | 'delete' | 'yank'
  | 'write' | 'edit' | 'quit' | 'print';

export type VimExAddress =
  | { readonly kind: 'current' }
  | { readonly kind: 'last' }
  | { readonly kind: 'line'; readonly line: number }
  | { readonly kind: 'mark'; readonly name: string }
  | { readonly kind: 'search'; readonly direction: 'forward' | 'backward'; readonly pattern: string }
  | { readonly kind: 'relative'; readonly delta: number };

export interface VimExAddressExpression {
  readonly address: VimExAddress;
  readonly offset: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface VimExRangeSpec {
  readonly start: VimExAddressExpression;
  readonly end: VimExAddressExpression;
  readonly separator: ',' | ';' | '%' | 'single';
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export type VimExArguments =
  | { readonly kind: 'substitute'; readonly pattern: string; readonly replacement: string; readonly flags: string; readonly repeatLast?: boolean; readonly count?: number }
  | { readonly kind: 'global'; readonly pattern: string; readonly inverse: boolean; readonly body: VimExCommand; readonly bodies: readonly VimExCommand[] }
  | { readonly kind: 'normal'; readonly keys: string }
  | { readonly kind: 'destination'; readonly destination: VimExAddressExpression }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'none' };

/** Source locations are consumed by command-line discovery and diagnostics. */
export interface VimExCommandMetadata {
  readonly source: string;
  readonly commandStart: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly commandNameStart: number;
  readonly commandNameEnd: number;
  readonly argumentStart: number;
  readonly argumentEnd: number;
  readonly separatorStart: number | null;
}

export interface VimExCommand {
  readonly name: VimExCommandName;
  readonly typedName: string;
  readonly bang: boolean;
  readonly range: VimExRangeSpec | null;
  readonly arguments: VimExArguments;
  readonly metadata: VimExCommandMetadata;
}

export type VimExParseFailure =
  | { readonly kind: 'invalid-command'; readonly sourceOffset: number; readonly reason: string }
  | { readonly kind: 'invalid-range'; readonly sourceOffset: number; readonly reason: string }
  | { readonly kind: 'invalid-address'; readonly sourceOffset: number; readonly reason: string }
  | { readonly kind: 'invalid-delimiter'; readonly sourceOffset: number; readonly reason: string }
  | { readonly kind: 'unterminated-delimiter'; readonly sourceOffset: number }
  | { readonly kind: 'nested-global'; readonly sourceOffset: number }
  | { readonly kind: 'empty-argument'; readonly sourceOffset: number };

export type VimExPrepareFailure =
  | VimExParseFailure
  | { readonly kind: 'document-read-failed'; readonly sourceOffset: number }
  | { readonly kind: 'invalid-line-range'; readonly sourceOffset: number }
  | { readonly kind: 'missing-mark'; readonly name: string; readonly sourceOffset: number }
  | { readonly kind: 'search-address-not-found'; readonly sourceOffset: number }
  | { readonly kind: 'pattern-error'; readonly error: PatternEvaluationError; readonly sourceOffset: number }
  | { readonly kind: 'no-previous-substitute'; readonly sourceOffset: number }
  | { readonly kind: 'destination-in-range'; readonly sourceOffset: number }
  | { readonly kind: 'unsupported-normal-command'; readonly keys: string; readonly sourceOffset: number }
  | { readonly kind: 'unsupported-script'; readonly sourceOffset: number }
  | { readonly kind: 'nested-command-failed'; readonly sourceOffset: number; readonly failure: VimExPrepareFailure };

export interface VimExResolutionContext {
  readonly currentLine: LineIndex;
  readonly marks?: ReadonlyMap<string, LineIndex> | Readonly<Record<string, LineIndex>>;
  readonly wrapscan?: boolean;
  readonly patternOptions?: PatternOptions;
}

export interface VimExSubstituteState {
  readonly pattern: string;
  readonly replacement: string;
  readonly flags: string;
}

export interface VimExPrepareContext extends VimExResolutionContext {
  readonly cursor?: Utf16Offset;
  readonly searchState?: VimSearchState;
  readonly lastSubstitute?: VimExSubstituteState;
  /** Ex commands have one document range; this count is metadata for callers with multiple cursors. */
  readonly selectionCount?: number;
}

export interface VimExResolvedRange {
  readonly firstLine: LineIndex;
  readonly lastLine: LineIndex;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export type VimExRegisterEffect = {
  readonly operation: 'yank' | 'delete';
  readonly destination: string;
  readonly lines: readonly string[];
  readonly type: 'V';
};

export type VimExHostEffect =
  | { readonly kind: 'write'; readonly documentId: DocumentSnapshot['id']; readonly expectedVersion: DocumentVersion; readonly path: string | null; readonly bang: boolean }
  | { readonly kind: 'open'; readonly path: string | null; readonly bang: boolean }
  | { readonly kind: 'quit'; readonly bang: boolean };

export interface VimExPlan {
  readonly command: VimExCommandName;
  readonly range: VimExResolvedRange;
  readonly edits: readonly DocumentEdit[];
  readonly undoGroup: string;
  readonly registerEffect: VimExRegisterEffect | null;
  readonly hostEffects: readonly VimExHostEffect[];
  readonly execution: {
    readonly kind: 'document-once';
    readonly primaryRange: true;
    readonly selectionCount: number;
  };
  readonly nestedPlans: readonly VimExPlan[];
  readonly substituteState: VimExSubstituteState | null;
}

const COMMANDS: ReadonlyArray<{ readonly name: VimExCommandName; readonly min: number; readonly aliases: readonly string[] }> = [
  { name: 'substitute', min: 1, aliases: ['s', 'substitute'] },
  { name: 'global', min: 1, aliases: ['g', 'global'] },
  { name: 'vglobal', min: 1, aliases: ['v', 'vglobal'] },
  { name: 'normal', min: 4, aliases: ['norm', 'normal'] },
  { name: 'move', min: 1, aliases: ['m', 'move'] },
  { name: 'copy', min: 2, aliases: ['co', 'copy', 't'] },
  { name: 'delete', min: 1, aliases: ['d', 'delete'] },
  { name: 'yank', min: 1, aliases: ['y', 'yank'] },
  { name: 'write', min: 1, aliases: ['w', 'write'] },
  { name: 'edit', min: 1, aliases: ['e', 'edit'] },
  { name: 'quit', min: 1, aliases: ['q', 'quit'] },
  { name: 'print', min: 1, aliases: ['p', 'print'] },
];

/** Resolve only native names and reviewed native abbreviations. */
export function resolveVimExCommandName(typedName: string): Result<VimExCommandName, VimExParseFailure> {
  if (typedName === '&' || typedName === '&&' || typedName === '~') return { ok: true, value: 'substitute' };
  // A full alias always resolves regardless of its minimum abbreviation
  // length (`:t` for `copy`'s short alias), even when that alias is shorter
  // than `min`; `min` only governs prefix abbreviations of the long name.
  const matches = COMMANDS.filter((candidate) => candidate.aliases.some((alias) => alias === typedName || (alias.startsWith(typedName) && typedName.length >= candidate.min)));
  if (matches.length !== 1) {
    return { ok: false, error: { kind: 'invalid-command', sourceOffset: 0, reason: matches.length === 0 ? `unknown-command:${typedName}` : `ambiguous-command:${typedName}` } };
  }
  return { ok: true, value: matches[0]!.name };
}

/** Parse one Ex command, retaining exact source positions for discovery and diagnostics. */
export function parseVimExCommand(source: string, start = 0): Result<VimExCommand, VimExParseFailure> {
  const parsed = parseOne(source, start, false);
  return parsed.ok ? { ok: true, value: parsed.value.command } : parsed;
}

/** Parse `|`-separated commands while respecting escaped/delimited patterns. */
export function parseVimExSequence(source: string): Result<readonly VimExCommand[], VimExParseFailure> {
  const commands: VimExCommand[] = [];
  let index = 0;
  while (true) {
    const parsed = parseOne(source, index, false);
    if (!parsed.ok) return parsed;
    commands.push(parsed.value.command);
    index = parsed.value.next;
    if (source[index] === undefined) return { ok: true, value: Object.freeze(commands) };
    if (source[index] !== '|') return { ok: false, error: { kind: 'invalid-command', sourceOffset: index, reason: 'unexpected-command-tail' } };
    index += 1;
    if (source[index] === undefined) return { ok: false, error: { kind: 'empty-argument', sourceOffset: index } };
  }
}

/** Resolve parsed addresses against one immutable document snapshot. */
export function resolveVimExRange(
  snapshot: DocumentSnapshot,
  range: VimExRangeSpec | null,
  context: VimExResolutionContext,
): Result<VimExResolvedRange, VimExPrepareFailure> {
  if (context.currentLine as number < 0 || (context.currentLine as number) >= snapshot.lineCount) {
    return { ok: false, error: { kind: 'invalid-line-range', sourceOffset: range?.sourceStart ?? 0 } };
  }
  if (range === null) {
    return { ok: true, value: { firstLine: context.currentLine, lastLine: context.currentLine, sourceStart: 0, sourceEnd: 0 } };
  }
  if (range.separator === '%') {
    return { ok: true, value: { firstLine: 0 as LineIndex, lastLine: (snapshot.lineCount - 1) as LineIndex, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd } };
  }
  const first = resolveAddress(snapshot, range.start, context, context.currentLine);
  if (!first.ok) return first;
  const secondBase = range.separator === ';' ? first.value : context.currentLine;
  const second = range.separator === 'single'
    ? first
    : resolveAddress(snapshot, range.end, context, secondBase);
  if (!second.ok) return second;
  const low = Math.min(first.value as number, second.value as number);
  const high = Math.max(first.value as number, second.value as number);
  return {
    ok: true,
    value: { firstLine: low as LineIndex, lastLine: high as LineIndex, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd },
  };
}

/** Prepare Ex edits/effects without mutating the document or performing host IO. */
export function prepareVimEx(
  snapshot: DocumentSnapshot,
  command: VimExCommand,
  context: VimExPrepareContext,
): Result<VimExPlan, VimExPrepareFailure> {
  const range = command.range === null && (command.name === 'global' || command.name === 'vglobal')
    ? ({ firstLine: 0 as LineIndex, lastLine: (snapshot.lineCount - 1) as LineIndex, sourceStart: 0, sourceEnd: 0 } satisfies VimExResolvedRange)
    : undefined;
  const resolved = range === undefined ? resolveVimExRange(snapshot, command.range, context) : { ok: true as const, value: range };
  if (!resolved.ok) return resolved;
  return prepareCommand(snapshot, command, context, resolved.value);
}

function prepareCommand(
  snapshot: DocumentSnapshot,
  command: VimExCommand,
  context: VimExPrepareContext,
  range: VimExResolvedRange,
): Result<VimExPlan, VimExPrepareFailure> {
  const selectionCount = context.selectionCount ?? 1;
  if (!Number.isSafeInteger(selectionCount) || selectionCount < 1) return fail(command, 'invalid-line-range', 'invalid-selection-count');
  const base = (edits: readonly DocumentEdit[], registerEffect: VimExRegisterEffect | null, hostEffects: readonly VimExHostEffect[], nestedPlans: readonly VimExPlan[], substituteState: VimExSubstituteState | null): Result<VimExPlan, VimExPrepareFailure> => {
    const checked = validateEdits(edits, snapshot);
    if (!checked.ok) return checked;
    return {
      ok: true,
      value: Object.freeze({
        command: command.name,
        range,
        edits: Object.freeze([...edits]),
        undoGroup: `vim-ex-${snapshot.version as number}-${command.metadata.commandStart}`,
        registerEffect,
        hostEffects: Object.freeze([...hostEffects]),
        execution: Object.freeze({ kind: 'document-once' as const, primaryRange: true as const, selectionCount }),
        nestedPlans: Object.freeze([...nestedPlans]),
        substituteState,
      }),
    };
  };

  switch (command.name) {
    case 'write':
      return base([], null, [{ kind: 'write', documentId: snapshot.id, expectedVersion: snapshot.version, path: command.arguments.kind === 'text' && command.arguments.value.length > 0 ? command.arguments.value : null, bang: command.bang }], [], null);
    case 'edit':
      return base([], null, [{ kind: 'open', path: command.arguments.kind === 'text' && command.arguments.value.length > 0 ? command.arguments.value : null, bang: command.bang }], [], null);
    case 'quit':
      return base([], null, [{ kind: 'quit', bang: command.bang }], [], null);
    case 'print':
      // A bare range (or `:p`) has no text effect; it only moves the cursor
      // to the resolved range, which the caller reads off the returned plan.
      return base([], null, [], [], null);
    case 'delete': {
      const effectiveRange = applyExCountRange(snapshot, range, command);
      const deleted = lineContents(snapshot, effectiveRange);
      if (!deleted.ok) return deleted;
      const edits = lineDeleteEdits(snapshot, effectiveRange);
      return edits.ok ? base(edits.value, registerFrom(command, 'delete', deleted.value), [], [], null) : edits;
    }
    case 'yank': {
      const effectiveRange = applyExCountRange(snapshot, range, command);
      const lines = lineContents(snapshot, effectiveRange);
      return lines.ok ? base([], registerFrom(command, 'yank', lines.value), [], [], null) : lines;
    }
    case 'copy':
    case 'move': {
      if (command.arguments.kind !== 'destination') return fail(command, 'invalid-command', 'missing-destination');
      const destination = resolveAddress(snapshot, command.arguments.destination, context, context.currentLine, { allowLineZero: true });
      if (!destination.ok) return destination;
      const destinationLine = destination.value as number;
      // nvim (`:1,2t2` duplicates; `:1,2m2` is a no-op): `:copy` never
      // removes its source, so a destination inside (or at the end of) the
      // range is always a plain insertion, never the move-only no-op or the
      // move-only "range into itself" error (E134).
      if (command.name === 'move') {
        if (destinationLine === (range.lastLine as number)) return base([], null, [], [], null);
        if (destinationLine >= (range.firstLine as number) && destinationLine <= (range.lastLine as number)) return fail(command, 'destination-in-range', 'destination-is-inside-source-range');
      }
      const transformed = command.name === 'copy'
        ? copyLineEdits(snapshot, range, destinationLine)
        : moveLineEdits(snapshot, range, destinationLine);
      return transformed.ok ? base(transformed.value, null, [], [], null) : transformed;
    }
    case 'normal': {
      if (command.arguments.kind !== 'normal') return fail(command, 'invalid-command', 'missing-normal-keys');
      const normal = normalEdits(snapshot, range, command.arguments.keys);
      return normal.ok ? base(normal.value, null, [], [], null) : normal;
    }
    case 'substitute': {
      if (command.arguments.kind !== 'substitute') return fail(command, 'invalid-command', 'missing-substitute-payload');
      const effectiveRange = extendRangeByCount(snapshot, range, command.arguments.count);
      const substitute = prepareSubstitute(snapshot, command, context, effectiveRange, command.arguments.pattern, command.arguments.replacement, command.arguments.flags);
      if (!substitute.ok) return substitute;
      return base(substitute.value.edits, null, [], [], { pattern: substitute.value.pattern, replacement: substitute.value.replacement, flags: substitute.value.flags });
    }
    case 'global':
    case 'vglobal': {
      if (command.arguments.kind !== 'global') return fail(command, 'invalid-command', 'missing-global-payload');
      if (command.arguments.body.name === 'global' || command.arguments.body.name === 'vglobal') return fail(command, 'nested-global', 'nested-global-command');
      const selected = matchingLines(snapshot, range, command.arguments.pattern, context.patternOptions);
      if (!selected.ok) return selected;
      const wanted = command.name === 'global' ? selected.value : allLinesExcept(range, selected.value);
      // nvim (`:g/^/m0` on a\nb\nc -> c\nb\na): :m/:t bodies reorder lines, so
      // later marks in `wanted` must see earlier moves/copies, not the
      // original snapshot. Everything else (:d, :s, :normal char edits) only
      // ever touches its own original line's own offsets, so those stay on
      // the original per-line prepareCommand path below, which is already
      // coordinate-safe across independent lines.
      if (command.arguments.body.name === 'move' || command.arguments.body.name === 'copy') {
        return prepareGlobalReorder(snapshot, command, command.arguments.body, context, range, wanted, base);
      }
      const bodies = command.arguments.bodies;
      const nestedPlans: VimExPlan[] = [];
      const edits: DocumentEdit[] = [];
      let registerEffect: VimExRegisterEffect | null = null;
      for (const line of wanted) {
        // A single body command runs against the shared original snapshot (its
        // edits only ever touch its own line's own offsets -- see the comment
        // above). A `|`-chained body (nvim: `:g/a/s/X/Y/|s/x/Z/`) instead runs
        // each piece in order against the *result* of the previous one, so the
        // line is isolated into its own tiny synthetic snapshot first.
        const chained = bodies.length === 1
          ? prepareGlobalSingleBody(snapshot, command, bodies[0]!, context, range, line)
          : prepareGlobalChainedBody(snapshot, command, bodies, context, range, line);
        if (!chained.ok) return chained;
        nestedPlans.push(...chained.value.nestedPlans);
        edits.push(...chained.value.edits);
        if (chained.value.registerEffect !== null) {
          registerEffect = registerEffect === null ? chained.value.registerEffect : Object.freeze({
            ...chained.value.registerEffect,
            lines: Object.freeze([...registerEffect.lines, ...chained.value.registerEffect.lines]),
          });
        }
      }
      return base(mergeEdits(edits), registerEffect, [], nestedPlans, null);
    }
  }
}

type VimExBasePlanBuilder = (
  edits: readonly DocumentEdit[],
  registerEffect: VimExRegisterEffect | null,
  hostEffects: readonly VimExHostEffect[],
  nestedPlans: readonly VimExPlan[],
  substituteState: VimExSubstituteState | null,
) => Result<VimExPlan, VimExPrepareFailure>;

/**
 * `:g`/`:v` with a `:move`/`:copy` body: simulate the reorder on a plain
 * array of original line ids (fast; not a keystroke-path operation), then
 * emit one whole-document replace with the final text. Destinations are
 * resolved against the array's CURRENT length/positions, matching Neovim's
 * per-iteration marks instead of the original, now-stale snapshot.
 */
function prepareGlobalReorder(
  snapshot: DocumentSnapshot,
  command: VimExCommand,
  body: VimExCommand,
  context: VimExPrepareContext,
  range: VimExResolvedRange,
  wanted: readonly LineIndex[],
  base: VimExBasePlanBuilder,
): Result<VimExPlan, VimExPrepareFailure> {
  if (body.arguments.kind !== 'destination') return fail(command, 'invalid-command', 'missing-destination');
  const totalLines = snapshot.lineCount;
  const wholeRange: VimExResolvedRange = { firstLine: 0 as LineIndex, lastLine: (totalLines - 1) as LineIndex, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd };
  const wholeLines = lineContents(snapshot, wholeRange);
  if (!wholeLines.ok) return wholeLines;
  const lines: string[] = [...wholeLines.value];
  const ids: number[] = lines.map((_, index) => index);
  for (const originalLine of wanted) {
    const currentIndex = ids.indexOf(originalLine as number);
    if (currentIndex === -1) continue; // an earlier :move already relocated this line's id; content still counted once
    const destination = resolveVirtualDestination(body.arguments.destination, ids, currentIndex, context);
    if (!destination.ok) return destination;
    const destinationLine = destination.value;
    if (destinationLine === currentIndex) continue;
    if (body.name === 'move') {
      const [text] = lines.splice(currentIndex, 1);
      const [id] = ids.splice(currentIndex, 1);
      const insertAt = destinationLine < currentIndex ? destinationLine + 1 : destinationLine;
      lines.splice(insertAt, 0, text ?? '');
      ids.splice(insertAt, 0, id ?? (originalLine as number));
    } else {
      const text = lines[currentIndex] ?? '';
      const insertAt = destinationLine + 1;
      lines.splice(insertAt, 0, text);
      ids.splice(insertAt, 0, -1);
    }
  }
  const documentText = snapshot.slice(0 as Utf16Offset, snapshot.lengthUtf16 as Utf16Offset);
  if (!documentText.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
  const trailingNewline = documentText.value.endsWith('\n');
  const finalText = `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
  const edits: DocumentEdit[] = finalText === documentText.value
    ? []
    : [{ start: 0 as Utf16Offset, end: snapshot.lengthUtf16 as Utf16Offset, text: finalText }];
  return base(edits, null, [], [], null);
}

interface VimExGlobalBodyResult {
  readonly edits: readonly DocumentEdit[];
  readonly nestedPlans: readonly VimExPlan[];
  readonly registerEffect: VimExRegisterEffect | null;
}

function prepareGlobalSingleBody(
  snapshot: DocumentSnapshot,
  command: VimExCommand,
  body: VimExCommand,
  context: VimExPrepareContext,
  range: VimExResolvedRange,
  line: LineIndex,
): Result<VimExGlobalBodyResult, VimExPrepareFailure> {
  const nestedRange: VimExResolvedRange = { firstLine: line, lastLine: line, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd };
  const nested = prepareCommand(snapshot, body, context, nestedRange);
  if (!nested.ok) return { ok: false, error: { kind: 'nested-command-failed', sourceOffset: command.metadata.argumentStart, failure: nested.error } };
  if (nested.value.hostEffects.length !== 0) return fail(command, 'unsupported-script', 'global-host-effect-not-allowed');
  return { ok: true, value: { edits: nested.value.edits, nestedPlans: [nested.value], registerEffect: nested.value.registerEffect } };
}

/**
 * Run a `|`-chained `:g` body (nvim: `:g/a/s/X/Y/|s/x/Z/` applies both per
 * matched line, each seeing the previous one's result). The matched line is
 * isolated into its own single-line synthetic snapshot so each chained
 * command reads the text the previous one produced; the final text is
 * folded back into one edit against the real document.
 */
function prepareGlobalChainedBody(
  snapshot: DocumentSnapshot,
  command: VimExCommand,
  bodies: readonly VimExCommand[],
  context: VimExPrepareContext,
  range: VimExResolvedRange,
  line: LineIndex,
): Result<VimExGlobalBodyResult, VimExPrepareFailure> {
  const startResult = snapshot.lineStartOffset(line);
  if (!startResult.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
  const lineStart = startResult.value as number;
  const nextResult = snapshot.lineStartOffset(((line as number) + 1) as LineIndex);
  const lineEnd = nextResult.ok ? (nextResult.value as number) - 1 : snapshot.lengthUtf16;
  const originalText = snapshot.slice(lineStart as Utf16Offset, lineEnd as Utf16Offset);
  if (!originalText.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
  let text = originalText.value;
  const nestedPlans: VimExPlan[] = [];
  let registerEffect: VimExRegisterEffect | null = null;
  const localContext: VimExPrepareContext = { ...context, currentLine: 0 as LineIndex };
  const localRange: VimExResolvedRange = { firstLine: 0 as LineIndex, lastLine: 0 as LineIndex, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd };
  for (const body of bodies) {
    const nested = prepareCommand(createLineSnapshot(snapshot, text), body, localContext, localRange);
    if (!nested.ok) return { ok: false, error: { kind: 'nested-command-failed', sourceOffset: command.metadata.argumentStart, failure: nested.error } };
    if (nested.value.hostEffects.length !== 0) return fail(command, 'unsupported-script', 'global-host-effect-not-allowed');
    nestedPlans.push(nested.value);
    if (nested.value.registerEffect !== null) {
      registerEffect = registerEffect === null ? nested.value.registerEffect : Object.freeze({
        ...nested.value.registerEffect,
        lines: Object.freeze([...registerEffect.lines, ...nested.value.registerEffect.lines]),
      });
    }
    text = applyEditsToText(text, nested.value.edits);
  }
  const edits: DocumentEdit[] = text === originalText.value
    ? []
    : [{ start: lineStart as Utf16Offset, end: lineEnd as Utf16Offset, text }];
  return { ok: true, value: { edits, nestedPlans, registerEffect } };
}

function applyEditsToText(text: string, edits: readonly DocumentEdit[]): string {
  if (edits.length === 0) return text;
  const sorted = [...edits].sort((left, right) => (right.start as number) - (left.start as number));
  let result = text;
  for (const edit of sorted) result = result.slice(0, edit.start as number) + edit.text + result.slice(edit.end as number);
  return result;
}

/** A read-only single-line synthetic snapshot, for running a body command in
 * isolation against one already-edited line without a real document. */
function createLineSnapshot(parent: DocumentSnapshot, text: string): DocumentSnapshot {
  const length = text.length;
  const inBounds = (offset: number): boolean => Number.isSafeInteger(offset) && offset >= 0 && offset <= length;
  return {
    id: parent.id,
    version: parent.version,
    revisionId: parent.revisionId,
    lengthUtf16: length,
    lineCount: 1,
    readOnly: false,
    slice: (start, end) => {
      const s = start as number;
      const e = end as number;
      if (!inBounds(s) || !inBounds(e) || e < s) return { ok: false, error: { kind: 'invalid-range' } };
      return { ok: true, value: text.slice(s, e) };
    },
    lineIndexAt: (offset) => (inBounds(offset as number) ? { ok: true, value: 0 as LineIndex } : { ok: false, error: { kind: 'invalid-line' } }),
    lineStartOffset: (lineIndex) => ((lineIndex as number) === 0 ? { ok: true, value: 0 as Utf16Offset } : { ok: false, error: { kind: 'invalid-line' } }),
    utf8OffsetAt: (offset) => (inBounds(offset as number) ? { ok: true, value: new TextEncoder().encode(text.slice(0, offset as number)).length as Utf8ByteOffset } : { ok: false, error: { kind: 'invalid-encoded-offset' } }),
    utf32OffsetAt: (offset) => (inBounds(offset as number) ? { ok: true, value: [...text.slice(0, offset as number)].length as Utf32Offset } : { ok: false, error: { kind: 'invalid-encoded-offset' } }),
    offsetAtUtf8: (byteOffset) => {
      const target = byteOffset as number;
      if (!Number.isSafeInteger(target) || target < 0) return { ok: false, error: { kind: 'invalid-encoded-offset' } };
      let bytes = 0;
      let index = 0;
      for (const scalar of text) {
        if (bytes === target) return { ok: true, value: index as Utf16Offset };
        bytes += new TextEncoder().encode(scalar).length;
        index += scalar.length;
      }
      return bytes === target ? { ok: true, value: index as Utf16Offset } : { ok: false, error: { kind: 'invalid-encoded-offset' } };
    },
    offsetAtUtf32: (scalarOffset) => {
      const target = scalarOffset as number;
      if (!Number.isSafeInteger(target) || target < 0) return { ok: false, error: { kind: 'invalid-encoded-offset' } };
      let scalars = 0;
      let index = 0;
      for (const scalar of text) {
        if (scalars === target) return { ok: true, value: index as Utf16Offset };
        scalars += 1;
        index += scalar.length;
      }
      return scalars === target ? { ok: true, value: index as Utf16Offset } : { ok: false, error: { kind: 'invalid-encoded-offset' } };
    },
  };
}

function resolveVirtualDestination(
  expression: VimExAddressExpression,
  ids: readonly number[],
  currentIndex: number,
  context: VimExPrepareContext,
): Result<number, VimExPrepareFailure> {
  let line: number;
  switch (expression.address.kind) {
    case 'current': line = currentIndex; break;
    case 'last': line = ids.length - 1; break;
    case 'line': line = expression.address.line - 1; break;
    case 'relative': line = currentIndex + expression.address.delta; break;
    case 'mark': {
      const marked = context.marks instanceof Map
        ? context.marks.get(expression.address.name)
        : context.marks === undefined ? undefined : (context.marks as Readonly<Record<string, LineIndex>>)[expression.address.name];
      if (marked === undefined) return { ok: false, error: { kind: 'missing-mark', name: expression.address.name, sourceOffset: expression.sourceStart } };
      const at = ids.indexOf(marked as number);
      if (at === -1) return { ok: false, error: { kind: 'missing-mark', name: expression.address.name, sourceOffset: expression.sourceStart } };
      line = at;
      break;
    }
    case 'search':
      return { ok: false, error: { kind: 'unsupported-script', sourceOffset: expression.sourceStart } };
  }
  line += expression.offset;
  if (line === -1) return { ok: true, value: -1 };
  if (!Number.isSafeInteger(line) || line < 0 || line >= ids.length) return { ok: false, error: { kind: 'invalid-line-range', sourceOffset: expression.sourceStart } };
  return { ok: true, value: line };
}

function prepareSubstitute(
  snapshot: DocumentSnapshot,
  command: VimExCommand,
  context: VimExPrepareContext,
  range: VimExResolvedRange,
  pattern: string,
  replacement: string,
  flags: string,
): Result<VimSubstitutePlan, VimExPrepareFailure> {
  let actualPattern = pattern;
  let actualReplacement = replacement;
  let actualFlags = flags;
  const isRepeat = command.typedName === '&' || command.typedName === '&&' || command.typedName === '~' || (command.arguments.kind === 'substitute' && command.arguments.repeatLast === true);
  if (isRepeat) {
    const previous = context.lastSubstitute;
    if (previous === undefined) return fail(command, 'no-previous-substitute', 'no-previous-substitute');
    actualPattern = previous.pattern;
    actualReplacement = previous.replacement;
    // nvim :help :s_r -- `:~`/`:&r` reuse the shared last-used (search-or-
    // substitute) pattern instead of the last-substitute-only pattern; a bare
    // `:&`/`:&&` (no r) keeps the last-substitute-only pattern even if a
    // plain search ran more recently.
    if (command.typedName === '~' || flags.includes('r')) {
      const state = context.searchState ?? EMPTY_VIM_SEARCH_STATE;
      if (state.pattern !== null && state.pattern.length !== 0) actualPattern = state.pattern;
    }
  }
  // `&` flag (must be first, nvim :help :s_flags): union this invocation's
  // flags onto the previous substitute's flags rather than replacing them
  // (`:s/x/y/&g` and `:&&g` both keep+add; a bare `:&`/`:s` drop them).
  const keepsFlags = command.typedName === '&&' || actualFlags.startsWith('&');
  if (keepsFlags) {
    const previous = context.lastSubstitute;
    if (previous === undefined) return fail(command, 'no-previous-substitute', 'no-previous-substitute');
    const extra = actualFlags.startsWith('&') ? actualFlags.slice(1) : actualFlags;
    actualFlags = [...new Set([...previous.flags, ...extra])].join('');
  }
  const state = context.searchState ?? EMPTY_VIM_SEARCH_STATE;
  const substituteRequest = {
    pattern: actualPattern,
    replacement: actualReplacement,
    flags: actualFlags,
    range: { firstLine: range.firstLine, lastLine: range.lastLine },
    ...(context.cursor === undefined ? {} : { cursor: context.cursor }),
    ...(context.patternOptions === undefined ? {} : { patternOptions: context.patternOptions }),
  };
  const prepared = prepareVimSubstitute(snapshot, state, substituteRequest);
  if (!prepared.ok) return { ok: false, error: mapSearchFailure(command, prepared.error) };
  return prepared;
}

function mapSearchFailure(command: VimExCommand, error: { readonly kind: string }): VimExPrepareFailure {
  if (error.kind === 'pattern-error') {
    const patternError = (error as { readonly error?: unknown }).error;
    return { kind: 'pattern-error', error: patternError instanceof PatternEvaluationError ? patternError : new PatternEvaluationError('invalid-pattern', 'substitute-pattern-failed', 0), sourceOffset: command.metadata.argumentStart };
  }
  if (error.kind === 'empty-pattern') return failValue(command, 'empty-argument', 'empty-substitute-pattern');
  if (error.kind === 'unsupported-replacement') return failValue(command, 'unsupported-script', 'expression-replacement-is-not-supported');
  if (error.kind === 'invalid-offset') return failValue(command, 'invalid-range', 'invalid-substitute-range');
  return failValue(command, 'invalid-command', `substitute-failed:${error.kind}`);
}

function matchingLines(
  snapshot: DocumentSnapshot,
  range: VimExResolvedRange,
  pattern: string,
  options: PatternOptions | undefined,
): Result<readonly LineIndex[], VimExPrepareFailure> {
  let evaluation: ReturnType<typeof createPatternEvaluation>;
  try {
    evaluation = createPatternEvaluation(compilePattern(pattern, options), patternSnapshotFromDocument(snapshot));
    const progress = evaluation.resume(Number.MAX_SAFE_INTEGER);
    if (progress.kind !== 'complete') return { ok: false, error: { kind: 'pattern-error', error: new PatternEvaluationError('step-budget-exceeded', 'global-pattern-did-not-complete', evaluation.steps), sourceOffset: range.sourceStart } };
    const lines = new Set<number>();
    for (const match of progress.result.matches) {
      const line = snapshot.lineIndexAt(match.start);
      if (line.ok && (line.value as number) >= (range.firstLine as number) && (line.value as number) <= (range.lastLine as number)) lines.add(line.value as number);
    }
    return { ok: true, value: Object.freeze([...lines].sort((left, right) => left - right).map((line) => line as LineIndex)) };
  } catch (error: unknown) {
    const patternError = error instanceof PatternEvaluationError ? error : new PatternEvaluationError('invalid-pattern', 'global-pattern-failed', 0);
    return { ok: false, error: { kind: 'pattern-error', error: patternError, sourceOffset: range.sourceStart } };
  }
}

function resolveAddress(
  snapshot: DocumentSnapshot,
  expression: VimExAddressExpression,
  context: VimExResolutionContext,
  relativeCurrent: LineIndex,
  options?: { readonly allowLineZero?: boolean },
): Result<LineIndex, VimExPrepareFailure> {
  let line: number;
  switch (expression.address.kind) {
    case 'current': line = relativeCurrent as number; break;
    case 'last': line = snapshot.lineCount - 1; break;
    case 'line': line = expression.address.line - 1; break;
    case 'relative': line = (relativeCurrent as number) + expression.address.delta; break;
    case 'mark': {
      const marked = context.marks instanceof Map
        ? context.marks.get(expression.address.name)
        : context.marks === undefined ? undefined : (context.marks as Readonly<Record<string, LineIndex>>)[expression.address.name];
      if (marked === undefined) return { ok: false, error: { kind: 'missing-mark', name: expression.address.name, sourceOffset: expression.sourceStart } };
      line = marked as number;
      break;
    }
    case 'search': {
      const found = searchAddressLines(snapshot, expression.address.pattern, expression.address.direction, relativeCurrent, context.patternOptions, context.wrapscan !== false);
      if (!found.ok) return { ok: false, error: { kind: 'search-address-not-found', sourceOffset: expression.sourceStart } };
      line = found.value;
      break;
    }
  }
  line += expression.offset;
  if (line === -1 && options?.allowLineZero === true) return { ok: true, value: -1 as LineIndex };
  if (!Number.isSafeInteger(line) || line < 0 || line >= snapshot.lineCount) return { ok: false, error: { kind: 'invalid-line-range', sourceOffset: expression.sourceStart } };
  return { ok: true, value: line as LineIndex };
}

function searchAddressLines(
  snapshot: DocumentSnapshot,
  pattern: string,
  direction: 'forward' | 'backward',
  current: LineIndex,
  options: PatternOptions | undefined,
  wrapscan: boolean,
): Result<LineIndex, VimExPrepareFailure> {
  try {
    const evaluation = createPatternEvaluation(compilePattern(pattern, options), patternSnapshotFromDocument(snapshot));
    const result = evaluation.resume(Number.MAX_SAFE_INTEGER);
    if (result.kind !== 'complete') return { ok: false, error: { kind: 'search-address-not-found', sourceOffset: 0 } };
    const lines = new Set<number>();
    for (const match of result.result.matches) {
      const line = snapshot.lineIndexAt(match.start);
      if (line.ok) lines.add(line.value as number);
    }
    const ordered = [...lines].sort((left, right) => left - right);
    const currentNumber = current as number;
    const candidate = direction === 'forward'
      ? ordered.find((line) => line > currentNumber)
      : [...ordered].reverse().find((line) => line < currentNumber);
    if (candidate !== undefined) return { ok: true, value: candidate as LineIndex };
    if (!wrapscan) return { ok: false, error: { kind: 'search-address-not-found', sourceOffset: 0 } };
    const wrapped = direction === 'forward' ? ordered[0] : ordered.at(-1);
    return wrapped === undefined ? { ok: false, error: { kind: 'search-address-not-found', sourceOffset: 0 } } : { ok: true, value: wrapped as LineIndex };
  } catch (error: unknown) {
    const patternError = error instanceof PatternEvaluationError ? error : new PatternEvaluationError('invalid-pattern', 'search-address-failed', 0);
    return { ok: false, error: { kind: 'pattern-error', error: patternError, sourceOffset: 0 } };
  }
}

function lineContents(snapshot: DocumentSnapshot, range: VimExResolvedRange): Result<readonly string[], VimExPrepareFailure> {
  const result: string[] = [];
  for (let line = range.firstLine as number; line <= (range.lastLine as number); line += 1) {
    const start = snapshot.lineStartOffset(line as LineIndex);
    if (!start.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
    const next = snapshot.lineStartOffset((line + 1) as LineIndex);
    const end = next.ok ? (next.value as number) - 1 : snapshot.lengthUtf16;
    const text = snapshot.slice(start.value, end as Utf16Offset);
    if (!text.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
    result.push(text.value);
  }
  return { ok: true, value: Object.freeze(result) };
}

function lineDeleteEdits(snapshot: DocumentSnapshot, range: VimExResolvedRange): Result<readonly DocumentEdit[], VimExPrepareFailure> {
  const startResult = snapshot.lineStartOffset(range.firstLine);
  if (!startResult.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
  let start = startResult.value as number;
  let end: number;
  if ((range.lastLine as number) + 1 < snapshot.lineCount) {
    const next = snapshot.lineStartOffset(((range.lastLine as number) + 1) as LineIndex);
    if (!next.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
    end = next.value as number;
  } else if (start > 0) {
    start -= 1;
    end = snapshot.lengthUtf16;
  } else {
    end = snapshot.lengthUtf16;
  }
  return { ok: true, value: Object.freeze([{ start: start as Utf16Offset, end: end as Utf16Offset, text: '' }]) };
}

function copyLineEdits(snapshot: DocumentSnapshot, range: VimExResolvedRange, destination: number): Result<readonly DocumentEdit[], VimExPrepareFailure> {
  const lines = lineContents(snapshot, range);
  if (!lines.ok) return lines;
  const insertion = lineInsertion(snapshot, destination, lines.value);
  if (!insertion.ok) return insertion;
  return { ok: true, value: Object.freeze([insertion.value]) };
}

function moveLineEdits(snapshot: DocumentSnapshot, range: VimExResolvedRange, destination: number): Result<readonly DocumentEdit[], VimExPrepareFailure> {
  const lines = lineContents(snapshot, range);
  if (!lines.ok) return lines;
  const insertion = lineInsertion(snapshot, destination, lines.value);
  if (!insertion.ok) return insertion;
  const deletion = lineDeleteEdits(snapshot, range);
  if (!deletion.ok) return deletion;
  return { ok: true, value: Object.freeze(mergeEdits([insertion.value, ...deletion.value])) };
}

function lineInsertion(snapshot: DocumentSnapshot, destination: number, lines: readonly string[]): Result<DocumentEdit, VimExPrepareFailure> {
  const block = lines.join('\n');
  const after = destination + 1;
  let offset: number;
  if (after < snapshot.lineCount) {
    const start = snapshot.lineStartOffset(after as LineIndex);
    if (!start.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: 0 } };
    offset = start.value as number;
    return { ok: true, value: { start: offset as Utf16Offset, end: offset as Utf16Offset, text: `${block}\n` } };
  }
  offset = snapshot.lengthUtf16;
  const tail = snapshot.slice((Math.max(0, offset - 1)) as Utf16Offset, offset as Utf16Offset);
  const endsWithNewline = tail.ok && tail.value === '\n';
  return { ok: true, value: { start: offset as Utf16Offset, end: offset as Utf16Offset, text: endsWithNewline ? `${block}\n` : `\n${block}` } };
}

function normalEdits(snapshot: DocumentSnapshot, range: VimExResolvedRange, keys: string): Result<readonly DocumentEdit[], VimExPrepareFailure> {
  if (keys === 'dd') return lineDeleteEdits(snapshot, range);
  if (keys !== 'x' && keys !== 'X' && keys !== 'D' && keys !== '~' && keys !== 'J') return { ok: false, error: { kind: 'unsupported-normal-command', keys, sourceOffset: range.sourceStart } };
  const edits: DocumentEdit[] = [];
  for (let line = range.firstLine as number; line <= (range.lastLine as number); line += 1) {
    const current = line as LineIndex;
    const start = snapshot.lineStartOffset(current);
    if (!start.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
    const content = lineContents(snapshot, { ...range, firstLine: current, lastLine: current });
    if (!content.ok) return content;
    const value = content.value[0] ?? '';
    if (keys === 'D') {
      edits.push({ start: start.value, end: (start.value as number + value.length) as Utf16Offset, text: '' });
    } else if (keys === 'x' || keys === 'X') {
      const offset = keys === 'x' ? 0 : previousScalarStart(value, value.length);
      if (offset < value.length) {
        const absolute = (start.value as number) + offset;
        const width = scalarWidth(value, offset);
        edits.push({ start: absolute as Utf16Offset, end: (absolute + width) as Utf16Offset, text: '' });
      }
    } else if (keys === '~' && value.length !== 0) {
      const width = scalarWidth(value, 0);
      const scalar = value.slice(0, width);
      const converted = scalar === scalar.toUpperCase() ? scalar.toLowerCase() : scalar.toUpperCase();
      edits.push({ start: start.value, end: (start.value as number + width) as Utf16Offset, text: converted });
    } else if (keys === 'J' && line < (range.lastLine as number) && line + 1 < snapshot.lineCount) {
      const end = snapshot.lineStartOffset((line + 1) as LineIndex);
      if (!end.ok) return { ok: false, error: { kind: 'document-read-failed', sourceOffset: range.sourceStart } };
      const newline = (end.value as number) - 1;
      edits.push({ start: newline as Utf16Offset, end: (newline + 1) as Utf16Offset, text: ' ' });
    }
  }
  return { ok: true, value: Object.freeze(edits) };
}

/**
 * `:[range]d[elete]`/`:[range]y[ank]` accept `[x] [count]`: an optional
 * single-letter register followed by an optional decimal line count. A bare
 * number (`:d 2`) is a count, never a register name.
 */
function parseExRegisterAndCount(text: string): { readonly register?: string; readonly count?: number } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  const match = /^(?:([A-Za-z"])\s*)?(\d+)?$/u.exec(trimmed);
  if (match === null) return {};
  const [, register, countText] = match;
  return {
    ...(register === undefined ? {} : { register }),
    ...(countText === undefined ? {} : { count: Number(countText) }),
  };
}

function applyExCountRange(snapshot: DocumentSnapshot, range: VimExResolvedRange, command: VimExCommand): VimExResolvedRange {
  if (command.arguments.kind !== 'text') return range;
  const { count } = parseExRegisterAndCount(command.arguments.value);
  return extendRangeByCount(snapshot, range, count);
}

/** A trailing `[count]` (`:d 3`, `:s/a/b/g 3`) replaces the range with `count`
 * lines starting at the original range's last line. */
function extendRangeByCount(snapshot: DocumentSnapshot, range: VimExResolvedRange, count: number | undefined): VimExResolvedRange {
  if (count === undefined || count < 1) return range;
  const firstLine = range.lastLine as number;
  const lastLine = Math.min(snapshot.lineCount - 1, firstLine + count - 1);
  return { ...range, firstLine: firstLine as LineIndex, lastLine: lastLine as LineIndex };
}

function registerFrom(command: VimExCommand, operation: 'yank' | 'delete', lines: readonly string[]): VimExRegisterEffect {
  const parsed = command.arguments.kind === 'text' ? parseExRegisterAndCount(command.arguments.value) : {};
  const destination = parsed.register ?? '"';
  return Object.freeze({ operation, destination, lines: Object.freeze([...lines]), type: 'V' });
}

function parseOne(source: string, start: number, _nested: boolean): Result<{ readonly command: VimExCommand; readonly next: number }, VimExParseFailure> {
  let index = start;
  if (source[index] === ':') index += 1;
  while (source[index] === ' ' || source[index] === '\t') index += 1;
  const commandStart = index;
  const parsedRange = parseRange(source, index);
  if (!parsedRange.ok) return parsedRange;
  const range = parsedRange.value.range;
  index = parsedRange.value.next;
  const rangeEnd = index;
  const nameStart = index;
  let typedName: string;
  if (source[index] === '&' && source[index + 1] === '&') {
    typedName = '&&';
    index += 2;
  } else if (source[index] === '&' || source[index] === '~') {
    typedName = source[index] ?? '';
    index += 1;
  } else {
    const match = /^[A-Za-z]+/u.exec(source.slice(index));
    if (match === null) {
      // A bare range with no command name (`:3`) is Neovim's implicit
      // `:print`, which just moves the cursor to the range.
      if (rangeEnd > commandStart) { typedName = 'p'; } else {
        return { ok: false, error: { kind: 'invalid-command', sourceOffset: index, reason: 'missing-command-name' } };
      }
    } else {
      typedName = match[0];
      index += typedName.length;
    }
  }
  const resolved = resolveVimExCommandName(typedName);
  if (!resolved.ok) return { ok: false, error: { ...resolved.error, sourceOffset: nameStart } };
  const bang = source[index] === '!';
  if (bang) index += 1;
  const argumentStart = index;
  let arguments_: VimExArguments;
  let next = index;
  if (resolved.value === 'substitute') {
    if (typedName === '&' || typedName === '&&' || typedName === '~') {
      const end = scanUntilPipe(source, index);
      const { flags, count } = splitFlagsAndCount(source.slice(index, end).trim());
      arguments_ = { kind: 'substitute', pattern: '', replacement: '', flags, repeatLast: true, ...(count === undefined ? {} : { count }) };
      next = end;
    } else {
      const first = readExDelimited(source, index);
      if (!first.ok) {
        // nvim (bare `:s`, `:s g`): no delimiter at all means "repeat the
        // last substitute", same as `:&`, with any trailing text as flags.
        if (first.error.kind !== 'invalid-delimiter') return first;
        const end = scanUntilPipe(source, index);
        const { flags, count } = splitFlagsAndCount(source.slice(index, end).trim());
        arguments_ = { kind: 'substitute', pattern: '', replacement: '', flags, repeatLast: true, ...(count === undefined ? {} : { count }) };
        next = end;
      } else {
        const second = readExDelimited(source, first.value.next, first.value.delimiter);
        if (!second.ok) return second;
        const end = scanUntilPipe(source, second.value.next);
        const { flags, count } = splitFlagsAndCount(source.slice(second.value.next, end).trim());
        arguments_ = { kind: 'substitute', pattern: first.value.value, replacement: second.value.value, flags, ...(count === undefined ? {} : { count }) };
        next = end;
      }
    }
  } else if (resolved.value === 'global' || resolved.value === 'vglobal') {
    const pattern = readExDelimited(source, index);
    if (!pattern.ok) return pattern;
    let bodyStart = pattern.value.next;
    while (source[bodyStart] === ' ' || source[bodyStart] === '\t') bodyStart += 1;
    if (source[bodyStart] === undefined || source[bodyStart] === '|') return { ok: false, error: { kind: 'empty-argument', sourceOffset: bodyStart } };
    const firstBody = parseOne(source, bodyStart, true);
    if (!firstBody.ok) return firstBody;
    if (firstBody.value.command.name === 'global' || firstBody.value.command.name === 'vglobal') return { ok: false, error: { kind: 'nested-global', sourceOffset: bodyStart } };
    // nvim (`:g/a/s/X/Y/|s/x/Z/`): a `:g`/`:v` body runs to end of line, so any
    // `|`-chained commands after the first belong to the body too (unlike a
    // top-level `|` between independent commands), except `:normal`'s body,
    // which already consumes to end of line and treats `|` as a literal key.
    const bodies: VimExCommand[] = [firstBody.value.command];
    next = firstBody.value.next;
    while (source[next] === '|') {
      const more = parseOne(source, next + 1, true);
      if (!more.ok) return more;
      if (more.value.command.name === 'global' || more.value.command.name === 'vglobal') return { ok: false, error: { kind: 'nested-global', sourceOffset: next + 1 } };
      bodies.push(more.value.command);
      next = more.value.next;
    }
    arguments_ = { kind: 'global', pattern: pattern.value.value, inverse: resolved.value === 'vglobal', body: firstBody.value.command, bodies: Object.freeze(bodies) };
  } else if (resolved.value === 'move' || resolved.value === 'copy') {
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    const destination = parseAddress(source, index);
    if (!destination.ok || destination.value === undefined) return { ok: false, error: { kind: 'invalid-address', sourceOffset: index, reason: 'missing-destination' } };
    next = scanUntilPipe(source, destination.value.next);
    if (source.slice(destination.value.next, next).trim().length !== 0) return { ok: false, error: { kind: 'invalid-address', sourceOffset: destination.value.next, reason: 'trailing-destination' } };
    arguments_ = { kind: 'destination', destination: destination.value.expression };
  } else if (resolved.value === 'normal') {
    // nvim (`:normal x|x` deletes twice, not once): `:normal`'s key argument
    // runs to end of line; `|` is a literal key, never a command separator,
    // both at top level and inside a `:g`/`:v` body.
    const end = source.length;
    const keys = source.slice(index, end).trim();
    if (keys.length === 0) return { ok: false, error: { kind: 'empty-argument', sourceOffset: index } };
    arguments_ = { kind: 'normal', keys };
    next = end;
  } else {
    const end = scanUntilPipe(source, index);
    const value = source.slice(index, end).trim();
    arguments_ = value.length === 0 ? { kind: 'none' } : { kind: 'text', value };
    next = end;
  }
  const command: VimExCommand = Object.freeze({
    name: resolved.value,
    typedName,
    bang,
    range,
    arguments: arguments_,
    metadata: Object.freeze({ source, commandStart, rangeStart: commandStart, rangeEnd, commandNameStart: nameStart, commandNameEnd: nameStart + typedName.length, argumentStart, argumentEnd: next, separatorStart: source[next] === '|' ? next : null }),
  });
  return { ok: true, value: { command, next } };
}

function parseRange(source: string, start: number): Result<{ readonly range: VimExRangeSpec | null; readonly next: number }, VimExParseFailure> {
  if (source[start] === '%') {
    return { ok: true, value: { range: Object.freeze({ start: dummyAddress(start), end: dummyAddress(start + 1), separator: '%' as const, sourceStart: start, sourceEnd: start + 1 }), next: start + 1 } };
  }
  const first = parseAddress(source, start);
  if (!first.ok) return first;
  // nvim (`:,$d`): an omitted first address before `,`/`;` defaults to the
  // current line, rather than making the whole range absent.
  if (first.value === undefined && source[start] !== ',' && source[start] !== ';') {
    return { ok: true, value: { range: null, next: start } };
  }
  const firstAddress = first.value ?? { expression: dummyAddress(start), next: start };
  let next = firstAddress.next;
  const separator = source[next];
  if (separator !== ',' && separator !== ';') {
    return { ok: true, value: { range: Object.freeze({ start: firstAddress.expression, end: firstAddress.expression, separator: 'single', sourceStart: start, sourceEnd: next }), next } };
  }
  const second = parseAddress(source, next + 1);
  if (!second.ok || second.value === undefined) return { ok: false, error: { kind: 'invalid-range', sourceOffset: next + 1, reason: 'missing-range-end' } };
  next = second.value.next;
  return { ok: true, value: { range: Object.freeze({ start: firstAddress.expression, end: second.value.expression, separator, sourceStart: start, sourceEnd: next }), next } };
}

function parseAddress(source: string, start: number): Result<{ readonly expression: VimExAddressExpression; readonly next: number } | undefined, VimExParseFailure> {
  const initial = source[start];
  if (initial === undefined) return { ok: true, value: undefined };
  const sourceStart = start;
  let index = start;
  let address: VimExAddress;
  if (initial === '.') { address = { kind: 'current' }; index += 1; }
  else if (initial === '$') { address = { kind: 'last' }; index += 1; }
  else if (initial === '+' || initial === '-') {
    const sign = initial === '+' ? 1 : -1;
    index += 1;
    const digits = /^\d*/u.exec(source.slice(index))?.[0] ?? '';
    index += digits.length;
    address = { kind: 'relative', delta: sign * (digits.length === 0 ? 1 : Number(digits)) };
  } else if (initial === "'") {
    const name = source[index + 1];
    if (name === undefined) return { ok: false, error: { kind: 'invalid-address', sourceOffset: index, reason: 'missing-mark-name' } };
    address = { kind: 'mark', name };
    index += 2;
  } else if (initial === '/' || initial === '?') {
    const read = readExDelimited(source, index);
    if (!read.ok) return read;
    address = { kind: 'search', direction: initial === '/' ? 'forward' : 'backward', pattern: read.value.value };
    index = read.value.next;
  } else if (/\d/u.test(initial)) {
    const digits = /^\d+/u.exec(source.slice(index))?.[0] ?? '';
    index += digits.length;
    const line = Number(digits);
    // Line 0 is valid syntax: `:m0`/`:t0` mean "before the first line".
    if (!Number.isSafeInteger(line) || line < 0) return { ok: false, error: { kind: 'invalid-address', sourceOffset: sourceStart, reason: 'invalid-line-number' } };
    address = { kind: 'line', line };
  } else return { ok: true, value: undefined };
  let offset = 0;
  while (source[index] === '+' || source[index] === '-') {
    const sign = source[index] === '+' ? 1 : -1;
    index += 1;
    const digits = /^\d*/u.exec(source.slice(index))?.[0] ?? '';
    index += digits.length;
    offset += sign * (digits.length === 0 ? 1 : Number(digits));
  }
  return { ok: true, value: { expression: Object.freeze({ address, offset, sourceStart, sourceEnd: index }), next: index } };
}

function dummyAddress(sourceStart: number): VimExAddressExpression {
  return Object.freeze({ address: { kind: 'current' as const }, offset: 0, sourceStart, sourceEnd: sourceStart + 1 });
}

function readExDelimited(source: string, start: number, expectedDelimiter?: string): Result<{ readonly value: string; readonly next: number; readonly delimiter: string }, VimExParseFailure> {
  const delimiter = expectedDelimiter ?? source[start];
  if (delimiter === undefined || delimiter === ' ' || delimiter === '\t' || /[A-Za-z0-9]/u.test(delimiter)) return { ok: false, error: { kind: 'invalid-delimiter', sourceOffset: start, reason: 'delimiter-required' } };
  const output: string[] = [];
  const contentStart = expectedDelimiter === undefined ? start + 1 : start;
  for (let index = contentStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const next = source[index + 1];
      if (next === undefined) return { ok: false, error: { kind: 'unterminated-delimiter', sourceOffset: index } };
      output.push(character, next);
      index += 1;
    } else if (character === delimiter) return { ok: true, value: { value: output.join(''), next: index + 1, delimiter } };
    else if (character !== undefined) output.push(character);
  }
  // nvim (`:s/a/b`, `:s/a`): a missing trailing delimiter is not an error;
  // Vim treats end-of-line as an implicit close for the final field.
  return { ok: true, value: { value: output.join(''), next: source.length, delimiter } };
}

/**
 * `:s{pat}{rep}{flags} [count]`: a trailing decimal count, separated by
 * whitespace from the flag letters, is `:s`'s line count (like `:d`/`:y`'s
 * trailing count) -- nvim: `:2s/a/b/g 3` substitutes lines 2-4.
 */
function splitFlagsAndCount(raw: string): { readonly flags: string; readonly count?: number } {
  const trailing = /^(.*?)\s+(\d+)$/u.exec(raw);
  if (trailing !== null) return { flags: trailing[1] ?? '', count: Number(trailing[2]) };
  if (/^\d+$/u.test(raw)) return { flags: '', count: Number(raw) };
  return { flags: raw };
}

function scanUntilPipe(source: string, start: number): number {
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '|') return index;
  }
  return source.length;
}

function allLinesExcept(range: VimExResolvedRange, selected: readonly LineIndex[]): readonly LineIndex[] {
  const set = new Set(selected.map((line) => line as number));
  const lines: LineIndex[] = [];
  for (let line = range.firstLine as number; line <= (range.lastLine as number); line += 1) if (!set.has(line)) lines.push(line as LineIndex);
  return Object.freeze(lines);
}

function validateEdits(edits: readonly DocumentEdit[], snapshot: DocumentSnapshot): Result<void, VimExPrepareFailure> {
  let end = -1;
  for (const edit of mergeEdits(edits)) {
    const start = edit.start as number;
    const finish = edit.end as number;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish) || start < 0 || finish < start || finish > snapshot.lengthUtf16 || start < end) return { ok: false, error: { kind: 'invalid-range', sourceOffset: 0, reason: 'overlapping-edit' } };
    end = finish;
  }
  return { ok: true, value: undefined };
}

function mergeEdits(edits: readonly DocumentEdit[]): DocumentEdit[] {
  const sorted = [...edits].sort((left, right) => (left.start as number) - (right.start as number) || (left.end as number) - (right.end as number));
  const merged: DocumentEdit[] = [];
  for (const edit of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined) { merged.push(edit); continue; }
    if ((edit.start as number) < (previous.end as number)) {
      if (previous.text.length === 0 && edit.text.length === 0) {
        merged[merged.length - 1] = { ...previous, end: Math.max(previous.end as number, edit.end as number) as Utf16Offset };
      } else return sorted;
    } else if ((edit.start as number) === (previous.end as number)
      && (previous.start as number) !== (previous.end as number)
      && (edit.start as number) !== (edit.end as number)) {
      merged[merged.length - 1] = { ...previous, end: edit.end, text: previous.text + edit.text };
    } else merged.push(edit);
  }
  return merged;
}

function scalarWidth(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : codePoint === undefined ? 0 : 1;
}

function previousScalarStart(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const unit = text.charCodeAt(offset - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && offset >= 2 ? offset - 2 : offset - 1;
}

function fail(command: VimExCommand, kind: VimExPrepareFailure['kind'], reason: string): Result<never, VimExPrepareFailure> {
  return { ok: false, error: failValue(command, kind, reason) };
}

function failValue(command: VimExCommand, kind: VimExPrepareFailure['kind'], reason: string): VimExPrepareFailure {
  if (kind === 'nested-global') return { kind, sourceOffset: command.metadata.commandNameStart };
  if (kind === 'destination-in-range') return { kind, sourceOffset: command.metadata.argumentStart };
  if (kind === 'no-previous-substitute') return { kind, sourceOffset: command.metadata.argumentStart };
  if (kind === 'unsupported-script') return { kind, sourceOffset: command.metadata.argumentStart };
  if (kind === 'unsupported-normal-command') return { kind, keys: reason, sourceOffset: command.metadata.argumentStart };
  if (kind === 'invalid-command' || kind === 'invalid-range' || kind === 'invalid-address' || kind === 'invalid-delimiter' || kind === 'unterminated-delimiter' || kind === 'empty-argument') return { kind, sourceOffset: command.metadata.argumentStart, reason } as VimExParseFailure;
  return { kind: 'invalid-command', sourceOffset: command.metadata.argumentStart, reason };
}
