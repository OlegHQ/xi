import { strict as assert } from 'node:assert';
import { compilePattern, findAllMatches, patternSnapshotFromDocument } from '../../../packages/vim/pattern/index';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentId } from '../../../packages/primitives/src/index';

/**
 * The fast ASCII literal search path ticked the step budget once per UTF-16
 * unit *skipped*, not per match candidate examined. A 2 MiB document with a
 * single literal match at the very end therefore exhausted the default
 * 250_000-step budget long before reaching it, even though the actual
 * evaluator work (an `indexOf`-class native scan) is cheap. This asserts the
 * fix: the same search now completes, and finds the match, well within the
 * default budget.
 */
function main(): void {
  const TWO_MIB = 2 * 1024 * 1024;
  const filler = 'x'.repeat(TWO_MIB - 1);
  const text = `${filler}Q`;
  const matchOffset = TWO_MIB - 1;

  const opened = openTextDocument('literal-fast-path-budget' as DocumentId, new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('T-LITERAL-FAST-PATH-BUDGET-DOCUMENT');
  const snapshot = patternSnapshotFromDocument(opened.document.snapshot());

  // No explicit stepBudget/outputLimit: exercises the actual defaults.
  const program = compilePattern('Q');
  const result = findAllMatches(program, snapshot);

  assert.equal(result.matches.length, 1, 'exactly one literal match is found');
  assert.equal(result.matches[0]?.start, matchOffset, 'the match is located at the very end of the document');
  assert.ok(result.steps <= program.stepBudget, `evaluation must stay within the default step budget (${program.stepBudget}), used ${result.steps}`);

  console.log(`T-LITERAL-FAST-PATH-BUDGET-01 passed: found the sole match at offset ${matchOffset} of a ${TWO_MIB}-byte document using ${result.steps} steps (budget ${program.stepBudget}).`);
}

main();
