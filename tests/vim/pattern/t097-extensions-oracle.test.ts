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

interface OraclePatternObservation {
  readonly span: readonly [string, number, number];
  readonly captures: readonly string[];
}

interface DifferentialCase {
  readonly id: string;
  readonly lines: readonly string[];
  readonly pattern: string;
}

const version = 97 as DocumentVersion;
const cases: readonly DifferentialCase[] = [
  { id: 'intersection-overlap', lines: ['foobar'], pattern: String.raw`foo\&foobar` },
  { id: 'intersection-capture', lines: ['ab'], pattern: String.raw`\v(a)&ab` },
  { id: 'intersection-no-match', lines: ['foobar'], pattern: String.raw`foo\&bar` },
  { id: 'optional-sequence-greedy', lines: ['read redo r x'], pattern: String.raw`r\%[ead]` },
  { id: 'optional-sequence-classes', lines: ['road'], pattern: String.raw`r\%[[eo]ad]` },
  { id: 'lookahead-positive-capture', lines: ['foobar'], pattern: String.raw`foo\(bar\)\@=` },
  { id: 'lookahead-negative', lines: ['foobaz'], pattern: String.raw`foo\(bar\)\@!` },
  { id: 'lookbehind-variable-width', lines: ['xab'], pattern: String.raw`\v(a|xa)@<=b` },
  { id: 'lookbehind-negative', lines: ['foobar bar'], pattern: String.raw`\(foo\)\@<!bar` },
  { id: 'atomic-no-retry', lines: ['aaab'], pattern: String.raw`\v(a*)@>ab` },
  { id: 'atomic-control-retries', lines: ['aaab'], pattern: String.raw`\v(a*)ab` },
  { id: 'backreference-case-sensitive', lines: ['abcABC'], pattern: String.raw`\v(abc)\1` },
  { id: 'backreference-case-insensitive', lines: ['abcABC'], pattern: String.raw`\c\v(abc)\1` },
  { id: 'engine-auto', lines: ['ab'], pattern: String.raw`\%#=0\v(a|ab)+` },
  { id: 'engine-old', lines: ['ab'], pattern: String.raw`\%#=1\v(a|ab)+` },
  { id: 'engine-nfa', lines: ['ab'], pattern: String.raw`\%#=2\v(a|ab)+` },
  { id: 'engine-auto-posix-upper-ignorecase', lines: ['a'], pattern: String.raw`\%#=0\c[[:upper:]]` },
  { id: 'engine-old-posix-upper-ignorecase', lines: ['a'], pattern: String.raw`\%#=1\c[[:upper:]]` },
  { id: 'engine-nfa-posix-upper-ignorecase', lines: ['a'], pattern: String.raw`\%#=2\c[[:upper:]]` },
  { id: 'engine-old-posix-lower-ignorecase', lines: ['A'], pattern: String.raw`\%#=1\c[[:lower:]]` },
  { id: 'engine-nfa-posix-lower-ignorecase', lines: ['A'], pattern: String.raw`\%#=2\c[[:lower:]]` },
  { id: 'engine-nfa-bounded-backreference', lines: ['aa'], pattern: String.raw`\%#=2\v(a)\1` },
  { id: 'engine-old-forward-reference-lookbehind', lines: ['abc,abc'], pattern: String.raw`\%#=1\1\@<=,\([a-z]\+\)` },
  { id: 'engine-nfa-forward-reference-lookbehind', lines: ['abc,abc'], pattern: String.raw`\%#=2\1\@<=,\([a-z]\+\)` },
  { id: 'codepoint-decimal', lines: ['AA'], pattern: String.raw`\%d65` },
  { id: 'codepoint-hex', lines: ['*'], pattern: String.raw`\%x2a` },
  { id: 'codepoint-octal', lines: [' '], pattern: String.raw`\%o040` },
  { id: 'codepoint-unicode', lines: ['€'], pattern: String.raw`\%u20ac` },
  { id: 'codepoint-large-unicode', lines: ['😀'], pattern: String.raw`\%U1F600` },
  { id: 'combining-ignore-different-and-extra-marks', lines: ['ä́b'], pattern: 'á\\Zb' },
  { id: 'combining-ignore-mark', lines: ['càt'], pattern: String.raw`ca\Zt` },
  { id: 'combining-ignore-trailing-mark', lines: ['á'], pattern: String.raw`a\Z` },
  { id: 'combining-ignore-trailing-mark-end-anchor', lines: ['á'], pattern: String.raw`a\Z$` },
  { id: 'combining-ignore-capture-trailing-mark', lines: ['á'], pattern: String.raw`\(a\)\Z` },
  { id: 'combining-ignore-capture-interior-mark', lines: ['áb'], pattern: String.raw`\(a\)\Zb` },
  { id: 'combining-ignore-leading-text-mark', lines: ['́a'], pattern: String.raw`\Za` },
  { id: 'combining-leading-pattern-mark', lines: ['á'], pattern: '\\Ź' },
  { id: 'combining-leading-pattern-mark-with-following-base', lines: ['áa'], pattern: '\\Źa' },
  { id: 'combining-leading-pattern-mark-needs-attached-base', lines: ['́a'], pattern: '\\Źa' },
  { id: 'combining-atom', lines: ['càt'], pattern: String.raw`ca\%Ct` },
  { id: 'combining-atom-multiple-marks', lines: ['cà́t'], pattern: String.raw`ca\%Ct` },
  { id: 'combining-atom-no-mark', lines: ['cat'], pattern: String.raw`ca\%Ct` },
  { id: 'combining-atom-precomposed-mismatch', lines: ['càt'], pattern: String.raw`ca\%Ct` },
  { id: 'combining-precomposed-does-not-decompose', lines: ['càt'], pattern: String.raw`ca\Zt` },
];

