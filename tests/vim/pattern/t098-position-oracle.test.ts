import { strict as assert } from 'node:assert';
import {
  compilePattern,
  createPatternEvaluation,
  createPatternTextSnapshot,
  findAllMatches,
  PatternEvaluationError,
  patternSnapshotFromDocument,
  type PatternVisualArea,
} from '../../../packages/vim/pattern/index';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentId, DocumentVersion, LineIndex, Utf16Offset, Utf8ByteOffset } from '../../../packages/primitives/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
assert.equal(manifest.oracle.version, '0.12.4');
const version = 98 as DocumentVersion;
const coordinateText = 'á😀\t中x\nsecond';
const coordinateLines = ['á😀\t中x', 'second'] as const;

const oracleCases = [
  { id: 'file-start', pattern: String.raw`\%^.`, row: 1, col: 0, expected: [1, 1] },
  { id: 'line-one', pattern: String.raw`\%1l.`, row: 1, col: 0, expected: [1, 1] },
  { id: 'line-two', pattern: String.raw`\%2l.`, row: 1, col: 0, expected: [2, 1] },
  { id: 'line-before-two', pattern: String.raw`\%<2l.`, row: 1, col: 0, expected: [1, 1] },
  { id: 'line-after-one', pattern: String.raw`\%>1l.`, row: 1, col: 0, expected: [2, 1] },
  { id: 'byte-before-four', pattern: String.raw`\%<4c.`, row: 1, col: 0, expected: [1, 1] },
  { id: 'byte-after-three', pattern: String.raw`\%>3c.`, row: 1, col: 0, expected: [1, 4] },
  { id: 'byte-a', pattern: String.raw`\%1c.`, row: 1, col: 0, expected: [1, 1] },
  { id: 'byte-inside-composing-scalar', pattern: String.raw`\%1l\%2c.`, row: 1, col: 0, expected: [0, 0] },
  { id: 'byte-emoji', pattern: String.raw`\%4c.`, row: 1, col: 0, expected: [1, 4] },
  { id: 'byte-wide-glyph', pattern: String.raw`\%9c.`, row: 1, col: 0, expected: [1, 9] },
  { id: 'virtual-emoji', pattern: String.raw`\%2v.`, row: 1, col: 0, expected: [1, 4] },
  { id: 'virtual-before-four', pattern: String.raw`\%<4v.`, row: 1, col: 0, expected: [1, 1] },
  { id: 'virtual-after-two', pattern: String.raw`\%>2v.`, row: 1, col: 0, expected: [1, 8] },
  { id: 'virtual-tab', pattern: String.raw`\%4v.`, row: 1, col: 0, expected: [1, 8] },
  { id: 'virtual-wide-glyph', pattern: String.raw`\%9v.`, row: 1, col: 0, expected: [1, 9] },
  { id: 'cursor-absolute', pattern: String.raw`\%#.`, row: 1, col: 3, expected: [1, 4] },
  { id: 'mark-exact', pattern: String.raw`\%'m.`, row: 1, col: 0, expected: [1, 4] },
  { id: 'mark-before', pattern: String.raw`\%<'m.`, row: 1, col: 0, expected: [1, 1] },
  { id: 'mark-after', pattern: String.raw`\%>'m.`, row: 1, col: 0, expected: [1, 8] },
  { id: 'cursor-byte-column', pattern: String.raw`\%.c.`, row: 1, col: 3, expected: [1, 4] },
  { id: 'cursor-virtual-column', pattern: String.raw`\%.v.`, row: 1, col: 3, expected: [2, 3] },
  { id: 'cursor-line', pattern: String.raw`\%.l.`, row: 2, col: 0, expected: [2, 1] },
  { id: 'end-of-file', pattern: String.raw`.\%$`, row: 1, col: 0, expected: [2, 6] },
] as const;

