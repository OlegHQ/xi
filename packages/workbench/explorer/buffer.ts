import { asIdentifier, type DocumentId, type ViewId, type LineIndex, type Utf16Offset } from '../../contracts/src/index';
import { openTextDocument, type DocumentSnapshot, type TextFileDocument } from '../../document/src/entrypoints/launch';
import { offsetToPosition } from '../../document/src/index';
import { createVimRegisterBank } from '../../vim/src/entrypoints/launch';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSession, type OwnedVimSessionOptions } from '../vim-session';
import type { ExplorerDirectoryOperationPlan } from './operations';

export interface ExplorerBufferSource { readonly id: string; readonly path: string; readonly name: string; readonly kind: 'file' | 'directory' | 'symlink' | 'other' }
export interface ExplorerBufferModel {
  readonly generation: number;
  readonly directoryPath: string;
  readonly mode: string;
  readonly dirty: boolean;
  readonly rows: readonly { readonly id: string; readonly name: string; readonly kind: ExplorerBufferSource['kind']; readonly sourcePath: string | undefined }[];
  readonly selectedIndex: number;
  readonly cursorColumn: number;
  readonly visualIndices: readonly number[];
  readonly prompt: string;
  readonly reviewLines: readonly string[] | undefined;
}
export interface ExplorerBufferOptions {
  readonly root: string;
  readonly list: (path: string) => Promise<{ readonly ok: true; readonly value: readonly Omit<ExplorerBufferSource, 'id'>[] } | { readonly ok: false; readonly error: string }>;
  readonly encodeName: (name: string) => string;
  readonly parseLine: (text: string) => { readonly id: string | undefined; readonly name: string; readonly prefixLength: number };
  readonly compile: (buffers: readonly { readonly path: string; readonly snapshot: DocumentSnapshot; readonly sourceIds: readonly string[] }[], sources: readonly ExplorerBufferSource[]) => { readonly ok: true; readonly value: ExplorerDirectoryOperationPlan } | { readonly ok: false; readonly error: string };
  readonly apply: (plan: ExplorerDirectoryOperationPlan) => Promise<boolean>;
  readonly openFile: (path: string, close: boolean) => Promise<void>;
  readonly onHostCommand?: OwnedVimSessionOptions['onHostCommand'];
  readonly notify: () => void;
  readonly error: (message: string) => void;
  readonly marker: (name: string, payload?: unknown) => void;
}
interface DirectoryBuffer { readonly path: string; readonly document: TextFileDocument; readonly session: OwnedVimSession; readonly viewId: ViewId; readonly sourceIds: readonly string[] }

/** A Files window edits real document buffers with Xi's existing Vim engine. Directory
 * identities travel in ordinary registers, while each document retains its own history. */
export class ExplorerBufferController {
  readonly #options: ExplorerBufferOptions;
  readonly #buffers = new Map<string, DirectoryBuffer>();
  readonly #sources = new Map<string, ExplorerBufferSource>();
  readonly #listeners = new Set<(model: ExplorerBufferModel) => void>();
  #registers = createVimRegisterBank();
  #current: DirectoryBuffer | undefined;
  #nextId = 0;
  #generation = 0;
  #review: ExplorerDirectoryOperationPlan | undefined;
  #reviewIndex = 0;
  #busy = false;
  #disposed = false;

