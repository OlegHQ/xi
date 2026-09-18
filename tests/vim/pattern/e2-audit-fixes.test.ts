#!/usr/bin/env bun
// Regression tests for findings E2-2 (\/ literal escape), E2-3 (empty-match
// suppression adjacent to a prior match) and E2-4 (very-magic bare % position
// atoms). Run with `bun run tests/vim/pattern/e2-audit-fixes.test.ts`.
import { strict as assert } from 'node:assert';
import {
  compilePattern,
  createPatternTextSnapshot,
  findAllMatches,
  substituteAll,
} from '../../../packages/vim/pattern/index';
import type { DocumentVersion } from '../../../packages/primitives/src/index';

const version = 1 as DocumentVersion;

// --- E2-2: `\/` is always a literal `/`, never an unsupported escape. ------------
// Oracle (bypasses command-line delimiter stripping entirely):
//   nvim -S <<'let pos = searchpos(''a\/b'', ''n'') | echo pos'  -> [1, 1]  (matches "a/b")
{
  const program = compilePattern('a\\/b', {});
  const snapshot = createPatternTextSnapshot(version, 'xa/by');
  const result = findAllMatches(program, snapshot);
  assert.equal(result.matches.length, 1, 'E2-2 \\/ must be treated as a literal /');
  assert.equal(result.matches[0]?.start, 1);
  assert.equal(result.matches[0]?.end, 4);
}

// --- E2-3: an empty match right after a non-empty (or already-accepted empty)
// match at the same position is never reported, matching nvim's :s///g scan. ----
// Oracle:
//   nvim --headless --clean -c 'call setline(1,"a1b")' -c '%s/\d*/N/g' -c 'print' -c 'q!'
//     -> NaNb   (Xi produced NaNNb before this fix)
//   nvim --headless --clean -c 'call setline(1,"feed")' -c '%s/e*/-/g' -c 'print' -c 'q!'
//     -> -f-d   (Xi produced -f--d before this fix)
{
  const program = compilePattern('\\d*', {});
  const snapshot = createPatternTextSnapshot(version, 'a1b');
  const substituted = substituteAll(program, snapshot, 'N');
  assert.equal(substituted.text, 'NaNb', 'E2-3 \\d* global substitute on "a1b"');
}
{
  const program = compilePattern('e*', {});
  const snapshot = createPatternTextSnapshot(version, 'feed');
  const substituted = substituteAll(program, snapshot, '-');
  assert.equal(substituted.text, '-f-d', 'E2-3 e* global substitute on "feed"');
}

// --- E2-4: very-magic routes a bare `%` (no backslash) to the same position-atom
// parser as `\%`, not just `%(`. ---------------------------------------------------
// Oracle:
//   nvim -S <<'let pos = searchpos(''\v%d65'', ''n'') | echo pos'  on "ABC" -> [1, 1] ("A")
//   nvim -S <<'echo matchstrpos(''abc a'', ''\va%[bc]'')'          -> ['abc', 0, 3]
//   nvim -S <<'echo matchstrpos(''abc a'', ''\va%[bc]'', 4)'       -> ['a', 4, 5]
{
  const program = compilePattern('\\v%d65', {});
  const snapshot = createPatternTextSnapshot(version, 'ABC');
  const result = findAllMatches(program, snapshot);
  assert.equal(result.matches.length, 1, 'E2-4 bare %d65 must match a literal A');
  assert.equal(result.matches[0]?.start, 0);
  assert.equal(result.matches[0]?.end, 1);
}
{
  const program = compilePattern('\\va%[bc]', {});
  const snapshot = createPatternTextSnapshot(version, 'abc a');
  const result = findAllMatches(program, snapshot);
  assert.equal(result.matches.length, 2, 'E2-4 bare %[...] optional-sequence atom');
  assert.equal(result.matches[0]?.start, 0);
  assert.equal(result.matches[0]?.end, 3);
  assert.equal(result.matches[1]?.start, 4);
  assert.equal(result.matches[1]?.end, 5);
}

console.log('tests/vim/pattern/e2-audit-fixes.test.ts OK');
