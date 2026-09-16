import { strict as assert } from 'node:assert';
import {
  compilePattern,
  createPatternEvaluation,
  createPatternTextSnapshot,
  findAllMatches,
  PatternEvaluationError,
  type CaptureSpan,
} from '../../../packages/vim/pattern/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';
import type { DocumentVersion } from '../../../packages/primitives/src/index';

interface PatternProbe {
  readonly id: string;
  readonly text: string;
  readonly pattern: string;
  readonly expectedSpan: readonly [string, number, number];
  readonly expectedCaptures?: readonly string[];
}

interface OraclePatternProbe {
  readonly id: string;
  readonly span: readonly [string, number, number];
  readonly captures: readonly string[];
  readonly captureSpans: readonly (readonly [number, number])[];
}

const version = 100 as DocumentVersion;
const acute = '\u0301';
const grave = '\u0300';
const probes: readonly PatternProbe[] = [
  ...([0, 1, 2] as const).map((selector) => ({
    id: `base-literal-rejects-composed-${selector}`,
    text: `a${acute}`,
    pattern: `\\%#=${selector}a`,
    expectedSpan: ['', -1, -1] as const,
  })),
  { id: 'literal-nfa-marks-order-independent-and-extras', text: `a${grave}${acute}`, pattern: `\\%#=0a${acute}`, expectedSpan: [`a${grave}${acute}`, 0, 5] },
  { id: 'literal-nfa-selector-two-order-independent', text: `a${grave}${acute}`, pattern: `\\%#=2a${acute}`, expectedSpan: [`a${grave}${acute}`, 0, 5] },
  { id: 'literal-old-engine-exact-composed-sequence', text: `a${acute}`, pattern: `\\%#=1a${acute}`, expectedSpan: [`a${acute}`, 0, 3] },
  { id: 'literal-old-engine-rejects-extra-mark', text: `a${acute}${grave}`, pattern: `\\%#=1a${acute}`, expectedSpan: ['', -1, -1] },
  { id: 'literal-old-engine-rejects-reordered-mark', text: `a${grave}${acute}`, pattern: `\\%#=1a${acute}`, expectedSpan: ['', -1, -1] },
  ...([0, 1, 2] as const).map((selector) => ({
    id: `bare-mark-matches-composed-cluster-${selector}`,
    text: `a${acute}${grave}`,
    pattern: `\\%#=${selector}${acute}`,
    expectedSpan: [`a${acute}${grave}`, 0, 5] as const,
  })),
  ...([0, 1, 2] as const).map((selector) => ({
    id: `bare-mark-detached-leading-case-${selector}`,
    text: `${acute}a`,
    pattern: `\\%#=${selector}${acute}`,
    expectedSpan: selector === 1 ? [acute, 0, 2] as const : ['', -1, -1] as const,
  })),
  ...([0, 1, 2] as const).map((selector) => ({
    id: `dot-consumes-composed-cluster-${selector}`,
    text: `a${acute}`,
    pattern: `\\%#=${selector}.`,
    expectedSpan: [`a${acute}`, 0, 3] as const,
  })),
  { id: 'dot-matches-leading-standalone-mark', text: `${acute}a`, pattern: '.', expectedSpan: [acute, 0, 2] },
  { id: 'class-nfa-consumes-composed-cluster', text: `a${acute}`, pattern: String.raw`\%#=0[a]`, expectedSpan: [`a${acute}`, 0, 3] },
  { id: 'class-selector-two-consumes-composed-cluster', text: `a${acute}`, pattern: String.raw`\%#=2[a]`, expectedSpan: [`a${acute}`, 0, 3] },
  { id: 'class-old-engine-keeps-base-span', text: `a${acute}`, pattern: String.raw`\%#=1[a]`, expectedSpan: ['a', 0, 1] },
  ...([0, 1, 2] as const).map((selector) => ({
    id: `class-matches-standalone-composing-mark-${selector}`,
    text: acute,
    pattern: `\\%#=${selector}[${acute}]`,
    expectedSpan: [acute, 0, 2] as const,
  })),
  ...([0, 1, 2] as const).map((selector) => ({
    id: `class-mark-does-not-split-attached-cluster-${selector}`,
    text: `a${acute}`,
    pattern: `\\%#=${selector}[${acute}]`,
    expectedSpan: ['', -1, -1] as const,
  })),
  { id: 'class-nfa-includes-composing-members', text: `a${grave}${acute}`, pattern: `\\%#=0[a${acute}]`, expectedSpan: [`a${grave}${acute}`, 0, 5] },
  { id: 'class-old-engine-composing-prefix-span', text: `a${acute}${grave}`, pattern: `\\%#=1[a${acute}]`, expectedSpan: [`a${acute}`, 0, 3] },
  { id: 'class-old-engine-rejects-composing-order', text: `a${grave}${acute}`, pattern: `\\%#=1[a${acute}]`, expectedSpan: ['', -1, -1] },
  ...([0, 1, 2] as const).map((selector) => ({
    id: `ignore-combining-selector-${selector}`,
    text: `a${acute}${grave}`,
    pattern: `\\%#=${selector}a\\Z`,
    expectedSpan: selector === 1 ? ['a', 0, 1] as const : [`a${acute}${grave}`, 0, 5] as const,
  })),
  ...([0, 1, 2] as const).map((selector) => ({
    id: `skip-combining-selector-${selector}`,
    text: `a${acute}${grave}t`,
    pattern: `\\%#=${selector}a\\%Ct`,
    expectedSpan: [`a${acute}${grave}t`, 0, 6] as const,
  })),
  ...([0, 1, 2] as const).map((selector) => {
    const text = selector === 1 ? `xa${acute}${grave}y` : `xa${grave}${acute}y`;
    const capturedCluster = selector === 1 ? `a${acute}${grave}` : `a${grave}${acute}`;
    const capturedPattern = selector === 1 ? `a${acute}${grave}` : `a${acute}`;
    return {
      id: `capture-composed-cluster-selector-${selector}`,
      text,
      pattern: `\\%#=${selector}\\v(x)(${capturedPattern})(y)`,
      expectedSpan: [text, 0, Buffer.byteLength(text, 'utf8')] as const,
      expectedCaptures: ['x', capturedCluster, 'y'],
    };
  }),
  ...([0, 1, 2] as const).map((selector) => ({
    id: `capture-precomposed-selector-${selector}`,
    text: 'xày',
    pattern: `\\%#=${selector}\\v(x)(à)(y)`,
    expectedSpan: ['xày', 0, 4] as const,
    expectedCaptures: ['x', 'à', 'y'],
  })),
  ...([0, 1, 2] as const).map((selector) => ({
    id: `capture-leading-mark-selector-${selector}`,
    text: `a${acute}`,
    pattern: `\\%#=${selector}\\v(${acute})`,
    expectedSpan: [`a${acute}`, 0, 3] as const,
    expectedCaptures: [selector === 1 ? '' : `a${acute}`],
  })),
  { id: 'precomposed-literal', text: 'à', pattern: 'à', expectedSpan: ['à', 0, 2] },
  ...([0, 1, 2] as const).map((selector) => ({
    id: `decomposed-literal-does-not-match-precomposed-${selector}`,
    text: 'à',
    pattern: `\\%#=${selector}a${acute}`,
    expectedSpan: ['', -1, -1] as const,
  })),
  { id: 'precomposed-literal-rejects-extra-mark', text: `à${acute}`, pattern: 'à', expectedSpan: ['', -1, -1] },
];

