/** Pure ctags (tags file) parsing: no filesystem access, no host navigation semantics. Callers
 * read the file, cap its size before decoding if desired, and use `parseCtags`/`lookupCtags` to
 * find entries by name. */

import type { CancellationToken, FilesystemPort, Result } from '../../contracts/src/index';
import type { HostNavigationFailure, HostNavigationProvider, HostLocation } from './host';

/** Filesystem operations the ctags navigation host needs beyond the contracts `FilesystemPort`. */
export interface CtagsFilesystemPort extends FilesystemPort {
  resolvePath(base: string, path: string): string;
  directoryPath(path: string): string;
}

export interface CtagsNavigationHostOptions {
  readonly filesystem: CtagsFilesystemPort;
  readonly workspaceRoot: string;
  readonly fileUri: (path: string) => string;
  /** Tags files searched, relative to `workspaceRoot`, in order. Defaults to `tags` then `.tags`. */
  readonly tagsFileNames?: readonly string[];
  /** Maximum tags-file size read; larger files are skipped. Defaults to 4 MiB. */
  readonly maxTagsFileBytes?: number;
}

interface CachedTagsFile {
  readonly sizeBytes: number;
  readonly modifiedMilliseconds: number;
  readonly records: readonly CtagsRecord[];
}

/** Builds the `{ file, tag }` provider `HostNavigationController` needs to resolve `gf`/tag/host
 * navigation against the workspace filesystem and a `tags`/`.tags` ctags file. */
export function createCtagsNavigationHost(options: CtagsNavigationHostOptions): HostNavigationProvider {
  const { filesystem, workspaceRoot, fileUri } = options;
  const tagsFileNames = options.tagsFileNames ?? ['tags', '.tags'];
  const maxTagsFileBytes = options.maxTagsFileBytes ?? 4 * 1024 * 1024;
  // Host-scoped: parsed records are reused across lookups for the same workspace as long as the
  // tags file's (size, mtime) from the stat already taken for admission is unchanged, instead of
  // re-reading and re-parsing a file up to maxTagsFileBytes on every single lookup.
  // `cancellation` is optional on `HostNavigationProvider` for callers that have none in scope
  // (e.g. tests); when omitted, a token that never reports cancellation is equivalent, since each
  // op here is one bounded stat/read.
  const fallbackCancellation: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose(): void {} }) });
  const cache = new Map<string, CachedTagsFile>();
  return {
    async file(path: string, line?: number, cancellation?: CancellationToken): Promise<Result<HostLocation, HostNavigationFailure>> {
      const token = cancellation ?? fallbackCancellation;
      if (path.length === 0 || path.includes('\0') || !path.startsWith('/')) return { ok: false, error: { kind: 'missing', message: `file target is invalid: ${path}` } };
      if (token.isCancelled) return { ok: false, error: { kind: 'cancelled', message: 'file navigation was cancelled' } };
      const info = await filesystem.stat(path, token);
      if (!info.ok) return { ok: false, error: { kind: 'missing', message: `file target is unavailable: ${path}` } };
      if (info.value.kind !== 'file' && info.value.kind !== 'symlink') return { ok: false, error: { kind: 'missing', message: `file target is not a file: ${path}` } };
      const safeLine = line === undefined ? 0 : line;
      if (!Number.isSafeInteger(safeLine) || safeLine < 0) return { ok: false, error: { kind: 'unavailable', message: 'file line is invalid' } };
      return { ok: true, value: Object.freeze({ uri: fileUri(path), line: safeLine, utf16: 0 }) };
    },
    async tag(name: string, cancellation?: CancellationToken): Promise<Result<readonly HostLocation[], HostNavigationFailure>> {
      const token = cancellation ?? fallbackCancellation;
      if (name.length === 0 || name.length > 4096 || name.includes('\0') || /\s/u.test(name)) return { ok: false, error: { kind: 'missing', message: `tag ${name} was not found` } };
      const results: HostLocation[] = [];
      for (const tagsFileName of tagsFileNames) {
        if (token.isCancelled) return { ok: false, error: { kind: 'cancelled', message: 'tag navigation was cancelled' } };
        const tagsPath = filesystem.resolvePath(workspaceRoot, tagsFileName);
        const info = await filesystem.stat(tagsPath, token);
        if (!info.ok || info.value.kind !== 'file' || info.value.sizeBytes > maxTagsFileBytes) {
          cache.delete(tagsPath);
          continue;
        }
        const cached = cache.get(tagsPath);
        let records: readonly CtagsRecord[];
        if (cached !== undefined && cached.sizeBytes === info.value.sizeBytes && cached.modifiedMilliseconds === info.value.modifiedMilliseconds) {
          records = cached.records;
        } else {
          const bytes = await filesystem.readFile(tagsPath, token);
          if (!bytes.ok) continue;
          let content: string;
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value); } catch { continue; }
          records = parseCtags(content);
          cache.set(tagsPath, { sizeBytes: info.value.sizeBytes, modifiedMilliseconds: info.value.modifiedMilliseconds, records });
        }
        for (const record of lookupCtags(records, name)) {
          const targetPath = record.path.startsWith('/') ? record.path : filesystem.resolvePath(filesystem.directoryPath(tagsPath), record.path);
          if (targetPath.includes('\0')) continue;
          results.push(Object.freeze({ uri: fileUri(targetPath), line: record.line, utf16: 0 }));
        }
      }
      return { ok: true, value: Object.freeze(results) };
    },
  };
}

