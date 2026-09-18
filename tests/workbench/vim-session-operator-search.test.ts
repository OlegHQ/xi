import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSessionOptions } from '../../packages/workbench/vim-session/index';

// Regression covering the operator-pending `/`/`?` search-motion path end to end through
// the owned session: `d/pat<CR>`, `y?pat<CR>`, and a not-found pattern leaving the buffer
// untouched with the E486 message. The wiring itself (opening the search prompt on
// operator-motion '/'/'?' in executeCommand, resolving it in submitSearchCommandLine via
// applySearchOperator, Escape cancelling pendingOperatorSearch in closeCommandLine) already
// lives in packages/workbench/vim-session/index.ts; this file exercises it against the
// Neovim oracle rather than re-deriving it.
//
// Oracle: .artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE -i NONE
//   -c 'call setline(1,["abc def"])' -c 'call cursor(1,1)'
//   -c 'execute "normal! d/def\r"' -c 'echo join(getline(1,"$"),"|")' -c 'q!'
//   -> "abc def" cursor(1,1), d/def<CR> -> "def"
//   -c 'call setline(1,["one","two","three"])' -c 'call cursor(1,1)'
//   -c "execute \"normal! d/two/+1\r\"" -c 'echo join(getline(1,"$"),"|")' -c 'q!'
//   -> one/two/three cursor(1,1), d/two/+1<CR> -> ['']  (empty buffer)
//   -c 'call setline(1,["abc def"])' -c 'execute "normal! d/zzz\r"' -c 'echo join(getline(1,"$"),"|")' -c 'q!'
//   -> "abc def" (unchanged); :echo shows "E486: Pattern not found: zzz"

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-operator-search-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('vim-session-operator-search-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
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
  text(): string;
}

function session(initial: string, extraOptions: Partial<OwnedVimSessionOptions> = {}): Session {
  const doc = document(initial);
  const messages: string[] = [];
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('vim-session-operator-search-view'),
    onMessage: (message) => { messages.push(message); },
    ...extraOptions,
  });
  return {
    vim,
    doc,
    messages,
    text: () => {
      const snapshot = doc.snapshot();
      const full = snapshot.slice(0 as unknown as Parameters<typeof snapshot.slice>[0], snapshot.lengthUtf16 as unknown as Parameters<typeof snapshot.slice>[1]);
      return full.ok ? full.value : '<unreadable>';
    },
  };
}

async function type(target: Session, keyEvents: readonly OwnedVimKeyEvent[]): Promise<void> {
  for (const key of keyEvents) await target.vim.handleKey(key);
}

/** Tokenizes `<CR>`/`<Esc>` alongside plain characters, matching the sibling prompt test. */
function keys(source: string): OwnedVimKeyEvent[] {
  const out: OwnedVimKeyEvent[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '<') {
      const end = source.indexOf('>', index);
      const token = source.slice(index + 1, end);
      index = end + 1;
      if (token === 'CR') out.push(event('return', '\r'));
      else if (token === 'Esc') out.push(event('ESC', '\x1b'));
      else out.push(event(token));
      continue;
    }
    out.push(event(char === ' ' ? 'space' : char, char));
    index += 1;
  }
  return out;
}

async function main(): Promise<void> {
  // d/def<CR>: exclusive forward search motion deletes up to (not including) the match.
  {
    const s = session('abc def');
    await type(s, keys('d/def<CR>'));
    assert.equal(s.text(), 'def', 'SEARCH-01 d/def<CR> deletes exclusive up to the match');
  }

  // d/two/+1<CR>: a numeric line search-offset makes the operator motion linewise,
  // spanning whole lines from the cursor's line through the offset line.
  {
    const s = session('one\ntwo\nthree');
    await type(s, keys('d/two/+1<CR>'));
    assert.equal(s.text(), '', 'SEARCH-02 d/two/+1<CR> deletes linewise through the offset line');
  }

  // d/zzz<CR>: no match -- the buffer is untouched and the not-found message is reported;
  // the pending operator must not silently apply against a stale/zero-length range.
  {
    const s = session('abc def');
    await type(s, keys('d/zzz<CR>'));
    assert.equal(s.text(), 'abc def', 'SEARCH-03 d/zzz<CR> leaves the buffer unchanged when no match is found');
    assert.ok(
      s.messages.some((message) => message.includes('E486') && message.includes('zzz')),
      `SEARCH-04 d/zzz<CR> reports the not-found message; got ${JSON.stringify(s.messages)}`,
    );
  }

  // y?abc<CR>: a backward search motion as an operator target (yank), proving the wiring
  // isn't forward-only.
  {
    const s = session('abc def abc');
    // Put the cursor on the second "abc" (offset 8) before searching backward.
    for (let i = 0; i < 8; i += 1) await type(s, keys('l'));
    await type(s, keys('y?abc<CR>'));
    assert.equal(s.text(), 'abc def abc', 'SEARCH-05 y?abc<CR> is a yank -- the buffer is unchanged');
    await type(s, keys('0P'));
    assert.equal(s.text(), 'abc def abc def abc', 'SEARCH-06 the yanked backward-search range is pasted back correctly');
  }

  // Escape while an operator is pending on a search cancels cleanly: no edit, no crash.
  {
    const s = session('abc def');
    await type(s, keys('d/de'));
    await type(s, keys('<Esc>'));
    assert.equal(s.text(), 'abc def', 'SEARCH-07 Esc during d/... cancels without editing the buffer');
    // The session must still be responsive afterward (parser/mode not wedged).
    await type(s, keys('x'));
    assert.equal(s.text(), 'bc def', 'SEARCH-08 the session accepts ordinary keys after the cancelled operator-search');
  }

  console.log('vim-session-operator-search: all fixtures passed');
}

void main();
