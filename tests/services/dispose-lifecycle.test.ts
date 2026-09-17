#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import {
  CancellationSource,
  type CancellationToken,
  type FileInfo,
  type FilesystemPort,
  type PlatformFailure,
  type Result,
} from '../../packages/contracts/src/index';
import { asUtf16Offset, type DocumentId, type SelectionId, type UndoGroupId, type Utf16Offset, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSet } from '../../packages/selections/src/index';
import { PersistenceService } from '../../packages/services/persistence/index';
import { compileInitialConfig, ConfigStore } from '../../packages/services/config/index';
import { JournaledFilesystemOperations, type JournaledFilesystemPort, type DirectoryOperationPlan } from '../../packages/services/files/index';
import { AtomicCommandCoordinator, createAtomicWorkbenchState } from '../../packages/workbench/editing/atomic-command';

const cancellation = new CancellationSource().token;

async function main(): Promise<void> {
  await testPersistenceServiceDispose();
  await testConfigStoreDispose();
  await testJournaledFilesystemOperationsDispose();
  await testAtomicCommandCoordinatorDispose();
  console.log('dispose-lifecycle passed idempotent disposal and use-after-dispose rejection for PersistenceService, ConfigStore, JournaledFilesystemOperations and AtomicCommandCoordinator');
}

async function testPersistenceServiceDispose(): Promise<void> {
  const fs = new FakeFilesystem();
  fs.seed('/tmp/dispose-lifecycle.txt', new TextEncoder().encode('hello'));
  const service = new PersistenceService(fs);
  const opened = await service.openFile('/tmp/dispose-lifecycle.txt', identifier<DocumentId>('dispose-doc'), cancellation);
  assert.equal(opened.ok, true, 'DISPOSE-PERSISTENCE-01 a normal open succeeds before dispose');

  service.dispose();
  service.dispose(); // idempotent

  const afterDispose = await service.openFile('/tmp/dispose-lifecycle.txt', identifier<DocumentId>('dispose-doc-2'), cancellation);
  assert.equal(afterDispose.ok, false, 'DISPOSE-PERSISTENCE-02 openFile is rejected after dispose');
  if (!afterDispose.ok) assert.equal(afterDispose.error.kind, 'disposed');

  if (opened.ok && opened.value.kind === 'editable') {
    const saved = await service.saveFile(opened.value.document, opened.value.path, cancellation);
    assert.equal(saved.ok, false, 'DISPOSE-PERSISTENCE-03 saveFile is rejected after dispose');
    if (!saved.ok) assert.equal(saved.error.kind, 'disposed');
  }
}

async function testConfigStoreDispose(): Promise<void> {
  const initial = compileInitialConfig();
  assert.equal(initial.ok, true, 'DISPOSE-CONFIG-01 default config compiles');
  if (!initial.ok) return;
  const store = new ConfigStore(initial.value);
  const reloaded = store.reload([{ name: 'defaults', kind: 'defaults', source: 'schema-version = 1\n' }]);
  assert.equal(reloaded.ok, true, 'DISPOSE-CONFIG-02 a normal reload succeeds before dispose');

  store.dispose();
  store.dispose(); // idempotent

  const afterDispose = store.reload([{ name: 'defaults', kind: 'defaults', source: 'schema-version = 1\n' }]);
  assert.equal(afterDispose.ok, false, 'DISPOSE-CONFIG-03 reload is rejected after dispose');
  if (!afterDispose.ok) assert.equal(afterDispose.error.diagnostics[0]?.code, 'disposed');
  assert.equal(store.snapshot.schemaVersion, 1, 'DISPOSE-CONFIG-04 the last compiled snapshot remains readable after dispose');
}

async function testJournaledFilesystemOperationsDispose(): Promise<void> {
  const fs = new FakeJournaledFilesystem();
  const service = new JournaledFilesystemOperations(fs);
  const emptyPlan: DirectoryOperationPlan = { contractVersion: 1, directoryPath: '/tmp/dispose-journal', baseGeneration: 0, operations: [] };
  const preflight = await service.preflight(emptyPlan, cancellation);
  assert.equal(preflight.ok, true, 'DISPOSE-JOURNAL-01 a normal preflight succeeds before dispose');

  service.dispose();
  service.dispose(); // idempotent

  const afterDispose = await service.preflight(emptyPlan, cancellation);
  assert.equal(afterDispose.ok, false, 'DISPOSE-JOURNAL-02 preflight is rejected after dispose');
  if (!afterDispose.ok) assert.equal(afterDispose.error.kind, 'disposed');

  const applyAfterDispose = await service.apply(emptyPlan, cancellation);
  assert.equal(applyAfterDispose.ok, false, 'DISPOSE-JOURNAL-03 apply is rejected after dispose');
  if (!applyAfterDispose.ok) assert.equal(applyAfterDispose.error.kind, 'disposed');
}

