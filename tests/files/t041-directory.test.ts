#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import {
  DirectoryDraft,
  escapeDirectoryName,
  type DirectoryDraftSourceEntry,
} from '../../packages/services/files/index';
import type { DirectoryDraftDocumentOpener } from '../../packages/services/files/directory-draft';
import {
  DirectoryReviewFocusLifecycle,
  formatDirectoryReviewLines,
} from '../../packages/ui/directory/index';
import { FocusGraph } from '../../packages/workbench/focus/index';
import { openTextDocument } from '../../packages/document/src/index';
import type { DocumentId } from '../../packages/contracts/src/index';

// DirectoryDraft (a service) never opens documents itself; tests stand in for the
// workbench/composition root that owns the real document (docs/architecture.md).
const openDraftDocument: DirectoryDraftDocumentOpener = (id, text) => {
  const opened = openTextDocument(id as DocumentId, new TextEncoder().encode(text), 41027, { fileFormat: 'unix' });
  if (opened.kind !== 'editable') return { ok: false, error: `document open failed: ${opened.kind}` };
  return { ok: true, value: opened.document };
};

const entries: readonly DirectoryDraftSourceEntry[] = [
  { id: 'source-alpha', name: 'alpha.txt', path: '/workspace/alpha.txt', stableIdentity: 'inode-a' },
  { id: 'source-beta', name: 'beta.txt', path: '/workspace/beta.txt', stableIdentity: 'inode-b' },
  { id: 'source-newline', name: 'line\nname', path: '/workspace/line\nname', stableIdentity: 'inode-n' },
];

function draft() {
  const created = DirectoryDraft.create('/workspace', entries, openDraftDocument);
  assert.equal(created.ok, true);
  if (created.ok) return created.value;
  throw new Error('directory draft fixture failed to initialize');
}

async function main(): Promise<void> {
  testNativeDraftOperationsAndEscaping();
  testPublishWhenSubscribed();
  testInvalidRowsPreserveDraft();
  testDuplicateAndAmbiguousIdentityFailures();
  await testReviewCancelRestoresEditFocus();
  console.log('T041 directory draft passed native in-memory edits, anchored IDs, reversible control-name escaping, located validation errors, duplicate/collision rejection and review focus restoration');
}

function testPublishWhenSubscribed(): void {
  const editable = draft();
  const published: string[] = [];
  const subscription = editable.subscribe((model) => { published.push(model.text); });
  assert.equal(editable.rename('source-alpha', 'renamed.txt').ok, true);
  assert.equal(published[0], 'renamed.txt\nbeta.txt\nline\\nname', 'T041-PUBLISH-01 subscribers receive the updated model');
  subscription.dispose();
}

function testNativeDraftOperationsAndEscaping(): void {
  const model = draft().model;
  assert.equal(model.text, 'alpha.txt\nbeta.txt\nline\\nname', 'T041-ESCAPE-01 newline filename is represented reversibly');
  assert.equal(escapeDirectoryName('tab\tcr\rslash\\'), 'tab\\tcr\\rslash\\\\', 'T041-ESCAPE-02 tabs, CR and slash escapes are reversible');

  const editable = draft();
  const renamed = editable.rename('source-alpha', 'renamed.txt');
  assert.equal(renamed.ok, true, 'T041-NATIVE-01 rename edits draft only');
  const yank = editable.yank(['source-beta']);
  assert.equal(yank.ok, true, 'T041-NATIVE-02 yank does not touch disk');
  if (!yank.ok) return;
  const put = editable.put(yank.value, 'source-alpha');
  assert.equal(put.ok, true, 'T041-NATIVE-03 put creates an explicit copy row');
  if (put.ok) assert.equal(editable.rename(put.value[0] ?? '', 'beta-copy.txt').ok, true, 'T041-NATIVE-03b copy candidate can be given a distinct destination');
  const deleted = editable.delete(['source-newline']);
  assert.equal(deleted.ok, true, 'T041-NATIVE-04 delete edits the draft only');
  const plan = editable.compilePlan();
  assert.equal(plan.ok, true, 'T041-NATIVE-05 native edits compile without filesystem access');
  if (plan.ok) {
    assert.deepEqual(plan.value.operations.map((operation) => operation.kind), ['rename', 'copy', 'trash']);
    const copy = plan.value.operations.find((operation) => operation.kind === 'copy');
    assert.equal(copy?.destinationPath, '/workspace/beta-copy.txt', 'T041-NATIVE-06 copy candidate retains source identity and destination');
  }
  const empty = draft();
  assert.equal(empty.delete(['source-alpha', 'source-beta', 'source-newline']).ok, true, 'T041-NATIVE-07 deleting every row leaves an empty draft');
  const emptyPlan = empty.compilePlan();
  assert.equal(emptyPlan.ok, true, 'T041-NATIVE-08 an empty draft compiles trash operations');
  if (emptyPlan.ok) assert.equal(emptyPlan.value.operations.filter((operation) => operation.kind === 'trash').length, 3);
}