const caseTable = oracleCases.map((fixture) =>
  `{id=${luaString(fixture.id)},pattern=string.char(${luaBytes(fixture.pattern)}),row=${fixture.row},col=${fixture.col}}`,
).join(',');
const oracleLua = `vim.api.nvim_buf_set_mark(0,'m',1,3,{}); local cases={${caseTable}}; local result={}; for _,c in ipairs(cases) do vim.api.nvim_win_set_cursor(0,{c.row,c.col}); result[c.id]=vim.fn.searchpos(c.pattern,'cnW') end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(result)})`;
const coordinateOracle = await runOracleFixture({
  id: 'T098-VP10-VP16-coordinate-matrix',
  title: 'Positional byte, line and virtual-cell coordinates',
  purpose: 'Pinned Neovim 0.12.4 oracle for VP-10 positional forms and VP-16 UTF-8/UTF-16/cell coordinates.',
  modes: ['normal'],
  lines: coordinateLines,
  steps: [{ label: 'query-position-atoms', keys: `:lua ${oracleLua}<CR>` }],
} satisfies OracleFixture, binaryPath);
const coordinateEncoded = coordinateOracle.snapshots[0]?.lines[0];
assert(coordinateEncoded !== undefined, 'coordinate fixture has an oracle result');
const coordinateExpected = JSON.parse(coordinateEncoded) as Record<string, readonly [number, number]>;
const coordinateDocument = openTextDocument('t098-coordinate-doc' as DocumentId, new TextEncoder().encode(coordinateText));
assert.equal(coordinateDocument.kind, 'editable');
if (coordinateDocument.kind !== 'editable') throw new Error('T098 coordinate fixture must be editable');
const coordinateSnapshot = coordinateDocument.document.snapshot();
const patternSnapshot = patternSnapshotFromDocument(coordinateSnapshot);
const markEmoji = utf16Offset(2);
for (const fixture of oracleCases) {
  const cursorOffset = utf16OffsetFromLineByte(coordinateText, fixture.row, fixture.col);
  const program = compilePattern(fixture.pattern, {
    positionContext: {
      version: coordinateSnapshot.version,
      cursor: utf16Offset(cursorOffset),
      marks: { m: markEmoji },
      tabstop: 8,
    },
  });
  const result = findAllMatches(program, patternSnapshot);
  const actual = result.matches[0];
  const expected = coordinateExpected[fixture.id];
  assert(expected !== undefined, `${fixture.id}: oracle result exists`);
  assert.deepEqual(expected, fixture.expected, `${fixture.id}: pinned Neovim coordinate observation`);
  if (expected[0] === 0) {
    assert.equal(actual, undefined, `${fixture.id}: no match at an invalid byte-column boundary`);
    continue;
  }
  assert(actual !== undefined, `${fixture.id}: Xi finds pinned Neovim match ${JSON.stringify(expected)}`);
  const expectedStart = utf16OffsetFromLineByte(coordinateText, expected[0], expected[1] - 1);
  assert.equal(actual.start as number, expectedStart, `${fixture.id}: UTF-8 byte column converts to UTF-16 offset`);
  const expectedEnd = expectedStart + vimCharacterUtf16Width(coordinateText, expectedStart);
  assert.equal(actual.end as number, expectedEnd, `${fixture.id}: match preserves Vim character and composing span`);
}

const visualCases = [
  { id: 'characterwise', lines: ['abcdef'], keys: '0vll<Esc>', mode: 'v', area: { kind: 'characterwise', start: 0, end: 3 }, candidates: [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [1, 5]], positions: [[1, 1], [1, 2], [1, 3], [0, 0], [0, 0], [0, 0]] },
  { id: 'linewise', lines: ['abc', 'def'], keys: '0Vj<Esc>', mode: 'V', area: { kind: 'linewise', firstLine: 0, lastLine: 1 }, candidates: [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]], positions: [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]] },
  { id: 'blockwise-tab-cells', lines: ['a\t中x', 'abcdefghij'], keys: '0<C-v>j2l<Esc>', mode: '\u0016', area: { kind: 'blockwise', firstLine: 0, lastLine: 1, firstCell: 0, lastCell: 2 }, candidates: [[1, 0], [1, 1], [1, 2], [1, 5], [2, 0], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7], [2, 8], [2, 9]], positions: [[1, 1], [1, 2], [0, 0], [0, 0], [2, 1], [2, 2], [2, 3], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]] },
] as const;
for (const fixture of visualCases) {
  const luaCandidates = fixture.candidates.map(([row, col]) => `{${row},${col}}`).join(',');
  const queryLua = `local p=string.char(${luaBytes(String.raw`\%#\%V.`)}); local candidates={${luaCandidates}}; local found={}; for _,point in ipairs(candidates) do vim.api.nvim_win_set_cursor(0,point); found[#found+1]=vim.fn.searchpos(p,'cnW') end; local a=vim.fn.getpos("'<"); local b=vim.fn.getpos("'>"); vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode({found=found,a=a,b=b,mode=vim.fn.visualmode()})})`;
  const observation = await runOracleFixture({
    id: `T098-VP10-visual-${fixture.id}`,
    title: `Visual-area positional atom: ${fixture.id}`,
    purpose: 'Pinned Neovim visual marks and per-position \\%V oracle for VP-10.',
    modes: ['normal'],
    lines: fixture.lines,
    steps: [
      { label: 'select-area', keys: fixture.keys },
      { label: 'query-visual-membership', keys: `:lua ${queryLua}<CR>` },
    ],
  } satisfies OracleFixture, binaryPath);
  const encoded = observation.snapshots.at(-1)?.lines[0];
  assert(encoded !== undefined, `${fixture.id}: visual oracle data exists`);
  const measured = JSON.parse(encoded) as { readonly found: readonly (readonly [number, number])[]; readonly a: readonly number[]; readonly b: readonly number[]; readonly mode: string };
  assert.equal(measured.mode, fixture.mode, `${fixture.id}: actual visual mode`);
  assert.deepEqual(measured.found, fixture.positions, `${fixture.id}: pinned visual membership`);

  const text = fixture.lines.join('\n');
  const doc = openTextDocument(`t098-visual-${fixture.id}` as DocumentId, new TextEncoder().encode(text));
  assert.equal(doc.kind, 'editable');
  if (doc.kind !== 'editable') throw new Error(`T098 ${fixture.id} fixture must be editable`);
  const snapshot = doc.document.snapshot();
  const area = fixture.area as unknown as PatternVisualArea;
  const selectedCandidates = measured.found.flatMap(([row, col]) =>
    row === 0 ? [] : [utf16Offset(utf16OffsetFromLineByte(text, row, col - 1))],
  ).map((offset) => offset as number);
  const visualProgram = compilePattern(String.raw`\%V.`, {
    positionContext: { version: snapshot.version, visualArea: area, tabstop: 8 },
  });
  const actualSelected = findAllMatches(visualProgram, patternSnapshotFromDocument(snapshot)).matches.map((match) => match.start as number);
  assert.deepEqual(actualSelected, selectedCandidates, `${fixture.id}: Xi visual area uses oracle-proven line/cell membership`);
}

