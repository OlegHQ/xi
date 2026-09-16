import { strict as assert } from 'node:assert';
import { IncrementalSyntaxHighlighter, type SyntaxParseRequest } from '../../packages/services/syntax/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const documentId = 'T112-document' as DocumentId;
const request = (version: number, text: string): SyntaxParseRequest => ({
  documentId,
  documentVersion: version as DocumentVersion,
  requestId: `T112-request-${version}` as RequestId,
  generation: version,
  text,
});

async function staleParseYieldsToNewInput(): Promise<void> {
  const tasks: Array<() => void> = [];
  const service = new IncrementalSyntaxHighlighter({
    schedule: (task) => { tasks.push(task); },
    maxPendingRequests: 2,
  });
  const large = 'const value = 1;\n'.repeat(20_000);
  assert.equal(service.submit(request(1, large)).accepted, true, 'T112-MAIN-STALL-01 oversized parse is accepted asynchronously');
  assert.equal(tasks.length, 1, 'T112-MAIN-STALL-01 first parse is scheduled instead of running on submit');
  tasks.shift()?.();
  assert.ok(service.diagnostics().resumableSlices >= 1, 'T112-MAIN-STALL-01 parser yields before completing the large request');

  assert.equal(service.submit(request(2, 'const newest = true;')).accepted, true, 'T112-MAIN-STALL-01 input arriving during parse is accepted');
  while (tasks.length > 0) tasks.shift()?.();
  await service.flush();
  assert.equal(service.latest()?.documentVersion, 2 as DocumentVersion, 'T112-MAIN-STALL-01 newest input publishes after stale work is cancelled');
  assert.ok(service.diagnostics().staleIgnored >= 1, 'T112-MAIN-STALL-01 stale parser work is never published');
  assert.ok(service.diagnostics().maxObservedQueuedUtf16Units <= 4 * 1024 * 1024, 'T112-QUEUES-01 queued text stays within the shared UTF-16 credit');
  assert.equal(service.submit(request(4, 'const resync = true;')).accepted, true, 'T112-RESYNC-01 missing delta is accepted as a bounded full resync');
  while (tasks.length > 0) tasks.shift()?.();
  await service.flush();
  assert.ok(service.diagnostics().resyncs >= 1, 'T112-RESYNC-01 missing delta increments the explicit resync counter');
  service.dispose();
}

function rejectsUnadmittablePayloadAndDisposesPendingWork(): void {
  const tasks: Array<() => void> = [];
  const service = new IncrementalSyntaxHighlighter({
    maxPendingUtf16Units: 64,
    schedule: (task) => { tasks.push(task); },
  });
  const rejected = service.submit(request(1, 'x'.repeat(65)));
  assert.equal(rejected.accepted, false, 'T112-QUEUES-02 payload over the byte credit is rejected atomically');
  if (!rejected.accepted) assert.equal(rejected.error.kind, 'queue-full');
  assert.equal(service.pendingRequests(), 0, 'T112-QUEUES-02 rejected work is not retained');

  service.dispose();

  const disposalTasks: Array<() => void> = [];
  const disposalService = new IncrementalSyntaxHighlighter({
    schedule: (task) => { disposalTasks.push(task); },
  });
  const accepted = disposalService.submit(request(2, 'x\n'.repeat(20_000)));
  assert.equal(accepted.accepted, true);
  disposalTasks.shift()?.();
  disposalService.dispose();
  while (disposalTasks.length > 0) disposalTasks.shift()?.();
  assert.equal(disposalService.pendingRequests(), 0, 'T112-DISPOSE-01 disposal releases active and scheduled parser work');
}

await staleParseYieldsToNewInput();
rejectsUnadmittablePayloadAndDisposesPendingWork();
console.log('T112 scheduler passed resumable parse yielding, stale cancellation, UTF-16 queue credits and disposal fixtures');
