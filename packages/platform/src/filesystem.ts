import { createReadStream, promises as fs, watch as watchFile } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type {
  CancellationToken,
  Disposable,
  FileInfo,
  FileWatchEvent,
  FilesystemPort,
  PlatformFailure,
  Result,
} from '../../contracts/src/index.ts';

export interface WorkspaceFileEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly hidden: boolean;
}

export interface WorkspaceFileEnumerationOptions {
  readonly maxEntries?: number;
  readonly ignoredDirectoryNames?: readonly string[];
}

/** One directory child returned by the native Explorer adapter. */
export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly kind: 'directory' | 'file' | 'symlink' | 'other';
  readonly relativePath: string;
  readonly hidden: boolean;
  readonly ignored: boolean;
  readonly stableIdentity?: string;
  readonly sizeBytes?: number;
  readonly modifiedMilliseconds?: number;
  readonly symlinkTarget?: string;
}

export interface WorkspaceDirectoryWatchEvent {
  readonly kind: 'changed' | 'overflow';
  readonly path: string;
}

/**
 * Native asynchronous filesystem adapter. Persistence owns the write policy;
 * this adapter only supplies the platform port and the atomic primitive.
 */
export class NodeFilesystemPort implements FilesystemPort {
  #temporaryCounter = 0;

  /** Keep OS path policy behind the platform boundary used by the launcher. */
  resolvePath(base: string, path: string): string { return resolve(base, path); }
  directoryPath(path: string): string { return dirname(path); }

