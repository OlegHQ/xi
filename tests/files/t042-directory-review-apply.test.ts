#!/usr/bin/env bun
// T041/T042 composition-root path: `apps/xi/src/main.ts`'s `applyDirectoryReview` reads
// `draft.model.review` (compiled by `openReview()`, native Vim edits only -- rename, yank/put
// as a copy, delete as trash), applies it through `JournaledFilesystemOperations.apply(plan,
// cancellation.token)` exactly as `tests/files/t042-journaled.test.ts` does, then re-enumerates
// the directory into the SAME draft via `DirectoryDraft.refreshFromEntries`. This test exercises
// that exact create(copy)+rename+delete(trash) call sequence end to end; t042-journaled.test.ts
// only builds plans by hand and never calls `refreshFromEntries`.
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '../../packages/contracts/src/index';
import { DirectoryDraft, type DirectoryDraftSourceEntry } from '../../packages/services/files/index';
import { JournaledFilesystemOperations } from '../../packages/services/files/index';
import { openDraftDocument } from './directory-draft-document-factory';
import { NodeFilesystemPort } from '../../packages/platform/src/index';

const token = new CancellationSource().token;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xi-t042-review-'));
  try {
    await testCreateRenameDeleteReviewAppliesAndRefreshes(root);
    console.log('T042 directory-review apply passed: copy(create)+rename+trash(delete) plan applies through JournaledFilesystemOperations and refreshFromEntries re-lists the same draft');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCreateRenameDeleteReviewAppliesAndRefreshes(root: string): Promise<void> {
  const directory = join(root, 'workspace');
  const a = join(directory, 'a.txt');
  const b = join(directory, 'b.txt');
  await mkdir(directory, { recursive: true });
  await writeFile(a, 'alpha\n');
  await writeFile(b, 'beta\n');

  const entries: readonly DirectoryDraftSourceEntry[] = [
    { id: 'row-a', name: 'a.txt', path: a, stableIdentity: 'a' },
    { id: 'row-b', name: 'b.txt', path: b, stableIdentity: 'b' },
  ];
  const created = DirectoryDraft.create(directory, entries, openDraftDocument);
  assert.equal(created.ok, true, 'T042-REVIEW-01 draft initializes');
  if (!created.ok) return;
  const draft = created.value;

  // Native draft edits: rename a.txt, yank+put b.txt as a copy (create), delete b.txt (trash).
  assert.equal(draft.rename('row-a', 'a-renamed.txt').ok, true, 'T042-REVIEW-02 rename edits draft only');
  const yanked = draft.yank(['row-b']);
  assert.equal(yanked.ok, true, 'T042-REVIEW-03 yank succeeds');
  if (!yanked.ok) return;
  const pasted = draft.put(yanked.value, 'row-b');
  assert.equal(pasted.ok, true, 'T042-REVIEW-04 put creates a copy candidate row');
  if (!pasted.ok) return;
  const pastedRowId = pasted.value[0];
  assert.notEqual(pastedRowId, undefined, 'T042-REVIEW-05 put returns the new row id');
  if (pastedRowId === undefined) return;
  assert.equal(draft.rename(pastedRowId, 'b-copy.txt').ok, true, 'T042-REVIEW-06 rename the copy candidate to its destination name');
  assert.equal(draft.delete(['row-b']).ok, true, 'T042-REVIEW-07 delete marks the original for trash');

  const opened = draft.openReview();
  assert.equal(opened.ok, true, 'T042-REVIEW-08 review compiles a plan from draft-only edits');
  if (!opened.ok) return;
  const plan = opened.value;
  assert.equal(plan.operations.length, 3, 'T042-REVIEW-09 plan has one rename, one copy and one trash operation');
  assert.equal(plan.operations.some((operation) => operation.kind === 'rename'), true, 'T042-REVIEW-10 plan includes the rename');
  assert.equal(plan.operations.some((operation) => operation.kind === 'copy'), true, 'T042-REVIEW-11 plan includes the copy (create)');
  assert.equal(plan.operations.some((operation) => operation.kind === 'trash'), true, 'T042-REVIEW-12 plan includes the trash (delete)');

  const service = new JournaledFilesystemOperations(new NodeFilesystemPort());
  const applied = await service.apply(plan, token);
  assert.equal(applied.ok, true, 'T042-REVIEW-13 plan applies through the same journaled service main.ts uses');

  assert.equal(await readFile(join(directory, 'a-renamed.txt'), 'utf8'), 'alpha\n', 'T042-REVIEW-14 rename landed on disk');
  assert.equal(await readFile(join(directory, 'b-copy.txt'), 'utf8'), 'beta\n', 'T042-REVIEW-15 copy (create) landed on disk');
  await assert.rejects(readFile(b, 'utf8'), 'T042-REVIEW-16 the original is gone (trashed, not left in place)');

  // Re-enumerate the directory back into the same draft/document, exactly as
  // `applyDirectoryReview` does after a successful apply.
  const diskEntries = await readdir(directory, { withFileTypes: true });
  const freshEntries: readonly DirectoryDraftSourceEntry[] = diskEntries
    .filter((entry) => entry.isFile())
    .map((entry, index) => ({ id: `fresh-${index + 1}`, name: entry.name, path: join(directory, entry.name), kind: 'file' as const }));
  const refreshed = draft.refreshFromEntries(freshEntries);
  assert.equal(refreshed.ok, true, 'T042-REVIEW-17 refreshFromEntries accepts the post-apply listing');
  const model = draft.model;
  assert.equal(model.focus, 'edit', 'T042-REVIEW-18 refresh returns focus to edit');
  assert.equal(model.review, undefined, 'T042-REVIEW-19 refresh clears the stale review');
  assert.equal(model.rows.some((row) => row.escapedName === 'a-renamed.txt'), true, 'T042-REVIEW-20 refreshed rows reflect the new on-disk name');
  assert.equal(model.rows.some((row) => row.escapedName === 'b-copy.txt'), true, 'T042-REVIEW-21 refreshed rows reflect the created file');
  assert.equal(model.rows.some((row) => row.escapedName === 'b.txt'), false, 'T042-REVIEW-22 the deleted file no longer appears');
}

await main();
