import type { Utf16Offset } from '../../contracts/src/index';
import type { DocumentSnapshot } from '../../document/src/index';
import type { DirectoryOperation, DirectoryOperationPlan } from './directory-draft';
import { decodeDirectoryName } from './directory-draft';

export interface DirectoryBufferSource {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}
export interface DirectoryBufferInput { readonly path: string; readonly snapshot: DocumentSnapshot; readonly sourceIds?: readonly string[] }

/** Path identities live in the line so ordinary Vim registers carry them between
 * directories. Only the UI conceals this prefix; the document owns editable text. */
export function parseDirectoryBufferLine(text: string): { readonly id: string | undefined; readonly name: string; readonly prefixLength: number } {
  const match = /^\/(\d+)\//u.exec(text);
  return { id: match?.[1], name: text.slice(match?.[0].length ?? 0), prefixLength: match?.[0].length ?? 0 };
}

export function compileDirectoryBuffers(root: string, buffers: readonly DirectoryBufferInput[], sources: readonly DirectoryBufferSource[]):
  { readonly ok: true; readonly value: DirectoryOperationPlan } | { readonly ok: false; readonly error: string } {
  const indexed = new Map(sources.map((source) => [source.id, source]));
  const destinations = new Map<string, { readonly id: string | undefined; readonly directory: boolean }>();
  const occurrences = new Map<string, string[]>();
  const creates = new Map<string, boolean>();
  for (const buffer of buffers) {
    const text = buffer.snapshot.slice(0 as Utf16Offset, buffer.snapshot.lengthUtf16 as Utf16Offset);
    if (!text.ok) return { ok: false, error: 'directory text could not be read' };
    const lines = text.value.split('\n');
    for (let line = 0; line < lines.length; line += 1) {
      const row = parseDirectoryBufferLine(lines[line] ?? '');
      if (row.name.length === 0 && row.id === undefined) continue;
      const decoded = decodeDirectoryName(row.name);
      if (!decoded.ok) return { ok: false, error: `${buffer.path}:${line + 1}: ${decoded.message}` };
      const directory = decoded.value.endsWith('/');
      const name = directory ? decoded.value.slice(0, -1) : decoded.value;
      if (name.length === 0 || name.includes('\0') || name.startsWith('/') || name.split('/').some((part) => part === '' || part === '.' || part === '..')) return { ok: false, error: `${buffer.path}:${line + 1}: invalid entry name` };
      const path = `${buffer.path.replace(/\/$/u, '')}/${name}`;
      if (!path.startsWith(`${root.replace(/\/$/u, '')}/`)) return { ok: false, error: 'destination is outside the workspace' };
      if (destinations.has(path)) return { ok: false, error: `duplicate destination: ${path}` };
      if (row.id !== undefined && !indexed.has(row.id)) return { ok: false, error: 'entry identity was modified; undo that edit' };
      destinations.set(path, { id: row.id, directory });
      if (row.id !== undefined) occurrences.set(row.id, [...(occurrences.get(row.id) ?? []), path]);
      else {
        creates.set(path, directory);
        let parent = path.slice(0, path.lastIndexOf('/'));
        while (parent.length > buffer.path.replace(/\/$/u, '').length) {
          if (!sources.some((source) => source.path === parent && source.kind === 'directory')) creates.set(parent, true);
          parent = parent.slice(0, parent.lastIndexOf('/'));
        }
      }
    }
  }
  const operations: DirectoryOperation[] = [];
  for (const source of sources) {
    const paths = occurrences.get(source.id) ?? [];
    const parentLoaded = buffers.some((buffer) => buffer.sourceIds === undefined ? source.path.slice(0, source.path.lastIndexOf('/')) === buffer.path.replace(/\/$/u, '') : buffer.sourceIds.includes(source.id));
    if (!parentLoaded && paths.length === 0) continue;
    const original = paths.includes(source.path) || !parentLoaded;
    const targets = paths.filter((path) => path !== source.path);
    if (source.kind === 'symlink' && (!original || targets.length > 0)) return { ok: false, error: `symbolic link operations are refused: ${source.path}` };
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      if (source.kind === 'directory' && target.startsWith(`${source.path}/`)) return { ok: false, error: 'cannot move or copy a directory inside itself' };
      const rowId = `${source.id}-${index}`;
      if (!original && index === 0) operations.push({ kind: 'rename', rowId, sourceId: source.id, sourcePath: source.path, destinationPath: target, from: source.path, to: target });
      else operations.push({ kind: 'copy', rowId, sourceId: source.id, sourcePath: source.path, destinationPath: target });
    }
    if (!original && targets.length === 0) operations.push({ kind: 'trash', rowId: source.id, sourceId: source.id, sourcePath: source.path });
  }
  for (const operation of operations) {
    if (operations.some((candidate) => candidate !== operation && candidate.kind !== 'copy' && operation.sourcePath.startsWith(`${candidate.sourcePath}/`))) return { ok: false, error: 'synchronize edits inside a directory before moving or deleting that directory' };
  }
  for (const [path, directory] of [...creates].sort(([left], [right]) => left.split('/').length - right.split('/').length)) operations.push({ kind: 'create', rowId: `new-${operations.length}`, sourcePath: path, destinationPath: path, directory });
  if (operations.length > 256) return { ok: false, error: 'synchronize at most 256 operations at once' };
  return { ok: true, value: { contractVersion: 1, directoryPath: root, baseGeneration: 0, operations } };
}
