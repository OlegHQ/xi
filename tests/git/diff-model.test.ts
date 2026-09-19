import assert from 'node:assert/strict';
import { computeLineDiff } from '../../packages/services/git/diff';

function run(): void {
  // Identical
  {
    const diff = computeLineDiff(['a\n', 'b\n', 'c\n'], ['a\n', 'b\n', 'c\n']);
    assert.equal(diff.hunks.length, 0, 'DIFF-IDENT-01 identical files produce no hunks');
    assert.equal(diff.lines.length, 0, 'DIFF-IDENT-02 identical files produce no rendered lines');
  }

  // All added
  {
    const diff = computeLineDiff([], ['x\n', 'y\n']);
    assert.equal(diff.hunks.length, 1, 'DIFF-ADD-01 one hunk for an all-added file');
    assert.ok(diff.lines.every((line) => line.kind === 'added'), 'DIFF-ADD-02 every line is added');
    assert.equal(diff.lines.length, 2);
  }

  // All deleted
  {
    const diff = computeLineDiff(['x\n', 'y\n'], []);
    assert.equal(diff.hunks.length, 1, 'DIFF-DEL-01 one hunk for an all-deleted file');
    assert.ok(diff.lines.every((line) => line.kind === 'removed'), 'DIFF-DEL-02 every line is removed');
  }

  // Middle change with 3 lines of context on each side
  {
    const oldLines = ['1\n', '2\n', '3\n', '4\n', '5\n', '6\n', '7\n', '8\n', '9\n', '10\n'];
    const newLines = ['1\n', '2\n', '3\n', '4\n', 'X\n', '6\n', '7\n', '8\n', '9\n', '10\n'];
    const diff = computeLineDiff(oldLines, newLines);
    assert.equal(diff.hunks.length, 1, 'DIFF-MID-01 one hunk around the single-line change');
    const hunk = diff.hunks[0]!;
    // Change is at index 4 (line 5): context lines 2..8 (0-indexed 1..7) => 3 before, 3 after.
    assert.equal(hunk.oldStart, 2, 'DIFF-MID-02 hunk starts 3 lines of context before the change');
    assert.equal(hunk.newStart, 2);
    const removed = diff.lines.filter((line) => line.kind === 'removed');
    const added = diff.lines.filter((line) => line.kind === 'added');
    assert.equal(removed.length, 1);
    assert.equal(added.length, 1);
    assert.equal(removed[0]!.text, '5\n');
    assert.equal(added[0]!.text, 'X\n');
    const contextCount = diff.lines.filter((line) => line.kind === 'context').length;
    assert.equal(contextCount, 6, 'DIFF-MID-03 3 lines of context on each side of the change');
  }

  // CRLF preserved
  {
    const diff = computeLineDiff(['a\r\n', 'b\r\n'], ['a\r\n', 'c\r\n']);
    const removed = diff.lines.find((line) => line.kind === 'removed');
    const added = diff.lines.find((line) => line.kind === 'added');
    assert.equal(removed?.text, 'b\r\n', 'DIFF-CRLF-01 removed line keeps its CRLF');
    assert.equal(added?.text, 'c\r\n', 'DIFF-CRLF-02 added line keeps its CRLF');
  }

  // Missing trailing newline preserved
  {
    const diff = computeLineDiff(['a\n'], ['a\n', 'b']);
    const added = diff.lines.find((line) => line.kind === 'added');
    assert.equal(added?.text, 'b', 'DIFF-NOEOL-01 last line with no trailing newline is preserved as-is');
  }

  // Budget fallback: two large, entirely unrelated files degrade to whole-file replace but
  // still succeed synchronously and produce one added/removed set covering every line.
  {
    const big = 3000;
    const oldLines = Array.from({ length: big }, (_v, i) => `old-${i}-${Math.random()}\n`);
    const newLines = Array.from({ length: big }, (_v, i) => `new-${i}-${Math.random()}\n`);
    const diff = computeLineDiff(oldLines, newLines);
    // Whichever path is taken (Myers within budget, or fallback), every old line is removed
    // and every new line is added since none match.
    const removed = diff.lines.filter((line) => line.kind === 'removed');
    const added = diff.lines.filter((line) => line.kind === 'added');
    assert.equal(removed.length, big, 'DIFF-BUDGET-01 all-old lines accounted for');
    assert.equal(added.length, big, 'DIFF-BUDGET-02 all-new lines accounted for');
  }

  // Hunk boundaries: two separate changes far apart produce two hunks
  {
    const oldLines = Array.from({ length: 30 }, (_v, i) => `${i}\n`);
    const newLines = [...oldLines];
    newLines[2] = 'CHANGED-A\n';
    newLines[25] = 'CHANGED-B\n';
    const diff = computeLineDiff(oldLines, newLines);
    assert.equal(diff.hunks.length, 2, 'DIFF-HUNK-01 far-apart changes produce separate hunks');
  }

  console.log('T-diff-model Git line diff passed identical/added/deleted/middle-change/CRLF/no-trailing-newline/budget-fallback/hunk-boundary cases');
}

run();
