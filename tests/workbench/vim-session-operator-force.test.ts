import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSessionOptions } from '../../packages/workbench/vim-session/index';

// Regression: the parser (packages/vim/parser/index.ts) emits `force: 'v' | 'V' | '<C-v>'`
// on `operator-motion` commands for o_v/o_V/o_CTRL-V (:help o_v -- a v/V/<C-v> typed right
// after the operator overrides the motion's own wise-ness), and
// packages/vim/multi/index.ts's `prepareVimMultiOperator` already honors `force` (see
// tests/vim/multi/p2-operator-force.test.ts), but nothing in
// packages/workbench/vim-session/index.ts threaded `command.force` through to that call, so
// end-to-end `dvj` behaved like plain `dj`. This drives the real keystrokes through the
// owned session to prove the wiring, not just the underlying multi-operator primitive.
//
// Oracle: .artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE -i NONE
//   -c 'call setline(1,["abc","def","ghi"])' -c 'call cursor(1,2)'
//   -c 'execute "normal! dvj"' -c 'echo join(getline(1,"$"),"|")' -c 'q!'
//   -> abc\ndef\nghi cursor(1,2) [0-based offset 1], dvj -> aef|ghi
//   -c 'execute "normal! dVl"' on the same buffer/cursor -> def|ghi
//   -c "execute \"normal! d\\<C-v>j\"" on the same buffer/cursor -> ac|df|ghi

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-operator-force-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('vim-session-operator-force-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
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

function session(initial: string, extraOptions: Partial<OwnedVimSessionOptions> = {}): Session {
  const doc = document(initial);
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('vim-session-operator-force-view'),
    ...extraOptions,
  });
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

async function type(target: Session, keyEvents: readonly OwnedVimKeyEvent[]): Promise<void> {
  for (const key of keyEvents) await target.vim.handleKey(key);
}

/** Tokenizes `<C-x>` alongside plain characters, matching the sibling prompt test. */
function keys(source: string): OwnedVimKeyEvent[] {
  const out: OwnedVimKeyEvent[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '<') {
      const end = source.indexOf('>', index);
      const token = source.slice(index + 1, end);
      index = end + 1;
      if (token.startsWith('C-')) out.push({ name: token.slice(2), raw: token.slice(2), shift: false, option: false, ctrl: true, meta: false });
      else out.push(event(token));
      continue;
    }
    out.push(event(char === ' ' ? 'space' : char, char));
    index += 1;
  }
  return out;
}

async function main(): Promise<void> {
  // dvj: j is linewise; forced characterwise -> exclusive from the cursor to the same
  // column on the next line. Without force wiring this would behave like plain `dj`
  // (whole-line delete). Cursor starts on 'b' (offset 1, i.e. nvim column 2) --
  // `call cursor(1,2)` in the oracle command above.
  {
    const s = session('abc\ndef\nghi\n');
    await type(s, keys('l'));
    await type(s, keys('dvj'));
    assert.equal(s.text(), 'aef\nghi\n', 'FORCE-01 dvj forces linewise j to exclusive characterwise');
  }

  // dVl: l is characterwise; forced linewise -> whole line deleted. Without force wiring
  // this would behave like plain `dl`.
  {
    const s = session('abc\ndef\nghi\n');
    await type(s, keys('l'));
    await type(s, keys('dVl'));
    assert.equal(s.text(), 'def\nghi\n', 'FORCE-02 dVl forces l to linewise');
  }

  // d<C-v>j: blockwise force -- deletes the same column on both the cursor's line and the
  // line below. Without force wiring this would behave like plain `dj`.
  {
    const s = session('abc\ndef\nghi\n');
    await type(s, keys('l'));
    await type(s, keys('d<C-v>j'));
    assert.equal(s.text(), 'ac\ndf\nghi\n', 'FORCE-03 d<C-v>j forces blockwise deletion of the cursor column');
  }

  console.log('vim-session-operator-force: all fixtures passed');
}

void main();