async function testAtomicCommandCoordinatorDispose(): Promise<void> {
  const document = editable('abcd');
  const viewId = identifier<ViewId>('dispose-view');
  const selections = selection(document, [0], [identifier<SelectionId>('dispose-sel-0')]);
  const view = { viewId, selections, mode: 'insert' as const, repeatTarget: null };
  const created = createAtomicWorkbenchState(document.snapshot(), { activeViewId: viewId, views: [view] });
  assert.equal(created.ok, true, 'DISPOSE-ATOMIC-01 initial workbench state is valid');
  if (!created.ok) return;
  const coordinator = new AtomicCommandCoordinator(document, created.value);

  const undoGroup = identifier<UndoGroupId>('dispose-lifecycle-group');
  const executed = await coordinator.execute({
    intent: null,
    undoGroup,
    resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 1), edits: [] }),
  });
  assert.equal(executed.ok, true, 'DISPOSE-ATOMIC-02 a normal execute succeeds before dispose');

  coordinator.dispose();
  coordinator.dispose(); // idempotent

  const executeAfterDispose = await coordinator.execute({
    intent: null,
    undoGroup,
    resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 1), edits: [] }),
  });
  assert.equal(executeAfterDispose.ok, false, 'DISPOSE-ATOMIC-03 execute is rejected after dispose');
  if (!executeAfterDispose.ok) assert.equal(executeAfterDispose.error.kind, 'disposed');

  const replaceAfterDispose = coordinator.replaceState({ activeViewId: viewId, views: [view] });
  assert.equal(replaceAfterDispose.ok, false, 'DISPOSE-ATOMIC-04 replaceState is rejected after dispose');
  if (!replaceAfterDispose.ok) assert.equal(replaceAfterDispose.error.kind, 'disposed');
}

class FakeFilesystem implements FilesystemPort {
  #files = new Map<string, Uint8Array>();
  #info = new Map<string, FileInfo>();
  #mtime = 1;

  seed(path: string, bytes: Uint8Array): void {
    this.#files.set(path, bytes.slice());
    this.#info.set(path, { kind: 'file', sizeBytes: bytes.length, modifiedMilliseconds: this.#mtime++, device: 'fake', inode: path, linkCount: 1 });
  }
  async readFile(path: string, token: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    const bytes = this.#files.get(path);
    return bytes === undefined ? fail('ENOENT') : { ok: true, value: bytes.slice() };
  }
  async writeFileAtomic(path: string, bytes: Uint8Array, token: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    this.seed(path, bytes);
    return { ok: true, value: undefined };
  }
  async stat(path: string, token: CancellationToken): Promise<Result<FileInfo, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    const info = this.#info.get(path);
    return info === undefined ? fail('ENOENT') : { ok: true, value: info };
  }
  async watch(): Promise<Result<{ dispose(): void }, PlatformFailure>> { return { ok: true, value: { dispose() {} } }; }
}

class FakeJournaledFilesystem extends FakeFilesystem implements JournaledFilesystemPort {
  async makeDirectory(): Promise<Result<void, PlatformFailure>> { return { ok: true, value: undefined }; }
  async renamePath(): Promise<Result<void, PlatformFailure>> { return { ok: true, value: undefined }; }
  async copyPath(): Promise<Result<void, PlatformFailure>> { return { ok: true, value: undefined }; }
  async removePath(): Promise<Result<void, PlatformFailure>> { return { ok: true, value: undefined }; }
}

function fail(code: string): Result<never, PlatformFailure> { return { ok: false, error: { code, message: code, retryable: code === 'ENOSPC' } }; }

function editable(text: string): TextFileDocument {
  const lineEndings = Array.from({ length: [...text].filter((character) => character === '\n').length }, () => 'lf' as const);
  const created = TextFileDocument.create(identifier<DocumentId>('dispose-lifecycle-document'), text, lineEndings, 'lf');
  if (!created.ok) throw new Error(`dispose-lifecycle-document:${created.error.kind}`);
  return created.value;
}

function selection(document: TextFileDocument, positions: readonly number[], ids: readonly SelectionId[]): SelectionSet {
  const created = createSelectionSet(document.snapshot(), {
    primaryId: ids[0] as SelectionId,
    selectionGeneration: 0,
    members: positions.map((position, index) => gap(ids[index] as SelectionId, position)),
  });
  if (!created.ok) throw new Error(`dispose-lifecycle-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

function gap(id: SelectionId, position: number): SelectionMemberInput {
  const endpoint = { kind: 'gap' as const, offset: offset(position) };
  return { id, kind: 'insert-caret', direction: 'forward', anchor: endpoint, head: endpoint };
}

function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`dispose-lifecycle-offset:${result.error.message}`);
  return result.value;
}

function identifier<T extends string>(value: string): T { return value as T; }

void main();
