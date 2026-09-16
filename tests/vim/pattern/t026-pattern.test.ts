import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  compilePattern,
  createPatternEvaluation,
  createPatternTextSnapshot,
  findAllMatches,
  PatternEvaluationError,
  patternSnapshotFromDocument,
  substituteAll,
} from '../../../packages/vim/pattern/index';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentVersion, Utf16Offset } from '../../../packages/primitives/src/index';

interface FixtureCase {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly pattern: string;
  readonly replacement: string;
  readonly expectedLines: readonly string[];
  readonly cursor?: { readonly line: number; readonly byteColumn0: number };
}

interface SafetyFixture {
  readonly id: string;
  readonly pattern: string;
  readonly textPrefix?: string;
  readonly textLength?: number;
  readonly suffix?: string;
  readonly stepBudget?: number;
  readonly expectedCode?: string;
  readonly lines?: readonly string[];
  readonly expectedOffsets?: readonly number[];
  readonly maximumMatches?: number;
}

interface FixtureDocument {
  readonly schemaVersion: number;
  readonly oracle: { readonly name: string; readonly version: string };
  readonly cases: readonly FixtureCase[];
  readonly safetyFixtures: readonly SafetyFixture[];
}

const version = 1 as DocumentVersion;
const fixturePath = resolve(process.cwd(), 'tests/fixtures/vim/T005-pattern-cases.json');
const fixtures: FixtureDocument = JSON.parse(await readFile(fixturePath, 'utf8')) as FixtureDocument;
assert.equal(fixtures.schemaVersion, 1);
assert.deepEqual(fixtures.oracle, { name: 'Neovim', version: '0.12.4' });

const caseText = createPatternTextSnapshot(version, 'FOO foo');
assert.equal(findAllMatches(compilePattern('foo', { ignoreCase: true }), caseText).matches.length, 2);
assert.equal(findAllMatches(compilePattern('Foo', { ignoreCase: true, smartCase: true }), caseText).matches.length, 0);
assert.equal(findAllMatches(compilePattern(String.raw`\cFoo`, { ignoreCase: true, smartCase: true }), caseText).matches.length, 2);
assert.equal(findAllMatches(compilePattern(String.raw`\CFoo`, { ignoreCase: true, smartCase: true }), caseText).matches.length, 0);

let corpusMatches = 0;
for (const fixture of fixtures.cases) {
  const text = fixture.lines.join('\n');
  const cursor = fixture.cursor === undefined ? undefined : cursorOffset(text, fixture.cursor.line, fixture.cursor.byteColumn0);
  const program = compilePattern(fixture.pattern, cursor === undefined
    ? {}
    : { cursor: { version, offset: cursor as Utf16Offset } });
  const result = substituteAll(program, createPatternTextSnapshot(version, text), fixture.replacement);
  assert.deepEqual(result.text.split('\n'), fixture.expectedLines, fixture.id);
  assert.equal(result.snapshotVersion, version, fixture.id);
  assert.equal(result.engine, program.features.containsBackreference || program.features.containsLookaround ? 'backtracking' : 'nfa', fixture.id);
  corpusMatches += 1;
}

for (const fixture of fixtures.safetyFixtures) {
  if (fixture.expectedCode === 'step-budget-exceeded') {
    const text = `${fixture.textPrefix?.repeat(fixture.textLength ?? 0) ?? ''}${fixture.suffix ?? ''}`;
    const session = createPatternEvaluation(
      compilePattern(fixture.pattern, fixture.stepBudget === undefined ? {} : { stepBudget: fixture.stepBudget }),
      createPatternTextSnapshot(version, text),
    );
    if (fixture.id === 'PATT-CATASTROPHIC-01') {
      const progress = session.resume(Number.MAX_SAFE_INTEGER);
      assert.equal(progress.kind, 'complete', `${fixture.id}: regular catastrophic backtracking case must complete on the NFA path`);
      if (progress.kind === 'complete') {
        assert.equal(progress.result.engine, 'nfa');
        assert.equal(progress.result.matches.length, 0);
        assert(progress.result.steps <= (fixture.stepBudget ?? 0));
      }
      continue;
    }
    assert.throws(() => session.resume(Number.MAX_SAFE_INTEGER), (error: unknown) => {
      assert(error instanceof PatternEvaluationError);
      assert.equal(error.code, fixture.expectedCode);
      assert(error.source !== undefined);
      assert(error.steps <= (fixture.stepBudget ?? 0) + 1);
      return true;
    }, fixture.id);
    continue;
  }
  if (fixture.expectedCode === 'unsupported-construct') {
    if (fixture.id === 'PATT-UNSUPPORTED-ENGINE-01') {
      const program = compilePattern(fixture.pattern);
      assert.equal(program.engineSelector, 2, `${fixture.id}: selector 2 is now implemented`);
      findAllMatches(program, createPatternTextSnapshot(version, ''));
      continue;
    }
    assert.throws(() => compilePattern(fixture.pattern), (error: unknown) => {
      assert(error instanceof PatternEvaluationError);
      assert.equal(error.code, fixture.expectedCode);
      assert(error.source !== undefined);
      assert(error.source.start >= 0 && error.source.end > error.source.start && error.source.end <= fixture.pattern.length);
      return true;
    }, fixture.id);
    continue;
  }
  if (fixture.expectedOffsets !== undefined && fixture.lines !== undefined) {
    const matches = findAllMatches(
      compilePattern(fixture.pattern, fixture.maximumMatches === undefined ? {} : { outputLimit: fixture.maximumMatches }),
      createPatternTextSnapshot(version, fixture.lines.join('\n')),
    ).matches;
    assert.deepEqual(matches.map((match) => match.start as number), fixture.expectedOffsets, fixture.id);
    continue;
  }
  throw new Error(`unhandled-safety-fixture:${fixture.id}`);
}