const unicodeDocument = openTextDocument('t098-utf8-utf16' as DocumentId, new TextEncoder().encode(coordinateText));
assert.equal(unicodeDocument.kind, 'editable');
if (unicodeDocument.kind !== 'editable') throw new Error('T098 unicode fixture must be editable');
const unicodeSnapshot = unicodeDocument.document.snapshot();
const emojiByteOffset = 3 as Utf8ByteOffset;
const emojiOffset = unicodeSnapshot.offsetAtUtf8(emojiByteOffset);
assert(emojiOffset.ok, 'UTF-8 offset at emoji start converts to a document offset');
assert.equal(emojiOffset.value as number, 2, 'astral scalar is two UTF-16 code units');
const reverseEmojiOffset = unicodeSnapshot.utf8OffsetAt(emojiOffset.value);
assert(reverseEmojiOffset.ok);
assert.equal(reverseEmojiOffset.value as number, 3, 'document offset converts back to oracle UTF-8 bytes');
assert.equal(unicodeSnapshot.offsetAtUtf8(4 as Utf8ByteOffset).ok, false, 'byte offsets inside a multibyte scalar are rejected');
const combiningEnd = unicodeSnapshot.utf8OffsetAt(utf16Offset(1));
assert(combiningEnd.ok);
assert.equal(combiningEnd.value as number, 1, 'combining sequence boundaries retain explicit byte and UTF-16 units');

const callerState = { cursor: 5, repeat: 'last-search', version: unicodeSnapshot.version };
const callerStateBefore = { ...callerState };
const staleProgram = compilePattern(String.raw`\%#`, {
  positionContext: { version: 97 as DocumentVersion, cursor: utf16Offset(2) },
});
assert.throws(() => createPatternEvaluation(staleProgram, patternSnapshotFromDocument(unicodeSnapshot)), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'stale-position' && error.source?.start === 0 && error.source.end === 3,
  'stale positional context fails before evaluation with the responsible pattern source span',
);
assert.deepEqual(callerState, callerStateBefore, 'stale evaluation cannot change cursor, repeat state or version');
const unchangedAfterStale = unicodeDocument.document.snapshot();
assert.equal(unchangedAfterStale.version, unicodeSnapshot.version);
const unchangedText = unchangedAfterStale.slice(utf16Offset(0), utf16Offset(unchangedAfterStale.lengthUtf16));
assert(unchangedText.ok);
assert.equal(unchangedText.value, coordinateText);

const missingVisualContext = compilePattern(String.raw`\%V`);
assert.throws(() => findAllMatches(missingVisualContext, createPatternTextSnapshot(version, 'abc')), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'unsupported-construct' && error.source?.start === 0 && error.source.end === 3,
  'visual context absence is a typed, source-aware evaluation error rather than a silent non-match',
);
assert.throws(() => findAllMatches(compilePattern(String.raw`\%'m.`), createPatternTextSnapshot(version, 'abc')), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'unsupported-construct' && error.source?.start === 0,
  'mark context absence is a typed, source-aware evaluation error rather than a silent non-match',
);

