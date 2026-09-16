import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  compilePattern,
  createPatternTextSnapshot,
  findAllMatches,
  PatternEvaluationError,
  substituteAll,
  type CaptureSpan,
} from '../../../packages/vim/pattern/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';
import type { DocumentVersion, Utf16Offset } from '../../../packages/primitives/src/index';

interface OraclePatternObservation {
  readonly span: readonly [string, number, number];
  readonly captures: readonly string[];
  readonly groupOneSpan: readonly [string, number, number];
  readonly groupTwoSpan: readonly [string, number, number];
  readonly lines: readonly string[];
}

interface T005Case {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly pattern: string;
  readonly replacement: string;
  readonly expectedLines: readonly string[];
  readonly cursor?: { readonly line: number; readonly byteColumn0: number };
}

interface T005Cases {
  readonly cases: readonly T005Case[];
}

const version = 26 as DocumentVersion;
const fixtureId = 'PATT-T026-ORACLE-UNICODE-CAPTURES-01';
const text = 'x😀é!';
const pattern = '\\v(😀)(é)';
const captureOnePattern = '\\v\\zs😀\\ze(é)';
const captureTwoPattern = '\\v(😀)\\zsé\\ze';
const lua = `local text=table.concat(vim.api.nvim_buf_get_lines(0,0,-1,true),'\\n'); local p=string.char(${luaBytes(pattern)}); local c1=string.char(${luaBytes(captureOnePattern)}); local c2=string.char(${luaBytes(captureTwoPattern)}); local result={span=vim.fn.matchstrpos(text,p),captures=vim.fn.matchlist(text,p),groupOneSpan=vim.fn.matchstrpos(text,c1),groupTwoSpan=vim.fn.matchstrpos(text,c2)}; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(result)})`;
const oracleFixture: OracleFixture = {
  id: fixtureId,
  title: 'Compare production Vim regex spans and captures with Neovim 0.12.4',
  purpose: 'Direct matchstrpos/matchlist oracle for UTF-8 byte spans, UTF-16 spans and captures.',
  modes: ['normal'],
  lines: [text],
  steps: [{ label: 'emit pattern observation', keys: `:lua ${lua}<CR>` }],
};
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
assert.equal(manifest.oracle.version, '0.12.4');

const t005Fixture: T005Cases = JSON.parse(await readFile(resolve(process.cwd(), 'tests/fixtures/vim/T005-pattern-cases.json'), 'utf8')) as T005Cases;
let directCorpusComparisons = 0;
let directSpanCaptureComparisons = 0;
for (const fixture of t005Fixture.cases) {
  const sourceText = fixture.lines.join('\n');
  const oracleLua = `local text=table.concat(vim.api.nvim_buf_get_lines(0,0,-1,true),'\\n'); local p=string.char(${luaBytes(fixture.pattern)}); local r=string.char(${luaBytes(fixture.replacement)}); local result={span=vim.fn.matchstrpos(text,p),captures=vim.fn.matchlist(text,p),groupOneSpan={'',-1,-1},groupTwoSpan={'',-1,-1}}; vim.cmd('%s/'..p..'/'..r..'/g'); result.lines=vim.api.nvim_buf_get_lines(0,0,-1,true); vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(result)})`;
  const directFixture: OracleFixture = {
    id: `T026-DIRECT-${fixture.id}`,
    title: fixture.title,
    purpose: 'Direct pinned-Neovim output, first reported span, and capture comparison for the production evaluator.',
    modes: ['normal'],
    lines: fixture.lines,
    ...(fixture.cursor === undefined ? {} : { cursor: fixture.cursor }),
    steps: [{ label: fixture.title, keys: `:lua ${oracleLua}<CR>` }],
  };
  const oracleSnapshot = (await runOracleFixture(directFixture, binaryPath)).snapshots[0];
  const encoded = oracleSnapshot?.lines[0];
  assert(encoded !== undefined, `${fixture.id}: direct oracle observation missing`);
  const expected = JSON.parse(encoded) as OraclePatternObservation;
  assert.deepEqual(expected.lines, fixture.expectedLines, `${fixture.id}: fixture oracle expectation changed`);

  const cursor = fixture.cursor === undefined ? undefined : cursorOffset(sourceText, fixture.cursor.line, fixture.cursor.byteColumn0);
  const program = compilePattern(fixture.pattern, cursor === undefined ? {} : { cursor: { version, offset: cursor as Utf16Offset } });
  const candidate = substituteAll(program, createPatternTextSnapshot(version, sourceText), fixture.replacement);
  assert.deepEqual(candidate.text.split('\n'), expected.lines, `${fixture.id}: production output differs from direct oracle`);
  const first = candidate.matches[0];
  const matchstrposProvidesBufferLineContext = fixture.id !== 'PATT-POSITION-LINE-01' && !fixture.pattern.includes('\\%#');
  if (matchstrposProvidesBufferLineContext && expected.span[1] >= 0) {
    assert(first !== undefined, `${fixture.id}: oracle found a match but Xi did not`);
    assert.equal(utf16ToUtf8(sourceText, first.start as number), expected.span[1], `${fixture.id}: first match start differs`);
    assert.equal(utf16ToUtf8(sourceText, first.end as number), expected.span[2], `${fixture.id}: first match end differs`);
    for (let group = 1; group <= 9; group += 1) {
      const capture: CaptureSpan | undefined = first.captures.get(group);
      const observed: string = capture === undefined ? '' : sourceText.slice(capture.start as number, capture.end as number);
      assert.equal(observed, expected.captures[group] ?? '', `${fixture.id}: capture ${group} differs`);
    }
    directSpanCaptureComparisons += 1;
  } else if (matchstrposProvidesBufferLineContext) {
    assert.equal(first, undefined, `${fixture.id}: Xi found a match rejected by oracle`);
  }
  directCorpusComparisons += 1;
}