const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
assert.equal(manifest.oracle.version, '0.12.4');
const luaCases = probes.map((probe) =>
  `{id=${luaString(probe.id)}, text=string.char(${luaBytes(probe.text)}), pattern=string.char(${luaBytes(probe.pattern)})}`,
).join(',');
const lua = `local cases={${luaCases}}; local result={}; for _,c in ipairs(cases) do local span=vim.fn.matchstrpos(c.text,c.pattern); local list=vim.fn.matchlist(c.text,c.pattern); local captures={}; local captureSpans={}; for i=1,9 do local value=list[i+1] or ''; captures[i]=value; if value=='' then captureSpans[i]={-1,-1} else local first=string.find(c.text,value,span[2]+1,true); captureSpans[i]={first-1,first-1+#value} end end; table.insert(result,{id=c.id,span=span,captures=captures,captureSpans=captureSpans}) end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.json.encode(result)})`;
const oracle = await runOracleFixture({
  id: 'T100-COMPOSING-SELECTOR-MATRIX',
  title: 'Pinned composing-character behavior across Vim regexp engines',
  purpose: 'Minimized spans and captures for regular literals, dot, classes, selectors, \u005cZ and \u005c%C.',
  modes: ['normal'],
  lines: ['oracle-probe'],
  steps: [{ label: 'evaluate composing matrix', keys: `:lua ${lua}<CR>` }],
} satisfies OracleFixture, binaryPath);
const output = oracle.snapshots[0]?.lines[0];
assert(output !== undefined, 'T100 composing oracle emitted no matrix');
const observed: unknown = JSON.parse(output);
assert(Array.isArray(observed), 'T100 composing oracle matrix is invalid');
const byId = new Map((observed as OraclePatternProbe[]).map((probe) => [probe.id, probe]));
for (const probe of probes) {
  const expected = byId.get(probe.id);
  assert(expected !== undefined, `${probe.id}: oracle result missing`);
  assert.deepEqual(expected.span, probe.expectedSpan, `${probe.id}: pinned Vim span changed`);
  const result = findAllMatches(compilePattern(probe.pattern), createPatternTextSnapshot(version, probe.text));
  const actual = result.matches[0];
  if (expected.span[1] < 0) {
    assert.equal(actual, undefined, `${probe.id}: Xi matched a Vim-rejected pattern`);
    continue;
  }
  assert(actual !== undefined, `${probe.id}: Xi missed Vim's match`);
  assert.equal(utf16ToUtf8(probe.text, actual.start as number), expected.span[1], `${probe.id}: UTF-8 start`);
  assert.equal(utf16ToUtf8(probe.text, actual.end as number), expected.span[2], `${probe.id}: UTF-8 end`);
  assert.equal(probe.text.slice(actual.start as number, actual.end as number), expected.span[0], `${probe.id}: matched cluster`);
  const expectedCaptures = probe.expectedCaptures ?? [];
  for (let group = 1; group <= expectedCaptures.length; group += 1) {
    const capture: CaptureSpan | undefined = actual.captures.get(group);
    assert(capture !== undefined, `${probe.id}: capture ${group} is missing`);
    const value = probe.text.slice(capture.start as number, capture.end as number);
    assert.equal(value, expected.captures[group - 1], `${probe.id}: capture ${group}`);
    if (value === '') {
      assert.equal(capture.start, capture.end, `${probe.id}: empty capture ${group} is zero-width`);
      continue;
    }
    assert.deepEqual([
      utf16ToUtf8(probe.text, capture.start as number),
      utf16ToUtf8(probe.text, capture.end as number),
    ], expected.captureSpans[group - 1], `${probe.id}: capture ${group} UTF-8 span`);
  }
}

