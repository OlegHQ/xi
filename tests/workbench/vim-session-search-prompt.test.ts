import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSessionOptions } from '../../packages/workbench/vim-session/index';

// Oracle: nvim --headless --clean -u NONE 0.12.4.

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-search-prompt-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('vim-session-search-prompt-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function event(name: string, raw = name): OwnedVimKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

interface Session {
  readonly vim: ReturnType<typeof createOwnedVimSession>;
  readonly doc: TextFileDocument;
  readonly messages: string[];
  cursor(): number | undefined;
  mode(): string | undefined;
  text(): string;
  line(): number;
}

function session(initial: string, extraOptions: Partial<OwnedVimSessionOptions> = {}): Session {
  const doc = document(initial);
  let cursor: number | undefined;
  let mode: string | undefined;
  const messages: string[] = [];
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('vim-session-search-prompt-view'),
    onStateChange: (state) => {
      mode = state.mode;
      const primary = state.selections.members.find((member: { id: unknown }) => member.id === state.selections.primaryId) ?? state.selections.members[0];
      cursor = (primary as { head?: { at?: { offset?: number } } } | undefined)?.head?.at?.offset;
    },
    onMessage: (message) => { messages.push(message); },
    ...extraOptions,
  });
  return {
    vim,
    doc,
    messages,
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
  // 1a. `/` opens a forward search prompt; Enter runs it and moves the Normal cursor to
  // the next match (strictly after the cursor, matching nvim's `/`). nvim: `/foo<CR>` on
  // "aaa\nfoo\naaa\nfoo\naaa\n" from line 1 lands on line 2.
  {
    const s = session('aaa\nfoo\naaa\nfoo\naaa\n');
    await type(s, keys('/foo<CR>'));
    assert.equal(s.line(), 1, 'PROMPT-01 / opens a forward search and Enter moves to the next match');
    assert.equal(s.vim.commandLineActive, false, 'PROMPT-02 the prompt closes after Enter');
  }

  // 1b. `?` opens a backward search prompt; `n`/`N` then continue in the pattern's own
  // persisted direction (`n` repeats, `N` reverses just once), matching v_slash/v_?.
  {
    const s = session('aaa\nfoo\naaa\nfoo\naaa\n');
    await type(s, keys('G'));
    await type(s, keys('?foo<CR>'));
    assert.equal(s.line(), 3, 'PROMPT-03 ? opens a backward search and Enter moves to the previous match');
    await type(s, keys('n'));
    assert.equal(s.line(), 1, 'PROMPT-04 n repeats the backward search');
    await type(s, keys('N'));
    assert.equal(s.line(), 3, 'PROMPT-05 N reverses the last search just this once');
  }

  // 1c. Esc cancels the prompt and restores the pre-search cursor/mode -- nothing about
  // the buffer or cursor changes just from typing a pattern that is never submitted.
  {
    const s = session('aaa\nfoo\naaa\n');
    const before = s.cursor();
    await type(s, keys('/foo'));
    assert.equal(s.vim.commandLineActive, true, 'PROMPT-06 the prompt is open mid-type');
    await type(s, keys('<Esc>'));
    assert.equal(s.vim.commandLineActive, false, 'PROMPT-07 Esc closes the prompt');
    assert.equal(s.cursor(), before, 'PROMPT-08 Esc restores the pre-search cursor');
    assert.equal(s.mode(), 'normal', 'PROMPT-09 Esc leaves Normal mode unchanged');
  }

  // 1d. Backspacing an empty `/`/`?` prompt closes it (nvim), unlike an empty `:` prompt.
  {
    const s = session('aaa\n');
    await type(s, keys('/'));
    assert.equal(s.vim.commandLineActive, true, 'PROMPT-10 / opens the prompt');
    await type(s, keys('<BS>'));
    assert.equal(s.vim.commandLineActive, false, 'PROMPT-11 <BS> on an empty search prompt closes it');
  }

  // 1e. A search that finds nothing anywhere reports E486 and leaves the cursor in place.
  {
    const s = session('aaa\nfoo\naaa\n');
    const before = s.cursor();
    await type(s, keys('/zzz<CR>'));
    assert.equal(s.cursor(), before, 'PROMPT-12 a failed search does not move the cursor');
    assert.ok(s.messages.some((message) => message.includes('E486') && message.includes('zzz')), 'PROMPT-13 a failed search reports E486: Pattern not found');
  }

  // 1f. A forward search that must wrap reports "search hit BOTTOM, continuing at TOP".
  {
    const s = session('aaa\nfoo\naaa\nfoo\naaa\n');
    await type(s, keys('/foo<CR>'));
    assert.equal(s.line(), 1, 'PROMPT-14 first forward match');
    await type(s, keys('/foo<CR>'));
    assert.equal(s.line(), 3, 'PROMPT-15 second forward match');
    s.messages.length = 0;
    await type(s, keys('/foo<CR>'));
    assert.equal(s.line(), 1, 'PROMPT-16 a third search wraps back to the first match');
    assert.ok(s.messages.some((message) => message.includes('hit BOTTOM')), 'PROMPT-17 wrapping reports search hit BOTTOM, continuing at TOP');
  }

  // 1g. An empty `/`+Enter repeats the last committed pattern.
  {
    const s = session('aaa\nfoo\naaa\nfoo\naaa\n');
    await type(s, keys('/foo<CR>'));
    assert.equal(s.line(), 1, 'PROMPT-18 first search establishes the last pattern');
    await type(s, keys('/<CR>'));
    assert.equal(s.line(), 3, 'PROMPT-19 empty / repeats the last pattern');
  }

  // 1h. A count before `/` finds the Nth match forward.
  {
    const s = session('aaa\nfoo\naaa\nfoo\naaa\nfoo\naaa\n');
    await type(s, keys('2/foo<CR>'));
    assert.equal(s.line(), 3, 'PROMPT-20 a count before / finds the 2nd match, skipping the 1st');
  }

  // 1i. `/pattern/e` lands the cursor on the last character of the match (nvim's `e`
  // search-offset), reusing the offset support already in packages/vim/search.
  {
    const s = session('xfooy\n');
    await type(s, keys('/foo/e<CR>'));
    assert.equal(s.cursor(), 3, 'PROMPT-21 /pattern/e lands on the last character of the match');
  }

  // 1j. Visual `/`/`?` extends the active selection's head to the match instead of
  // collapsing to Normal mode (nvim v_/-default).
  {
    const s = session('aaa\nfoo\naaa\n');
    await type(s, keys('v'));
    await type(s, keys('/foo<CR>'));
    assert.equal(s.mode(), 'visual-character', 'PROMPT-22 Visual / keeps Visual mode active');
    assert.equal(s.line(), 1, 'PROMPT-23 Visual / extends the head to the match');
  }

  // 1k. `/`/`?` as an operator-pending motion: `d/foo<CR>` deletes exclusive up to the
  // match (not including it), matching nvim's exclusive search motion.
  {
    const s = session('aaa foo bbb\n');
    await type(s, keys('d/foo<CR>'));
    assert.equal(s.text(), 'foo bbb\n', 'PROMPT-24 d/foo<CR> deletes exclusive up to the match');
    assert.equal(s.cursor(), 0, 'PROMPT-25 the cursor lands at the start of the remaining text');
  }
  {
    // Esc while an operator is pending on a search cancels cleanly (no edit, no crash).
    const s = session('aaa foo bbb\n');
    await type(s, keys('d/fo'));
    await type(s, keys('<Esc>'));
    assert.equal(s.text(), 'aaa foo bbb\n', 'PROMPT-26 Esc during d/... cancels without editing the buffer');
    assert.equal(s.vim.commandLineActive, false, 'PROMPT-27 Esc closes the operator-pending search prompt');
  }

  // 3. Operator-pending H/M/L address the host-reported viewport, linewise (dd-style).
  {
    const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const s = session(text, { viewport: { topLine: () => 2, bottomLine: () => 8 } });
    await type(s, keys('dH'));
    assert.equal(s.text().split('\n')[0], 'l4', 'PROMPT-28 dH deletes linewise from the cursor line through the viewport top line');
  }
  {
    const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const s = session(text, { viewport: { topLine: () => 2, bottomLine: () => 8 } });
    await type(s, keys('dL'));
    assert.equal(s.text(), 'l10\n', 'PROMPT-29 dL deletes linewise from the cursor line through the viewport bottom line');
  }

  // 4. <C-v> numeric literal entry: a non-digit before the maximum digit count terminates
  // the code with the digits typed so far, and the terminating key is then processed
  // normally instead of being rejected. nvim: `i<C-v>1a<Esc>` gives "\x01a".
  {
    const s = session('');
    await type(s, keys('i<C-v>1a<Esc>'));
    assert.equal(s.text(), '\x01a', 'PROMPT-30 a non-digit terminator ends the code and is inserted normally');
  }
  {
    // Escape itself as the terminator both ends the code and exits Insert mode.
    const s = session('');
    await type(s, keys('i<C-v>1<Esc>'));
    assert.equal(s.text(), '\x01', 'PROMPT-31 Escape terminates the code and exits Insert mode');
    assert.equal(s.mode(), 'normal', 'PROMPT-32 the session is back in Normal mode, not stuck or crashed');
  }

  // 5. `/pattern/[+-]N` (nvim's bare-number search-offset, `:help search-offset`): the
  // cursor lands N lines below/above the match's line, in column 1 (not first non-blank).
  {
    const s = session('aaa\nfoo\nccc\nddd\n');
    await type(s, keys('/foo/+1<CR>'));
    assert.equal(s.line(), 2, 'PROMPT-33 /pattern/+1 lands N lines below the match line');
    assert.equal(s.cursor(), 8, 'PROMPT-34 /pattern/+1 puts the cursor in column 1 of that line');
  }
  {
    // A bare "+"/"-" (no digits) means 1, same as nvim's `/pattern/+`.
    const s = session('aaa\nfoo\nccc\nddd\n');
    await type(s, keys('/foo/+<CR>'));
    assert.equal(s.line(), 2, 'PROMPT-35 a bare + offset means 1 line down');
  }
  {
    const s = session('aaa\nfoo\nccc\nddd\n');
    await type(s, keys('G'));
    await type(s, keys('?foo?-1<CR>'));
    assert.equal(s.line(), 0, 'PROMPT-36 ?pattern?-1 lands N lines above the match line, backward search');
    assert.equal(s.cursor(), 0, 'PROMPT-37 the landing column is still 1 for a backward line offset');
  }

  // 6. `n`/`N` reuse the last typed search-offset (nvim carries it forward until a new
  // `/`/`?`/`*`/`#` redefines or clears it).
  {
    const s = session('a foo\nb\nc foo\nd\ne foo\nf\n');
    await type(s, keys('/foo/+1<CR>'));
    assert.equal(s.line(), 1, 'PROMPT-38 first search establishes the +1 offset');
    await type(s, keys('n'));
    assert.equal(s.line(), 3, 'PROMPT-39 n reuses the +1 offset for the next match');
    // A later plain search with no offset text clears it, so a following n lands exactly
    // on the match instead of N lines past it.
    await type(s, keys('/foo<CR>'));
    assert.equal(s.line(), 4, 'PROMPT-40 a plain /pattern<CR> clears the previously typed offset');
    await type(s, keys('n'));
    assert.equal(s.line(), 0, 'PROMPT-41 n after the plain search no longer applies +1');
  }

  // 7. `d/pattern/+1<CR>` (line search-offset as an operator motion) becomes linewise --
  // nvim deletes whole lines from the cursor's line through the offset line, inclusive.
  {
    const s = session('aaa\nfoo\nccc\nddd\n');
    await type(s, keys('d/foo/+1<CR>'));
    assert.equal(s.text(), 'ddd\n', 'PROMPT-42 d/pattern/+1<CR> deletes linewise through the offset line');
    assert.equal(s.cursor(), 0, 'PROMPT-43 the cursor lands at the start of the remaining text');
  }

  console.log('vim-session-search-prompt: all fixtures passed');
}

void main();