const caseOracleCases = [
  { id: 'PATT-T026-IGNORECASE-01', pattern: 'foo', expected: 'X X' },
  { id: 'PATT-T026-SMARTCASE-01', pattern: 'Foo', expected: 'FOO foo' },
  { id: 'PATT-T026-CASE-OVERRIDE-INSENSITIVE-01', pattern: String.raw`\cFoo`, expected: 'X X' },
  { id: 'PATT-T026-CASE-OVERRIDE-SENSITIVE-01', pattern: String.raw`\CFoo`, expected: 'FOO foo' },
] as const;
for (const fixture of caseOracleCases) {
  const options = fixture.id === 'PATT-T026-IGNORECASE-01'
    ? { ignorecase: true }
    : { ignorecase: true, smartcase: true };
  const caseLua = `local p=string.char(${luaBytes(fixture.pattern)}); vim.cmd('silent! %s/'..p..'/X/g'); local lines=vim.api.nvim_buf_get_lines(0,0,-1,true); vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(lines)})`;
  const caseOracle = await runOracleFixture({
    id: fixture.id,
    title: fixture.id,
    purpose: 'Pinned `:substitute` check for ignorecase, smartcase and inline case directives.',
    modes: ['normal'],
    lines: ['FOO foo'],
    options,
    steps: [{ label: fixture.id, keys: `:lua ${caseLua}<CR>` }],
  }, binaryPath);
  const observedJson = caseOracle.snapshots[0]?.lines[0];
  assert(observedJson !== undefined, `${fixture.id}: no oracle result`);
  const observedLines: unknown = JSON.parse(observedJson);
  assert.deepEqual(observedLines, [fixture.expected], `${fixture.id}: Neovim result`);
  const candidateOptions = fixture.id === 'PATT-T026-IGNORECASE-01'
    ? { ignoreCase: true }
    : { ignoreCase: true, smartCase: true };
  const candidate = substituteAll(compilePattern(fixture.pattern, candidateOptions), createPatternTextSnapshot(version, 'FOO foo'), 'X');
  assert.deepEqual(candidate.text.split('\n'), observedLines, `${fixture.id}: Xi result`);
}

const oracleResult = await runOracleFixture(oracleFixture, binaryPath);
const output = oracleResult.snapshots[0]?.lines[0];
assert(output !== undefined, `${fixtureId}: oracle did not emit result`);
const expected: OraclePatternObservation = JSON.parse(output) as OraclePatternObservation;

const candidate = findAllMatches(compilePattern(pattern), createPatternTextSnapshot(version, text)).matches[0];
assert(candidate !== undefined);
assert.equal(expected.span[1], utf16ToUtf8(text, candidate.start as number));
assert.equal(expected.span[2], utf16ToUtf8(text, candidate.end as number));
assert.equal(expected.span[0], text.slice(candidate.start as number, candidate.end as number));
assert.equal(expected.captures[1], text.slice(candidate.captures.get(1)?.start as number, candidate.captures.get(1)?.end as number));
assert.equal(expected.captures[2], text.slice(candidate.captures.get(2)?.start as number, candidate.captures.get(2)?.end as number));
for (const [group, span] of [[1, expected.groupOneSpan], [2, expected.groupTwoSpan]] as const) {
  const capture = candidate.captures.get(group);
  assert(capture !== undefined);
  assert.equal(span[1], utf16ToUtf8(text, capture.start as number), `capture ${group} start differs from oracle`);
  assert.equal(span[2], utf16ToUtf8(text, capture.end as number), `capture ${group} end differs from oracle`);
}

const reportedStart = findAllMatches(compilePattern(String.raw`foo\zsbar`), createPatternTextSnapshot(version, 'foobar')).matches[0];
assert(reportedStart !== undefined);
assert.deepEqual([reportedStart.start as number, reportedStart.end as number, reportedStart.consumedStart as number, reportedStart.consumedEnd as number], [3, 6, 0, 6]);
const reportedEnd = findAllMatches(compilePattern(String.raw`foo\zebar`), createPatternTextSnapshot(version, 'foobar')).matches[0];
assert(reportedEnd !== undefined);
assert.deepEqual([reportedEnd.start as number, reportedEnd.end as number, reportedEnd.consumedStart as number, reportedEnd.consumedEnd as number], [0, 3, 0, 6]);

