import { strict as assert } from 'node:assert';
import { asUtf16Offset } from '../../packages/primitives/src/index';
import type { ClockPort, Disposable } from '../../packages/contracts/src/index';
import { SaveCoordinator, type FormatterPipelinePort, type SaveCoordinatorPersistencePort } from '../../packages/workbench/editing/save-coordinator';

const testClock: ClockPort = {
  monotonicMilliseconds: () => Date.now(),
  schedule: (delayMilliseconds: number, callback: () => void): Disposable => {
    const handle = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ dispose: () => clearTimeout(handle) });
  },
  sleep: async () => ({ ok: true, value: undefined }),
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// G1: `requestSave`, `:w`, type (a new version committed), `:w` again while the first save is
// still writing. The second call must not silently resolve to the first (stale) save's result:
// it must produce a follow-up save that actually persists the newer version's bytes.
{
  const savedVersions: number[] = [];
  const persistence: SaveCoordinatorPersistencePort = {
    saveFile: async (document) => { savedVersions.push((document as { readonly version: number }).version); await sleep(15); return { ok: true, value: undefined }; },
    clearRecovery: async () => ({ ok: true, value: undefined }),
    checkpoint: async () => ({ ok: true, value: undefined }),
  };
  const host = { documents: new Map(), sessions: new Map() };
  const session = { buffers: () => [], views: () => [], buffer: () => undefined, applyDocumentEdits: async () => ({ ok: true, value: {} }), applyTextEdits: async () => ({ ok: true, value: {} }) };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: false,
    createFormatterPipeline: async () => undefined,
  });

  const document = { id: 'doc-1', version: 1 };
  const first = coordinator.requestSave(document as never, '/workspace/a.txt', undefined);
  // A keystroke commits (bumps the document's version) while the first save is still in
  // flight, then the user saves again -- both calls happen before any await, exactly like two
  // back-to-back `:w` commands separated only by a synchronous edit.
  document.version = 2;
  const second = coordinator.requestSave(document as never, '/workspace/a.txt', undefined);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, true, 'G1-01 the first save reports success');
  assert.equal(secondResult, true, 'G1-02 the follow-up save reports success');
  // The mock reads the live document reference when the write actually executes, so both
  // calls observe the already-committed version 2 (this coordinator only controls whether a
  // *second real write* happens at all, not the underlying persistence port's own read timing).
  // What matters is that the buggy dedupe path (return the first save's promise as-is) would
  // have produced exactly one `saveFile` call here; the fix must produce two.
  assert.deepEqual(savedVersions, [2, 2], 'G1-03 a follow-up save actually ran (two real writes), not a silent dedupe onto the stale in-flight save');

  coordinator.dispose();
}

// G1 regression guard: two concurrent requests for the *same* (unchanged) version must still
// dedupe into a single underlying save -- the fix must not turn every concurrent `:w` into a
// double write.
{
  let saveCalls = 0;
  const persistence: SaveCoordinatorPersistencePort = {
    saveFile: async () => { saveCalls += 1; await sleep(5); return { ok: true, value: undefined }; },
    clearRecovery: async () => ({ ok: true, value: undefined }),
    checkpoint: async () => ({ ok: true, value: undefined }),
  };
  const host = { documents: new Map(), sessions: new Map() };
  const session = { buffers: () => [], views: () => [], buffer: () => undefined, applyDocumentEdits: async () => ({ ok: true, value: {} }), applyTextEdits: async () => ({ ok: true, value: {} }) };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: false,
    createFormatterPipeline: async () => undefined,
  });

  const document = { id: 'doc-1', version: 1 };
  const [first, second] = await Promise.all([
    coordinator.requestSave(document as never, '/workspace/a.txt', undefined),
    coordinator.requestSave(document as never, '/workspace/a.txt', undefined),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(saveCalls, 1, 'G1-04 two concurrent saves of an unchanged version still dedupe into one underlying save');

  coordinator.dispose();
}

// G3: format-on-save applies a whole-document replace sized from the pre-format snapshot. If
// the document changes mid-format (a keystroke committed while an external formatter process
// runs), applying an edit built from the stale snapshot's length would clobber those newer
// bytes. The version must be re-checked immediately before applying, and retried against a
// fresh snapshot instead.
{
  let content = 'hello';
  let version = 1;
  let mutatedOnce = false;
  const fakeDocument = {
    id: 'doc-2',
    get version(): number { return version; },
    snapshot: () => {
      const capturedContent = content;
      const capturedVersion = version;
      return {
        id: 'doc-2',
        version: capturedVersion,
        revisionId: `rev-${capturedVersion}`,
        lengthUtf16: capturedContent.length,
        slice: (start: number, end: number) => ({ ok: true, value: capturedContent.slice(start as number, end as number) }),
      };
    },
  };

  let formatCalls = 0;
  const pipeline: FormatterPipelinePort = {
    dispose: () => {},
    formatTwiceStable: async (_doc, currentVersion) => {
      formatCalls += 1;
      if (!mutatedOnce) {
        // Simulate a keystroke landing while the (first) format request is still running.
        mutatedOnce = true;
        content = 'hello world, more text';
        version += 1;
        await sleep(5);
      }
      return { ok: true, value: { changed: true, text: 'FORMATTED', expectedVersion: currentVersion(), formatterIds: ['fake'] } };
    },
  };

  const appliedEdits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  const persistence: SaveCoordinatorPersistencePort = {
    saveFile: async () => ({ ok: true, value: undefined }),
    clearRecovery: async () => ({ ok: true, value: undefined }),
    checkpoint: async () => ({ ok: true, value: undefined }),
  };
  const host = { documents: new Map(), sessions: new Map() };
  const session = {
    buffers: () => [],
    views: () => [],
    buffer: () => undefined,
    applyDocumentEdits: async (_documentId: unknown, edits: readonly { readonly start: unknown; readonly end: unknown; readonly text: string }[]) => {
      for (const edit of edits) appliedEdits.push({ start: asUtf16Offset(0).ok ? (edit.start as number) : -1, end: edit.end as number, text: edit.text });
      return { ok: true, value: {} };
    },
    applyTextEdits: async () => ({ ok: true, value: {} }),
  };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: true,
    createFormatterPipeline: async () => pipeline,
  });

  const result = await coordinator.requestSave(fakeDocument as never, '/workspace/a.txt', undefined);
  assert.equal(result, true, 'G3-01 the save still succeeds after retrying past the stale mid-format edit');
  assert.equal(formatCalls, 2, 'G3-02 the stale version is detected and the formatter is retried against a fresh snapshot');
  assert.equal(appliedEdits.length, 1, 'G3-03 only the retried (fresh-version) edit is ever applied -- the stale one never reaches applyDocumentEdits');
  assert.equal(appliedEdits[0]?.end, 'hello world, more text'.length, 'G3-04 the applied edit covers the post-edit document length, not the stale pre-edit length (would otherwise truncate the newly typed text)');

  coordinator.dispose();
}

console.log('G1/G3 SaveCoordinator mid-save-edit fixtures passed');