const resumableText = createPatternTextSnapshot(version, 'ab'.repeat(128));
const resumableProgram = compilePattern(String.raw`\v(a|ab)+`);
const resumable = createPatternEvaluation(resumableProgram, resumableText);
let resumableSteps = 0;
let progress = resumable.resume(7);
while (progress.kind === 'pending') {
  assert(resumable.steps - resumableSteps <= 7, 'one resume slice exceeded its work-unit limit');
  resumableSteps = resumable.steps;
  progress = resumable.resume(7);
}
const synchronous = findAllMatches(resumableProgram, resumableText);
assert.deepEqual(progress.result.matches, synchronous.matches);
assert.equal(progress.result.steps, synchronous.steps);
assert.equal(progress.result.engine, 'nfa');

const zeroWidthRepeatPattern = compilePattern(String.raw`\v(a?)*b`);
const zeroWidthRepeatSnapshot = createPatternTextSnapshot(version, 'aab b');
const zeroWidthRepeatMatches = findAllMatches(zeroWidthRepeatPattern, zeroWidthRepeatSnapshot).matches;
assert.deepEqual(zeroWidthRepeatMatches.map((match) => [match.start as number, match.end as number]), [[0, 3], [4, 5]]);
assert.equal(substituteAll(zeroWidthRepeatPattern, zeroWidthRepeatSnapshot, 'X').text, 'X X');

const backreferenceExplosion = createPatternEvaluation(
  compilePattern(String.raw`\v((a|aa)+)\1b`, { stepBudget: 2_000 }),
  createPatternTextSnapshot(version, 'a'.repeat(32)),
);
assert.throws(() => backreferenceExplosion.resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'step-budget-exceeded' && error.steps === 2_001 && error.source !== undefined,
);

const boundedDocument = openTextDocument(
  'pattern-budget-document' as import('../../../packages/primitives/src/index').DocumentId,
  new TextEncoder().encode('a'.repeat(32)),
);
assert.equal(boundedDocument.kind, 'editable');
if (boundedDocument.kind !== 'editable') throw new Error('pattern-budget-fixture-opened-read-only');
const boundedDocumentBefore = boundedDocument.document.snapshot();
const boundedDocumentText = boundedDocumentBefore.slice(0 as Utf16Offset, boundedDocumentBefore.lengthUtf16 as Utf16Offset);
assert(boundedDocumentText.ok);
const boundedDocumentSession = createPatternEvaluation(
  compilePattern(String.raw`\v(a+)+b`, { stepBudget: 128 }),
  patternSnapshotFromDocument(boundedDocumentBefore),
);
assert.throws(() => boundedDocumentSession.resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'step-budget-exceeded',
);
const boundedDocumentAfter = boundedDocument.document.snapshot();
const boundedDocumentAfterText = boundedDocumentAfter.slice(0 as Utf16Offset, boundedDocumentAfter.lengthUtf16 as Utf16Offset);
assert(boundedDocumentAfterText.ok);
assert.equal(boundedDocumentAfter.version, boundedDocumentBefore.version, 'timeout cannot commit a text version');
assert.equal(boundedDocumentAfterText.value, boundedDocumentText.value, 'timeout cannot alter document text');
const cursorContext = { version: boundedDocumentBefore.version, offset: 0 as Utf16Offset };
const cursorContextBefore = { ...cursorContext };
const cursorBudgetSession = createPatternEvaluation(
  compilePattern(String.raw`\%#\v(a+)+b`, { cursor: cursorContext, stepBudget: 128 }),
  patternSnapshotFromDocument(boundedDocumentBefore),
);
assert.throws(() => cursorBudgetSession.resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'step-budget-exceeded',
);
assert.deepEqual(cursorContext, cursorContextBefore, 'timeout cannot mutate the caller-owned cursor context');