const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
assert.equal(manifest.oracle.version, '0.12.4');
for (const fixture of cases) {
  const sourceText = fixture.lines.join('\n');
  const lua = `local t=table.concat(vim.api.nvim_buf_get_lines(0,0,-1,true),'\\n'); local p=string.char(${luaBytes(fixture.pattern)}); local result={span=vim.fn.matchstrpos(t,p),captures=vim.fn.matchlist(t,p)}; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(result)})`;
  const observation = await runOracleFixture({
    id: `T097-${fixture.id}`,
    title: fixture.id,
    purpose: 'Pinned Neovim 0.12.4 differential for an in-scope advanced Vim pattern behavior.',
    modes: ['normal'],
    lines: fixture.lines,
    steps: [{ label: fixture.id, keys: `:lua ${lua}<CR>` }],
  } satisfies OracleFixture, binaryPath);
  const encoded = observation.snapshots[0]?.lines[0];
  assert(encoded !== undefined, `${fixture.id}: missing oracle observation`);
  const expected = JSON.parse(encoded) as OraclePatternObservation;
  const program = compilePattern(fixture.pattern);
  const result = findAllMatches(program, createPatternTextSnapshot(version, sourceText));
  const actual = result.matches[0];
  if (expected.span[1] < 0) {
    assert.equal(actual, undefined, `${fixture.id}: Xi produced a match rejected by Neovim`);
    continue;
  }
  assert(actual !== undefined, `${fixture.id}: Xi missed Neovim's match ${JSON.stringify(expected.span)}`);
  assert.equal(utf16ToUtf8(sourceText, actual.start as number), expected.span[1], `${fixture.id}: start`);
  assert.equal(utf16ToUtf8(sourceText, actual.end as number), expected.span[2], `${fixture.id}: end`);
  assert.equal(sourceText.slice(actual.start as number, actual.end as number), expected.span[0], `${fixture.id}: matched text`);
  for (let group = 1; group <= 9; group += 1) {
    const capture: CaptureSpan | undefined = actual.captures.get(group);
    const value: string = capture === undefined ? '' : sourceText.slice(capture.start as number, capture.end as number);
    assert.equal(value, expected.captures[group] ?? '', `${fixture.id}: capture ${group}`);
  }
  const expectedEngine = program.engineSelector === 1 || program.features.containsBackreference || program.features.containsLookaround
    || program.features.containsIntersection || program.features.containsOptionalSequence || program.features.containsCombiningAtom
    ? 'backtracking'
    : 'nfa';
  assert.equal(result.engine, expectedEngine, `${fixture.id}: selected Xi execution path`);
}

