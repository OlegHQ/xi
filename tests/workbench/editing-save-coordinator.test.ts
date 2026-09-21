import { strict as assert } from 'node:assert';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
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

// T036-INSERT-FINAL-NEWLINE-UNIT-01: the default save policy adds one LF through the
// workbench edit port before persistence, so the document owner—not persistence—owns the
// mutation.
{
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
    applyDocumentEdits: async (_documentId: unknown, edits: readonly { readonly start: number; readonly end: number; readonly text: string }[]) => {
      appliedEdits.push(...edits);
      return { ok: true as const, value: {} };
    },
    applyTextEdits: async () => ({ ok: true as const, value: {} }),
  };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: false,
    insertFinalNewline: true,
    createFormatterPipeline: async () => undefined,
  });
  const document = {
    id: 'doc-final-newline',
    version: 1,
    snapshot: () => ({ hasFinalNewline: false, lengthUtf16: 5 }),
  };
  assert.equal(await coordinator.requestSave(document as never, '/workspace/a.txt', undefined), true, 'T036-INSERT-FINAL-NEWLINE-UNIT-01 save succeeds after inserting the final newline');
  assert.deepEqual(appliedEdits, [{ start: 5, end: 5, text: '\n' }], 'T036-INSERT-FINAL-NEWLINE-UNIT-02 final newline is one document-owner insertion at EOF');
  coordinator.dispose();
}

// T036-SAVE-TRIMS-UNIT-01: both write-time trims are one document transaction and preserve
// the existing final newline rather than rewriting the whole document through persistence.
{
  const appliedEdits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  const content = 'hello  \nworld  \n\n\n';
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
    applyDocumentEdits: async (_documentId: unknown, edits: readonly { readonly start: number; readonly end: number; readonly text: string }[]) => {
      appliedEdits.push(...edits);
      return { ok: true as const, value: {} };
    },
    applyTextEdits: async () => ({ ok: true as const, value: {} }),
  };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: false,
    insertFinalNewline: false,
    trimFinalNewlines: true,
    trimTrailingWhitespace: true,
    createFormatterPipeline: async () => undefined,
  });
  const document = {
    id: 'doc-save-trims',
    version: 1,
    snapshot: () => ({
      hasFinalNewline: true,
      lengthUtf16: content.length,
      slice: (start: number, end: number) => ({ ok: true as const, value: content.slice(start, end) }),
    }),
  };
  assert.equal(await coordinator.requestSave(document as never, '/workspace/a.txt', undefined), true, 'T036-SAVE-TRIMS-UNIT-01 save succeeds after applying trim edits');
  assert.deepEqual(appliedEdits, [
    { start: 5, end: 7, text: '' },
    { start: 13, end: 15, text: '' },
    { start: 16, end: 18, text: '' },
  ], 'T036-SAVE-TRIMS-UNIT-02 trims trailing spaces and extra final newlines without replacing the document');
  coordinator.dispose();
}

// T036-AUTO-SAVE-UNIT-01: delayed auto-save uses the same guarded persistence path and fires
// once for a dirty, named buffer after the configured quiet period.
{
  let saveCalls = 0;
  const documentId = asIdentifier<DocumentId>('doc-auto-save', 'T036-auto-save-document');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const document = { id: documentId.value, version: 1 };
  const persistence: SaveCoordinatorPersistencePort = {
    saveFile: async () => { saveCalls += 1; return { ok: true, value: undefined }; },
    clearRecovery: async () => ({ ok: true, value: undefined }),
    checkpoint: async () => ({ ok: true, value: undefined }),
  };
  const host = { documents: new Map([[document.id, document]]), sessions: new Map() };
  const session = { buffers: () => [{ documentId: document.id, path: '/workspace/main.txt', dirty: true }], views: () => [], buffer: () => undefined, applyDocumentEdits: async () => ({ ok: true, value: {} }), applyTextEdits: async () => ({ ok: true, value: {} }) };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: false,
    autoSaveAfterDelay: { enable: true, timeout: 5 },
    createFormatterPipeline: async () => undefined,
  });
  coordinator.scheduleAutoSave(document.id);
  await sleep(20);
  assert.equal(saveCalls, 1, 'T036-AUTO-SAVE-UNIT-01 delayed auto-save writes a dirty named buffer once');
  coordinator.dispose();
}

// T036-AUTO-SAVE-FOCUS-UNIT-01: terminal focus loss saves every dirty named buffer
// through the same guarded path, while focus restoration and disabled config are no-ops.
{
  let saveCalls = 0;
  const documentId = asIdentifier<DocumentId>('doc-focus-save', 'T036-focus-save-document');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const document = { id: documentId.value, version: 1 };
  const persistence: SaveCoordinatorPersistencePort = {
    saveFile: async () => { saveCalls += 1; return { ok: true, value: undefined }; },
    clearRecovery: async () => ({ ok: true, value: undefined }),
    checkpoint: async () => ({ ok: true, value: undefined }),
  };
  const host = { documents: new Map([[document.id, document]]), sessions: new Map() };
  const session = { buffers: () => [{ documentId: document.id, path: '/workspace/focus.txt', dirty: true }], views: () => [], buffer: () => undefined, applyDocumentEdits: async () => ({ ok: true, value: {} }), applyTextEdits: async () => ({ ok: true, value: {} }) };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: false,
    autoSaveFocusLost: true,
    createFormatterPipeline: async () => undefined,
  });
  coordinator.handleFocusChange(true);
  assert.equal(saveCalls, 0, 'T036-AUTO-SAVE-FOCUS-UNIT-01 focus restoration does not save');
  coordinator.handleFocusChange(false);
  await sleep(10);
  assert.equal(saveCalls, 1, 'T036-AUTO-SAVE-FOCUS-UNIT-01 focus loss saves the dirty named buffer');
  coordinator.dispose();
}

console.log('G1/G3 SaveCoordinator mid-save-edit fixtures passed');
