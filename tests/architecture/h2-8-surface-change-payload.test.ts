import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost, type SurfaceChangePayload } from '../../packages/workbench/host/index';

// H2-8: BufferHost.notifySurfaceChange() used to be a zero-payload broadcast (`() => void`)
// from 11 call sites across the composition root, telling every subscriber only "something
// changed". It now takes an optional typed SurfaceChangePayload, coalesces every payload
// raised within one macrotask into a single listener pass, and the old zero-arg call/listener
// shapes keep working unchanged (a wrapper, not a breaking rename).

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'H2-8-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value = 'alpha\n'): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const launchDocumentId = id<DocumentId>('H2-8-launch-document');
const launchDocument = document(launchDocumentId);
const session = new WorkbenchSession({ workspaceId: 'H2-8' });
const launchViewId = id<ViewId>('H2-8-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId });

const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: () => undefined,
  marker: () => {},
  launchViewId,
});

// 1. The pre-H2-8 zero-arg call/listener shapes still compile and still fire.
let legacyCalls = 0;
const legacySubscription = host.onSurfaceChange(() => { legacyCalls += 1; });
host.notifySurfaceChange();
await flush();
assert.equal(legacyCalls, 1, 'H2-8-01 a zero-arg notifySurfaceChange() still reaches a zero-arg listener');
legacySubscription.dispose();

// 2. A typed payload reaches a listener that reads it.
const seen: SurfaceChangePayload[][] = [];
const typedSubscription = host.onSurfaceChange((payloads) => { seen.push([...payloads]); });
host.notifySurfaceChange({ kind: 'git-status', generation: 3 });
await flush();
assert.equal(seen.length, 1, 'H2-8-02 exactly one coalesced listener pass fires');
assert.deepEqual(seen[0], [{ kind: 'git-status', generation: 3 }], 'H2-8-03 the payload reaches the listener intact');

// 3. Multiple notifySurfaceChange() calls within one macrotask coalesce into a single listener
// pass carrying every payload, not one pass per call.
seen.length = 0;
host.notifySurfaceChange({ kind: 'explorer', documentId: launchDocumentId });
host.notifySurfaceChange({ kind: 'search', generation: 7 });
host.notifySurfaceChange();
await flush();
assert.equal(seen.length, 1, 'H2-8-04 three notifySurfaceChange() calls in the same macrotask coalesce into one listener pass');
assert.equal(seen[0]?.length, 3, 'H2-8-05 the coalesced pass carries all three payloads');
assert.equal(seen[0]?.[0]?.kind, 'explorer', 'H2-8-06 payload order is preserved');
assert.equal(seen[0]?.[2]?.kind, 'unspecified', 'H2-8-07 a bare notifySurfaceChange() defaults to kind "unspecified"');

typedSubscription.dispose();
console.log('H2-8 BufferHost.notifySurfaceChange() carries a typed payload, coalesces per macrotask, and keeps the old zero-arg shape working');
