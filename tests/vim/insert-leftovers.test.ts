import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent } from '../../packages/workbench/vim-session/index';

// Oracle: nvim --headless --clean -u NONE 0.12.4 (default 'backspace=indent,eol,start').

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-leftovers-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('insert-leftovers-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function event(name: string, raw = name): OwnedVimKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

interface Session {
  readonly vim: ReturnType<typeof createOwnedVimSession>;
  readonly doc: TextFileDocument;
  text(): string;
}

function session(initial: string): Session {
  const doc = document(initial);
  const vim = createOwnedVimSession(doc, { viewId: id<ViewId>('insert-leftovers-view') });
  return {
    vim,
    doc,
    text: () => {
      const snapshot = doc.snapshot();
      const full = snapshot.slice(0 as unknown as Parameters<typeof snapshot.slice>[0], snapshot.lengthUtf16 as unknown as Parameters<typeof snapshot.slice>[1]);
      return full.ok ? full.value : '<unreadable>';
    },
  };
}

async function type(target: Session, keys: readonly OwnedVimKeyEvent[]): Promise<void> {
  for (const key of keys) await target.vim.handleKey(key);
}

/** Tokenizes `<Esc>`, `<CR>`, `<BS>`, `<Del>`, and `<C-x>` alongside plain characters. */
function keys(source: string): OwnedVimKeyEvent[] {
  const out: OwnedVimKeyEvent[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '<') {
      const end = source.indexOf('>', index);
      const token = source.slice(index + 1, end);
      index = end + 1;
      if (token === 'Esc') out.push(event('ESC', '\x1b'));
      else if (token === 'CR') out.push(event('return', '\r'));
      else if (token === 'BS') out.push(event('backspace', '\x7f'));
      else if (token === 'Del') out.push(event('Delete', '\x7f'));
      else if (token.startsWith('C-')) out.push({ name: token.slice(2), raw: token.slice(2), shift: false, option: false, ctrl: true, meta: false });
      else out.push(event(token));
      continue;
    }
    out.push(event(char === ' ' ? 'space' : char, char));
    index += 1;
  }
  return out;
}