const typedUnsupported: readonly { readonly id: string; readonly source: string }[] = [
  { id: 'PATT-ERROR-SYNTAX-ONLY-Z-GROUP-01', source: String.raw`\z(foo)` },
  { id: 'PATT-ERROR-CONTEXTUAL-VISUAL-ATOM-01', source: String.raw`\%V` },
];
for (const fixture of typedUnsupported) {
  let thrown: unknown;
  try {
    const program = compilePattern(fixture.source);
    findAllMatches(program, createPatternTextSnapshot(version, 'aaaaab'));
  } catch (error: unknown) {
    thrown = error;
  }
  assert(thrown instanceof PatternEvaluationError, `${fixture.id}: unsupported form must fail explicitly`);
  assert.equal(thrown.code, 'unsupported-construct', fixture.id);
  assert(thrown.source !== undefined, `${fixture.id}: missing source span`);
}

const zeroWidthFixtureId = 'PATT-T026-ZERO-WIDTH-REPEAT-01';
const zeroWidthText = 'aab b';
const zeroWidthPattern = String.raw`\v(a?)*b`;
const zeroWidthLua = `local t=table.concat(vim.api.nvim_buf_get_lines(0,0,-1,true),'\\n'); local p=string.char(${luaBytes(zeroWidthPattern)}); local result={span=vim.fn.matchstrpos(t,p),captures=vim.fn.matchlist(t,p)}; vim.cmd('%s/'..p..'/X/g'); result.lines=vim.api.nvim_buf_get_lines(0,0,-1,true); vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(result)})`;
const zeroWidthOracle = await runOracleFixture({
  id: zeroWidthFixtureId,
  title: 'Nested nullable repetition terminates with Vim greedy match spans',
  purpose: 'Pinned zero-width repetition failure fixture for the production evaluator.',
  modes: ['normal'],
  lines: [zeroWidthText],
  steps: [{ label: 'observe and substitute nullable repeat', keys: `:lua ${zeroWidthLua}<CR>` }],
}, binaryPath);
const zeroWidthEncoded = zeroWidthOracle.snapshots[0]?.lines[0];
assert(zeroWidthEncoded !== undefined);
const zeroWidthExpected = JSON.parse(zeroWidthEncoded) as OraclePatternObservation;
assert.deepEqual(zeroWidthExpected.lines, ['X X']);
const zeroWidthResult = findAllMatches(compilePattern(zeroWidthPattern), createPatternTextSnapshot(version, zeroWidthText));
assert.equal(zeroWidthResult.matches.length, 2);
assert.deepEqual(zeroWidthResult.matches.slice(0, 1).map((match) => [
  utf16ToUtf8(zeroWidthText, match.start as number),
  utf16ToUtf8(zeroWidthText, match.end as number),
]), [[zeroWidthExpected.span[1], zeroWidthExpected.span[2]]]);
const zeroCapture = zeroWidthResult.matches[0]?.captures.get(1);
assert.equal(zeroCapture === undefined ? '' : zeroWidthText.slice(zeroCapture.start as number, zeroCapture.end as number), zeroWidthExpected.captures[1] ?? '');
assert.deepEqual(substituteAll(compilePattern(zeroWidthPattern), createPatternTextSnapshot(version, zeroWidthText), 'X').text.split('\n'), zeroWidthExpected.lines);

console.log(`PASS T026 direct Neovim corpus=${directCorpusComparisons}/${t005Fixture.cases.length} output matches; span/capture cases=${directSpanCaptureComparisons}; binary=${manifest.oracle.binarySha256}`);
console.log(`PASS T026 ignorecase/smartcase/inline-case oracle cases=${caseOracleCases.length}`);
console.log(`PASS ${fixtureId}: Neovim ${manifest.oracle.version} spans/captures=match`);
console.log(`PASS ${zeroWidthFixtureId}: Neovim span/capture/output and Xi budgeted termination match`);
console.log(`PASS T026 syntax-only/contextual typed failures=${typedUnsupported.map((fixture) => fixture.id).join(',')}`);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}

function utf16ToUtf8(value: string, offset: number): number {
  return Buffer.byteLength(value.slice(0, offset), 'utf8');
}

function cursorOffset(text: string, oneBasedLine: number, byteColumn0: number): number {
  const lines = text.split('\n');
  const line = lines[oneBasedLine - 1];
  if (line === undefined || byteColumn0 < 0) throw new Error('pattern-fixture-cursor-outside-document');
  let bytes = 0;
  let utf16 = 0;
  for (const scalar of line) {
    if (bytes === byteColumn0) break;
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > byteColumn0) throw new Error('pattern-fixture-cursor-splits-utf8-scalar');
    bytes += scalarBytes;
    utf16 += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('pattern-fixture-cursor-column-out-of-range');
  let before = 0;
  for (let lineIndex = 0; lineIndex < oneBasedLine - 1; lineIndex += 1) before += (lines[lineIndex] ?? '').length + 1;
  return before + utf16;
}