const rawBufferBytes = [0x61, 0x00, 0x62, 0x78, 0xf0, 0x9f, 0x98, 0x80, 0x79];
const nulPattern = String.raw`\%d0`;
const nulAndBPattern = String.raw`\%d0\%d98`;
const emojiPattern = String.raw`\%U1F600`;
const nulAtomLua = String.raw`[=[\%d0]=]`;
const emojiAtomLua = String.raw`[=[\%U1F600]=]`;
assert.deepEqual(compilePattern(nulPattern).root.source, { start: 0, end: 4 }, 'NUL codepoint source span uses pattern UTF-16 units');
assert.deepEqual(compilePattern(emojiPattern).root.source, { start: 0, end: 8 }, 'supplementary codepoint source span uses pattern UTF-16 units');
assert.throws(() => compilePattern(String.raw`\%U110000`), (error: unknown) =>
  error instanceof PatternEvaluationError
  && error.code === 'invalid-pattern'
  && error.source !== undefined
  && error.source.start === 0
  && error.source.end === 9,
  'invalid Unicode codepoint boundary preserves its pattern source span',
);
const luaBufferProbe = `local function probe(pattern) local s=vim.fn.searchpos(pattern,'cnW'); local e=vim.fn.searchpos(pattern,'cenW'); return {s[1],s[2]-1,e[2]} end; local result={nul=probe([=[${nulPattern}]=]),nulThenB=probe([=[${nulAndBPattern}]=]),emoji=probe([=[${emojiPattern}]=]),selectorNul={},selectorEmoji={}}; for selector=0,2 do local prefix=string.char(92,37,35,61,48+selector); result.selectorNul[selector+1]=probe(prefix..${nulAtomLua}); result.selectorEmoji[selector+1]=probe(prefix..${emojiAtomLua}) end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.json.encode(result)})`;
const bufferOracle = await runOracleFixture({
  id: 'T100-REAL-BUFFER-NUL-CODEPOINTS',
  title: 'NUL and supplementary code point atoms in a file-loaded Neovim buffer',
  purpose: 'Search real file bytes without embedding NUL in Lua strings; oracle columns are UTF-8 byte coordinates.',
  modes: ['normal'],
  lines: [''],
  endOfLine: false,
  rawBufferBytes,
  steps: [{ label: 'search NUL and emoji', keys: `:lua ${luaBufferProbe}<CR>` }],
} satisfies OracleFixture, binaryPath);
const bufferOutput = bufferOracle.snapshots[0]?.lines[0];
assert(bufferOutput !== undefined, 'T100 raw-buffer oracle emitted no result');
const bufferExpected: unknown = JSON.parse(bufferOutput);
assert.deepEqual(bufferExpected, {
  nul: [1, 1, 2],
  nulThenB: [1, 1, 3],
  emoji: [1, 4, 5],
  selectorNul: [[1, 1, 2], [1, 1, 2], [1, 1, 2]],
  selectorEmoji: [[1, 4, 5], [1, 4, 5], [1, 4, 5]],
}, 'pinned Neovim real-buffer codepoint spans');
const bufferText = 'a\u0000bx😀y';
for (const [pattern, expectedRange, expectedBytes] of [
  [nulPattern, [1, 2], [1, 2]],
  [nulAndBPattern, [1, 3], [1, 3]],
  [emojiPattern, [4, 6], [4, 8]],
] as const) {
  const actual = findAllMatches(compilePattern(pattern), createPatternTextSnapshot(version, bufferText)).matches[0];
  assert(actual !== undefined, `${pattern}: Xi missed real-buffer code point`);
  assert.deepEqual([actual.start as number, actual.end as number], expectedRange, `${pattern}: UTF-16 snapshot range`);
  assert.equal(utf16ToUtf8(bufferText, actual.start as number), expectedBytes[0], `${pattern}: UTF-8 start byte`);
  assert.equal(utf16ToUtf8(bufferText, actual.end as number), expectedBytes[1], `${pattern}: UTF-8 end byte`);
}
for (const selector of [0, 1, 2] as const) {
  for (const [atom, expectedRange, expectedBytes] of [
    [nulPattern, [1, 2], [1, 2]],
    [emojiPattern, [4, 6], [4, 8]],
  ] as const) {
    const pattern = String.raw`\%#=${selector}` + atom;
    const actual = findAllMatches(compilePattern(pattern), createPatternTextSnapshot(version, bufferText)).matches[0];
    assert(actual !== undefined, `${pattern}: Xi missed selector-specific buffer code point`);
    assert.deepEqual([actual.start as number, actual.end as number], expectedRange, `${pattern}: UTF-16 snapshot range`);
    assert.deepEqual([
      utf16ToUtf8(bufferText, actual.start as number),
      utf16ToUtf8(bufferText, actual.end as number),
    ], expectedBytes, `${pattern}: UTF-8 byte span`);
  }
}

