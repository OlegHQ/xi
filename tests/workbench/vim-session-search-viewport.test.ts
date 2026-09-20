import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSessionOptions } from '../../packages/workbench/vim-session/index';

// Oracle: nvim --headless --clean -u NONE 0.12.4.

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-search-viewport-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('vim-session-search-viewport-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function event(name: string, raw = name): OwnedVimKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

interface Session {
  readonly vim: ReturnType<typeof createOwnedVimSession>;
  readonly doc: TextFileDocument;
  cursor(): number | undefined;
  mode(): string | undefined;
  text(): string;
  line(): number;
}

function session(initial: string, extraOptions: Partial<OwnedVimSessionOptions> = {}): Session {
  const doc = document(initial);
  let cursor: number | undefined;
  let mode: string | undefined;
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('vim-session-search-viewport-view'),
    onStateChange: (state) => {
      mode = state.mode;
      const primary = state.selections.members.find((member: { id: unknown }) => member.id === state.selections.primaryId) ?? state.selections.members[0];
      cursor = (primary as { head?: { at?: { offset?: number } } } | undefined)?.head?.at?.offset;
    },
    ...extraOptions,
  });
  return {
    vim,
    doc,
    cursor: () => cursor,
    mode: () => mode,
    text: () => {
      const snapshot = doc.snapshot();
      const full = snapshot.slice(0 as unknown as Parameters<typeof snapshot.slice>[0], snapshot.lengthUtf16 as unknown as Parameters<typeof snapshot.slice>[1]);
      return full.ok ? full.value : '<unreadable>';
    },
    line: () => {
      const off = cursor;
      if (off === undefined) return -1;
      const result = doc.snapshot().lineIndexAt(off as never);
      return result.ok ? (result.value as unknown as number) : -1;
    },
  };
}

async function type(target: Session, keys: readonly OwnedVimKeyEvent[]): Promise<void> {
  for (const key of keys) await target.vim.handleKey(key);
}

function keys(source: string): OwnedVimKeyEvent[] {
  const out: OwnedVimKeyEvent[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '<') {
      const end = source.indexOf('>', index);
      const token = source.slice(index + 1, end);
      index = end + 1;
      out.push(token === 'Esc' ? event('ESC', '\x1b') : token === 'CR' ? event('return', '\r') : event(token));
      continue;
    }
    out.push(event(char === ' ' ? 'space' : char, char));
    index += 1;
  }
  return out;
}

