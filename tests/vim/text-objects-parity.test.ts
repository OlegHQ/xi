import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import {
  extendVimVisualTextObject,
  resolveVimTextObject,
  type VimTextObjectKey,
  type VimVisualTextSelectionInput,
} from '../../packages/vim/text-objects/index';

// Each fixture's expected slice was verified against pinned Neovim 0.12.4
// (`nvim --headless --clean`) with the command noted alongside it.

let documentCounter = 0;
function snapshotOf(text: string): DocumentSnapshot {
  documentCounter += 1;
  const id = asIdentifier<DocumentId>(`text-objects-parity-${documentCounter}`, 'documentId');
  assert.ok(id.ok, 'T-TXTOBJ-SETUP-01 document id is valid');
  if (!id.ok) throw new Error('unreachable');
  const opened = openTextDocument(id.value, new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable', 'T-TXTOBJ-SETUP-02 fixture opens as editable text');
  if (opened.kind !== 'editable') throw new Error('unreachable');
  return opened.document.snapshot();
}

function offset(value: number): Utf16Offset {
  const parsed = asUtf16Offset(value);
  assert.ok(parsed.ok, 'T-TXTOBJ-SETUP-03 offset is valid');
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

function resolve(
  text: string,
  cursorOffset: number,
  key: VimTextObjectKey,
  count?: number,
): { readonly start: number; readonly end: number; readonly kind: string } | { readonly failed: string } {
  const snapshot = snapshotOf(text);
  const cursor = { documentVersion: snapshot.version, offset: offset(cursorOffset) };
  const invocation = count === undefined ? { key } : { key, count };
  const result = resolveVimTextObject(snapshot, cursor, invocation);
  if (!result.ok) return { failed: result.error.kind };
  return { start: result.value.start as number, end: result.value.end as number, kind: result.value.kind };
}

function slice(text: string, start: number, end: number): string {
  return text.slice(start, end);
}

// 1. `diw` on a one-character word must select only that character, never
// swallowing an adjacent word. Verified:
//   nvim --headless --clean -c 'call setline(1,["a bc"])' -c 'normal! diw' -c 'echo join(getline(1,"$"),"|")' -c q
//   -> " bc" (only "a" removed)
{
  const text = 'a bc';
  const range = resolve(text, 0, 'iw');
  assert.ok('start' in range, 'T-TXTOBJ-01a resolves diw on a one-char word');
  if ('start' in range) assert.equal(slice(text, range.start, range.end), 'a', 'T-TXTOBJ-01a diw selects only the one-char word');
}
// nvim --headless --clean -c 'call setline(1,["foo.bar"])' -c 'normal! 3ldiw' -c 'echo join(getline(1,"$"),"|")' -c q
//   -> "foobar" (only "." removed)
{
  const text = 'foo.bar';
  const range = resolve(text, 3, 'iw');
  assert.ok('start' in range, 'T-TXTOBJ-01b resolves diw on a one-char punctuation word');
  if ('start' in range) assert.equal(slice(text, range.start, range.end), '.', 'T-TXTOBJ-01b diw selects only the single-char delimiter');
}

// 2. `diw` on a genuinely empty line must not reach across the blank line's
// newlines and join the surrounding lines. Verified:
//   nvim --headless --clean -c 'call setline(1,["a","","b"])' -c 'normal! 2Gdiw' -c 'echo join(getline(1,"$"),"|")' -c q
//   -> "a||b" (unchanged; diw on an empty line is a no-op)
{
  const range = resolve('a\n\nb', 2, 'iw');
  assert.ok('failed' in range, 'T-TXTOBJ-02 diw on an empty line fails rather than joining lines');
  if ('failed' in range) assert.equal(range.failed, 'empty-object', 'T-TXTOBJ-02 diw on an empty line reports empty-object');
}

// 3. Multi-line `di(` must delete only the interior lines when the opening
// delimiter is alone at the end of its line and the closer is alone at the
// start of its line, matching Neovim's `ip`-like linewise interior deletion.
// Verified:
//   printf 'f(\n  a,\n  b\n)\n' > /tmp/t.txt; nvim --headless --clean -c 'e /tmp/t.txt' -c 'normal! di(' \
//     -c 'echo join(getline(1,"$"),"|")' -c q
//   -> "f(|)"
{
  const text = 'f(\n  a,\n  b\n)\n';
  const range = resolve(text, 0, 'i(');
  assert.ok('start' in range, 'T-TXTOBJ-03 resolves multi-line di(');
  if ('start' in range) {
    const before = slice(text, 0, range.start);
    const after = slice(text, range.end, text.length);
    assert.equal(`${before}${after}`, 'f(\n)\n', 'T-TXTOBJ-03 multi-line di( leaves the opener and closer on their own lines');
  }
}

// 4. `dit` on an empty element must not delete the opening tag; there is no
// content to remove. Verified:
//   nvim --headless --clean -c 'call setline(1,["<a></a>"])' -c 'normal! dit' -c 'echo join(getline(1,"$"),"|")' -c q
//   -> "<a></a>" (unchanged)
{
  const text = '<a></a>';
  const range = resolve(text, 0, 'it');
  assert.ok('start' in range, 'T-TXTOBJ-04 resolves dit on an empty element');
  if ('start' in range) {
    assert.equal(range.start, range.end, 'T-TXTOBJ-04 dit on an empty element is zero-width');
    assert.equal(slice(text, 0, range.start), '<a>', 'T-TXTOBJ-04 dit does not remove the opening tag');
  }
}

// 5a. A count on whitespace `iw`/`aw` must not be dropped. Verified:
//   nvim --headless --clean -c 'call setline(1,["a   b   c   d"])' -c 'normal! l3diw' \
//     -c 'echo join(getline(1,"$"),"|")' -c q
//   -> "ac   d" (whitespace, word, whitespace: 3 alternating units)
{
  const text = 'a   b   c   d';
  const range = resolve(text, 1, 'iw', 3);
  assert.ok('start' in range, 'T-TXTOBJ-05a resolves 3iw on whitespace');
  if ('start' in range) assert.equal(slice(text, range.start, range.end), '   b   ', 'T-TXTOBJ-05a count 3 on whitespace iw consumes 3 alternating units');
}

// 5b. `daw` must not eat the line's own indentation when the word has no
// trailing whitespace to grab instead. Verified:
//   nvim --headless --clean -c 'call setline(1,["  foo"])' -c 'normal! 02ldaw' -c 'echo "[" . join(getline(1,"$"),"|") . "]"' -c q
//   -> "[  ]" (indentation kept, "foo" removed)
{
  const text = '  foo';
  const range = resolve(text, 2, 'aw');
  assert.ok('start' in range, 'T-TXTOBJ-05b resolves daw at the end of an indented line');
  if ('start' in range) {
    assert.equal(slice(text, 0, range.start), '  ', 'T-TXTOBJ-05b daw keeps the line indentation');
    assert.equal(slice(text, range.start, range.end), 'foo', 'T-TXTOBJ-05b daw removes only the word');
  }
}

// 5c. `ip`/`ap` on a blank-line run must select the run of blank lines
// itself, not jump forward to the next non-blank paragraph. Verified:
//   nvim --headless --clean -c "call setline(1,['a','','','b'])" -c 'normal! 2Gdip' -c 'echo string(getline(1,"$"))' -c q
//   -> ['a', 'b'] (both blank lines removed)
{
  const text = 'a\n\n\nb';
  const range = resolve(text, 2, 'ip');
  assert.ok('start' in range, 'T-TXTOBJ-05c resolves ip on a blank-line run');
  if ('start' in range) {
    assert.equal(range.kind, 'linewise', 'T-TXTOBJ-05c blank-run ip is linewise');
    assert.equal(slice(text, 0, range.start) + slice(text, range.end, text.length), 'a\nb', 'T-TXTOBJ-05c ip selects exactly the blank-line run');
  }
}

// 5d. Repeating an inner text object in Visual mode must extend the
// selection rather than being a no-op. Verified:
//   nvim --headless --clean -c "call setline(1,['one two three'])" -c 'normal! viwiwd' -c 'echo string(getline(1,"$"))' -c q
//   -> ['two three'] (viwiw grows to include the trailing space)
{
  const text = 'one two three';
  const snapshot = snapshotOf(text);
  const initial: VimVisualTextSelectionInput = {
    documentVersion: snapshot.version,
    anchor: offset(0),
    head: offset(0),
    direction: 'forward',
    kind: 'characterwise',
  };
  const step1 = extendVimVisualTextObject(snapshot, initial, { key: 'iw' });
  assert.ok(step1.ok, 'T-TXTOBJ-05d first viw resolves');
  if (!step1.ok) throw new Error('unreachable');
  const step2 = extendVimVisualTextObject(snapshot, step1.value, { key: 'iw' });
  assert.ok(step2.ok, 'T-TXTOBJ-05d second viw resolves');
  if (step2.ok) {
    assert.equal(slice(text, step2.value.start as number, step2.value.end as number), 'one ',
      'T-TXTOBJ-05d repeating viw extends the selection into trailing whitespace');
  }
}

// 5e. Quote objects: `i"` with a count >= 2 widens to include the
// delimiters, unlike `i"` (count 1, inner-only) or `a"` (which additionally
// grabs surrounding whitespace). Escaped quotes are not treated as
// delimiters. Verified:
//   printf 'x "ab" "cd"\n' > /tmp/t.txt
//   nvim --headless --clean -c 'e /tmp/t.txt' -c 'normal! 0di"' -c 'echo join(getline(1,"$"),"|")' -c q -> 'x "" "cd"'
//   nvim --headless --clean -c 'e /tmp/t.txt' -c 'normal! 02di"' -c 'echo join(getline(1,"$"),"|")' -c q -> 'x  "cd"'
{
  const text = 'x "ab" "cd"';
  const single = resolve(text, 0, 'i"');
  assert.ok('start' in single, 'T-TXTOBJ-05e resolves i" (count 1) before the first quote');
  if ('start' in single) assert.equal(slice(text, single.start, single.end), 'ab', 'T-TXTOBJ-05e i" (count 1) selects only the inner content');
  const counted = resolve(text, 0, 'i"', 2);
  assert.ok('start' in counted, 'T-TXTOBJ-05e resolves 2i" before the first quote');
  if ('start' in counted) assert.equal(slice(text, counted.start, counted.end), '"ab"', 'T-TXTOBJ-05e 2i" widens to include the delimiters without grabbing whitespace');
}
{
  // Escaped quote inside the pair does not close it early.
  const text = '"a\\"b" "c"';
  const range = resolve(text, 0, 'i"');
  assert.ok('start' in range, 'T-TXTOBJ-05e-esc resolves i" with an escaped quote inside the pair');
  if ('start' in range) assert.equal(slice(text, range.start, range.end), 'a\\"b', 'T-TXTOBJ-05e-esc escaped quote does not end the pair early');
}

// 6. A bracket count deeper than the available nesting must fail (Neovim
// beeps, no change), not silently succeed on a shallower pair. Verified:
//   nvim --headless --clean -c 'call setline(1,["(a)"])' -c 'normal! l2di(' -c 'echo "[" . join(getline(1,"$"),"|") . "]"' -c q
//   -> "[(a)]" (unchanged)
{
  const range = resolve('(a)', 1, 'i(', 2);
  assert.ok('failed' in range, 'T-TXTOBJ-06 2di( beyond available nesting fails');
  if ('failed' in range) assert.equal(range.failed, 'object-not-found', 'T-TXTOBJ-06 reports object-not-found rather than a shallower match');
}

console.log('text-objects-parity passed all fixtures against pinned Neovim 0.12.4 expectations.');