function testInvalidRowsPreserveDraft(): void {
  const editable = draft();
  const before = editable.text;
  const changed = editable.setRowText('source-alpha', 'bad\\q');
  assert.equal(changed.ok, true, 'T041-INVALID-01 arbitrary Vim row text remains editable before review');
  const failed = editable.compilePlan();
  assert.equal(failed.ok, false, 'T041-INVALID-02 malformed escaped row blocks plan compilation');
  if (!failed.ok) {
    assert.equal(failed.error.kind, 'invalid-escape');
    assert.equal(failed.error.rowId, 'source-alpha');
    assert.equal(failed.error.line, 0);
    assert.equal(failed.error.column, 3);
  }
  assert.equal(editable.model.text, 'bad\\q\nbeta.txt\nline\\nname', 'T041-INVALID-03 invalid draft text is preserved');
  assert.notEqual(editable.text, before);
  assert.equal(editable.model.error?.line, 0, 'T041-INVALID-04 error is located on the invalid row');
}

function testDuplicateAndAmbiguousIdentityFailures(): void {
  const duplicate = draft();
  const yank = duplicate.yank(['source-alpha']);
  assert.equal(yank.ok, true);
  if (!yank.ok) return;
  assert.equal(duplicate.paste(yank.value, { preserveIdentity: true }).ok, true, 'T041-FAIL-DUP-01 imported paste can retain identity for validation');
  const duplicateText = duplicate.text;
  const duplicatePlan = duplicate.compilePlan();
  assert.equal(duplicatePlan.ok, false, 'T041-FAIL-DUP-02 duplicate identity is rejected');
  if (!duplicatePlan.ok) assert.equal(duplicatePlan.error.kind, 'duplicate-id');
  assert.equal(duplicate.text, duplicateText, 'T041-FAIL-DUP-03 duplicate identity keeps draft text');

  const collision = draft();
  assert.equal(collision.rename('source-alpha', 'beta.txt').ok, true);
  const collisionPlan = collision.compilePlan();
  assert.equal(collisionPlan.ok, false, 'T041-FAIL-AMB-01 destination collision rejects ambiguous rename');
  if (!collisionPlan.ok) {
    assert.equal(collisionPlan.error.kind, 'duplicate-destination');
    assert.equal(collisionPlan.error.rowId, 'source-beta');
  }
}

async function testReviewCancelRestoresEditFocus(): Promise<void> {
  const editable = draft();
  assert.equal(editable.rename('source-alpha', 'reviewed.txt').ok, true);
  const expectedText = editable.text;
  const review = editable.openReview();
  assert.equal(review.ok, true, 'T041-REVIEW-01 :w opens a review plan');
  assert.equal(editable.model.focus, 'review');
  assert.match(formatDirectoryReviewLines(editable.model, 60, 8).join('\n'), /reviewed\.txt/u, 'T041-REVIEW-02 review lists rename candidate');

  const graph = new FocusGraph();
  const editor = graph.register({ id: 'directory-editor', kind: 'editor', contexts: ['directory-edit'] });
  assert.equal(editor.ok, true);
  const lifecycle = new DirectoryReviewFocusLifecycle({
    focus: graph,
    onCancelReview: () => { editable.cancelReview(); },
  });
  assert.equal(lifecycle.open().ok, true, 'T041-REVIEW-03 review captures editor focus');
  assert.equal(graph.snapshot.activeTargetId, lifecycle.targetId);
  const cancelled = await lifecycle.cancel();
  assert.equal(cancelled.ok, true, 'T041-REVIEW-04 cancel succeeds');
  assert.equal(editable.model.focus, 'edit', 'T041-REVIEW-05 cancel restores directory edit focus');
  assert.equal(editable.text, expectedText, 'T041-REVIEW-06 cancel preserves draft text');
  assert.equal(graph.snapshot.activeTargetId, 'directory-editor', 'T041-REVIEW-07 FocusGraph restores source editor');
  lifecycle.dispose();
  graph.dispose();
}

await main();
