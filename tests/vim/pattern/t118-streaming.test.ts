import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import {
  compilePattern,
  createPatternEvaluation,
  findAllMatches,
  patternSnapshotFromDocument,
  PatternEvaluationError,
} from '../../../packages/vim/pattern/index';

const idResult = asIdentifier<DocumentId>('T118-streaming', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function open(value: string): DocumentSnapshot {
  const opened = openTextDocument(documentId, new TextEncoder().encode(value));
  if (opened.kind !== 'editable') throw new Error(`expected-editable:${opened.kind}`);
  return opened.document.snapshot();
}

function observe(snapshot: DocumentSnapshot): { readonly snapshot: DocumentSnapshot; readonly reads: readonly number[] } {
  const reads: number[] = [];
  const observed = new Proxy(snapshot, {
    get(target, property) {
      if (property === 'slice') {
        return (start: Utf16Offset, end: Utf16Offset) => {
          reads.push((end as number) - (start as number));
          return target.slice(start, end);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as DocumentSnapshot;
  return { snapshot: observed, reads };
}

const source = 'x'.repeat(4 * 1024 * 1024);
const base = open(source);
const observed = observe(base);
const program = compilePattern('z', { stepBudget: 20_000_000, cancellationCheckInterval: 4096 });
const evaluation = createPatternEvaluation(program, patternSnapshotFromDocument(observed.snapshot));
const result = evaluation.resume(Number.MAX_SAFE_INTEGER);
assert.equal(result.kind, 'complete', 'T118-SEARCH-STREAM-01 no-match scan completes');
if (result.kind !== 'complete') throw new Error('streaming scan did not complete');
assert.equal(result.result.matches.length, 0, 'T118-SEARCH-STREAM-02 no-match remains a no-match');
assert.ok(observed.reads.length > 1, 'T118-SEARCH-STREAM-03 document was read in multiple chunks');
assert.ok(Math.max(...observed.reads) <= 64 * 1024,
  `T118-SEARCH-STREAM-04 largest document read was ${Math.max(...observed.reads)} UTF-16 units`);
// The fast ASCII literal path charges one step per bounded native `indexOf`
// probe (at most FAST_SCAN_BATCH=4096 UTF-16 units per probe), not one step
// per unit skipped, so a fully sparse/no-match scan is charged roughly
// `source.length / 4096` steps instead of `source.length` steps. This keeps
// long, mostly-empty searches (e.g. a single match at the end of a
// multi-MiB document) well inside the default step budget while still
// counting real, bounded work and yielding at the same cadence as before.
assert.ok(evaluation.steps > 0, 'T118-SEARCH-STREAM-05 failed candidate work is still counted');
assert.ok(
  evaluation.steps <= Math.ceil(source.length / 1024),
  `T118-SEARCH-STREAM-05 bounded indexOf probes should cost far fewer steps than UTF-16 units scanned, got ${evaluation.steps} steps for ${source.length} units`,
);

let cancelled = false;
const cancellable = createPatternEvaluation(
  compilePattern('z', { stepBudget: 20_000_000, cancellationCheckInterval: 64, shouldCancel: () => cancelled }),
  patternSnapshotFromDocument(base),
);
assert.equal(cancellable.resume(256).kind, 'pending', 'T118-SEARCH-CANCEL-01 evaluation yields before completion');
cancelled = true;
assert.throws(() => cancellable.resume(256), (error: unknown) =>
  error instanceof PatternEvaluationError && error.code === 'cancelled' && error.steps > 0,
  'T118-SEARCH-CANCEL-02 cancellation is typed and observed at a work boundary');

const small = findAllMatches(compilePattern('x'), patternSnapshotFromDocument(open('x')));
assert.equal(small.matches.length, 1, 'T118-SEARCH-SEMANTICS-01 document-backed snapshots preserve ordinary matches');
console.log(`T118 streaming evaluator passed no-match reads=${observed.reads.length}, maxRead=${Math.max(...observed.reads)}, steps=${evaluation.steps}, cancellation=pass`);
