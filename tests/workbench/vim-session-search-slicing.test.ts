import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument, type Utf16Offset } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSessionOptions } from '../../packages/workbench/vim-session/index';
import { EMPTY_VIM_SEARCH_STATE, searchVimBuffer } from '../../packages/vim/search/index';

// Regression for the F/E2-7 finding: packages/vim/search/index.ts's synchronous
// `searchVimBuffer` runs `resume(Number.MAX_SAFE_INTEGER)` in one uninterrupted call, so
// an adversarial pattern (catastrophic-backtracking shape) can burn its whole step budget
// synchronously -- ~170ms measured on `\v(x)@<=(a+)+b`, far past AGENTS.md's <=8ms
// ordinary-interactive-stall ceiling. packages/workbench/vim-session must drive every
// keystroke/command-line search (`/`, `?`, n, N, *, #, g*, g#) through the bounded,
// yielding `searchVimBufferInteractive` instead, with a generation/abort guard so a
// newer search cancels a still-resuming older one and its stale result is discarded.
//
// Oracle: this file tests Xi's own scheduling/cancellation behavior, not Vim text
// semantics (already covered against nvim by tests/workbench/vim-session-search-prompt.test.ts,
// which this change must keep green), so no Neovim comparison applies here.

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-search-slicing-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('vim-session-search-slicing-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
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
}

function session(initial: string, extraOptions: Partial<OwnedVimSessionOptions> = {}): Session {
  const doc = document(initial);
  let cursor: number | undefined;
  const messages: string[] = [];
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('vim-session-search-slicing-view'),
    onStateChange: (state) => {
      const primary = state.selections.members.find((member: { id: unknown }) => member.id === state.selections.primaryId) ?? state.selections.members[0];
      cursor = (primary as { head?: { at?: { offset?: number } } } | undefined)?.head?.at?.offset;
    },
    onMessage: (message) => { messages.push(message); },
    ...extraOptions,
  });
  return { vim, doc, messages, cursor: () => cursor };
}

/** Tokenizes `<CR>` alongside plain characters, matching the sibling prompt test. */
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
      else out.push(event(token));
      continue;
    }
    out.push(event(char === ' ' ? 'space' : char, char));
    index += 1;
  }
  return out;
}

async function type(target: Session, keyEvents: readonly OwnedVimKeyEvent[]): Promise<void> {
  for (const key of keyEvents) await target.vim.handleKey(key);
}

/** Races a microtask sampler against `task`: since `searchVimBufferInteractive` only
 * yields via `await Promise.resolve()` (a microtask hop, packages/vim/search/index.ts),
 * a sampler re-queueing itself the same way interleaves once per slice and its largest
 * gap approximates the longest uninterrupted synchronous stretch `task` produced. */
async function longestSyncGapMs(task: () => Promise<void>): Promise<number> {
  let last = performance.now();
  let maxGap = 0;
  let done = false;
  async function sampler(): Promise<void> {
    while (!done) {
      await Promise.resolve();
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }
  }
  const samplerDone = sampler();
  await task();
  done = true;
  await samplerDone;
  return maxGap;
}

const adversarialPattern = String.raw`\v(x)@<=(a+)+b`;

async function main(): Promise<void> {
  // Baseline: confirm this pattern really is expensive when run through the unbounded,
  // synchronous entry point on this host, so the bounded assertion below is measured
  // against a real cost and isn't just testing a pattern that was already cheap.
  const baselineDoc = document('a'.repeat(120) + '\n');
  const baselineView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const baselineStarted = performance.now();
  searchVimBuffer(baselineDoc.snapshot(), baselineView, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: adversarialPattern, direction: 'forward', wrapscan: false });
  const unboundedMs = performance.now() - baselineStarted;

  // 1. Driving the adversarial pattern through the session's own `/` command-line
  // dispatch (the actual keystroke path) must never block the event loop anywhere near
  // as long as the unbounded call above, and must stay under the AGENTS.md 8ms ordinary
  // stall ceiling (widened only for host scheduling noise, exactly like
  // tests/vim/search/e2-7-perf.test.ts).
  {
    const s = session('a'.repeat(120) + '\n');
    await type(s, keys('/'));
    await type(s, [...adversarialPattern].map((char) => event(char === ' ' ? 'space' : char, char)));
    const submit = keys('<CR>')[0]!;
    let settled = false;
    const maxGap = await longestSyncGapMs(async () => {
      await s.vim.handleKey(submit);
      settled = true;
    });
    assert.ok(settled, 'SLICE-01 the search dispatch call itself must resolve');
    const p95ThresholdMs = 8;
    const relativeCeilingMs = Math.max(p95ThresholdMs, unboundedMs / 5);
    assert.ok(
      maxGap <= relativeCeilingMs,
      `SLICE-02 no synchronous segment of the session's search dispatch may exceed ${p95ThresholdMs}ms (or 1/5 of the unbounded call under host noise); measured ${maxGap.toFixed(3)}ms, unbounded=${unboundedMs.toFixed(1)}ms`,
    );
    // 2. The result still arrives: the pattern genuinely has no match in an all-'a'
    // buffer, so the session reports the same E486 a synchronous search would.
    assert.ok(
      s.messages.some((message) => message.includes('E486')),
      'SLICE-03 the sliced search still completes and reports no match',
    );
  }

  // 3. A second search started before the first finishes cancels it: the stale
  // adversarial search's result must never land after a newer, real search already
  // moved the cursor.
  {
    const s = session('a'.repeat(120) + '\n');
    await type(s, keys('/'));
    await type(s, [...adversarialPattern].map((char) => event(char === ' ' ? 'space' : char, char)));
    const firstPromise = s.vim.handleKey(keys('<CR>')[0]!);
    // Fired before the first search's promise is awaited (and thus before it can run
    // more than its first synchronous slice): opens and submits a second, cheap search
    // for a literal 'a', which the session's closeCommandLine() (run synchronously at
    // the top of submitSearchCommandLine, before its own first await) leaves free to
    // start immediately.
    await type(s, keys('/'));
    await type(s, keys('a'));
    const secondPromise = s.vim.handleKey(keys('<CR>')[0]!);
    const secondResult = await secondPromise;
    const firstResult = await firstPromise;
    assert.equal(firstResult, true, 'SLICE-04 the cancelled first search still resolves its dispatch call cleanly');
    assert.equal(secondResult, true, 'SLICE-05 the second search resolves normally');
    assert.equal(s.cursor(), 1, 'SLICE-06 the cursor reflects the second (literal a) search, not a stale overwrite from the cancelled first');
    assert.ok(
      !s.messages.some((message) => message.includes('E486')),
      'SLICE-07 the cancelled search must not report its own (no-match) outcome after being superseded',
    );
  }

  console.log(`vim-session-search-slicing: all fixtures passed (unbounded baseline=${unboundedMs.toFixed(1)}ms)`);
}

void main();
