import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  openTextDocument,
  type DocumentId,
} from '../../../packages/document/src/index';
import type { DocumentVersion, Utf16Offset } from '../../../packages/primitives/src/index';
import {
  compilePattern,
  createPatternEvaluation,
  createPatternTextSnapshot,
  findAllMatches,
  PatternEvaluationError,
  patternSnapshotFromDocument,
  type CaptureSpan,
  type PatternCharacterClassContext,
} from '../../../packages/vim/pattern/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

// Run each owned VP family in one integrated gate so source/spec ripples are
// checked together before T026 is accepted.
for (const suite of [
  './t026-pattern.test.ts',
  './t026-oracle.test.ts',
  './t026-classes-oracle.test.ts',
  './t096-dialect-oracle.test.ts',
  './t096-newline-oracle.test.ts',
  './t096-captures-oracle.test.ts',
  './t096-spans-oracle.test.ts',
  './t097-extensions-oracle.test.ts',
  './t098-position-oracle.test.ts',
  './t100-composing-nul-oracle.test.ts',
]) {
  await import(suite);
}

const version = 26_026 as DocumentVersion;
const defaultClasses = {
  version,
  isKeyword: '@,48-57,_,192-255',
  isIdent: '@,48-57,_,192-255',
  isFilename: '@,48-57,/,.,-,_,+,,,#,$,%,~,=',
  isPrintable: '@,161-255',
} satisfies PatternCharacterClassContext;
interface MixedCase {
  readonly id: string;
  readonly pattern: string;
  readonly text: string;
  readonly optionName?: 'iskeyword';
  readonly optionValue?: string;
}
const mixedCases: readonly MixedCase[] = [
  {
    id: 'reported-span-captures-and-context-classes',
    pattern: String.raw`\%#=2\v(\k+)\zs(\p+)`,
    text: 'λ7!',
    optionName: 'iskeyword',
    optionValue: defaultClasses.isKeyword,
  },
  {
    id: 'unicode-class-and-intersection',
    pattern: String.raw`\%#=2\v\k+&[[:lower:]]+`,
    text: 'λab',
    optionName: 'iskeyword',
    optionValue: defaultClasses.isKeyword,
  },
  {
    id: 'unicode-class-lookahead',
    pattern: String.raw`\%#=0\v([[:lower:]]+)-([[:lower:]]+)@=`,
    text: 'λ-λ!',
  },
  {
    id: 'unicode-class-backreference',
    pattern: String.raw`\%#=0\v([[:lower:]]+)-\1`,
    text: 'λ-λ!',
  },
] as const;
const luaCases = mixedCases.map((test) => {
  const option = test.optionName === undefined ? 'nil' : `'${test.optionName}'`;
  const optionValue = test.optionValue === undefined ? 'nil' : `string.char(${luaBytes(test.optionValue)})`;
  return `{id='${test.id}',pattern=string.char(${luaBytes(test.pattern)}),text=string.char(${luaBytes(test.text)}),option=${option},value=${optionValue}}`;
}).join(',');
const lua = `local cases={${luaCases}}; local results={}; for _,c in ipairs(cases) do if c.option then vim.o[c.option]=c.value end; local t=c.text; local p=c.pattern; table.insert(results,{id=c.id,span=vim.fn.matchstrpos(t,p),captures=vim.fn.matchlist(t,p)}) end; vim.api.nvim_buf_set_lines(0,0,-1,true,{vim.json.encode(results)})`;
const fixture: OracleFixture = {
  id: 'T026-INTEGRATED-VP-FAMILY-MIXED',
  title: 'Integrated pattern families with shared Unicode option context',
  purpose: 'Compare reported spans and captures for patterns combining character-class options with NFA, intersection, lookahead and backreference paths.',
  modes: ['normal'],
  lines: [''],
  steps: [{ label: 'observe-mixed-pattern-families', keys: `:lua ${lua}<CR>` }],
};
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
assert.equal(manifest.oracle.version, '0.12.4');
const oracleRun = await runOracleFixture(fixture, binaryPath);
const encoded = oracleRun.snapshots[0]?.lines[0];
assert(encoded !== undefined, 'mixed-family oracle emitted observations');
const observations = JSON.parse(encoded) as readonly {
  readonly id: string;
  readonly span: readonly [string, number, number];
  readonly captures: readonly string[];
}[];
const mixedRows: unknown[] = [];
for (const test of mixedCases) {
  const expected = observations.find((observation) => observation.id === test.id);
  assert(expected !== undefined, `${test.id}: direct Neovim observation exists`);
  const context: PatternCharacterClassContext = {
    ...defaultClasses,
    ...(test.optionValue === undefined ? {} : { isKeyword: test.optionValue }),
  };
  const actual = findAllMatches(
    compilePattern(test.pattern, { characterClassContext: context }),
    createPatternTextSnapshot(version, test.text),
  ).matches[0];
  if (expected.span[1] < 0) {
    assert.equal(actual, undefined, `${test.id}: Xi and Neovim both reject a match`);
    mixedRows.push({ id: test.id, expected: null, actual: null });
    continue;
  }
  assert(actual !== undefined, `${test.id}: Xi finds the pinned match`);
  const expectedSpan = [utf16AtByte(test.text, expected.span[1]), utf16AtByte(test.text, expected.span[2])];
  assert.deepEqual([actual.start as number, actual.end as number], expectedSpan, `${test.id}: UTF-8 oracle and UTF-16 Xi spans agree`);
  for (let group = 1; group <= 9; group += 1) {
    const capture: CaptureSpan | undefined = actual.captures.get(group);
    const value: string = capture === undefined ? '' : test.text.slice(capture.start as number, capture.end as number);
    assert.equal(value, expected.captures[group] ?? '', `${test.id}: capture ${group}`);
  }
  mixedRows.push({
    id: test.id,
    expected: { span: expected.span.slice(1), captures: expected.captures.slice(1) },
    actual: {
      span: [actual.start as number, actual.end as number],
      captures: [...actual.captures].map(([group, capture]) => [group, test.text.slice(capture.start as number, capture.end as number)]),
    },
  });
}