async function main(): Promise<void> {
  // 1. Replace-mode <BS> past the entry point (with nothing left to restore) only moves
  // the cursor left; it never deletes text that predates entering Replace mode.
  // nvim: `02lR<BS><Esc>` on "abcd" leaves the buffer "abcd" unchanged.
  {
    const s = session('abcd');
    await type(s, keys('llR<BS><Esc>'));
    assert.equal(s.text(), 'abcd', 'INSERT-LEFTOVERS-01 Replace <BS> past its own entry point does not delete');
  }
  {
    const s = session('abcdef');
    await type(s, keys('llRXYZ<BS><BS><BS><BS><Esc>'));
    assert.equal(s.text(), 'abcdef', 'INSERT-LEFTOVERS-02 3 backspaces undo 3 typed replacements, a 4th past entry just moves');
  }

  // 2. A count on R replays the typed text that many times in total, overwriting forward.
  // nvim: `3Rxy<Esc>` on "abcdefghijkl" gives "xyxyxyghijkl".
  {
    const s = session('abcdefghijkl');
    await type(s, keys('3Rxy<Esc>'));
    assert.equal(s.text(), 'xyxyxyghijkl', 'INSERT-LEFTOVERS-03 a count on R repeats the typed replacement forward');
  }

  // 3. <Del> at the end of the current line joins it with the next line (deletes the
  // separating newline); at the true last line (no following content) it is a no-op.
  // nvim: `0A<Del><Esc>` on ["abc","def"] gives one line "abcdef".
  {
    const s = session('abc\ndef');
    await type(s, keys('0A<Del><Esc>'));
    assert.equal(s.text(), 'abcdef', 'INSERT-LEFTOVERS-04 <Del> at EOL joins with the next line');
  }
  {
    const s = session('abc');
    await type(s, keys('0A<Del><Esc>'));
    assert.equal(s.text(), 'abc', 'INSERT-LEFTOVERS-05 <Del> at the true end of the buffer is a no-op');
  }

  // 4. <C-a> inserts the text from the last completed Insert/Replace session.
  // nvim: `ifoo<Esc>A<C-a><Esc>` gives "foofoo".
  {
    const s = session('');
    await type(s, keys('ifoo<Esc>A<C-a><Esc>'));
    assert.equal(s.text(), 'foofoo', 'INSERT-LEFTOVERS-06 <C-a> reinserts the last inserted text');
  }
  {
    const s = session('');
    await type(s, keys('i<C-a>x<Esc>'));
    assert.equal(s.text(), 'x', 'INSERT-LEFTOVERS-07 <C-a> with no prior insert is a safe no-op, not a literal control byte');
  }

  // 5. <C-k>{digraph} still inserts the digraph (default-digraph table, unaffected by the
  // <C-v> numeric literal-entry work below). nvim: `i<C-k>a:<Esc>` gives "ä".
  {
    const s = session('');
    await type(s, keys('i<C-k>a:<Esc>'));
    assert.equal(s.text(), 'ä', 'INSERT-LEFTOVERS-08 <C-k> digraph entry still works');
  }

  // 6. <C-v> numeric literal entry: decimal (byte), hex byte (x), hex4 (u) and hex8 (U)
  // code points. nvim: each of these gives the shown single character.
  {
    const s = session('');
    await type(s, keys('i<C-v>065<Esc>'));
    assert.equal(s.text(), 'A', 'INSERT-LEFTOVERS-09 <C-v>065 (decimal) inserts byte 65 = A');
  }
  {
    const s = session('');
    await type(s, keys('i<C-v>x41<Esc>'));
    assert.equal(s.text(), 'A', 'INSERT-LEFTOVERS-10 <C-v>x41 (hex byte) inserts byte 0x41 = A');
  }
  {
    const s = session('');
    await type(s, keys('i<C-v>u1234<Esc>'));
    assert.equal(s.text(), 'ሴ', 'INSERT-LEFTOVERS-11 <C-v>u1234 inserts U+1234');
  }
  {
    const s = session('');
    await type(s, keys('i<C-v>U0001F600<Esc>'));
    assert.equal(s.text(), '\u{1F600}', 'INSERT-LEFTOVERS-12 <C-v>U0001F600 inserts the astral U+1F600 emoji');
  }

  // 7. Dot-repeat and insert-mode leftovers coexist: '.' after cw/insert still works once
  // the above changes are in place (T-DOT-REGRESSION guard for this ticket's edits).
  {
    const s = session('foo bar baz');
    await type(s, keys('cwXXX<Esc>w.'));
    assert.equal(s.text(), 'XXX XXX baz', 'INSERT-LEFTOVERS-13 . after cw still replays the change');
  }
  {
    const s = session('x');
    await type(s, keys('3ifoo<Esc>.'));
    assert.equal(s.text(), 'foofoofofoofoofooox', 'INSERT-LEFTOVERS-14 . after a counted insert still replays with its recorded count');
  }

  // 8. <C-v>{digits} terminated by a control key: nvim does not swallow the terminator --
  // it splices in the literal character first, then processes the terminating key
  // normally. nvim: `i<C-v>65<BS><Esc>` on "" leaves "" (the just-typed 'A' is then
  // backspaced away); `i<C-v>65<CR><Esc>` gives two lines "A"/""; `i<C-v>65<C-w><Esc>`
  // deletes the whole just-typed word, leaving "".
  {
    const s = session('');
    await type(s, keys('i<C-v>65<BS><Esc>'));
    assert.equal(s.text(), '', 'INSERT-LEFTOVERS-15 <C-v>65<BS> replays Backspace over the just-inserted literal');
  }
  {
    const s = session('');
    await type(s, keys('i<C-v>65<CR><Esc>'));
    assert.equal(s.text(), 'A\n', 'INSERT-LEFTOVERS-16 <C-v>65<CR> replays Enter and splits after the literal');
  }
  {
    const s = session('');
    await type(s, keys('i<C-v>65<C-w><Esc>'));
    assert.equal(s.text(), '', 'INSERT-LEFTOVERS-17 <C-v>65<C-w> replays Ctrl-w and deletes the just-typed word');
  }
  // <C-r> replays the register-paste prompt after the literal, rather than swallowing it:
  // the first <Esc> only cancels that prompt (nvim keeps typing), a second <Esc> then
  // exits insert. nvim: `i<C-v>68<C-r><Esc><Esc>` on "x" gives "Dx".
  {
    const s = session('x');
    await type(s, keys('i<C-v>68<C-r><Esc><Esc>'));
    assert.equal(s.text(), 'Dx', 'INSERT-LEFTOVERS-18 <C-v>68<C-r> replays the register prompt (cancelable on its own) after the literal');
  }
  // A further <C-v> right after a terminated literal starts a fresh literal-code entry
  // instead of being swallowed (nvim: `i<C-v>65<C-v>66<Esc>` gives "AB").
  {
    const s = session('');
    await type(s, keys('i<C-v>65<C-v>66<Esc>'));
    assert.equal(s.text(), 'AB', 'INSERT-LEFTOVERS-19 a further <C-v> after a terminated literal starts a new one');
  }

  console.log('insert-leftovers: all fixtures passed');
}

void main();