  async readFile(path: string, cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      const bytes = await fs.readFile(path);
      if (cancellation.isCancelled) return cancelled();
      return { ok: true, value: new Uint8Array(bytes) };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'read-file') };
    }
  }

  async readFileChunks(path: string, cancellation: CancellationToken): Promise<Result<AsyncIterable<Uint8Array>, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
      async function* chunks(): AsyncIterable<Uint8Array> {
        try {
          for await (const chunk of stream) {
            if (cancellation.isCancelled) {
              stream.destroy();
              return;
            }
            yield new Uint8Array(chunk);
          }
        } finally {
          stream.destroy();
        }
      }
      return { ok: true, value: chunks() };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'read-file') };
    }
  }

  async stat(path: string, cancellation: CancellationToken): Promise<Result<FileInfo, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      // lstat is deliberate: a save must not silently replace a symlink.
      const info = await fs.lstat(path);
      if (cancellation.isCancelled) return cancelled();
      return {
        ok: true,
        value: Object.freeze({
          kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
          sizeBytes: info.size,
          modifiedMilliseconds: info.mtimeMs,
          device: String(info.dev),
          inode: String(info.ino),
          linkCount: info.nlink,
        } satisfies FileInfo),
      };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'stat') };
    }
  }

  /** Resolve a user supplied file against a workspace without leaking path policy to callers. */
  workspaceRelativePath(root: string, path: string): string | undefined {
    const relativePath = relative(root, resolve(root, path)).replaceAll('\\', '/');
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) return undefined;
    return relativePath;
  }

  /** Resolve a root-relative search result without moving path policy into a service or UI. */
  workspaceAbsolutePath(root: string, relativePath: string): string | undefined {
    if (relativePath.length === 0 || relativePath.includes('\0')) return undefined;
    const absolutePath = resolve(root, relativePath);
    return this.workspaceRelativePath(root, absolutePath) === relativePath.replaceAll('\\', '/') ? absolutePath : undefined;
  }

  /**
   * Enumerate one directory asynchronously. The caller supplies the root so
   * returned paths stay root-relative while the adapter remains independent
   * of the service-owned Explorer contract.
   */
  async enumerateDirectory(
    path: string,
    root: string,
    cancellation: CancellationToken,
    options: { readonly ignoredDirectoryNames?: readonly string[]; readonly maxEntries?: number } = {},
  ): Promise<Result<readonly WorkspaceDirectoryEntry[], PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    const ignoredNames = new Set(options.ignoredDirectoryNames ?? ['.git', 'node_modules', '.artifacts', '.cache', 'dist', '.xi-trash']);
    // Capped consistent with enumerateFiles's 120k background-index limit, and
    // batched with bounded concurrency instead of one sequential lstat per child.
    const maxEntries = options.maxEntries ?? 120_000;
    const concurrency = 64;
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      const capped = entries.length > maxEntries ? entries.slice(0, maxEntries) : entries;
      const result: WorkspaceDirectoryEntry[] = [];
      for (let start = 0; start < capped.length; start += concurrency) {
        if (cancellation.isCancelled) return cancelled();
        const slice = capped.slice(start, start + concurrency);
        const rows = await Promise.all(slice.map((entry) => this.statDirectoryEntry(path, root, entry, ignoredNames)));
        for (const row of rows) result.push(row);
      }
      return cancellation.isCancelled ? cancelled() : { ok: true, value: Object.freeze(result) };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'enumerate-directory') };
    }
  }

  private async statDirectoryEntry(
    path: string,
    root: string,
    entry: import('node:fs').Dirent,
    ignoredNames: ReadonlySet<string>,
  ): Promise<WorkspaceDirectoryEntry> {
    const absolutePath = join(path, entry.name);
    const relativePath = relative(root, absolutePath).split('\\').join('/');
    const ignored = ignoredNames.has(entry.name);
    let kind: WorkspaceDirectoryEntry['kind'] = entry.isDirectory()
      ? 'directory'
      : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
    let stableIdentity: string | undefined;
    let sizeBytes: number | undefined;
    let modifiedMilliseconds: number | undefined;
    let symlinkTarget: string | undefined;
    try {
      const info = await fs.lstat(absolutePath);
      stableIdentity = `${String(info.dev)}:${String(info.ino)}`;
      sizeBytes = info.size;
      modifiedMilliseconds = info.mtimeMs;
      if (info.isSymbolicLink()) {
        kind = 'symlink';
        try { symlinkTarget = await fs.readlink(absolutePath); } catch { /* preserve a visible broken link */ }
      }
    } catch (error: unknown) {
      // A child can disappear between readdir and lstat. Keep the row
      // visible with the Dirent kind and let the next watcher refresh fix
      // its metadata.
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    return Object.freeze({
      name: entry.name,
      kind,
      relativePath,
      hidden: entry.name.startsWith('.'),
      ignored,
      ...(stableIdentity === undefined ? {} : { stableIdentity }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(modifiedMilliseconds === undefined ? {} : { modifiedMilliseconds }),
      ...(symlinkTarget === undefined ? {} : { symlinkTarget }),
    });
  }

  /** Watch a directory for invalidation; the Explorer reconciles by rereading. */
  async watchDirectory(
    path: string,
    listener: (event: WorkspaceDirectoryWatchEvent) => void,
    cancellation: CancellationToken,
  ): Promise<Result<Disposable, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      let disposed = false;
      const onWatchEvent = (_eventType: string, filename: string | Buffer | null): void => {
        if (cancellation.isCancelled) return;
        const child = filename === undefined || filename === null ? path : join(path, filename.toString());
        listener({ kind: 'changed', path: child });
      };
      // Recursive watching keeps expanded subdirectories live without a watcher per
      // directory; not every platform/Node build supports it (Linux support is recent),
      // so an unsupported recursive option falls back to non-recursive watching of `path`
      // itself rather than failing the whole watch.
      let watcher;
      try {
        watcher = watchFile(path, { persistent: false, recursive: true }, onWatchEvent);
      } catch {
        watcher = watchFile(path, { persistent: false }, onWatchEvent);
      }
      // A removed watched directory, EMFILE or an inotify overflow surfaces as an
      // 'error' event; left unhandled it is an uncaught exception that crashes the
      // process. Report it through the existing overflow event instead of the
      // watcher going silent or the process going down.
      watcher.on('error', () => {
        if (disposed) return;
        disposed = true;
        watcher.close();
        if (!cancellation.isCancelled) listener({ kind: 'overflow', path });
      });
      const cancellationSubscription = cancellation.onCancel(() => {
        if (disposed) return;
        disposed = true;
        watcher.close();
      });
      return {
        ok: true,
        value: Object.freeze({
          dispose() {
            if (disposed) return;
            disposed = true;
            cancellationSubscription.dispose();
            watcher.close();
          },
        }),
      };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'watch-directory') };
    }
  }

  /** Enumerate files in bounded asynchronous batches for background indexes. */
  async enumerateFiles(
    root: string,
    cancellation: CancellationToken,
    onBatch: (entries: readonly WorkspaceFileEntry[]) => void | Promise<void>,
    options: WorkspaceFileEnumerationOptions = {},
  ): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    const maxEntries = options.maxEntries ?? 120_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return { ok: false, error: { code: 'invalid-limit', message: 'file enumeration limit must be positive', retryable: false } };
    const ignored = new Set(options.ignoredDirectoryNames ?? ['.git', 'node_modules', '.artifacts', '.cache', 'dist', '.xi-trash']);
    const queue: Array<{ readonly absolute: string; readonly relative: string }> = [{ absolute: root, relative: '' }];
    const batch: WorkspaceFileEntry[] = [];
    let total = 0;
    try {
      while (queue.length > 0 && total < maxEntries) {
        if (cancellation.isCancelled) return cancelled();
        const directory = queue.shift();
        if (directory === undefined) break;
        let entries: import('node:fs').Dirent[];
        try {
          entries = await fs.readdir(directory.absolute, { withFileTypes: true });
        } catch (error: unknown) {
          if (directory.relative.length === 0) return { ok: false, error: platformFailure(error, 'enumerate-files') };
          continue;
        }
        for (const entry of entries) {
          if (cancellation.isCancelled) return cancelled();
          const relativePath = directory.relative.length === 0 ? entry.name : `${directory.relative}/${entry.name}`;
          const absolutePath = join(directory.absolute, entry.name);
          if (entry.isDirectory()) {
            if (!ignored.has(entry.name) && !entry.isSymbolicLink()) queue.push({ absolute: absolutePath, relative: relativePath });
            continue;
          }
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          batch.push(Object.freeze({ relativePath, absolutePath, hidden: entry.name.startsWith('.') }));
          total += 1;
          if (batch.length >= 512) {
            await onBatch(Object.freeze(batch.splice(0, batch.length)));
            await Promise.resolve();
          }
          if (total >= maxEntries) break;
        }
      }
      if (batch.length > 0) await onBatch(Object.freeze(batch.splice(0, batch.length)));
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'enumerate-files') };
    }
  }

  async writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    return this.writeFileAtomicChunks(path, oneChunk(contents), cancellation);
  }

  async writeFileAtomicChunks(path: string, contents: AsyncIterable<Uint8Array>, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    const directory = dirname(path);
    const temporary = join(directory, `.${basename(path)}.xi-tmp-${process.pid}-${Date.now()}-${this.#temporaryCounter += 1}`);
    let temporaryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const existing = await safeLstat(path);
      if (cancellation.isCancelled) return cancelled();
      if (existing?.isSymbolicLink()) {
        return { ok: false, error: { code: 'symlink-save', message: 'refusing to replace a symbolic link', retryable: false } };
      }
      temporaryHandle = await fs.open(temporary, 'wx', existing === undefined ? 0o666 : existing.mode & 0o7777);
      for await (const chunk of contents) {
        if (cancellation.isCancelled) {
          await temporaryHandle.close();
          temporaryHandle = undefined;
          await safeUnlink(temporary);
          return cancelled();
        }
        await temporaryHandle.write(chunk);
      }
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      if (cancellation.isCancelled) {
        await safeUnlink(temporary);
        return cancelled();
      }
      await fs.rename(temporary, path);
      // Ensure the directory entry reaches stable storage where the platform
      // exposes directory fsync. Failure is reported instead of claiming a
      // stronger durability guarantee than the platform provided.
      try {
        const directoryHandle = await fs.open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch (error: unknown) {
        return { ok: false, error: platformFailure(error, 'directory-sync') };
      }
      return { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'atomic-write') };
    } finally {
      if (temporaryHandle !== undefined) {
        try { await temporaryHandle.close(); } catch { /* best effort cleanup */ }
      }
      await safeUnlink(temporary);
    }
  }

  async makeDirectory(path: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      await fs.mkdir(path, { recursive: true });
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'make-directory') };
    }
  }

  async renamePath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      await fs.rename(from, to);
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'rename') };
    }
  }

  async copyPath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      await fs.cp(from, to, { recursive: true, force: false, errorOnExist: true, dereference: false });
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'copy') };
    }
  }

  async removePath(path: string, recursive: boolean, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      await fs.rm(path, { recursive, force: false });
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'remove') };
    }
  }

  async watch(path: string, listener: (event: FileWatchEvent) => void, cancellation: CancellationToken): Promise<Result<Disposable, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      let disposed = false;
      const watcher = watchFile(path, { persistent: false }, (eventType) => {
        if (cancellation.isCancelled) return;
        listener({ kind: eventType === 'rename' ? 'created' : 'changed', path });
      });
      watcher.on('error', () => {
        if (disposed) return;
        disposed = true;
        watcher.close();
        if (!cancellation.isCancelled) listener({ kind: 'overflow', path });
      });
      const cancellationSubscription = cancellation.onCancel(() => {
        if (disposed) return;
        disposed = true;
        watcher.close();
      });
      return {
        ok: true,
        value: {
          dispose() {
            if (disposed) return;
            disposed = true;
            cancellationSubscription.dispose();
            watcher.close();
          },
        },
      };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'watch') };
    }
  }
}

async function* oneChunk(contents: Uint8Array): AsyncIterable<Uint8Array> {
  yield contents;
}

async function safeLstat(path: string): Promise<import('node:fs').Stats | undefined> {
  try { return await fs.lstat(path); } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try { await fs.unlink(path); } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') return;
  }
}

function cancelled(): Result<never, PlatformFailure> {
  return { ok: false, error: { code: 'cancelled', message: 'filesystem operation cancelled', retryable: false } };
}

function platformFailure(error: unknown, operation: string): PlatformFailure {
  const code = errorCode(error) ?? 'unknown';
  const retryable = code === 'EAGAIN' || code === 'EBUSY' || code === 'ENOSPC' || code === 'ETIMEDOUT';
  return {
    code,
    message: `${operation} failed (${code})`,
    retryable,
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}
