import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent } from '../../packages/workbench/vim-session/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-motions-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('vim-session-motions-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
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
  text(): string;
}

function session(initial: string, onMessage?: (message: string) => void): Session {
  const doc = document(initial);
  let cursor: number | undefined;
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('vim-session-motions-view'),
    onStateChange: (state) => {
      const primary = state.selections.members.find((member: { id: unknown }) => member.id === state.selections.primaryId) ?? state.selections.members[0];
      cursor = (primary as { head?: { at?: { offset?: number } } } | undefined)?.head?.at?.offset;
    },
    ...(onMessage === undefined ? {} : { onMessage }),
  });
  return {
    vim,
    doc,
    cursor: () => cursor,
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
  // 1. makeNormalSelection: an empty line gets its own endpoint, not the previous line's
  // last character, and never throws 'xi selection: invalid-endpoint'.
  {
    const s = session('abc\n\ndef');
    await type(s, keys('j'));
    assert.equal(s.cursor(), 4, 'MOTIONS-01 j onto an empty line lands cursor on it, not the previous line');
    await type(s, keys('dd'));
    assert.equal(s.text(), 'abc\ndef', 'MOTIONS-02 dd on an empty line deletes just that line');
  }
  {
    const s = session('\nfoo');
    await type(s, keys('j'));
    assert.equal(s.text(), '\nfoo', 'MOTIONS-03 a document starting with an empty line does not throw on construction/motion');
  }
  {
    const s = session('abc\ndef');
    await type(s, keys('D'));
    assert.equal(s.text(), '\ndef', 'MOTIONS-04 D on a line does not throw once its line becomes empty');
  }

  // 2. Normal-mode motion dispatch: word/structural/find-repeat motions that only worked
  // in Visual mode now work in Normal mode too.
  {
    const s = session('abc def');
    await type(s, keys('w'));
    assert.equal(s.cursor(), 4, 'MOTIONS-05 w moves by word in Normal mode');
  }
  {
    const s = session('(abc)');
    await type(s, keys('%'));
    assert.equal(s.cursor(), 4, 'MOTIONS-06 % jumps to the matching bracket in Normal mode');
  }
  {
    const s = session('aXbXcXd');
    await type(s, keys('fX;'));
    assert.equal(s.cursor(), 3, 'MOTIONS-07 ; repeats the last f/t find in Normal mode');
  }
  {
    const s = session('abcb');
    await type(s, keys('fbfz;'));
    assert.equal(s.cursor(), 1, 'MOTIONS-08 a failed f/t still becomes the ; repeat target (repeats the failed fz, not the earlier fb)');
  }

  // 3. count.value is only passed when the user actually typed digits, so a bare G goes to
  // the last line instead of being treated as an explicit 1G.
  {
    const s = session('a\nb\nc');
    await type(s, keys('G'));
    assert.equal(s.cursor(), 4, 'MOTIONS-09 bare G goes to the last line');
  }
  {
    const s = session('a\nb\nc');
    await type(s, keys('2G'));
    assert.equal(s.cursor(), 2, 'MOTIONS-10 an explicit count still addresses that line with G');
  }

  // 4. cw/ciw/s: the delete and the following insert share one undo group, so a single
  // undo after 'cwfoo<Esc>' restores the original text (Neovim: one undo step).
  {
    const s = session('abc def');
    await type(s, keys('cwfoo<Esc>u'));
    assert.equal(s.text(), 'abc def', 'MOTIONS-11 cw + insert + undo restores the original text in one step');
  }
  {
    const s = session('abc');
    await type(s, keys('sX<Esc>u'));
    assert.equal(s.text(), 'abc', 'MOTIONS-12 s + insert + undo restores the original text in one step');
  }
  {
    const s = session('abc def');
    await type(s, keys('ciwfoo<Esc>u'));
    assert.equal(s.text(), 'abc def', 'MOTIONS-13 ciw + insert + undo restores the original text in one step');
  }

  // 5. Dot-repeat reuses the recorded count when '.' carries no explicit count of its own,
  // and an explicit count on '.' overrides it.
  {
    const s = session('a\nb\nc\nd\ne');
    await type(s, keys('2dd.'));
    assert.equal(s.text(), 'e', 'MOTIONS-14 2dd. deletes 2 more lines, reusing the recorded count');
  }
  {
    const s = session('a b c d e f g h i j');
    await type(s, keys('3dw.'));
    assert.equal(s.text(), 'g h i j', 'MOTIONS-15 3dw. deletes 3 more words, reusing the recorded count');
  }
  {
    const s = session('x');
    await type(s, keys('3ifoo<Esc>.'));
    assert.equal(s.text(), 'foofoofofoofoofooox', 'MOTIONS-16 3ifoo<Esc>. reinserts foo 3 more times, reusing the recorded count');
  }

  // 6. replayMacroKey replays a recorded Ex command line through the Ex path instead of as
  // stray Normal-mode keys.
  {
    const s = session('xa\nya');
    s.vim.beginMacroRecording('a');
    await type(s, keys(':s/a/b/<CR>'));
    await s.vim.handleKey(event('q'));
    await type(s, keys('j@a'));
    assert.equal(s.text(), 'xb\nyb', 'MOTIONS-17 a macro-recorded Ex substitution replays as an Ex command, not literal keys');
  }

  {
    const s = session('a\nb\nc\nd');
    const control = (name: string): OwnedVimKeyEvent => ({ ...event(name), ctrl: true });
    await type(s, keys('Ggg'));
    assert.equal(s.cursor(), 0, 'MOTIONS-18 gg returns to the first line');
    await s.vim.handleKey(control('o'));
    assert.equal(s.cursor(), 6, 'MOTIONS-19 Ctrl-O traverses to the previous jump');
    await s.vim.handleKey(control('p'));
    assert.equal(s.cursor(), 0, 'MOTIONS-20 Ctrl-P traverses forward');
    await type(s, keys('jG'));
    await s.vim.handleKey(control('o'));
    assert.equal(s.cursor(), 2, 'MOTIONS-21 a new jump after a local move records that location');
  }

  console.log('vim-session-motions: all fixtures passed');
}

void main();