const resourceText = 'a'.repeat(512);
const resourceDocument = openTextDocument('t098-resources' as DocumentId, new TextEncoder().encode(resourceText));
assert.equal(resourceDocument.kind, 'editable');
if (resourceDocument.kind !== 'editable') throw new Error('T098 resource fixture must be editable');
const resourceSnapshot = resourceDocument.document.snapshot();
const resourcePatternSnapshot = patternSnapshotFromDocument(resourceSnapshot);
const externalState = { cursor: 0, repeat: 'unchanged', version: resourceSnapshot.version };
for (const pattern of [String.raw`\%1v.`, String.raw`\v\%1v(a)\1`]) {
  const expected = findAllMatches(compilePattern(pattern), resourcePatternSnapshot);
  const sliced = createPatternEvaluation(compilePattern(pattern), resourcePatternSnapshot);
  let progress = sliced.resume(3);
  let slices = 1;
  while (progress.kind === 'pending') {
    progress = sliced.resume(3);
    slices += 1;
  }
  assert(slices > 1, `${pattern}: coordinate indexing yields cooperatively`);
  assert.deepEqual(progress.result.matches, expected.matches, `${pattern}: sliced evaluation preserves match/capture state`);
  assert.equal(progress.result.snapshotVersion, resourceSnapshot.version);
  assert.deepEqual(externalState, { cursor: 0, repeat: 'unchanged', version: resourceSnapshot.version });

  const boundedFailure = createPatternEvaluation(
    compilePattern(pattern, { stepBudget: 80 }),
    resourcePatternSnapshot,
  );
  assert.throws(() => boundedFailure.resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
    error instanceof PatternEvaluationError && error.code === 'step-budget-exceeded' && error.steps === 81 && error.source !== undefined,
    `${pattern}: line coordinate indexing obeys deterministic work budgets`,
  );
  const cancellation = createPatternEvaluation(compilePattern(pattern), resourcePatternSnapshot);
  assert.equal(cancellation.resume(3).kind, 'pending');
  cancellation.cancel();
  assert.throws(() => cancellation.resume(1), (error: unknown) =>
    error instanceof PatternEvaluationError && error.code === 'cancelled' && error.source !== undefined,
    `${pattern}: cancellation is observed at a resumable coordinate-index boundary`,
  );
}
assert.equal(resourceDocument.document.snapshot().version, resourceSnapshot.version, 'budget/cancel paths never commit document state');
assert.equal(externalState.cursor, 0);
assert.equal(externalState.repeat, 'unchanged');
for (const fixture of [
  { pattern: String.raw`\%1l.`, text: 'abc', expectedEngine: 'nfa' },
  { pattern: String.raw`\v\%1l(a)\1`, text: 'aaaa', expectedEngine: 'backtracking' },
] as const) {
  const outputLimited = createPatternEvaluation(
    compilePattern(fixture.pattern, { outputLimit: 1, positionContext: { version: resourceSnapshot.version } }),
    createPatternTextSnapshot(resourceSnapshot.version, fixture.text),
  );
  assert.throws(() => outputLimited.resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
    error instanceof PatternEvaluationError && error.code === 'output-limit-exceeded' && error.source !== undefined,
    `${fixture.expectedEngine}: positional evaluation enforces output limits with source provenance`,
  );
  assert.deepEqual(externalState, { cursor: 0, repeat: 'unchanged', version: resourceSnapshot.version });
}
console.log(`PASS T098 oracle-coordinate=${oracleCases.length} visual=${visualCases.length} stale-version/UTF8-byte-boundaries/resumable-NFA+fallback-work+output-budget+cancellation=pass`);

function luaString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function luaBytes(value: string): string {
  return [...new TextEncoder().encode(value)].join(',');
}

function utf16Offset(value: number): Utf16Offset {
  return value as Utf16Offset;
}

function utf16OffsetFromLineByte(text: string, oneBasedLine: number, byteColumn0: number): number {
  const lines = text.split('\n');
  let absoluteLineStart = 0;
  for (let line = 0; line < oneBasedLine - 1; line += 1) absoluteLineStart += (lines[line] ?? '').length + 1;
  const currentLine = lines[oneBasedLine - 1];
  if (currentLine === undefined || byteColumn0 < 0) throw new Error('T098 oracle position is outside the fixture');
  let bytes = 0;
  let utf16 = 0;
  for (const scalar of currentLine) {
    if (bytes === byteColumn0) return absoluteLineStart + utf16;
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > byteColumn0) throw new Error('T098 oracle byte column splits a UTF-8 scalar');
    bytes += scalarBytes;
    utf16 += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('T098 oracle byte column is beyond the logical line');
  return absoluteLineStart + utf16;
}

function vimCharacterUtf16Width(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return 0;
  let end = offset + (codePoint > 0xffff ? 2 : 1);
  if (/^\p{M}$/u.test(String.fromCodePoint(codePoint))) return end - offset;
  while (end < text.length) {
    const next = text.codePointAt(end);
    if (next === undefined || !/^\p{M}$/u.test(String.fromCodePoint(next))) break;
    end += next > 0xffff ? 2 : 1;
  }
  return end - offset;
}
