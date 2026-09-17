#!/usr/bin/env bun
// T041/T042 wiring: DirectoryDraftController owns directory-draft orchestration end to end
// (open-as-buffer, `:w` opens review, Enter applies the plan and re-lists, Esc cancels,
// `:Explore` resolution) behind structural ports the composition root supplies -- this
// mirrors what `apps/xi/src/main.ts` actually wires (list/stat, create-draft, apply-plan,
// open-buffer, message/marker sinks), replacing the narrower DirectoryDraftPanel test that
// only checked review-focus bookkeeping.
import { strict as assert } from 'node:assert';
import {
  DirectoryDraftController,
  type DirectoryDraftControllerOptions,
  type DirectoryDraftEntryInput,
  type DirectoryDraftPort,
  type DirectoryDraftPortResult,
} from '../../../packages/workbench/directory/index';
import type { DocumentId, ViewId } from '../../../packages/contracts/src/index';

function fakeDraft(directoryPath: string): { readonly port: DirectoryDraftPort; readonly refreshedWith: DirectoryDraftEntryInput[][] } {
  let focus: 'edit' | 'review' = 'edit';
  let review: unknown;
  const refreshedWith: DirectoryDraftEntryInput[][] = [];
  const port: DirectoryDraftPort = {
    get model() { return { focus, directoryPath, review }; },
    subscribe: () => ({ dispose: () => {} }),
    openReview: (): DirectoryDraftPortResult => { focus = 'review'; review = { directoryPath, operations: [{ kind: 'rename' }] }; return { ok: true }; },
    cancelReview: (): DirectoryDraftPortResult => { focus = 'edit'; review = undefined; return { ok: true }; },
    refreshFromEntries: (entries): DirectoryDraftPortResult => { refreshedWith.push([...entries]); focus = 'edit'; review = undefined; return { ok: true }; },
  };
  return { port, refreshedWith };
}

function buildOptions(overrides: Partial<DirectoryDraftControllerOptions> = {}): {
  readonly options: DirectoryDraftControllerOptions;
  readonly errors: string[];
  readonly markers: { readonly name: string; readonly payload?: unknown }[];
  readonly notifyCount: { count: number };
  readonly openedBuffers: string[];
  readonly draftsByPath: Map<string, ReturnType<typeof fakeDraft>>;
} {
  const errors: string[] = [];
  const markers: { readonly name: string; readonly payload?: unknown }[] = [];
  const notifyCount = { count: 0 };
  const openedBuffers: string[] = [];
  const draftsByPath = new Map<string, ReturnType<typeof fakeDraft>>();
  const options: DirectoryDraftControllerOptions = {
    filesystem: {
      isDirectory: async (path) => path === '/workspace/dir' || path === '/workspace',
      listEntries: async (path) => ({ ok: true, value: [{ name: 'a.txt', path: `${path}/a.txt`, kind: 'file' }] }),
      resolvePath: (base, relative) => `${base}/${relative}`,
      directoryPath: (path) => path.slice(0, path.lastIndexOf('/')),
    },
    workspaceRoot: '/workspace',
    activeBufferPath: () => undefined,
    createDraft: (path, documentId) => {
      const created = fakeDraft(path);
      draftsByPath.set(path, created);
      return { ok: true, value: { port: created.port, document: { id: documentId } as never } };
    },
    applyPlan: async () => ({ ok: true }),
    openBuffer: async (path) => { openedBuffers.push(path); return true; },
    onError: (message) => errors.push(message),
    marker: (name, payload) => markers.push({ name, payload }),
    notifySurfaceChange: () => { notifyCount.count += 1; },
    ...overrides,
  };
  return { options, errors, markers, notifyCount, openedBuffers, draftsByPath };
}

async function main(): Promise<void> {
  await testOpenDocumentIfDirectory();
  await testNonDirectoryReturnsUndefined();
  await testSaveOpensReviewAndEnterAppliesAndRefreshes();
  await testEscapeCancelsReview();
  await testExploreResolvesDefaultAndExplicitPaths();
  await testApplyFailureKeepsReviewOpenState();
  console.log('T041/T042 DirectoryDraftController passed open-as-buffer, save-opens-review, Enter-applies-and-refreshes, Esc-cancels, Explore-resolution and apply-failure reporting');
}

async function testOpenDocumentIfDirectory(): Promise<void> {
  const { options, draftsByPath } = buildOptions();
  const controller = new DirectoryDraftController(options);
  const documentId = 'doc-1' as DocumentId;
  const document = await controller.openDocumentIfDirectory('/workspace/dir', documentId);
  assert.notEqual(document, undefined, 'T116-DIR-01 a directory path returns a draft document');
  assert.equal(controller.isDirectoryDraft(documentId), true, 'T116-DIR-02 the opened document is tracked as a directory draft');
  assert.equal(draftsByPath.has('/workspace/dir'), true, 'T116-DIR-03 createDraft was invoked for the directory');
}

