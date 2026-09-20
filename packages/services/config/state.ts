import { CancellationSource, type CancellationToken, type PlatformFailure, type Result, type ReadFileOptions } from '../../contracts/src/index';
import { parseToml, patchInlineTableScalar, patchTomlScalar } from './index';

interface StateFilesystem {
  readFile(path: string, cancellation: CancellationToken, options?: ReadFileOptions): Promise<Result<Uint8Array, PlatformFailure>>;
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
}

export type EditorStateKey = 'sidebar-visible' | 'sidebar-width' | 'sidebar-panel' | 'theme';

/** Patch only the owned scalar; unrelated settings and comments retain their bytes. */
export function updateEditorState(source: string, key: EditorStateKey, value: boolean | string | number): string {
  const parsed = parseToml(source);
  if (!parsed.ok) throw new Error('invalid TOML; state file left unchanged');
  const entry = parsed.value.entries.find(candidate => candidate.path.length === 2 && candidate.path[0] === 'editor' && candidate.path[1] === key);
  if (entry !== undefined) return patchTomlScalar(source, entry.location.line, value);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(newline);
  const header = lines.findIndex(line => /^\s*\[\s*(?:editor|"editor"|'editor')\s*\]\s*(?:#.*)?$/u.test(line));
  if (header >= 0) {
    lines.splice(header + 1, 0, `${key} = ${JSON.stringify(value)}`);
    return lines.join(newline);
  }
  const inline = parsed.value.entries.find(candidate => candidate.path.length === 1 && candidate.path[0] === 'editor');
  if (inline !== undefined) {
    if (typeof inline.value !== 'object' || inline.value === null || Array.isArray(inline.value)) throw new Error('editor must be a table; state file left unchanged');
    return patchInlineTableScalar(source, inline.location.line, key, value);
  }
  return `editor.${key} = ${JSON.stringify(value)}${newline}${source}`;
}

export function updateSidebarVisibility(source: string, visible: boolean): string {
  return updateEditorState(source, 'sidebar-visible', visible);
}

/** Serialize asynchronous read/modify/atomic-write operations. At most one pending value per owned setting
 * is retained while IO runs, so rapid toggles cannot build an unbounded write queue. */
export class EditorStatePersistence {
  readonly #filesystem: StateFilesystem;
  readonly #path: string;
  readonly #onError: (message: string) => void;
  readonly #cancellation = new CancellationSource();
  #pending = new Map<EditorStateKey, boolean | string | number>();
  #running: Promise<void> | undefined;
  #disposed = false;

  constructor(filesystem: StateFilesystem, path: string, onError: (message: string) => void) {
    this.#filesystem = filesystem;
    this.#path = path;
    this.#onError = onError;
  }

  setSidebarVisible(visible: boolean): void {
    if (this.#disposed) return;
    this.#set('sidebar-visible', visible);
  }

  setSidebarWidth(width: number): void { this.#set('sidebar-width', width); }

  setSidebarPanel(panel: 'files' | 'search' | 'git'): void { this.#set('sidebar-panel', panel); }

  setTheme(theme: string): void { this.#set('theme', theme); }

  #set(key: EditorStateKey, value: boolean | string | number): void {
    if (this.#disposed) return;
    this.#pending.set(key, value);
    this.#running ??= this.#writePending();
  }

  async flush(): Promise<void> { await this.#running; }

  async #writePending(): Promise<void> {
    // Start off the input stack; filesystem work never delays the immediate repaint.
    await Promise.resolve();
    try {
      while (this.#pending.size > 0) {
        const pending = this.#pending;
        this.#pending = new Map();
        const read = await this.#filesystem.readFile(this.#path, this.#cancellation.token, { maxBytes: 256 * 1024 });
        if (!read.ok && read.error.code !== 'not-found' && read.error.code !== 'ENOENT') throw new Error(read.error.message);
        const source = read.ok ? new TextDecoder('utf-8', { fatal: true }).decode(read.value) : '';
        let updated = source;
        for (const [key, value] of pending) updated = updateEditorState(updated, key, value);
        if (source === updated) continue;
        const written = await this.#filesystem.writeFileAtomic(this.#path, new TextEncoder().encode(updated), this.#cancellation.token);
        if (!written.ok) throw new Error(written.error.message);
      }
    } catch (error) {
      this.#pending.clear();
      this.#onError(`xi: could not save ${this.#path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.#running = undefined; }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#running;
    this.#cancellation.dispose();
  }
}
