import assert from 'node:assert/strict';
import type { CancellationToken, FileInfo, FileWatchEvent, PlatformFailure, Result, Disposable } from '../../packages/contracts/src/index';
import { createCtagsNavigationHost, type CtagsFilesystemPort } from '../../packages/services/navigation/ctags';

const NEVER_CANCELLED: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose(): void {} }) });

const TAGS_FILE = ['main\tsrc/main.ts\t/^function main() {$/;"\tf\tline:10'].join('\n');

class FakeFilesystem implements CtagsFilesystemPort {
  statCount = 0;
  readCount = 0;
  info: FileInfo = { kind: 'file', sizeBytes: TAGS_FILE.length, modifiedMilliseconds: 1_000 };
  content = TAGS_FILE;

  async stat(_path: string, _cancellation: CancellationToken): Promise<Result<FileInfo, PlatformFailure>> {
    this.statCount += 1;
    return { ok: true, value: this.info };
  }

  async readFile(_path: string, _cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    this.readCount += 1;
    return { ok: true, value: new TextEncoder().encode(this.content) };
  }

  async writeFileAtomic(): Promise<Result<void, PlatformFailure>> {
    throw new Error('not used by ctags host');
  }

  async watch(_path: string, _listener: (event: FileWatchEvent) => void, _cancellation: CancellationToken): Promise<Result<Disposable, PlatformFailure>> {
    throw new Error('not used by ctags host');
  }

  resolvePath(base: string, path: string): string {
    return `${base}/${path}`;
  }

  directoryPath(path: string): string {
    const index = path.lastIndexOf('/');
    return index === -1 ? path : path.slice(0, index);
  }
}

async function testCachesUnchangedTagsFile(): Promise<void> {
  const filesystem = new FakeFilesystem();
  const host = createCtagsNavigationHost({
    filesystem,
    workspaceRoot: '/workspace',
    fileUri: (path) => `file://${path}`,
    tagsFileNames: ['tags'],
  });

  const first = await host.tag('main');
  assert.ok(first.ok && first.value.length === 1, 'T-CTAGS-HOST-01 first lookup finds the tag');
  assert.equal(filesystem.readCount, 1, 'T-CTAGS-HOST-01 first lookup reads the tags file once');

  const second = await host.tag('main');
  assert.ok(second.ok && second.value.length === 1, 'T-CTAGS-HOST-02 second lookup still finds the tag');
  assert.equal(filesystem.readCount, 1, 'T-CTAGS-HOST-02 second lookup with unchanged stat does not re-read the tags file');
  assert.equal(filesystem.statCount, 2, 'T-CTAGS-HOST-02 admission still stats the file once per lookup to detect changes');

  // A changed mtime invalidates the cache and forces a fresh read/parse.
  filesystem.info = { kind: 'file', sizeBytes: TAGS_FILE.length, modifiedMilliseconds: 2_000 };
  filesystem.content = ['main\tsrc/main.ts\t/^function main() {$/;"\tf\tline:20'].join('\n');
  const third = await host.tag('main');
  assert.ok(third.ok && third.value.length === 1, 'T-CTAGS-HOST-03 lookup after mtime change succeeds');
  assert.equal(filesystem.readCount, 2, 'T-CTAGS-HOST-03 a changed mtime invalidates the cache and re-reads');
  assert.equal(third.value[0]?.line, 19, 'T-CTAGS-HOST-03 the re-read content is actually used');
}

await testCachesUnchangedTagsFile();
console.log('T-CTAGS-HOST ctags navigation host passed cache reuse on an unchanged stat and invalidation on a changed mtime');