const bufferLineCases = [
  { id: 'lookbehind-buffer-previous-line', lines: ['abc', 'b'], targetLine: 2, targetByteColumn0: 0, pattern: String.raw`\v(abc\n)@<=b`, expectedPosition: [2, 1] },
  { id: 'lookbehind-buffer-two-lines-rejected', lines: ['a', 'b', 'c'], targetLine: 3, targetByteColumn0: 0, pattern: String.raw`\v(a\nb\n)@<=c`, expectedPosition: [0, 0] },
  { id: 'lookbehind-buffer-numeric-limit-3', lines: ['abc', 'b'], targetLine: 2, targetByteColumn0: 0, pattern: String.raw`\v(abc\n)@3<=b`, expectedPosition: [2, 1] },
  { id: 'lookbehind-buffer-numeric-limit-1', lines: ['abc', 'b'], targetLine: 2, targetByteColumn0: 0, pattern: String.raw`\v(abc\n)@1<=b`, expectedPosition: [0, 0] },
  { id: 'lookbehind-buffer-utf8-limit-rounds-to-scalar', lines: ['éx'], targetLine: 1, targetByteColumn0: 2, pattern: '\\v(é)@1<=x', expectedPosition: [1, 3] },
  { id: 'lookbehind-buffer-utf8-two-scalars-limit-2', lines: ['ééx'], targetLine: 1, targetByteColumn0: 4, pattern: '\\v(éé)@2<=x', expectedPosition: [0, 0] },
  { id: 'lookbehind-buffer-utf8-two-scalars-limit-3', lines: ['ééx'], targetLine: 1, targetByteColumn0: 4, pattern: '\\v(éé)@3<=x', expectedPosition: [1, 5] },
] as const;
for (const fixture of bufferLineCases) {
  const sourceText = fixture.lines.join('\n');
  const lua = `local t=table.concat(vim.api.nvim_buf_get_lines(0,0,-1,true),'\\n'); local p=string.char(${luaBytes(fixture.pattern)}); local result={position=vim.fn.searchpos(p,'cnW'),captures=vim.fn.matchlist(t,p)}; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.fn.json_encode(result)})`;
  const observation = await runOracleFixture({
    id: `T097-${fixture.id}`,
    title: fixture.id,
    purpose: 'Buffer-context lookbehind boundary and numeric-limit oracle; matchstrpos(string) has different line context.',
    modes: ['normal'],
    lines: fixture.lines,
    cursor: { line: fixture.targetLine, byteColumn0: fixture.targetByteColumn0 },
    steps: [{ label: fixture.id, keys: `:lua ${lua}<CR>` }],
  }, binaryPath);
  const encoded = observation.snapshots[0]?.lines[0];
  assert(encoded !== undefined, `${fixture.id}: missing oracle observation`);
  const expected = JSON.parse(encoded) as { readonly position: readonly [number, number]; readonly captures: readonly string[] };
  assert.deepEqual(expected.position, fixture.expectedPosition, `${fixture.id}: pinned buffer search position`);
  const result = findAllMatches(compilePattern(fixture.pattern), createPatternTextSnapshot(version, sourceText));
  const actual = result.matches[0];
  if (fixture.expectedPosition[0] === 0) {
    assert.equal(actual, undefined, `${fixture.id}: Xi accepted a lookbehind outside Vim's buffer line window`);
    continue;
  }
  assert(actual !== undefined, `${fixture.id}: Xi missed the buffer-context oracle match`);
  const expectedStart = sourceText.split('\n').slice(0, fixture.expectedPosition[0] - 1).reduce((length, line) => length + line.length + 1, 0)
    + byteColumnToUtf16(fixture.lines[fixture.expectedPosition[0] - 1] ?? '', fixture.targetByteColumn0);
  assert.equal(actual.start as number, expectedStart, `${fixture.id}: start offset`);
}

