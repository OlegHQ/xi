import { asIdentifier, type DocumentId, type ViewId, type LineIndex, type Utf16Offset } from '../../contracts/src/index';
import { openTextDocument, type DocumentSnapshot, type TextFileDocument } from '../../document/src/entrypoints/launch';
import { offsetToPosition } from '../../document/src/index';
import { createVimRegisterBank } from '../../vim/src/entrypoints/launch';
import { createOwnedVimSession, type OwnedVimKeyEvent, type OwnedVimSession, type OwnedVimSessionOptions } from '../vim-session';
import type { ExplorerDirectoryOperationPlan } from './operations';

export interface ExplorerBufferSource { readonly id: string; readonly path: string; readonly name: string; readonly kind: 'file' | 'directory' | 'symlink' | 'other' }
export interface ExplorerBufferTreeRow {
  readonly id: string; readonly nodeId: string | undefined; readonly name: string; readonly path: string;
  readonly kind: ExplorerBufferSource['kind'] | 'root' | 'state'; readonly depth: number; readonly expanded: boolean;
  readonly bufferPath: string; readonly line: number | undefined; readonly selected: boolean; readonly visual: boolean;
}
interface BufferTreeNode { readonly id: string; readonly path: string; readonly name: string; readonly kind: ExplorerBufferTreeRow['kind']; readonly expanded: boolean; readonly children?: readonly string[] }
interface BufferTree {
  readonly model: { readonly generation: number; readonly roots: readonly string[]; readonly includeHidden?: boolean; readonly nodes?: readonly BufferTreeNode[]; readonly visibleRows: readonly { readonly nodeId: string; readonly depth?: number; readonly label?: string }[] };
  readNode(id: string): BufferTreeNode | undefined;
}
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
  #tree: BufferTree | undefined;
  #toggleTree: ((id: string) => Promise<void>) | undefined;
  #selectedRoot: string | undefined;
  #treeRowsCache: { readonly generation: number; readonly rows: readonly ExplorerBufferTreeRow[] } | undefined;
  #registers = createVimRegisterBank();
  #current: DirectoryBuffer | undefined;
  #nextId = 0;
  #generation = 0;
  #review: ExplorerDirectoryOperationPlan | undefined;
  #reviewIndex = 0;
  #busy = false;
  #disposed = false;

  constructor(options: ExplorerBufferOptions) { this.#options = options; }
  get generation(): number { return this.#generation; }
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
  attachTree(tree: BufferTree, toggle: (id: string) => Promise<void>): void { this.#tree = tree; this.#toggleTree = toggle; }
  get treeRows(): readonly ExplorerBufferTreeRow[] | undefined {
    const tree = this.#tree;
    if (tree === undefined) return undefined;
    const generation = tree.model.generation + this.#generation;
    if (this.#treeRowsCache?.generation === generation) return this.#treeRowsCache.rows;
    const active = this.model;
    const knownPaths = new Set(tree.model.nodes?.map((node) => node.path));
    const visible = new Map(tree.model.visibleRows.flatMap((row) => { const node = tree.readNode(row.nodeId); return node === undefined ? [] : [[node.path, { ...node, name: row.label ?? node.name }] as const]; }));
    const compressed = new Map<string, BufferTreeNode>();
    for (const node of visible.values()) if (node.kind === 'directory' && node.name.includes('/')) {
      let path = node.path;
      for (let index = 1; index < node.name.split('/').length; index += 1) { path = path.slice(0, path.lastIndexOf('/')); compressed.set(path, node); }
    }
    const visibleChild = (path: string): BufferTreeNode | undefined => visible.get(path) ?? compressed.get(path);
    const result: ExplorerBufferTreeRow[] = [];
    const visit = (node: BufferTreeNode, depth: number, bufferPath: string, line?: number, name = node.name, id = node.id): void => {
      const selected = this.#selectedRoot === undefined ? bufferPath === active.directoryPath && line === active.selectedIndex : node.id === this.#selectedRoot;
      result.push({ id, nodeId: node.id, name, path: node.path, kind: node.kind, depth, expanded: node.expanded, bufferPath, line, selected, visual: bufferPath === active.directoryPath && line !== undefined && active.visualIndices.includes(line) });
      if (!node.expanded || (node.kind !== 'root' && node.kind !== 'directory')) return;
      const buffer = this.#buffers.get(node.path);
      if (buffer === undefined) {
        for (const childId of node.children ?? []) { const child = tree.readNode(childId); const shown = child === undefined ? undefined : visibleChild(child.path); if (shown !== undefined) visit(shown, depth + 1, shown.path.slice(0, shown.path.lastIndexOf('/'))); }
        return;
      }
      const snapshot = buffer.document.snapshot();
      for (let index = 0; index < snapshot.lineCount; index += 1) {
        const row = this.#options.parseLine(directoryLine(snapshot, index).text);
        const source = row.id === undefined ? undefined : this.#sources.get(row.id);
        const path = source?.path ?? `${node.path}/${row.name}`;
        const child = visibleChild(path);
        if (child !== undefined && child.path !== path && row.name === source?.name) { visit(child, depth + 1, child.path.slice(0, child.path.lastIndexOf('/'))); continue; }
        if (source !== undefined && child === undefined && path === `${node.path}/${row.name}` && ((source.name.startsWith('.') && tree.model.includeHidden !== true) || knownPaths.has(path))) continue;
        const rowId = `directory-row:${node.path}:${index}`;
        if (child !== undefined) visit(child, depth + 1, node.path, index, row.name === source?.name ? child.name : row.name, rowId);
        else result.push({ id: rowId, nodeId: undefined, name: row.name, path, kind: source?.kind ?? (row.name.endsWith('/') ? 'directory' : 'file'), depth: depth + 1, expanded: false, bufferPath: node.path, line: index, selected: this.#selectedRoot === undefined && node.path === active.directoryPath && index === active.selectedIndex, visual: node.path === active.directoryPath && active.visualIndices.includes(index) });
      }
    };
    for (const id of tree.model.roots) { const root = tree.readNode(id); if (root !== undefined) visit(root, 0, root.path); }
    this.#treeRowsCache = { generation, rows: result };
    return result;
  }
  async selectTreeRow(id: string, activate = false): Promise<void> {
    const row = this.treeRows?.find((value) => value.id === id || value.nodeId === id);
    if (row === undefined || this.#busy || this.#review !== undefined) return;
    await this.open(row.bufferPath, row.path);
    if (row.line !== undefined) this.selectRow(row.line);
    if (activate && row.nodeId !== undefined && (row.kind === 'root' || row.kind === 'directory')) {
      await this.#toggleTree?.(row.nodeId);
      if (this.#tree?.readNode(row.nodeId)?.expanded) {
        await this.open(row.path);
        await this.open(row.bufferPath, row.path);
        if (row.line !== undefined) this.selectRow(row.line);
      }
    } else if (activate && row.kind === 'file' && row.nodeId !== undefined) await this.#options.openFile(row.path, false);
    this.#selectedRoot = row.kind === 'root' ? row.nodeId : undefined;
    this.#publish();
  }

  async contextAction(id: string, action: 'open' | 'toggle' | 'new-file' | 'new-folder' | 'rename' | 'move' | 'copy' | 'duplicate' | 'trash' | 'undo'): Promise<void> {
    const row = this.treeRows?.find((value) => value.id === id || value.nodeId === id);
    if (row === undefined) return;
    await this.selectTreeRow(row.id);
    const key = (raw: string, name = raw.toLowerCase()): Promise<'handled' | 'close'> => this.handleKey({ name, raw, ctrl: false, shift: false, meta: false, option: false });
    if (this.model.mode !== 'normal') await key('\x1b', 'escape');
    if (action === 'toggle') { await this.selectTreeRow(row.id, true); return; }
    if (action === 'open') { if (row.kind === 'file') await this.#options.openFile(row.path, true); else await this.selectTreeRow(row.id, true); return; }
    if (action === 'new-file' || action === 'new-folder') {
      if (!row.expanded && row.nodeId !== undefined) await this.#toggleTree?.(row.nodeId);
      await this.open(row.path); await key('o');
      if (action === 'new-folder') { await key('/'); await key('', 'home'); }
    } else if (action === 'rename') await key('C');
    else if (action === 'undo') await key('u');
    else if (action === 'trash' || action === 'move') { await key('d'); await key('d'); }
    else {
      await key('y'); await key('y');
      if (action === 'duplicate') {
        await this.#current?.session.handleKey({ name: 'p', raw: 'p', ctrl: false, shift: false, meta: false, option: false });
        this.#clampCursor(); this.#publish();
        await key('C'); for (const raw of `${row.name} copy`) await key(raw); await key('\x1b', 'escape');
      }
    }
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
    this.#selectedRoot = undefined;
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
    if (this.#tree !== undefined && plain && (view.session.mode === 'normal' || view.session.mode.startsWith('visual')) && await this.#handleTreeKey(key, event.name, normal)) return 'handled';
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
    if (this.#selectedRoot !== undefined && normal && ['d', 'x', 'c', 'i', 'a', 'I', 'A', 's', 'S', 'C', 'D', 'r'].includes(key)) return 'handled';
    this.#selectedRoot = undefined;
    const result = await (this.#current ?? buffer).session.handleKey(event);
    this.#clampCursor();
    this.#publish();
    return result === 'quit' ? 'close' : 'handled';
  }

  async #handleTreeKey(key: string, name: string, normal: boolean): Promise<boolean> {
    if (!'jkGghlL><pP'.includes(key) && !['up', 'down', 'left', 'right', 'enter', 'return'].includes(name.toLowerCase())) return false;
    const rows = this.treeRows ?? [];
    const selected = rows.findIndex((row) => row.selected);
    const row = rows[selected];
    if (row === undefined) return false;
    const pending = this.#current?.session.prefixHelp.pendingKeys;
    if (key === 'g' && pending?.length === 1 && pending[0] === 'g') {
      await this.#current?.session.handleKey({ name: 'escape', raw: '\x1b', ctrl: false, meta: false, option: false, shift: false });
      await this.selectTreeRow(rows[0]!.id); return true;
    }
    if ((key === '>' || key === '<') && (normal || this.model.mode.startsWith('visual'))) {
      const targets = normal ? [row] : rows.filter((value) => value.visual);
      for (const target of targets) if (target.nodeId !== undefined && (target.kind === 'directory' || target.kind === 'root') && target.expanded !== (key === '>')) await this.#toggleTree?.(target.nodeId);
      this.#publish(); return true;
    }
    const container = row.kind === 'directory' || row.kind === 'root';
    if (container && (key === 'p' || key === 'P') && (normal || pending?.[0] === '"' || /^\d$/u.test(pending?.[0] ?? ''))) {
      const prefix = pending?.slice() ?? [];
      if (prefix.length > 0) await this.#current?.session.handleKey({ name: 'escape', raw: '\x1b', ctrl: false, meta: false, option: false, shift: false });
      if (!row.expanded && row.nodeId !== undefined) await this.#toggleTree?.(row.nodeId);
      await this.open(row.path);
      for (const raw of prefix) await this.#current?.session.handleKey({ name: raw.toLowerCase(), raw, ctrl: false, meta: false, option: false, shift: false });
      return false;
    }
    if (!normal) return false;
    const direction = key === 'j' || name.toLowerCase() === 'down' ? 1 : key === 'k' || name.toLowerCase() === 'up' ? -1 : 0;
    if (direction !== 0 || key === 'G') {
      const target = rows[key === 'G' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, selected + direction))];
      if (target !== undefined) await this.selectTreeRow(target.id);
      return true;
    }
    if (key === 'h' || name.toLowerCase() === 'left') {
      if (container && row.expanded && row.nodeId !== undefined) { await this.#toggleTree?.(row.nodeId); this.#publish(); }
      else { const parent = rows.find((value) => value.path === row.bufferPath); if (parent !== undefined) await this.selectTreeRow(parent.id); }
      return true;
    }
    if (container && (key === 'l' || key === 'L' || name.toLowerCase() === 'right' || name.toLowerCase() === 'enter' || name.toLowerCase() === 'return')) {
      if (!row.expanded) await this.selectTreeRow(row.id, true);
      else if (rows[selected + 1]?.depth === row.depth + 1) await this.selectTreeRow(rows[selected + 1]!.id);
      return true;
    }
    return false;
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