export interface CtagsRecord {
  readonly name: string;
  /** The path field exactly as written in the tags file (relative or absolute); resolving it
   * against the tags file's directory is the caller's job, since that needs a filesystem port. */
  readonly path: string;
  /** Zero-based line number decoded from the ex-command address field, defaulting to 0 when the
   * address does not carry a recognizable line number. */
  readonly line: number;
}

const LINE_ADDRESS = /(?:^|;)line:([1-9][0-9]*)/;
const NUMERIC_ADDRESS = /^(?:[?/]?(\d+))(?:;"|[/?])?$/u;

/** Parses ctags (Universal/Exuberant) tab-separated tag lines, skipping `!_TAG_` pseudo-tag
 * headers. Supports both the `line:N` extension field and a bare/`;"`-terminated numeric
 * ex-command address; other ex-command addresses (search patterns) default to line 0, matching
 * the behavior of a `:tag` jump that then relies on a text search. When `options.maxBytes` is
 * given and the UTF-8 byte length of `text` exceeds it, returns no records (the file is treated
 * as too large to trust, the same as skipping it before reading). */
export function parseCtags(text: string, options?: { readonly maxBytes?: number }): readonly CtagsRecord[] {
  if (options?.maxBytes !== undefined && new TextEncoder().encode(text).byteLength > options.maxBytes) return Object.freeze([]);
  const records: CtagsRecord[] = [];
  const length = text.length;
  // Cursor-based scan: avoids materializing a `split('\n')` line array and a `split('\t')`
  // field array per row for files up to maxTagsFileBytes.
  let rowStart = 0;
  while (rowStart <= length) {
    const newline = text.indexOf('\n', rowStart);
    const lineEnd = newline === -1 ? length : newline;
    let rowEnd = lineEnd;
    if (rowEnd > rowStart && text.charCodeAt(rowEnd - 1) === 13 /* \r */) rowEnd -= 1;
    if (rowEnd > rowStart && !text.startsWith('!_TAG_', rowStart)) {
      const tab1 = text.indexOf('\t', rowStart);
      if (tab1 !== -1 && tab1 < rowEnd) {
        const tab2 = text.indexOf('\t', tab1 + 1);
        if (tab2 !== -1 && tab2 < rowEnd) {
          const tab3 = text.indexOf('\t', tab2 + 1);
          const addressEnd = tab3 !== -1 && tab3 < rowEnd ? tab3 : rowEnd;
          const name = text.slice(rowStart, tab1);
          const path = text.slice(tab1 + 1, tab2);
          const address = text.slice(tab2 + 1, addressEnd);
          const lineMatch = LINE_ADDRESS.exec(address);
          const numericMatch = NUMERIC_ADDRESS.exec(address);
          const lineNumber = lineMatch?.[1] ?? numericMatch?.[1];
          const line = lineNumber === undefined ? 0 : Number(lineNumber) - 1;
          if (Number.isSafeInteger(line) && line >= 0) records.push(Object.freeze({ name, path, line }));
        }
      }
    }
    if (newline === -1) break;
    rowStart = newline + 1;
  }
  return Object.freeze(records);
}

/** Returns every record whose tag name matches exactly. */
export function lookupCtags(records: readonly CtagsRecord[], name: string): readonly CtagsRecord[] {
  return Object.freeze(records.filter((record) => record.name === name));
}