const forwardReference = String.raw`\%#=1\1\@<=,\([a-z]\+\)`;
const forwardText = 'abc,abc';
const forward = findAllMatches(compilePattern(forwardReference), createPatternTextSnapshot(version, forwardText)).matches[0];
assert(forward !== undefined, 'lookbehind may reference a capture established by the following concat');
assert.deepEqual([forward.start as number, forward.end as number], [3, 7]);
assert.equal(forwardText.slice(forward.captures.get(1)?.start as number, forward.captures.get(1)?.end as number), 'abc');

for (const invalid of [
  { source: String.raw`\%#=3`, code: 'invalid-pattern' },
  { source: String.raw`\%d`, code: 'invalid-pattern' },
  { source: String.raw`\%U110000`, code: 'invalid-pattern' },
  { source: String.raw`\z(foo)`, code: 'unsupported-construct' },
]) {
  assert.throws(() => compilePattern(invalid.source), (error: unknown) =>
    error instanceof PatternEvaluationError && error.code === invalid.code && error.source !== undefined,
    `syntax failure must retain source span: ${invalid.source}`,
  );
}

const explosionSource = String.raw`\v((a|aa)+)\1b`;
const explosionText = 'a'.repeat(32);
const budgetFailure = (stepBudget: number) => {
  const session = createPatternEvaluation(
    compilePattern(explosionSource, { stepBudget }),
    createPatternTextSnapshot(version, explosionText),
  );
  let error: unknown;
  try {
    let progress = session.resume(11);
    while (progress.kind === 'pending') progress = session.resume(11);
  } catch (caught: unknown) {
    error = caught;
  }
  assert(error instanceof PatternEvaluationError);
  return error;
};
const firstBudgetFailure = budgetFailure(2_000);
const secondBudgetFailure = budgetFailure(2_000);
assert.equal(firstBudgetFailure.code, 'step-budget-exceeded');
assert.equal(firstBudgetFailure.steps, 2_001);
assert.deepEqual(firstBudgetFailure.source, secondBudgetFailure.source);
assert.equal(secondBudgetFailure.steps, firstBudgetFailure.steps);

const backtrackingSource = String.raw`\v(a)\1`;
const backtrackingText = 'aaaa';
const expectedBacktracking = findAllMatches(
  compilePattern(backtrackingSource),
  createPatternTextSnapshot(version, backtrackingText),
);
assert.throws(() => createPatternEvaluation(
  compilePattern(backtrackingSource, { outputLimit: 1 }),
  createPatternTextSnapshot(version, backtrackingText),
).resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'output-limit-exceeded' && error.source !== undefined,
  'fallback output limits fail explicitly with the root source span',
);
const resumableBacktracking = createPatternEvaluation(
  compilePattern(backtrackingSource),
  createPatternTextSnapshot(version, backtrackingText),
);
let backtrackingProgress = resumableBacktracking.resume(2);
assert.equal(backtrackingProgress.kind, 'pending', 'backtracking fallback yields cooperatively');
while (backtrackingProgress.kind === 'pending') backtrackingProgress = resumableBacktracking.resume(2);
assert.equal(backtrackingProgress.result.engine, 'backtracking');
assert.deepEqual(backtrackingProgress.result.matches, expectedBacktracking.matches, 'resuming fallback preserves results');

const cancellableBacktracking = createPatternEvaluation(
  compilePattern(backtrackingSource),
  createPatternTextSnapshot(version, backtrackingText),
);
assert.equal(cancellableBacktracking.resume(2).kind, 'pending');
cancellableBacktracking.cancel();
assert.throws(() => cancellableBacktracking.resume(1), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'cancelled' && error.source !== undefined,
  'cancellation is checked inside bounded backtracking work',
);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}

function utf16ToUtf8(value: string, offset: number): number {
  return Buffer.byteLength(value.slice(0, offset), 'utf8');
}

function byteColumnToUtf16(value: string, byteColumn0: number): number {
  let bytes = 0;
  let utf16 = 0;
  for (const scalar of value) {
    if (bytes === byteColumn0) break;
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > byteColumn0) throw new Error('oracle-column-splits-utf8-scalar');
    bytes += scalarBytes;
    utf16 += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('oracle-column-out-of-range');
  return utf16;
}

console.log(`PASS T097 pinned Neovim ${manifest.oracle.version} extension fixtures=${cases.length}, backreference-budget=deterministic, fallback-resume-cancel=pass`);
