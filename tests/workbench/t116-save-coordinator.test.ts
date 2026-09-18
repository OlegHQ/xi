import { strict as assert } from 'node:assert';
import type { ClockPort, Disposable } from '../../packages/contracts/src/index';
import { SaveCoordinator, type SaveCoordinatorPersistencePort } from '../../packages/workbench/editing/save-coordinator';

const testClock: ClockPort = {
  monotonicMilliseconds: () => Date.now(),
  schedule: (delayMilliseconds: number, callback: () => void): Disposable => {
    const handle = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ dispose: () => clearTimeout(handle) });
  },
  sleep: async () => ({ ok: true, value: undefined }),
};

function fakeDocument(id: string): { readonly id: string } {
  return { id };
}

// T116-SAVE-01: two concurrent `requestSave` calls for the same document dedupe into one
// underlying save -- the persistence port's `saveFile` is invoked exactly once.
{
  let saveCalls = 0;
  const persistence: SaveCoordinatorPersistencePort = {
    saveFile: async () => { saveCalls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true, value: undefined }; },
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

  const document = fakeDocument('doc-1') as never;
  const [first, second] = await Promise.all([
    coordinator.requestSave(document, '/workspace/a.txt', undefined),
    coordinator.requestSave(document, '/workspace/a.txt', undefined),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(saveCalls, 1, 'T116-SAVE-01 concurrent saves of the same document dedupe into one underlying save');

  coordinator.dispose();
}

// T116-SAVE-02: the checkpoint timer is cleared on dispose and never fires afterward, even
// past its debounce delay.
{
  let checkpointCalls = 0;
  const persistence: SaveCoordinatorPersistencePort = {
    saveFile: async () => ({ ok: true, value: undefined }),
    clearRecovery: async () => ({ ok: true, value: undefined }),
    checkpoint: async () => { checkpointCalls += 1; return { ok: true, value: undefined }; },
  };
  const dirtyBuffer = { documentId: 'doc-1', dirty: true, path: '/workspace/a.txt' };
  const host = { documents: new Map([['doc-1', fakeDocument('doc-1')]]), sessions: new Map() };
  const session = { buffers: () => [dirtyBuffer], views: () => [], buffer: () => undefined, applyDocumentEdits: async () => ({ ok: true, value: {} }), applyTextEdits: async () => ({ ok: true, value: {} }) };
  const coordinator = new SaveCoordinator({
    host: host as never,
    session: session as never,
    persistence,
    clock: testClock,
    marker: () => {},
    onError: () => {},
    formatOnSave: false,
    createFormatterPipeline: async () => undefined,
    checkpointDebounceMilliseconds: 10,
  });

  coordinator.scheduleCheckpoint('doc-1' as never);
  coordinator.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(checkpointCalls, 0, 'T116-SAVE-02 the checkpoint timer was cleared on dispose and never wrote after teardown');
}

console.log('T116 SaveCoordinator passed concurrent-save-dedupe and checkpoint-cleared-on-dispose fixtures');