for (const invalidOptions of [{ stepBudget: 0 }, { outputLimit: Number.MAX_SAFE_INTEGER }, { cancellationCheckInterval: 8_192 }]) {
  assert.throws(() => compilePattern('a', invalidOptions), (error: unknown) =>
    error instanceof PatternEvaluationError && error.code === 'invalid-pattern' && error.source !== undefined,
  );
}

const regularBudget = createPatternEvaluation(
  compilePattern(String.raw`\v(a|aa)*b`, { stepBudget: 12 }),
  createPatternTextSnapshot(version, 'a'.repeat(8)),
);
assert.throws(() => regularBudget.resume(Number.MAX_SAFE_INTEGER), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'step-budget-exceeded' && error.steps === 13 && error.source !== undefined,
  'regular NFA work must stop at a deterministic typed budget error',
);
assert.throws(() => createPatternEvaluation(
  compilePattern(String.raw`a\{4097}`),
  createPatternTextSnapshot(version, 'a'),
), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'program-limit-exceeded' && error.source !== undefined,
  'oversized regular programs must fail explicitly before evaluation',
);
assert.throws(() => findAllMatches(
  compilePattern('a', { outputLimit: 1 }),
  createPatternTextSnapshot(version, 'a a'),
), (error: unknown) => error instanceof PatternEvaluationError && error.code === 'output-limit-exceeded' && error.source !== undefined);

let cancellationChecks = 0;
const cancellable = createPatternEvaluation(
  compilePattern(String.raw`\v(a+)+b`, { cancellationCheckInterval: 4, shouldCancel: () => { cancellationChecks += 1; return false; } }),
  createPatternTextSnapshot(version, 'a'.repeat(32)),
);
const beforeCancel = cancellable.resume(4);
assert.equal(beforeCancel.kind, 'pending');
cancellable.cancel();
assert.throws(() => cancellable.resume(1), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'cancelled' && error.steps === 5,
);
assert.equal(cancellationChecks, 1, 'program cancellation predicate is polled at the configured interval');

const staleCursorProgram = compilePattern(String.raw`\%#`, { cursor: { version, offset: 1 as Utf16Offset } });
assert.throws(
  () => createPatternEvaluation(staleCursorProgram, createPatternTextSnapshot(2 as DocumentVersion, 'abc')),
  (error: unknown) => error instanceof PatternEvaluationError && error.code === 'stale-position',
);
assert.throws(() => findAllMatches(compilePattern(String.raw`\%#`), createPatternTextSnapshot(version, 'abc')),
  (error: unknown) => error instanceof PatternEvaluationError && error.code === 'unsupported-construct');

const astral = findAllMatches(compilePattern('😀'), createPatternTextSnapshot(version, 'a😀b')).matches[0];
assert(astral !== undefined);
assert.equal(astral.start as number, 1, 'match offsets count UTF-16 code units');
assert.equal(astral.end as number, 3);
const astralDot = findAllMatches(compilePattern('.'), createPatternTextSnapshot(version, '😀')).matches[0];
assert(astralDot !== undefined);
assert.equal(astralDot.end as number, 2, 'dot consumes one Unicode scalar without splitting a surrogate pair');

