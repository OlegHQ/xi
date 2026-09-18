#!/usr/bin/env bun
// Regression coverage for F2-10: a tags-file entry (e.g. `../../../../etc/shadow`) must not be
// able to navigate outside the workspace it was found in.
import assert from 'node:assert/strict';
import type { CancellationToken, FileInfo, FileWatchEvent, PlatformFailure, Result, Disposable } from '../../packages/contracts/src/index';
import { createCtagsNavigationHost, type CtagsFilesystemPort } from '../../packages/services/navigation/ctags';

const NEVER_CANCELLED: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose(): void {} }) });

const TAGS_FILE = [
  'safe\tsrc/main.ts\t/^function main() {$/;"\tf\tline:1',
  'escape\t../../../../etc/shadow\t/^root:/;"\tf\tline:1',
  'absoluteEscape\t/etc/shadow\t/^root:/;"\tf\tline:1',
].join('\n');

class FakeFilesystem implements CtagsFilesystemPort {
  content = TAGS_FILE;
  info: FileInfo = { kind: 'file', sizeBytes: TAGS_FILE.length, modifiedMilliseconds: 1_000 };

  async stat(_path: string, _cancellation: CancellationToken): Promise<Result<FileInfo, PlatformFailure>> {
    return { ok: true, value: this.info };
  }
  async readFile(_path: string, _cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    return { ok: true, value: new TextEncoder().encode(this.content) };
  }
  async writeFileAtomic(): Promise<Result<void, PlatformFailure>> { throw new Error('not used by ctags host'); }
  async watch(_path: string, _listener: (event: FileWatchEvent) => void, _cancellation: CancellationToken): Promise<Result<Disposable, PlatformFailure>> { throw new Error('not used by ctags host'); }
  resolvePath(base: string, path: string): string {
    const joined = path.startsWith('/') ? path : `${base}/${path}`;
    const stack: string[] = [];
    for (const part of joined.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return `/${stack.join('/')}`;
  }
  directoryPath(path: string): string {
    const index = path.lastIndexOf('/');
    return index === -1 ? path : path.slice(0, index);
  }
  workspaceRelativePath(root: string, path: string): string | undefined {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return path === root ? '' : path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }
}

async function main(): Promise<void> {
  const filesystem = new FakeFilesystem();
  const host = createCtagsNavigationHost({
    filesystem,
    workspaceRoot: '/workspace',
    fileUri: (path) => `file://${path}`,
    tagsFileNames: ['tags'],
  });

  const safe = await host.tag('safe');
  assert.ok(safe.ok && safe.value.length === 1, 'T-CTAGS-CONTAIN-01 an in-workspace tag still resolves');

  const escaped = await host.tag('escape');
  assert.ok(escaped.ok, 'T-CTAGS-CONTAIN-02 lookup itself does not fail');
  if (escaped.ok) assert.equal(escaped.value.length, 0, 'F2-10: a relative-traversal tag entry pointing outside the workspace must not resolve');

  const absoluteEscaped = await host.tag('absoluteEscape');
  assert.ok(absoluteEscaped.ok, 'T-CTAGS-CONTAIN-03 lookup itself does not fail');
  if (absoluteEscaped.ok) assert.equal(absoluteEscaped.value.length, 0, 'F2-10: an absolute-path tag entry pointing outside the workspace must not resolve');

  console.log('T-CTAGS-WORKSPACE-CONTAINMENT passed: tag lookups cannot navigate outside the workspace (F2-10)');
}

void main();
