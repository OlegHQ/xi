import type { CancellationToken, FilesystemPort, PersistedJumpLocation, PlatformFailure, Result } from '../../contracts/src/index';

/** The jumplist is bounded like Vim's and never stores document contents. */
export async function loadJumpHistory(filesystem: FilesystemPort, path: string, cancellation: CancellationToken): Promise<Result<readonly PersistedJumpLocation[], PlatformFailure>> {
  const read = await filesystem.readFile(path, cancellation, { maxBytes: 1024 * 1024 });
  if (!read.ok) return read.error.code === 'ENOENT' ? { ok: true, value: [] } : read;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.value));
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 || !('entries' in value) || !Array.isArray(value.entries) || value.entries.length > 100) throw new Error('invalid jump history');
    const entries: PersistedJumpLocation[] = [];
    for (const entry of value.entries as unknown[]) {
      if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string' || !entry.path.startsWith('/') || entry.path.length > 8192 || entry.path.includes('\0') || !('line' in entry) || typeof entry.line !== 'number' || !Number.isSafeInteger(entry.line) || entry.line < 0 || !('columnUtf16' in entry) || typeof entry.columnUtf16 !== 'number' || !Number.isSafeInteger(entry.columnUtf16) || entry.columnUtf16 < 0) throw new Error('invalid jump location');
      entries.push(Object.freeze({ path: entry.path, line: entry.line, columnUtf16: entry.columnUtf16 }));
    }
    return { ok: true, value: Object.freeze(entries) };
  } catch {
    return { ok: false, error: { retryable: false, code: 'invalid-jump-history', message: `Invalid jump history: ${path}` } };
  }
}

export function saveJumpHistory(filesystem: FilesystemPort, path: string, entries: readonly PersistedJumpLocation[], cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
  return filesystem.writeFileAtomic(path, new TextEncoder().encode(JSON.stringify({ version: 1, entries: entries.slice(-100) })), cancellation);
}
