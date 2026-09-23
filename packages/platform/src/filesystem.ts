import { constants, promises as fs, watch as watchFile } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function xiConfigDirectory(environment: Readonly<Record<string, string | undefined>>): string {
  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  return join(xdgConfigHome !== undefined && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(environment.HOME ?? process.cwd(), '.config'), 'xi');
}
import type {
  CancellationToken,
  Disposable,
  FileInfo,
  FileWatchEvent,
  FilesystemPort,
  PlatformFailure,
  ReadFileOptions,
  Result,
} from '../../contracts/src/index.ts';

export interface WorkspaceFileEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly hidden: boolean;
}

export interface WorkspaceFileEnumerationOptions {
  readonly maxEntries?: number;
  readonly maxVisitedEntries?: number;
  readonly ignoredDirectoryNames?: readonly string[];
  readonly followSymlinks?: boolean;
  readonly deduplicateLinks?: boolean;
  readonly maxDepth?: number;
  /** Helix-compatible ignore sources used by the file picker. */
  readonly ignore?: WorkspaceIgnoreOptions;
}

export interface WorkspaceDirectoryEnumerationOptions {
  readonly ignoredDirectoryNames?: readonly string[];
  readonly maxEntries?: number;
  readonly ignore?: WorkspaceIgnoreOptions;
}

export interface WorkspaceIgnoreOptions {
  readonly parents?: boolean;
  readonly ignore?: boolean;
  readonly gitIgnore?: boolean;
  readonly gitGlobal?: boolean;
  readonly gitExclude?: boolean;
  readonly homeDirectory?: string;
  readonly xdgConfigHome?: string;
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

interface IgnoreRule {
  readonly base: string;
  readonly glob: Bun.Glob;
  readonly basenameOnly: boolean;
  readonly directoryOnly: boolean;
  readonly negated: boolean;
  readonly priority: number;
}

/** Small, bounded gitignore-compatible matcher for the file-picker index. */
class WorkspaceIgnoreMatcher {
  readonly #root: string;
  readonly #options: Required<Pick<WorkspaceIgnoreOptions, 'parents' | 'ignore' | 'gitIgnore' | 'gitGlobal' | 'gitExclude'>>;
  readonly #rules: IgnoreRule[] = [];
  readonly #loaded = new Set<string>();
  readonly #gitDirectory: string | undefined;
  readonly #cancellation: CancellationToken;

  private constructor(root: string, options: WorkspaceIgnoreOptions, gitDirectory: string | undefined, cancellation: CancellationToken) {
    this.#root = root;
    this.#options = {
      parents: options.parents === true,
      ignore: options.ignore === true,
      gitIgnore: options.gitIgnore === true,
      gitGlobal: options.gitGlobal === true,
      gitExclude: options.gitExclude === true,
    };
    this.#gitDirectory = gitDirectory;
    this.#cancellation = cancellation;
  }

