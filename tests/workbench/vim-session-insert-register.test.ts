import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSessionOptions } from '../../packages/workbench/vim-session/index';

// Oracle: nvim --headless --clean -u NONE 0.12.4.
// `nvim --headless --clean -u NONE -c 'execute "normal! yiwA\<C-r>0\<Esc>"' -c 'w!' -c 'q!'`
// on "hello world" gives "hello worldhello" (charwise `<C-r>0`).
// The same on "foo\nbar" with `yyA\<C-r>0\<Esc>` gives "foofoo\n\nbar" (linewise keeps its
// trailing newline). `i\<C-r>\<Esc>y\<Esc>` on "x" gives "yx" (Esc cancels the prompt only).
// `yiwA\<C-r>0X\<Esc>.` on "hi " gives "hi hiXhiX" (the pasted text is part of dot's target).

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-insert-register-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('vim-session-insert-register-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function event(name: string, raw = name): OwnedVimKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

interface Session {
  readonly vim: ReturnType<typeof createOwnedVimSession>;
  readonly messages: string[];
  mode(): string | undefined;
  text(): string;
}

function session(initial: string, extraOptions: Partial<OwnedVimSessionOptions> = {}): Session {
  const doc = document(initial);
  let mode: string | undefined;
  const messages: string[] = [];
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('vim-session-insert-register-view'),
    onStateChange: (state) => { mode = state.mode; },
    onMessage: (message) => { messages.push(message); },
    ...extraOptions,
  });
  return {
    vim,
    messages,
    mode: () => mode,
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

/** Tokenizes `<Esc>`, `<CR>`, `<BS>`, and `<C-x>` alongside plain characters. */
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
  // 1. Charwise `<C-r>0` inserts the yanked word literally.
  {
    const s = session('hello world');
    await type(s, keys('yiwA<C-r>0<Esc>'));
    assert.equal(s.text(), 'hello worldhello', 'INSERT-REGISTER-01 charwise <C-r>0 inserts the yanked word');
  }

  // 2. Linewise `<C-r>0` inserts the line's text plus its trailing newline.
  {
    const s = session('foo\nbar');
    await type(s, keys('yyA<C-r>0<Esc>'));
    assert.equal(s.text(), 'foofoo\n\nbar', 'INSERT-REGISTER-02 linewise <C-r>0 keeps its trailing newline');
  }

  // 3. The unnamed register `"` mirrors the last yank/delete.
  {
    const s = session('hello world');
    await type(s, keys('yiwA<C-r>"<Esc>'));
    assert.equal(s.text(), 'hello worldhello', 'INSERT-REGISTER-03 <C-r>" reads the unnamed register');
  }

  // 4. Esc during the register-name prompt cancels the prompt only; Insert mode continues
  // and a further Esc then leaves it normally.
  {
    const s = session('x');
    await type(s, keys('i<C-r><Esc>y<Esc>'));
    assert.equal(s.text(), 'yx', 'INSERT-REGISTER-04 Esc cancels the <C-r> prompt without leaving Insert');
    assert.equal(s.mode(), 'normal', 'INSERT-REGISTER-05 the second Esc leaves Insert mode as usual');
  }

  // 5. <C-r><C-r>{reg} and <C-r><C-p>{reg} map to the same literal insert as plain <C-r>{reg}.
  {
    const s = session('hello world');
    await type(s, keys('yiwA<C-r><C-r>0<Esc>'));
    assert.equal(s.text(), 'hello worldhello', 'INSERT-REGISTER-06 <C-r><C-r>{reg} inserts literally, same as <C-r>{reg}');
  }
  {
    const s = session('hello world');
    await type(s, keys('yiwA<C-r><C-p>0<Esc>'));
    assert.equal(s.text(), 'hello worldhello', 'INSERT-REGISTER-07 <C-r><C-p>{reg} inserts literally, same as <C-r>{reg}');
  }

  // 6. The expression register is out of scope: it is skipped with a message, not inserted
  // and not left as a stuck prompt.
  {
    const s = session('x');
    await type(s, keys('i<C-r>=y<Esc>'));
    assert.equal(s.text(), 'yx', 'INSERT-REGISTER-08 "=" is skipped rather than inserted');
    assert.ok(s.messages.some((message) => message.includes('E15')), 'INSERT-REGISTER-09 "=" prints an advisory message');
  }

  // 7. The pasted register text is part of the insert session's dot-repeat text and undo
  // group: '.' replays both the paste and the text typed after it.
  {
    const s = session('hi ');
    await type(s, keys('yiwA<C-r>0X<Esc>.'));
    assert.equal(s.text(), 'hi hiXhiX', 'INSERT-REGISTER-10 dot-repeat replays the pasted register text plus the typed suffix');
  }

  // 8. Helix's default-yank-register controls implicit yanks and pastes while an explicit
  // register prefix remains authoritative.
  {
    const s = session('ab', { defaultYankRegister: 'a' });
    await type(s, keys('ylA<C-r>a<Esc>'));
    assert.equal(s.text(), 'aba', 'INSERT-REGISTER-11 configured default-yank-register supplies <C-r>a after an implicit yank');
  }
  {
    const s = session('ab', { defaultYankRegister: 'a' });
    await type(s, keys('"bylA<C-r>a<Esc>'));
    assert.equal(s.text(), 'ab', 'INSERT-REGISTER-12 an explicit yank register does not populate the configured default register');
  }
  {
    const s = session('ab', { defaultYankRegister: 'a' });
    await type(s, keys('"bylp'));
    assert.equal(s.text(), 'ab', 'INSERT-REGISTER-13 paste uses the configured default register rather than the unnamed register');
  }

  // 9. A completed production pointer selection uses editor.mouse-yank-register.
  {
    const s = session('alpha beta', { mouseYankRegister: 'a' });
    const target = (offset: number) => ({ lineIndex: 0, offset, displayCellColumn: offset, virtualCell: offset, cellPart: 'glyph' as const });
    assert.equal(s.vim.placePointer({
      kind: 'drag',
      viewId: 'vim-session-insert-register-view',
      anchor: { row: 0, column: 0, target: target(0) },
      head: { row: 0, column: 4, target: target(4) },
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
      completed: true,
    }), true, 'T036-MOUSE-YANK-REGISTER-UNIT-01 completed pointer selection is accepted');
    await type(s, keys('<Esc>"ap'));
    assert.equal(s.text(), 'alphaalpha beta', 'T036-MOUSE-YANK-REGISTER-UNIT-02 completed pointer selection is stored in the configured register');
  }

  // Xi's automatic pairs replay the typed keys, including a skipped closer.
  {
    const s = session('');
    await type(s, keys('i(x)<Esc>.'));
    assert.equal(s.text(), '(x(x))', 'AUTO-PAIRS-DOT-01 dot repeats a balanced pair at the current cursor');
    await type(s, keys('u'));
    assert.equal(s.text(), '(x)', 'AUTO-PAIRS-DOT-02 undo removes only the repeated pair');
  }
  {
    const s = session('', { insertOptions: { autoPairs: { x: 'y' } } });
    await type(s, keys('ix<Esc>.'));
    assert.equal(s.text(), 'xyxy', 'AUTO-PAIRS-DOT-03 custom pair replay stays balanced');
  }

  console.log('vim-session-insert-register: all fixtures passed');
}

void main();