async function main(): Promise<void> {
  // 1. `*`/`#`/`g*`/`g#` search the word (or, for g*/g#, substring) under the cursor, and
  // set the last search pattern so `n`/`N` continue it -- including * 's whole-word
  // constraint, which nvim encodes into the pattern text itself (`\<foo\>`) but this
  // engine tracks alongside the pattern (VimSearchState.fullWord) since it has no
  // word-boundary regex atom. nvim: `*n` on "foo\nfoobar\nfoo\nbarfoo\nfoo\n" from line 1
  // lands on line 3, then line 5 (skipping the non-whole-word "foobar"/"barfoo" lines).
  {
    const s = session('foo\nfoobar\nfoo\nbarfoo\nfoo\n');
    await type(s, keys('*'));
    assert.equal(s.line(), 2, 'SEARCH-01 * finds the next whole-word occurrence, skipping foobar');
    await type(s, keys('n'));
    assert.equal(s.line(), 4, 'SEARCH-02 n continues the whole-word * search, skipping barfoo');
    await type(s, keys('n'));
    assert.equal(s.line(), 0, 'SEARCH-03 n wraps back to the first match');
  }
  {
    const s = session('foo\nfoobar\nfoo\n');
    await type(s, keys('g*'));
    assert.equal(s.cursor(), 4, 'SEARCH-04 g* matches a substring (inside foobar), unlike *');
  }
  {
    // nvim: `G#` on "aaa\nbbb\naaa\nbbb\naaa" (cursor on the last line) goes to line 3.
    const s = session('aaa\nbbb\naaa\nbbb\naaa');
    await type(s, keys('G#'));
    assert.equal(s.line(), 2, 'SEARCH-05 # searches backward for the whole word under the cursor');
  }
  // 1b. N searches opposite of the last search but does not redefine what a later plain
  // `n` repeats -- nvim: `*` (line 3) then `N` (line 1) then `n` returns to line 3, not
  // line 1's backward neighbor.
  {
    const s = session('aaa\nbbb\naaa\nbbb\naaa\n');
    await type(s, keys('*'));
    assert.equal(s.line(), 2, 'SEARCH-06 * lands on line 3 (index 2)');
    await type(s, keys('N'));
    assert.equal(s.line(), 0, 'SEARCH-07 N searches backward for this one query');
    await type(s, keys('n'));
    assert.equal(s.line(), 2, 'SEARCH-08 a later n still repeats forward, unaffected by the N above');
  }
  // 1c. Visual `*`/`#` search for the exact selected text (a literal substring, not the
  // whole word under the cursor) and leave Visual mode. nvim v_star-default:
  // `0vll*` on "foo bar\nbar foo\nfoo bar baz\n" (selecting "foo") lands on line 2.
  {
    const s = session('foo bar\nbar foo\nfoo bar baz\n');
    await type(s, keys('0vll*'));
    assert.equal(s.mode(), 'normal', 'SEARCH-09 Visual * returns to Normal mode');
    assert.equal(s.line(), 1, 'SEARCH-10 Visual * searches for the selected text');
  }

  // 2. H/M/L address the host-reported visible-line range through options.viewport, with
  // counts, and fall back to the whole document when no viewport port is supplied.
  {
    const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const s = session(text, { viewport: { topLine: () => 2, bottomLine: () => 8 } });
    await type(s, keys('H'));
    assert.equal(s.line(), 2, 'VIEWPORT-01 H goes to the reported top line');
    await type(s, keys('3H'));
    assert.equal(s.line(), 4, 'VIEWPORT-02 a count on H offsets from the top line');
    await type(s, keys('M'));
    assert.equal(s.line(), 5, 'VIEWPORT-03 M goes to the middle of the reported range');
    await type(s, keys('L'));
    assert.equal(s.line(), 8, 'VIEWPORT-04 L goes to the reported bottom line');
    await type(s, keys('2L'));
    assert.equal(s.line(), 7, 'VIEWPORT-05 a count on L offsets back from the bottom line');
  }
  {
    const text = Array.from({ length: 5 }, (_, i) => `l${i + 1}`).join('\n');
    const s = session(text);
    await type(s, keys('L'));
    assert.equal(s.line(), 4, 'VIEWPORT-06 with no viewport port, L falls back to the last line of the whole document');
  }

  // 3. Visual `;`/`,` repeat/reverse the last f/F/t/T find, extending the Visual head
  // (not collapsing to a Normal cursor). nvim: `0fxv;;` on "axbxcxdxexf" (an 'x' every
  // other column) lands the head at column 6 (1-based).
  {
    const s = session('axbxcxdxexf');
    await type(s, keys('0fxv;;'));
    assert.equal(s.mode(), 'visual-character', 'FIND-01 visual ; keeps Visual mode active');
    assert.equal(s.cursor(), 5, 'FIND-02 visual ; repeats the find, extending the head');
    await type(s, keys(','));
    assert.equal(s.cursor(), 3, 'FIND-03 visual , reverses the last find');
  }

  // 5. A `clock` option overrides the default performance.now()-backed clock (used for
  // repeat-timing bookkeeping); a session omitting it still works via the default.
  {
    const doc = document('');
    let calls = 0;
    const vim = createOwnedVimSession(doc, {
      viewId: id<ViewId>('vim-session-search-viewport-clock-view'),
      clock: { monotonicMilliseconds: () => { calls += 1; return 1000; } },
    });
    await vim.handleKey(event('i'));
    await vim.handleKey(event('x', 'x'));
    await vim.handleKey(event('ESC', '\x1b'));
    assert.ok(calls > 0, 'CLOCK-01 the injected clock is actually consulted on the key path');
  }
  {
    // No `clock` option: the session must still function (default monotonic fallback).
    const s = session('');
    await type(s, keys('ix<Esc>'));
    assert.equal(s.text(), 'x', 'CLOCK-02 omitting the clock option still produces a working session');
  }

  console.log('vim-session-search-viewport: all fixtures passed');
}

void main();