  static async create(root: string, options: WorkspaceIgnoreOptions | undefined, cancellation: CancellationToken): Promise<Result<WorkspaceIgnoreMatcher, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    const selected = options ?? {};
    let gitDirectory: string | undefined;
    try { if (selected.gitIgnore === true || selected.gitExclude === true) gitDirectory = await discoverGitDirectory(root); }
    catch (error: unknown) { return { ok: false, error: platformFailure(error, 'discover-git') }; }
    if (cancellation.isCancelled) return cancelled();
    const matcher = new WorkspaceIgnoreMatcher(root, selected, gitDirectory, cancellation);
    const configHome = selected.xdgConfigHome !== undefined && isAbsolute(selected.xdgConfigHome)
      ? selected.xdgConfigHome
      : selected.homeDirectory === undefined ? undefined : join(selected.homeDirectory, '.config');
    if (configHome !== undefined && matcher.#options.ignore) {
      const loaded = await matcher.readFile(join(configHome, 'helix/ignore'), root, 0);
      if (!loaded.ok) return loaded;
    }
    if (configHome !== undefined && matcher.#options.gitGlobal) {
      const home = selected.homeDirectory ?? configHome;
      for (const path of [join(configHome, 'git/ignore')]) {
        const loaded = await matcher.readFile(path, root, 1);
        if (!loaded.ok) return loaded;
      }
      for (const configPath of [join(configHome, 'git/config'), ...(selected.homeDirectory === undefined ? [] : [join(selected.homeDirectory, '.gitconfig')])]) {
        let source: string;
        try {
          const info = await fs.stat(configPath);
          if (info.size > 1024 * 1024) return { ok: false, error: { code: 'git-config-too-large', message: `${configPath} exceeds 1 MiB`, retryable: false } };
          source = await fs.readFile(configPath, 'utf8');
        } catch (error: unknown) {
          if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') continue;
          return { ok: false, error: platformFailure(error, 'read-git-config') };
        }
        const configured = /^\s*excludesfile\s*=\s*(.+?)\s*$/imu.exec(source)?.[1]?.trim();
        if (configured !== undefined) {
          const expanded = configured.startsWith('~/') ? join(home, configured.slice(2)) : configured.startsWith('/') ? configured : join(home, configured);
          const loaded = await matcher.readFile(expanded, root, 1);
          if (!loaded.ok) return loaded;
        }
      }
    }
    if (gitDirectory !== undefined && matcher.#options.gitExclude) {
      const loaded = await matcher.readFile(join(gitDirectory, 'info/exclude'), root, 2);
      if (!loaded.ok) return loaded;
    }
    if (matcher.#options.parents) {
      const parents: string[] = [];
      let parent = dirname(root);
      for (let depth = 0; depth < 32 && parent !== dirname(parent); depth += 1) {
        parents.push(parent);
        parent = dirname(parent);
      }
      for (const directory of parents.reverse()) {
        if (gitDirectory !== undefined && matcher.#options.gitIgnore) { const loaded = await matcher.readFile(join(directory, '.gitignore'), directory, 3); if (!loaded.ok) return loaded; }
        if (matcher.#options.ignore) { const loaded = await matcher.readFile(join(directory, '.ignore'), directory, 4); if (!loaded.ok) return loaded; }
      }
    }
    return { ok: true, value: matcher };
  }

  async loadDirectory(directory: string): Promise<Result<void, PlatformFailure>> {
    if (this.#cancellation.isCancelled) return cancelled();
    if (this.#loaded.has(directory)) return { ok: true, value: undefined };
    this.#loaded.add(directory);
    if (this.#gitDirectory !== undefined && this.#options.gitIgnore) { const loaded = await this.readFile(join(directory, '.gitignore'), directory, 3); if (!loaded.ok) return loaded; }
    if (this.#options.ignore) { const loaded = await this.readFile(join(directory, '.ignore'), directory, 4); if (!loaded.ok) return loaded; }
    return { ok: true, value: undefined };
  }

  async ignored(relativePath: string, isDirectory: boolean, absolutePath = resolve(this.#root, relativePath), checkAncestors = true): Promise<boolean> {
    const parts = relativePath.split('/');
    for (let count = checkAncestors ? 1 : parts.length; count <= parts.length; count += 1) {
      const current = count === parts.length ? absolutePath : resolve(this.#root, ...parts.slice(0, count));
      const directory = count < parts.length || isDirectory;
      let matched: IgnoreRule | undefined;
      for (let index = 0; index < this.#rules.length; index += 1) {
        if (index % 256 === 255) await new Promise<void>((done) => setImmediate(done));
        const rule = this.#rules[index]!;
        if (rule.directoryOnly && !directory) continue;
        const candidate = relative(rule.base, current).replaceAll('\\', '/');
        if (candidate === '..' || candidate.startsWith('../') || candidate === '') continue;
        const subject = rule.basenameOnly ? basename(candidate) : candidate;
        if (!rule.glob.match(subject)) continue;
        if (matched === undefined || rule.priority > matched.priority || (rule.priority === matched.priority && rule.base.length >= matched.base.length)) matched = rule;
      }
      if (matched !== undefined && !matched.negated) return true;
    }
    return false;
  }

  private async readFile(path: string, base: string, priority: number): Promise<Result<void, PlatformFailure>> {
    if (this.#cancellation.isCancelled) return cancelled();
    if (this.#loaded.has(`file:${path}`)) return { ok: true, value: undefined };
    this.#loaded.add(`file:${path}`);
    let source: string;
    try {
      const file = await fs.open(path, 'r');
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (bytes <= 1024 * 1024) {
          if (this.#cancellation.isCancelled) return cancelled();
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, 1024 * 1024 + 1 - bytes));
          const read = await file.read(buffer, 0, buffer.length, null);
          if (read.bytesRead === 0) break;
          bytes += read.bytesRead;
          chunks.push(buffer.subarray(0, read.bytesRead));
        }
        if (bytes > 1024 * 1024) return { ok: false, error: { code: 'ignore-file-too-large', message: `${path} exceeds 1 MiB`, retryable: false } };
        source = Buffer.concat(chunks, bytes).toString('utf8');
      } finally { await file.close(); }
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return { ok: true, value: undefined };
      return { ok: false, error: platformFailure(error, 'read-ignore') };
    }
    const lines = source.split(/\r?\n/u).slice(0, 16_384);
    for (let index = 0; index < lines.length; index += 1) {
      if (this.#cancellation.isCancelled) return cancelled();
      const line = lines[index]!;
      const rule = parseIgnoreRule(line, base, priority);
      if (rule !== undefined) {
        if (this.#rules.length >= 65_536) return { ok: false, error: { code: 'ignore-rule-limit', message: 'ignore rule limit reached', retryable: false } };
        this.#rules.push(rule);
      }
      if (index % 256 === 255) await new Promise<void>((done) => setImmediate(done));
    }
    return { ok: true, value: undefined };
  }
}

/** Check specific open-buffer paths with the same ignore rules as file enumeration. */
async function visibleWorkspacePaths(
  root: string,
  paths: readonly string[],
  options: WorkspaceIgnoreOptions,
  cancellation: CancellationToken,
): Promise<Result<ReadonlySet<string>, PlatformFailure>> {
  const rootPath = resolve(root);
  const created = await WorkspaceIgnoreMatcher.create(rootPath, options, cancellation);
  if (!created.ok) return created;
  const visible = new Set<string>();
  for (const path of paths) {
    if (cancellation.isCancelled) return cancelled();
    const absolute = resolve(rootPath, path);
    const relativePath = relative(rootPath, absolute);
    if (path.length === 0 || path.includes('\0') || isAbsolute(path) || relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return { ok: false, error: { code: 'invalid-path', message: `path escapes workspace: ${path}`, retryable: false } };
    const parts = relativePath.split(sep);
    let ignored = false;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const directory = resolve(rootPath, ...parts.slice(0, depth));
      const loaded = await created.value.loadDirectory(directory);
      if (!loaded.ok) return loaded;
      const candidate = parts.slice(0, depth + 1).join('/');
      if (await created.value.ignored(candidate, depth < parts.length - 1, resolve(rootPath, candidate))) { ignored = true; break; }
    }
    if (!ignored) visible.add(path);
  }
  return { ok: true, value: visible };
}

function parseIgnoreRule(raw: string, base: string, priority: number): IgnoreRule | undefined {
  let pattern = raw.replace(/(?<!\\) +$/u, '');
  if (pattern.length === 0 || pattern.startsWith('#')) return undefined;
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  if (pattern.length === 0) return undefined;
  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  if (pattern.length === 0) return undefined;
  try { return { base, glob: new Bun.Glob(pattern), basenameOnly: !anchored && !pattern.includes('/'), directoryOnly, negated, priority }; }
  catch { return undefined; }
}

async function discoverGitDirectory(root: string): Promise<string | undefined> {
  let directory = resolve(root);
  for (let depth = 0; depth < 32; depth += 1) {
    const marker = join(directory, '.git');
    const info = await safeLstat(marker);
    if (info?.isDirectory()) return marker;
    if (info?.isFile()) {
      const source = await readSmallGitMarker(marker);
      const target = /^gitdir:\s*(.+)\s*$/mu.exec(source ?? '')?.[1];
      if (target !== undefined) {
        const gitDirectory = resolve(directory, target);
        const common = await readSmallGitMarker(join(gitDirectory, 'commondir'));
        return common === undefined ? gitDirectory : resolve(gitDirectory, common.trim());
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

async function readSmallGitMarker(path: string): Promise<string | undefined> {
  try {
    const file = await fs.open(path, 'r');
    try {
      const bytes = Buffer.alloc(4097);
      const read = await file.read(bytes, 0, bytes.length, 0);
      return read.bytesRead > 4096 ? undefined : bytes.toString('utf8', 0, read.bytesRead);
    } finally { await file.close(); }
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Coalescing window for `watchDirectory`'s 'changed' events; bounded below the 8ms/25ms latency budgets. */
const COALESCE_MILLISECONDS = 20;

/**
 * Native asynchronous filesystem adapter. Persistence owns the write policy;
 * this adapter only supplies the platform port and the atomic primitive.
 */
export class NodeFilesystemPort implements FilesystemPort {
  #temporaryCounter = 0;

  /** Resolve dirty-buffer eligibility through the same filesystem ignore policy as enumeration. */
  visibleWorkspacePaths(root: string, paths: readonly string[], options: WorkspaceIgnoreOptions, cancellation: CancellationToken): Promise<Result<ReadonlySet<string>, PlatformFailure>> {
    return visibleWorkspacePaths(root, paths, options, cancellation);
  }

  /** Keep OS path policy behind the platform boundary used by the launcher. */
  resolvePath(base: string, path: string): string { return resolve(base, path); }
  directoryPath(path: string): string { return dirname(path); }

  async readFile(path: string, cancellation: CancellationToken, options?: ReadFileOptions): Promise<Result<Uint8Array, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      if (options?.maxBytes !== undefined) {
        // Stat first so an oversized file is rejected before any of it is read into memory,
        // instead of materializing the whole file only to discover it is too large.
        const info = await fs.stat(path);
        if (cancellation.isCancelled) return cancelled();
        if (info.size > options.maxBytes) {
          return { ok: false, error: { code: 'file-too-large', message: `${path} is ${String(info.size)} bytes, exceeds the ${String(options.maxBytes)}-byte read bound`, retryable: false } };
        }
      }
      const bytes = await fs.readFile(path);
      if (cancellation.isCancelled) return cancelled();
      return { ok: true, value: new Uint8Array(bytes) };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'read-file') };
    }
  }

  async readFileChunks(path: string, cancellation: CancellationToken): Promise<Result<AsyncIterable<Uint8Array>, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    // Open the file handle up front instead of handing `createReadStream(path, ...)` a bare
    // path: that opens lazily and reports a missing/unreadable file as an async 'error' event
    // once the caller starts iterating, which throws out of the returned async generator
    // instead of surfacing here as a Result -- so a >256KiB open behaved differently (crashed)
    // than the small-file read path (which returns { ok: false, error: {...} }) for the exact
    // same missing file.
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(path, 'r');
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'read-file') };
    }
    if (cancellation.isCancelled) {
      await handle.close().catch(() => {});
      return cancelled();
    }
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024 });
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
        await handle.close().catch(() => {});
      }
    }
    return { ok: true, value: chunks() };
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
    options: WorkspaceDirectoryEnumerationOptions = {},
  ): Promise<Result<readonly WorkspaceDirectoryEntry[], PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    const ignoredNames = new Set(options.ignoredDirectoryNames ?? []);
    const ignoreMatcher = await WorkspaceIgnoreMatcher.create(root, options.ignore, cancellation);
    if (!ignoreMatcher.ok) return ignoreMatcher;
    const loadedDirectories: string[] = [];
    let current = resolve(path);
    const resolvedRoot = resolve(root);
    while (true) {
      loadedDirectories.push(current);
      if (current === resolvedRoot) break;
      const parent = dirname(current);
      if (parent === current || relative(resolvedRoot, current).startsWith('..')) break;
      current = parent;
    }
    for (const directory of loadedDirectories.reverse()) {
      const loaded = await ignoreMatcher.value.loadDirectory(directory);
      if (!loaded.ok) return loaded;
    }
    // Capped consistent with enumerateFiles's 120k background-index limit, and
    // batched with bounded concurrency instead of one sequential lstat per child.
    const maxEntries = options.maxEntries ?? 120_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return { ok: false, error: { code: 'invalid-limit', message: 'directory enumeration limit must be positive', retryable: false } };
    const concurrency = 64;
    try {
      const result: WorkspaceDirectoryEntry[] = [];
      const pending: import('node:fs').Dirent[] = [];
      const directory = await fs.opendir(path);
      for await (const entry of directory) {
        if (cancellation.isCancelled) return cancelled();
        if (result.length + pending.length >= maxEntries) return { ok: false, error: { code: 'enumeration-limit', message: 'directory enumeration limit reached', retryable: false } };
        pending.push(entry);
        if (pending.length === concurrency) {
          const rows = await Promise.all(pending.splice(0).map((item) => this.statDirectoryEntry(path, root, item, ignoredNames, ignoreMatcher.value)));
          result.push(...rows);
        }
      }
      if (pending.length > 0) result.push(...await Promise.all(pending.map((item) => this.statDirectoryEntry(path, root, item, ignoredNames, ignoreMatcher.value))));
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
    ignoreMatcher: WorkspaceIgnoreMatcher,
  ): Promise<WorkspaceDirectoryEntry> {
    const absolutePath = join(path, entry.name);
    const relativePath = relative(root, absolutePath).split('\\').join('/');
    const ignored = ignoredNames.has(entry.name) || await ignoreMatcher.ignored(relativePath, entry.isDirectory(), absolutePath);
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
      // Raw fs.watch can fire many events for one logical change (e.g. a single
      // write touching a file's mtime and size separately). Coalesce per path in
      // a short window instead of forwarding 1:1, so a write burst to one file
      // reaches the listener as one 'changed' event rather than a flood.
      const pending = new Map<string, WorkspaceDirectoryWatchEvent>();
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = (): void => {
        flushTimer = undefined;
        if (disposed || pending.size === 0) return;
        const events = [...pending.values()];
        pending.clear();
        for (const event of events) listener(event);
      };
      const onWatchEvent = (_eventType: string, filename: string | Buffer | null): void => {
        if (cancellation.isCancelled) return;
        const child = filename === undefined || filename === null ? path : join(path, filename.toString());
        pending.set(child, { kind: 'changed', path: child });
        if (flushTimer === undefined) flushTimer = setTimeout(flush, COALESCE_MILLISECONDS);
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
      // watcher going silent or the process going down. Overflow is reported
      // immediately, bypassing coalescing, and any pending coalesced flush is
      // dropped since the watcher is closing anyway.
      watcher.on('error', () => {
        if (disposed) return;
        disposed = true;
        if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
        watcher.close();
        if (!cancellation.isCancelled) listener({ kind: 'overflow', path });
      });
      const cancellationSubscription = cancellation.onCancel(() => {
        if (disposed) return;
        disposed = true;
        if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
        watcher.close();
      });
      return {
        ok: true,
        value: Object.freeze({
          dispose() {
            if (disposed) return;
            disposed = true;
            if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
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
    const maxVisitedEntries = options.maxVisitedEntries ?? 500_000;
    if (!Number.isSafeInteger(maxVisitedEntries) || maxVisitedEntries < 1) return { ok: false, error: { code: 'invalid-limit', message: 'file enumeration visit limit must be positive', retryable: false } };
    const ignored = new Set(options.ignoredDirectoryNames ?? []);
    const followSymlinks = options.followSymlinks === true;
    const deduplicateLinks = options.deduplicateLinks !== false;
    const maxDepth = options.maxDepth;
    if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 0)) return { ok: false, error: { code: 'invalid-limit', message: 'file enumeration max depth must be a non-negative integer', retryable: false } };
    const ignoreMatcher = await WorkspaceIgnoreMatcher.create(root, options.ignore, cancellation);
    if (!ignoreMatcher.ok) return { ok: false, error: ignoreMatcher.error };
    const queue: Array<{ readonly absolute: string; readonly relative: string; readonly ancestors: readonly string[]; readonly depth: number }> = [{ absolute: root, relative: '', ancestors: [], depth: 0 }];
    const visitedDirectories = new Set<string>();
    const visitedFiles = new Set<string>();
    const batch: WorkspaceFileEntry[] = [];
    let total = 0;
    let visited = 0;
    try {
      while (queue.length > 0 && total < maxEntries) {
        if (cancellation.isCancelled) return cancelled();
        if (++visited > maxVisitedEntries) return { ok: false, error: { code: 'enumeration-limit', message: 'file enumeration visit limit reached', retryable: false } };
        let directory = queue.shift();
        if (directory === undefined) break;
        const loadedRules = await ignoreMatcher.value.loadDirectory(directory.absolute);
        if (!loadedRules.ok) return loadedRules;
        if (followSymlinks) {
          const realDirectory = await fs.realpath(directory.absolute);
          if (directory.ancestors.includes(realDirectory)) continue;
          if (deduplicateLinks && visitedDirectories.has(realDirectory)) continue;
          if (deduplicateLinks) visitedDirectories.add(realDirectory);
          directory = { ...directory, ancestors: [...directory.ancestors, realDirectory] };
        }
        let entries: Awaited<ReturnType<typeof fs.opendir>>;
        try {
          entries = await fs.opendir(directory.absolute);
        } catch (error: unknown) {
          if (directory.relative.length === 0) return { ok: false, error: platformFailure(error, 'enumerate-files') };
          continue;
        }
        for await (const entry of entries) {
          if (cancellation.isCancelled) return cancelled();
          if (++visited > maxVisitedEntries) return { ok: false, error: { code: 'enumeration-limit', message: 'file enumeration visit limit reached', retryable: false } };
          const relativePath = directory.relative.length === 0 ? entry.name : `${directory.relative}/${entry.name}`;
          const absolutePath = join(directory.absolute, entry.name);
          // Ancestor directories have already passed this matcher before entering the
          // queue; checking them again for every child multiplies deep-tree work.
          if (await ignoreMatcher.value.ignored(relativePath, entry.isDirectory(), absolutePath, false)) continue;
          if (entry.isDirectory()) {
            if (!ignored.has(entry.name) && (maxDepth === undefined || directory.depth < maxDepth)) queue.push({ absolute: absolutePath, relative: relativePath, ancestors: directory.ancestors, depth: directory.depth + 1 });
            continue;
          }
          let fileIdentity = resolve(directory.ancestors.at(-1) ?? directory.absolute, entry.name);
          if (entry.isSymbolicLink() && followSymlinks) {
            let target: import('node:fs').Stats;
            try { target = await fs.stat(absolutePath); } catch { continue; }
            if (target.isDirectory()) {
              if (!ignored.has(entry.name) && (maxDepth === undefined || directory.depth < maxDepth)) queue.push({ absolute: absolutePath, relative: relativePath, ancestors: directory.ancestors, depth: directory.depth + 1 });
              continue;
            }
            if (!target.isFile()) continue;
            if (deduplicateLinks) {
              try { fileIdentity = await fs.realpath(absolutePath); } catch { continue; }
            }
          } else if (!entry.isFile() || entry.isSymbolicLink()) continue;
          if (deduplicateLinks && visitedFiles.has(fileIdentity)) continue;
          if (deduplicateLinks) visitedFiles.add(fileIdentity);
          batch.push(Object.freeze({ relativePath, absolutePath, hidden: relativePath.startsWith('.') || relativePath.includes('/.') }));
          total += 1;
          if (batch.length >= 128) {
            await onBatch(Object.freeze(batch.splice(0, batch.length)));
            await new Promise<void>((done) => setImmediate(done));
          }
          if (total >= maxEntries) break;
        }
      }
      if (batch.length > 0) await onBatch(Object.freeze(batch.splice(0, batch.length)));
      if (total >= maxEntries) return { ok: false, error: { code: 'enumeration-limit', message: 'file enumeration result limit reached', retryable: false } };
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'enumerate-files') };
    }
  }

  async writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    return this.writeFileAtomicChunks(path, oneChunk(contents), cancellation);
  }

  async writeFile(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const existing = await safeLstat(path);
      if (existing?.isSymbolicLink()) return { ok: false, error: { code: 'symlink-save', message: 'refusing to write through a symbolic link', retryable: false } };
      const mode = existing === undefined ? 0o666 : existing.mode & 0o7777;
      handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
      if (cancellation.isCancelled) return cancelled();
      let written = 0;
      while (written < contents.byteLength) {
        const result = await handle.write(contents, written, contents.byteLength - written);
        if (result.bytesWritten <= 0) throw new Error('write-file made no progress');
        written += result.bytesWritten;
      }
      await handle.close();
      handle = undefined;
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return { ok: false, error: platformFailure(error, 'write-file') };
    } finally {
      await handle?.close().catch(() => {});
    }
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
      if (existing !== undefined) {
        // `fs.open`'s mode argument is masked by the process umask when creating a new file,
        // so it alone cannot guarantee the temp file ends up with the original file's exact
        // permissions (e.g. an original mode more permissive than `~umask`). chmod sets the
        // exact bits, bypassing umask, before the temp file replaces the original.
        await temporaryHandle.chmod(existing.mode & 0o7777);
      }
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
      // Best-effort: ensure the directory entry itself reaches stable storage where the
      // platform exposes directory fsync. The rename that makes the new content visible under
      // `path` has already completed successfully by this point, so a failure here (e.g. a
      // platform/filesystem that refuses to open a directory for fsync) must not be reported
      // as a failed save -- that would tell the caller its content was lost when it was not.
      try {
        const directoryHandle = await fs.open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch {
        // Ignored: the save itself succeeded; only the directory-entry durability
        // enhancement could not be confirmed on this platform/filesystem.
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

  /** Create a config file once without replacing an existing file or racing another process. */
  async createFileIfMissing(path: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (cancellation.isCancelled) return cancelled();
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      const handle = await fs.open(path, 'wx');
      await handle.close();
      return cancellation.isCancelled ? cancelled() : { ok: true, value: undefined };
    } catch (error: unknown) {
      return errorCode(error) === 'EEXIST' ? { ok: true, value: undefined } : { ok: false, error: platformFailure(error, 'create-file') };
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
    // A missing temp file is expected (e.g. it was never created, or a prior cleanup already
    // removed it) and is swallowed; anything else (EPERM, EBUSY, ...) is a real failure to
    // clean up a temp file and must not be silently dropped -- both branches previously fell
    // through to the same implicit return regardless of the error.
    if (errorCode(error) !== 'ENOENT') throw error;
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
