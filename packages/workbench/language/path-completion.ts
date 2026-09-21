import type { CancellationToken, Result } from '../../contracts/src/index';
import { pathCompletionToken, type CompletionProviderPort, type WorkbenchCompletionList, type WorkbenchCompletionRequest } from './completion';
import type { LanguageWorkbenchSessionPort } from './overlays';

const PATH_COMPLETION_LIMIT = 200;

interface PathCompletionFilesystemPort {
  directoryPath(path: string): string;
  resolvePath(base: string, path: string): string;
  enumerateDirectory(path: string, root: string, cancellation: CancellationToken, options: { readonly maxEntries: number }): Promise<Result<readonly { readonly name: string; readonly kind: 'directory' | 'file' | 'symlink' | 'other'; readonly relativePath: string }[], { readonly message: string }>>;
}

/** Local path completion is workbench behavior over a typed filesystem port. */
export function createPathCompletionProvider(
  filesystem: PathCompletionFilesystemPort,
  session: LanguageWorkbenchSessionPort,
  workspaceRoot: string,
): CompletionProviderPort {
  return {
    complete: async (request: WorkbenchCompletionRequest, cancellation?: CancellationToken): Promise<Result<WorkbenchCompletionList, { readonly kind: 'unavailable'; readonly message: string }>> => {
      const activeViewId = session.activeViewId;
      const view = activeViewId === undefined ? undefined : session.readView(activeViewId);
      const primary = view?.selections.members.find((member) => member.id === view.selections.primaryId);
      if (view === undefined || primary === undefined || cancellation?.isCancelled === true) return { ok: true, value: { isIncomplete: false, items: [] } };
      const lineIndex = view.document.lineIndexAt(primary.head.at.offset);
      if (!lineIndex.ok) return { ok: true, value: { isIncomplete: false, items: [] } };
      const lineStart = view.document.lineStartOffset(lineIndex.value);
      if (!lineStart.ok) return { ok: true, value: { isIncomplete: false, items: [] } };
      const line = view.document.slice(lineStart.value, primary.head.at.offset);
      const token = line.ok ? pathCompletionToken(line.value) : undefined;
      if (token === undefined) return { ok: true, value: { isIncomplete: false, items: [] } };
      const buffer = session.buffers().find((candidate) => candidate.documentId === view.document.id);
      const baseDirectory = buffer?.path === undefined ? workspaceRoot : filesystem.directoryPath(buffer.path);
      const slash = token.text.lastIndexOf('/');
      const directoryText = slash < 0 ? '.' : token.text.slice(0, slash) || '/';
      const prefix = slash < 0 ? token.text : token.text.slice(slash + 1);
      const directory = directoryText.startsWith('/') ? directoryText : filesystem.resolvePath(baseDirectory, directoryText);
      const listed = await filesystem.enumerateDirectory(directory, directory, cancellation ?? neverCancelled, { maxEntries: PATH_COMPLETION_LIMIT });
      if (!listed.ok) return { ok: false, error: { kind: 'unavailable', message: listed.error.message } };
      const items = listed.value
        .filter((entry) => entry.name.startsWith(prefix) && entry.kind !== 'other')
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, PATH_COMPLETION_LIMIT)
        .map((entry, index) => {
          const replacement = `${token.text.slice(0, slash + 1)}${entry.name}${entry.kind === 'directory' || entry.kind === 'symlink' ? '/' : ''}`;
          return {
            id: `path:${request.documentId}:${request.documentVersion}:${index}:${entry.relativePath}`,
            label: replacement,
            detail: entry.kind,
            textEdit: { start: { line: request.position.line, utf16: token.start }, end: request.position, newText: replacement },
          };
        });
      return { ok: true, value: Object.freeze({ isIncomplete: listed.value.length >= PATH_COMPLETION_LIMIT, items: Object.freeze(items) }) };
    },
  };
}

const neverCancelled: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => ({ dispose() {} }) });
