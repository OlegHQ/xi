import type { ExplorerBufferController } from '../../workbench/src/entrypoints/launch';
import type { ExplorerNode, ExplorerReadModel, ExplorerReadPort } from './index';

/** Keep the services-owned tree's hierarchy and decorations, projecting document edits inline. */
export function createDirectoryExplorerRead(read: Pick<ExplorerBufferController, 'model' | 'generation' | 'treeRows' | 'subscribe'>, tree: ExplorerReadPort): ExplorerReadPort {
  const project = (): ExplorerReadModel => {
    const editing = read.model;
    const base = tree.model;
    const rows = read.treeRows;
    if (rows === undefined) return base;
    const original = new Map(base.nodes.map((node) => [node.id, node]));
    const node = (id: string, name: string, path: string, kind: ExplorerNode['kind'], depth = 0): ExplorerNode => ({ id, name, path, kind, depth, rootId: base.roots[0] ?? '', parentId: undefined, relativePath: name, expanded: false, hidden: false, ignored: false, loadState: 'ready', children: [], stableIdentity: id, sizeBytes: undefined, modifiedMilliseconds: undefined, permissions: undefined, symlinkTarget: undefined, git: undefined, message: kind === 'state' ? name : undefined });
    const nodes = rows.map((row) => ({ ...(row.nodeId === undefined ? undefined : original.get(row.nodeId)) ?? node(row.id, row.name, row.path, row.kind, row.depth), id: row.id, name: row.name, depth: row.depth, expanded: row.expanded }));
    const review = editing.reviewLines?.map((line, index) => node(`directory-review-${index}`, line, editing.directoryPath, 'state')) ?? [];
    const selectedId = editing.reviewLines === undefined ? rows.find((row) => row.selected)?.id : review[editing.selectedIndex]?.id;
    nodes.push(...review, node('directory-footer', editing.prompt, editing.directoryPath, 'state'));
    return { ...base, generation: editing.generation + base.generation, nodes, selectedId,
      visibleRows: nodes.map((value) => ({ nodeId: value.id, depth: value.depth, kind: value.kind, selected: value.id === selectedId })),
      edit: { mode: editing.mode, cursorColumn: editing.cursorColumn, visualIds: rows.filter((row) => row.visual).map((row) => row.id) },
    };
  };
  let generation = -1; let cached: ExplorerReadModel;
  const model = (): ExplorerReadModel => { const current = read.generation + tree.model.generation; if (generation !== current) { generation = current; cached = project(); } return cached; };
  return { get model() { return model(); }, subscribe: (listener) => { const a = read.subscribe(() => listener(model())); const b = tree.subscribe(() => listener(model())); return { dispose() { a.dispose(); b.dispose(); } }; } };
}