const modeCases = [
  { pattern: '.', magic: true, text: 'x.', expected: [0, 1] },
  { pattern: String.raw`\.`, magic: true, text: 'x.', expected: [1, 2] },
  { pattern: '.', magic: false, text: 'x.', expected: [1, 2] },
  { pattern: String.raw`\.`, magic: false, text: 'x.', expected: [0, 1] },
  { pattern: '[ab]', magic: true, text: 'xaz', expected: [1, 2] },
  { pattern: String.raw`\[ab]`, magic: false, text: 'xaz', expected: [1, 2] },
  { pattern: String.raw`a\+b`, magic: true, text: 'aaab', expected: [0, 4] },
  { pattern: 'a+b', magic: true, text: 'a+b', expected: [0, 3] },
  { pattern: String.raw`a\*b`, magic: false, text: 'aaab', expected: [0, 4] },
  { pattern: 'a*b', magic: false, text: 'a*b', expected: [0, 3] },
  { pattern: String.raw`\v(a|ab)+`, magic: true, text: 'ab', expected: [0, 1] },
  { pattern: String.raw`\V(a|ab)+`, magic: true, text: '(a|ab)+', expected: [0, 7] },
];
for (const fixture of modeCases) {
  const matches = findAllMatches(
    compilePattern(fixture.pattern, { magic: fixture.magic }),
    createPatternTextSnapshot(version, fixture.text),
  ).matches;
  assert.deepEqual(matches[0] === undefined ? undefined : [matches[0].start as number, matches[0].end as number], fixture.expected, `T096-MAGIC-${fixture.pattern}`);
}
const caseInsensitiveClass = findAllMatches(
  compilePattern('[a]', { ignoreCase: true }),
  createPatternTextSnapshot(version, 'A a'),
).matches;
assert.deepEqual(caseInsensitiveClass.map((match) => match.start as number), [2], 'Vim character classes ignore \c/ignorecase directives');
const posixAlpha = findAllMatches(compilePattern(String.raw`[[:alpha:]]\+`), createPatternTextSnapshot(version, '42Ab!')).matches[0];
assert(posixAlpha !== undefined);
assert.deepEqual([posixAlpha.start as number, posixAlpha.end as number], [2, 4]);
const builtinClasses = findAllMatches(compilePattern(String.raw`\v\h\w*`), createPatternTextSnapshot(version, '_name42')).matches[0];
assert(builtinClasses !== undefined);
assert.deepEqual([builtinClasses.start as number, builtinClasses.end as number], [0, 7]);

const mutableSnapshot = { version, text: 'before' };
const defensive = createPatternEvaluation(compilePattern('before'), mutableSnapshot);
mutableSnapshot.text = 'after';
mutableSnapshot.version = 2 as DocumentVersion;
const defensiveResult = defensive.resume(Number.MAX_SAFE_INTEGER);
assert.equal(defensiveResult.kind, 'complete');
if (defensiveResult.kind === 'complete') {
  assert.equal(defensiveResult.result.snapshotVersion, version);
  assert.equal(defensiveResult.result.matches.length, 1);
}

const opened = openTextDocument('pattern-snapshot' as import('../../../packages/primitives/src/index').DocumentId, new TextEncoder().encode('café😀\nsecond'));
assert.equal(opened.kind, 'editable');
if (opened.kind !== 'editable') throw new Error('unicode-fixture-opened-read-only');
const documentSnapshot = opened.document.snapshot();
const patternSnapshot = patternSnapshotFromDocument(documentSnapshot);
const unicodeProgram = compilePattern('😀');
const unicodeMatch = findAllMatches(unicodeProgram, patternSnapshot).matches[0];
assert(unicodeMatch !== undefined);
assert.equal(unicodeMatch.start as number, 4, 'document-backed evaluator uses UTF-16 offsets');
assert.equal(unicodeMatch.end as number, 6);
assert.equal(unicodeMatch.captures.size, 0);
const indexedLineMatch = findAllMatches(compilePattern(String.raw`\%2lsecond`), patternSnapshot).matches[0];
assert(indexedLineMatch !== undefined);
assert.equal(indexedLineMatch.start as number, 7, 'document-backed line atoms use the indexed versioned line lookup');

for (const unsupported of [String.raw`\z(foo)`]) {
  assert.throws(() => compilePattern(unsupported), (error: unknown) =>
    error instanceof PatternEvaluationError && error.code === 'unsupported-construct' && error.source !== undefined,
    `unsupported syntax must retain a source span: ${unsupported}`,
  );
}
assert.throws(() => findAllMatches(compilePattern(String.raw`\%V`), createPatternTextSnapshot(version, 'abc')), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'unsupported-construct' && error.source !== undefined,
  'visual-position syntax compiles but missing snapshot-bound selection context fails explicitly at evaluation',
);

console.log(`PASS T096 pattern evaluator corpus=${corpusMatches}/${fixtures.cases.length} regular NFA/backreference fallback/output+work budgets/resumability/cancellation/version/unicode=pass`);

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
  let priorLineLength = 0;
  for (let index = 0; index < oneBasedLine - 1; index += 1) priorLineLength += (lines[index] ?? '').length + 1;
  return priorLineLength + utf16;
}