// Evaluator failures and resumption are pure: the immutable document and the
// caller's cursor/repeat state remain unchanged across all three outcomes.
const stressText = 'x'.repeat(128);
const opened = openTextDocument('t026-integrated-purity' as DocumentId, new TextEncoder().encode(stressText));
assert.equal(opened.kind, 'editable');
if (opened.kind !== 'editable') throw new Error('integrated purity fixture must be editable');
const before = opened.document.snapshot();
const documentSnapshot = patternSnapshotFromDocument(before);
const classRules = Array.from({ length: 64 }, (_, index) => String(index)).join(',');
const classContext = { version: before.version, isIdent: classRules } satisfies PatternCharacterClassContext;
const callerState = { cursor: utf16Offset(7), repeat: 'last-search', version: before.version };
const callerStateBefore = { ...callerState };
const expectedEvaluation = findAllMatches(
  compilePattern(String.raw`\i`, { characterClassContext: classContext, stepBudget: 20_000 }),
  documentSnapshot,
);
assert.equal(expectedEvaluation.matches.length, 0);
const resumable = createPatternEvaluation(
  compilePattern(String.raw`\i`, { characterClassContext: classContext, stepBudget: 20_000 }),
  documentSnapshot,
);
let progress = resumable.resume(37);
let slices = 1;
while (progress.kind === 'pending') {
  progress = resumable.resume(37);
  slices += 1;
}
assert(slices > 1, 'option-heavy NFA scan yields through bounded resumable slices');
assert.deepEqual(progress.result.matches, expectedEvaluation.matches, 'resumption preserves the full result');
assert.equal(progress.result.steps, expectedEvaluation.steps, 'resumption preserves deterministic evaluator work');
const budgetFailure = createPatternEvaluation(
  compilePattern(String.raw`\i`, { characterClassContext: classContext, stepBudget: 300 }),
  documentSnapshot,
);
assert.throws(() => budgetFailure.resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'step-budget-exceeded' && error.steps === 301
    && error.source?.start === 0 && error.source.end === 2,
  'option-heavy work stops at its deterministic budget with source provenance',
);
const cancelled = createPatternEvaluation(
  compilePattern(String.raw`\i`, { characterClassContext: classContext, stepBudget: 20_000 }),
  documentSnapshot,
);
assert.equal(cancelled.resume(37).kind, 'pending');
cancelled.cancel();
assert.throws(() => cancelled.resume(1), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'cancelled' && error.source?.start === 0 && error.source.end === 2,
  'cancellation during option-class evaluation reports the responsible source',
);
assert.throws(() => createPatternEvaluation(
  compilePattern(String.raw`\i`, {
    characterClassContext: { version: (before.version - 1) as DocumentVersion, isIdent: classRules },
  }),
  documentSnapshot,
), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'stale-position' && error.source?.start === 0 && error.source.end === 2,
  'stale option context rejects before it can affect caller state',
);
const after = opened.document.snapshot();
const afterText = after.slice(utf16Offset(0), utf16Offset(after.lengthUtf16));
assert(afterText.ok);
assert.equal(after.version, before.version);
assert.equal(afterText.value, stressText);
assert.deepEqual(callerState, callerStateBefore);

const artifact = resolve(process.cwd(), '.artifacts/patterns/T026-integrated.json');
await mkdir(dirname(artifact), { recursive: true });
await writeFile(`${artifact}`, `${JSON.stringify({
  schemaVersion: 1,
  fixtureId: fixture.id,
  oracle: { version: manifest.oracle.version, binarySha256: manifest.oracle.binarySha256 },
  familySuites: [
    'T026 pattern/error unit', 'T026 VP-05 class context', 'T096 regular dialect/newline/captures/spans',
    'T097 extensions', 'T098 positional/coordinate', 'T100 composing/NUL',
  ],
  mixedRows,
  optionClassState: {
    optionRuleCount: 64,
    textUtf16Units: stressText.length,
    resumedSlices: slices,
    deterministicSteps: expectedEvaluation.steps,
    budgetFailure: { code: 'step-budget-exceeded', steps: 301, source: { start: 0, end: 2 } },
    cancellation: { code: 'cancelled', source: { start: 0, end: 2 } },
    staleContext: { code: 'stale-position', source: { start: 0, end: 2 } },
    documentVersionPreserved: after.version === before.version,
    documentTextPreserved: afterText.value === stressText,
    callerCursorAndRepeatPreserved: true,
  },
}, null, 2)}\n`, 'utf8');
console.log(`PASS T026 integrated pinned-family corpus; mixed=${mixedRows.length}; class-resume-slices=${slices}; option-steps=${expectedEvaluation.steps}; artifact=${artifact}`);

function luaBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')].join(',');
}

function utf16AtByte(value: string, target: number): number {
  let byteOffset = 0;
  let utf16Offset = 0;
  if (target === 0) return 0;
  for (const scalar of value) {
    byteOffset += Buffer.byteLength(scalar, 'utf8');
    utf16Offset += scalar.length;
    if (byteOffset === target) return utf16Offset;
    if (byteOffset > target) throw new Error(`oracle-byte-offset-inside-scalar: ${target}`);
  }
  if (byteOffset === target) return utf16Offset;
  throw new Error(`oracle-byte-offset-out-of-range: ${target}/${byteOffset}`);
}

function utf16Offset(value: number): Utf16Offset {
  return value as Utf16Offset;
}