const unicodeBudgetText = `a${acute.repeat(64)}`;
const unicodeSnapshot = createPatternTextSnapshot(version, unicodeBudgetText);
const expectedUnicodeMatch = findAllMatches(compilePattern('.'), unicodeSnapshot);
assert.deepEqual(expectedUnicodeMatch.matches.map((match) => [match.start as number, match.end as number]), [[0, unicodeBudgetText.length]]);
const resumableUnicode = createPatternEvaluation(compilePattern('.'), unicodeSnapshot);
let unicodeProgress = resumableUnicode.resume(1);
let resumeSlices = 1;
while (unicodeProgress.kind === 'pending') {
  unicodeProgress = resumableUnicode.resume(1);
  resumeSlices += 1;
}
assert(resumeSlices > 10, 'composing-cluster evaluation yields cooperatively');
assert.deepEqual(unicodeProgress.result.matches, expectedUnicodeMatch.matches, 'resuming during cluster scan preserves the final match');

function unicodeBudgetFailure(): PatternEvaluationError {
  const session = createPatternEvaluation(compilePattern('.', { stepBudget: 16 }), unicodeSnapshot);
  let failure: unknown;
  try {
    let progress = session.resume(3);
    while (progress.kind === 'pending') progress = session.resume(3);
  } catch (error: unknown) {
    failure = error;
  }
  assert(failure instanceof PatternEvaluationError);
  return failure;
}
const firstUnicodeBudgetFailure = unicodeBudgetFailure();
const secondUnicodeBudgetFailure = unicodeBudgetFailure();
assert.equal(firstUnicodeBudgetFailure.code, 'step-budget-exceeded');
assert.equal(firstUnicodeBudgetFailure.steps, 17);
assert.deepEqual(firstUnicodeBudgetFailure.source, { start: 0, end: 1 });
assert.deepEqual(secondUnicodeBudgetFailure.source, firstUnicodeBudgetFailure.source, 'cluster budget failures retain a deterministic source span');

const cancellableUnicode = createPatternEvaluation(compilePattern('.'), unicodeSnapshot);
assert.equal(cancellableUnicode.resume(2).kind, 'pending');
cancellableUnicode.cancel();
assert.throws(() => cancellableUnicode.resume(1), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'cancelled' && error.source !== undefined,
  'cancellation is checked while consuming a composed cluster',
);

console.log(`PASS T100 pinned Neovim ${manifest.oracle.version} composing probes=${probes.length}; selectors=0/1/2; captures/composed/precomposed/multiple/leading=match`);
console.log(`PASS T100 file-loaded NUL/codepoint byte spans; Xi UTF-16 snapshot spans; raw-byte artifact fixture=${rawBufferBytes.length} bytes`);
console.log(`PASS T100 composing-cluster budget/resume/cancel; resume slices=${resumeSlices}; deterministic failure step=${firstUnicodeBudgetFailure.steps}`);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}

function luaString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function utf16ToUtf8(value: string, offset: number): number {
  return Buffer.byteLength(value.slice(0, offset), 'utf8');
}