async function testNonDirectoryReturnsUndefined(): Promise<void> {
  const { options } = buildOptions();
  const controller = new DirectoryDraftController(options);
  const document = await controller.openDocumentIfDirectory('/workspace/file.txt', 'doc-2' as DocumentId);
  assert.equal(document, undefined, 'T116-DIR-04 a non-directory path is left to the caller\'s own file-open path');
}

async function testSaveOpensReviewAndEnterAppliesAndRefreshes(): Promise<void> {
  const applied: unknown[] = [];
  const { options, notifyCount, draftsByPath } = buildOptions({
    applyPlan: async (plan) => { applied.push(plan); return { ok: true }; },
  });
  const controller = new DirectoryDraftController(options);
  const documentId = 'doc-3' as DocumentId;
  await controller.openDocumentIfDirectory('/workspace/dir', documentId);

  const handledBeforeSave = controller.handleKeypress({ name: 'return', raw: '\r' } as never);
  assert.equal(handledBeforeSave, 'unhandled', 'T116-DIR-05 Enter is unhandled with no review open');

  const saved = controller.requestSave(documentId);
  assert.equal(saved, true, 'T116-DIR-06 :w on a directory-draft document is handled here');
  assert.equal(controller.isReviewOpen, true, 'T116-DIR-07 :w opens review');

  const handled = controller.handleKeypress({ name: 'return', raw: '\r' } as never);
  assert.equal(handled, 'handled', 'T116-DIR-08 Enter on an open review is handled');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(applied.length, 1, 'T116-DIR-09 Enter applies the review plan through applyPlan');
  assert.equal(controller.isReviewOpen, false, 'T116-DIR-10 a successful apply closes review');
  const draft = draftsByPath.get('/workspace/dir');
  assert.notEqual(draft, undefined);
  assert.equal(draft?.refreshedWith.length, 1, 'T116-DIR-11 a successful apply re-lists the directory into the same draft');
  assert.equal(notifyCount.count > 0, true, 'T116-DIR-12 apply notifies the surface to repaint');
}

async function testEscapeCancelsReview(): Promise<void> {
  const { options } = buildOptions();
  const controller = new DirectoryDraftController(options);
  const documentId = 'doc-4' as DocumentId;
  await controller.openDocumentIfDirectory('/workspace/dir', documentId);
  controller.requestSave(documentId);
  assert.equal(controller.isReviewOpen, true);
  const handled = controller.handleKeypress({ name: 'escape', raw: '' } as never);
  assert.equal(handled, 'handled', 'T116-DIR-13 Escape on an open review is handled');
  assert.equal(controller.isReviewOpen, false, 'T116-DIR-14 Escape cancels review without applying');

  // registerPanel's `close` hook (panel exclusivity) calls this directly too.
  await controller.openDocumentIfDirectory('/workspace/dir', 'doc-5' as DocumentId);
  controller.requestSave('doc-5' as DocumentId);
  assert.equal(controller.isReviewOpen, true);
  controller.closeReview();
  assert.equal(controller.isReviewOpen, false, 'T116-DIR-15 closeReview() (panel-close hook) cancels the open review');
}

async function testExploreResolvesDefaultAndExplicitPaths(): Promise<void> {
  const { options, openedBuffers, errors } = buildOptions();
  const controller = new DirectoryDraftController(options);
  await controller.explore(undefined, 'view-1' as ViewId);
  assert.deepEqual(openedBuffers, ['/workspace'], 'T116-DIR-16 no target and no active buffer falls back to the workspace root');

  const { options: withActive, openedBuffers: openedFromActive } = buildOptions({ activeBufferPath: () => '/workspace/dir/file.txt' });
  const controllerWithActive = new DirectoryDraftController(withActive);
  await controllerWithActive.explore(undefined, 'view-1' as ViewId);
  assert.deepEqual(openedFromActive, ['/workspace/dir'], 'T116-DIR-17 no target resolves to the active buffer\'s parent directory');

  await controller.explore('/workspace/file.txt', 'view-1' as ViewId);
  assert.equal(errors.some((message) => message.includes('not a directory')), true, 'T116-DIR-18 exploring a non-directory path reports an error');
}

async function testApplyFailureKeepsReviewOpenState(): Promise<void> {
  const { options, errors, markers, draftsByPath } = buildOptions({ applyPlan: async () => ({ ok: false, error: 'disk-full' }) });
  const controller = new DirectoryDraftController(options);
  const documentId = 'doc-6' as DocumentId;
  await controller.openDocumentIfDirectory('/workspace/dir', documentId);
  controller.requestSave(documentId);
  controller.handleKeypress({ name: 'enter', raw: '\r' } as never);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors.some((message) => message.includes('directory apply failed')), true, 'T116-DIR-19 a failed apply reports the error');
  assert.equal(markers.some((entry) => entry.name === 'XI_DIRECTORY_APPLY_FAILED'), true, 'T116-DIR-20 a failed apply emits the failure marker');
  assert.equal(draftsByPath.get('/workspace/dir')?.refreshedWith.length, 0, 'T116-DIR-21 a failed apply never re-lists the directory');
}

await main();