  constructor(options: ExplorerBufferOptions) { this.#options = options; }
  get active(): boolean { return this.#current !== undefined; }
  get model(): ExplorerBufferModel {
    const buffer = this.#current;
    if (buffer === undefined) return { generation: this.#generation, directoryPath: this.#options.root, mode: 'normal', dirty: false, rows: [], selectedIndex: 0, cursorColumn: 0, visualIndices: [], prompt: '', reviewLines: undefined };
    const view = buffer.session.readView(buffer.viewId)!;
    const primary = view.selections.members.find((member) => member.id === view.selections.primaryId)!;
    const position = offsetToPosition(view.document, primary.head.at.offset, 'utf-16');
    if (!position.ok) throw new Error('directory-cursor-coordinate');
    const at = position.value;
    const parsed = this.#options.parseLine(directoryLine(view.document, at.line).text);
    const rows = Array.from({ length: view.document.lineCount }, (_, line) => {
      const row = this.#options.parseLine(directoryLine(view.document, line).text);
      const source = row.id === undefined ? undefined : this.#sources.get(row.id);
      return { id: `directory-row-${line}`, name: row.name, kind: source?.kind ?? (row.name.endsWith('/') ? 'directory' : 'file'), sourcePath: source?.path };
    });
    const anchor = offsetToPosition(view.document, primary.anchor.at.offset, 'utf-16');
    const from = Math.min(anchor.ok ? anchor.value.line : at.line, at.line);
    const to = Math.max(anchor.ok ? anchor.value.line : at.line, at.line);
    const visualIndices = view.session.mode.startsWith('visual') ? Array.from({ length: to - from + 1 }, (_, index) => from + index) : [];
    return { generation: this.#generation, directoryPath: buffer.path, mode: view.session.mode, dirty: [...this.#buffers.values()].some((value) => value.document.isDirty), rows, selectedIndex: this.#review === undefined ? at.line : this.#reviewIndex, cursorColumn: Math.max(0, at.character - parsed.prefixLength), visualIndices,
      reviewLines: this.#review?.operations.map((operation) => operation.kind === 'trash' ? `Trash ${operation.sourcePath}` : operation.kind === 'create' ? `Create ${operation.destinationPath}${operation.directory ? '/' : ''}` : `${operation.kind === 'copy' ? 'Copy' : 'Move'} ${operation.sourcePath} → ${operation.destinationPath}`),
      prompt: this.#review === undefined ? buffer.session.commandLine?.source ?? `${view.session.mode.toUpperCase()} · = review changes` : `Apply ${this.#review.operations.length} operations? y / Enter · Esc cancel` };
  }
  subscribe(listener: (model: ExplorerBufferModel) => void): { dispose(): void } { this.#listeners.add(listener); return { dispose: () => this.#listeners.delete(listener) }; }

  async open(path: string, selectedPath?: string): Promise<void> {
    if (this.#disposed || (path !== this.#options.root && !path.startsWith(`${this.#options.root}/`))) return;
    let buffer = this.#buffers.get(path);
    if (buffer === undefined) {
      const listed = await this.#options.list(path);
      if (!listed.ok) { this.#options.error(`xi: ${listed.error}\n`); return; }
      if (this.#disposed) return;
      const sourceIds: string[] = [];
      const lines = listed.value.map((entry) => {
        const id = [...this.#sources.values()].find((source) => source.path === entry.path)?.id ?? String(++this.#nextId).padStart(6, '0');
        sourceIds.push(id);
        this.#sources.set(id, { ...entry, id });
        return `/${id}/${this.#options.encodeName(entry.name)}`;
      });
      const documentId = asIdentifier<DocumentId>(`files-directory-${this.#buffers.size}`, "directory buffer");
      const viewId = asIdentifier<ViewId>(`files-directory-view-${this.#buffers.size}`, "directory view");
      if (!documentId.ok || !viewId.ok) throw new Error('files-directory-identity');
      const opened = openTextDocument(documentId.value, new TextEncoder().encode(lines.join('\n')));
      if (opened.kind !== 'editable') { this.#options.error('xi: directory buffer could not be opened\n'); return; }
      const session = createOwnedVimSession(opened.document, { viewId: viewId.value, motionGhost: false,
        registers: { read: () => this.#registers, write: (bank) => { this.#registers = bank; } },
        ...(this.#options.onHostCommand === undefined ? {} : { onHostCommand: this.#options.onHostCommand }),
        onMessage: this.#options.error, onSave: async () => { this.review(); return true; },
        onExCommand: (source) => source === 'q' || source === 'q!' ? 'quit' : 'unhandled',
      });
      buffer = { path, document: opened.document, session, viewId: viewId.value, sourceIds };
      this.#buffers.set(path, buffer);
    }
    this.#current = buffer;
    if (selectedPath !== undefined) {
      const index = this.model.rows.findIndex((row) => row.sourcePath === selectedPath);
      if (index >= 0) buffer.session.setCursorPosition(index);
    }
    this.#clampCursor();
    this.#publish();
  }

  async handleKey(event: OwnedVimKeyEvent): Promise<'handled' | 'close'> {
    const buffer = this.#current;
    if (buffer === undefined || this.#busy) return 'handled';
    const plain = !event.ctrl && !event.meta && !event.option;
    const key = event.raw || event.name;
    if (this.#review !== undefined) {
      if (plain && (key === 'y' || event.name.toLowerCase() === 'enter' || event.name.toLowerCase() === 'return')) await this.#apply();
      else if (key === '\x1b' || key === 'n' || event.name.toLowerCase() === 'escape') { this.#review = undefined; this.#publish(); }
      else if (key === 'j' || key === 'k') { this.#reviewIndex = Math.max(0, Math.min(this.#review.operations.length - 1, this.#reviewIndex + (key === 'j' ? 1 : -1))); this.#publish(); }
      return 'handled';
    }
    const view = buffer.session.readView(buffer.viewId)!;
    const normal = view.session.mode === 'normal' && buffer.session.prefixHelp.pendingKeys.length === 0 && !buffer.session.commandLineActive;
    if (normal && plain && key === '=') { this.review(); return 'handled'; }
    if (normal && plain && (key === 'q' || key === '\x1b' || event.name.toLowerCase() === 'escape')) {
      return 'close';
    }
    if (normal && plain && key === 'h') {
      if (buffer.path !== this.#options.root) await this.open(buffer.path.slice(0, buffer.path.lastIndexOf('/')) || '/', buffer.path);
      return 'handled';
    }
    if (normal && plain && (key === 'l' || key === 'L' || event.name.toLowerCase() === 'enter' || event.name.toLowerCase() === 'return')) {
      const row = this.model.rows[this.model.selectedIndex];
      if (row?.sourcePath !== undefined) {
        if (row.kind === 'directory') await this.open(row.sourcePath);
        else await this.#options.openFile(row.sourcePath, key === 'L' || event.name.toLowerCase() === 'enter' || event.name.toLowerCase() === 'return');
      }
      return 'handled';
    }
    const result = await buffer.session.handleKey(event);
    this.#clampCursor();
    this.#publish();
    return result === 'quit' ? 'close' : 'handled';
  }

  handlePaste(bytes: Uint8Array): void { if (this.#busy || this.#review !== undefined) return; this.#current?.session.handlePaste(bytes); this.#clampCursor(); this.#publish(); }
  selectRow(index: number): void { if (this.#review !== undefined) this.#reviewIndex = Math.max(0, Math.min(this.#review.operations.length - 1, index)); else { this.#current?.session.setCursorPosition(index); this.#clampCursor(); } this.#publish(); }

  review(): void {
    const compiled = this.#options.compile([...this.#buffers.values()].map((buffer) => ({ path: buffer.path, snapshot: buffer.document.snapshot(), sourceIds: buffer.sourceIds })), [...this.#sources.values()]);
    if (!compiled.ok) this.#options.error(`xi: ${compiled.error}\n`);
    else {
      this.#review = compiled.value.operations.length === 0 ? undefined : compiled.value;
      this.#reviewIndex = 0;
      this.#options.marker('XI_FILES_REVIEW', { operations: compiled.value.operations });
    }
    this.#publish();
  }

  async #apply(): Promise<void> {
    const plan = this.#review;
    if (plan === undefined) return;
    this.#busy = true;
    try {
      if (!await this.#options.apply(plan)) return;
      let path = this.#current?.path ?? this.#options.root;
      const selected = this.model.selectedIndex;
      this.#options.marker('XI_FILES_APPLIED', { operations: plan.operations });
      for (const buffer of this.#buffers.values()) buffer.session.dispose();
      this.#buffers.clear(); this.#current = undefined; this.#review = undefined;
      for (const operation of plan.operations) if (operation.kind === 'rename') {
        if (path === operation.sourcePath || path.startsWith(`${operation.sourcePath}/`)) path = `${operation.destinationPath}${path.slice(operation.sourcePath.length)}`;
        for (const [id, source] of this.#sources) {
          if (source.path === operation.sourcePath || source.path.startsWith(`${operation.sourcePath}/`)) this.#sources.set(id, { ...source, path: `${operation.destinationPath}${source.path.slice(operation.sourcePath.length)}`, name: source.path === operation.sourcePath ? operation.destinationPath.slice(operation.destinationPath.lastIndexOf('/') + 1) : source.name });
        }
      }
      if (plan.operations.some((operation) => operation.kind === 'trash' && (path === operation.sourcePath || path.startsWith(`${operation.sourcePath}/`)))) path = this.#options.root;
      await this.open(path);
      this.selectRow(selected);
    } finally { this.#busy = false; this.#publish(); }
  }

  #clampCursor(): void {
    const buffer = this.#current;
    if (buffer === undefined) return;
    const view = buffer.session.readView(buffer.viewId)!;
    const primary = view.selections.members.find((member) => member.id === view.selections.primaryId)!;
    const position = offsetToPosition(view.document, primary.head.at.offset, 'utf-16');
    if (!position.ok) throw new Error('directory-cursor-coordinate');
    const at = position.value;
    const prefix = this.#options.parseLine(directoryLine(view.document, at.line).text).prefixLength;
    if (at.character >= prefix) return;
    if (view.session.mode === 'insert') buffer.session.setInsertCursor(directoryLine(view.document, at.line).start + prefix);
    else buffer.session.setCursorPosition(at.line, prefix);
  }
  #publish(): void {
    this.#generation += 1;
    this.#options.notify();
    if (this.#listeners.size > 0) { const model = this.model; for (const listener of this.#listeners) listener(model); }
    const buffer = this.#current;
    if (buffer !== undefined) {
      const view = buffer.session.readView(buffer.viewId)!;
      this.#options.marker('XI_FILES_CURSOR', { directoryPath: buffer.path, mode: view.session.mode, line: view.document.lineIndexAt(view.selections.members[0]!.head.at.offset) });
    }
  }
  dispose(): void { this.#disposed = true; for (const buffer of this.#buffers.values()) buffer.session.dispose(); this.#buffers.clear(); this.#sources.clear(); this.#listeners.clear(); }
}

function directoryLine(snapshot: DocumentSnapshot, line: number): { readonly text: string; readonly start: number } {
  const start = snapshot.lineStartOffset(line as LineIndex);
  const next = line + 1 < snapshot.lineCount ? snapshot.lineStartOffset((line + 1) as LineIndex) : undefined;
  if (!start.ok) throw new Error('directory-line-coordinate');
  const text = snapshot.slice(start.value, (next?.ok === true ? next.value - 1 : snapshot.lengthUtf16) as Utf16Offset);
  if (!text.ok) throw new Error('directory-line-read');
  return { start: start.value, text: text.value };
}
