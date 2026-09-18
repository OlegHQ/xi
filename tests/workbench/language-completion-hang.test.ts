// F1-1 regression: `CompletionSnippetController.openCompletion` must not spin forever when
// `ensureLanguage()` resolves (a memoized, already-resolved promise -- "no language server
// applies to this file", matching `apps/xi/src/wiring/language.ts`'s early return) but the
// completion controller/provider/session never get attached. Before the fix, the retry
// `void ensureLanguage().then(() => openCompletion(trigger))` re-entered unconditionally on
// every resolution, producing an unbounded microtask loop (the editor going dead) instead of
// terminating. The `ensureLanguage` fake below is itself the timeout guard: it throws once
// called more times than any legitimate single-retry path ever should, so a regression fails
// fast instead of the test process actually hanging.
import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import { CompletionSnippetController } from '../../packages/workbench/language/completion';
import { positionToOffset } from '../../packages/document/src/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'F1-1-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

const documentId = id<DocumentId>('F1-1-document');
const doc = document(documentId, 'alpha\nbeta\n');
const session = new WorkbenchSession({ workspaceId: 'F1-1' });
const viewId = id<ViewId>('F1-1-view');
session.openBuffer(doc, { viewId, path: '/workspace/a.ts' });
const host = new BufferHost(session, doc, {
  openDocument: async () => undefined,
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId: viewId,
});
host.createSession(doc, viewId);

const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
let ensureLanguageCalls = 0;
const MAX_LEGITIMATE_CALLS = 10;
const controller = new CompletionSnippetController({
  host,
  session,
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: () => {},
  fileUri: (path) => `file://${path}`,
  positionToOffset,
  ensureLanguage: (): Promise<void> => {
    ensureLanguageCalls += 1;
    if (ensureLanguageCalls > MAX_LEGITIMATE_CALLS) {
      throw new Error(`F1-1 regression: ensureLanguage retried ${ensureLanguageCalls} times -- openCompletion is spinning`);
    }
    return Promise.resolve();
  },
  ensureOptionalServices: async () => {},
  getSnippetSupport: () => undefined,
});

// No `attachLanguage` call: completion/provider/session stay unattached, matching "no language
// server applies to this file". `buildNavigationRequest` still resolves (there is an active
// view/buffer/cursor), so `request !== undefined` while `controller === undefined` -- the exact
// branch that used to retry unconditionally.
const opened = controller.openCompletion('invoked');
assert.equal(opened, true, 'F1-1a openCompletion reports handled even with no language attached');

// Let the retry's microtask chain run its course. Two flushes are enough for the fixed
// single-retry path (open -> ensureLanguage microtask -> one re-entrant openCompletion call);
// a real timer afterwards is the belt-and-suspenders guard the preamble asks for, bounded by
// the throwing fake above so it can never actually hang the test process.
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 20));

assert.equal(ensureLanguageCalls, 1, `F1-1b ensureLanguage must be retried at most once, was called ${ensureLanguageCalls} times`);
assert.ok(
  markers.some((entry) => entry.name === 'XI_COMPLETION_STATE' && (entry.payload as { readonly state: string }).state === 'unavailable'),
  'F1-1c an unavailable XI_COMPLETION_STATE marker is emitted once the single retry finds no language attached',
);

// Re-opening after settling must behave identically (the retry guard resets per attempt, not
// just once ever).
controller.closeCompletion(false);
const reopened = controller.openCompletion('invoked');
assert.equal(reopened, true, 'F1-1d re-opening after close still reports handled');
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(ensureLanguageCalls, 2, `F1-1e a fresh open retries ensureLanguage exactly once more, was called ${ensureLanguageCalls} times total`);

controller.dispose();
console.log('F1-1 language-completion-hang: PASS');
