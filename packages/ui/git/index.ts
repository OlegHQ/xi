import type { Disposable } from '../../contracts/src/index';

export type GitRowState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflicted';
export interface GitPanelRow { readonly id: string; readonly path: string; readonly state: GitRowState; readonly letter: string; }
export interface GitPanelSection { readonly id: 'staged' | 'changes' | 'untracked' | 'conflicts'; readonly label: string; readonly count: number; readonly collapsed: boolean; readonly entries: readonly GitPanelRow[]; }
export interface GitPanelReadModel { readonly contractVersion: 1; readonly generation: number; readonly branch: string | undefined; readonly state: 'idle' | 'loading' | 'ready' | 'unavailable'; readonly message: string | undefined; readonly sections: readonly GitPanelSection[]; readonly selectedId: string | undefined; }
export interface GitReadPort { readonly model: GitPanelReadModel; subscribe(listener: (model: GitPanelReadModel) => void): Disposable; }
const HEADER_ROWS = 2;
const HINT_TEXT = 'Enter open · s stage · u unstage · r refresh';
function expandGitItems(sections: readonly GitPanelSection[]): readonly ({ readonly kind: 'heading'; readonly section: GitPanelSection } | { readonly kind: 'row'; readonly row: GitPanelRow })[] {
  const items: ({ readonly kind: 'heading'; readonly section: GitPanelSection } | { readonly kind: 'row'; readonly row: GitPanelRow })[] = [];
  for (const section of sections) { items.push({ kind: 'heading', section }); if (!section.collapsed) for (const row of section.entries) items.push({ kind: 'row', row }); }
  return items;
}
function statusLine(model: GitPanelReadModel): string {
  const branch = model.branch ?? '(no branch)';
  if (model.state === 'loading') return `${branch}  Loading…`;
  if (model.state === 'unavailable') return 'Not a Git repository';
  const total = model.sections.reduce((sum, section) => sum + section.count, 0);
  return `${branch}  ${total} change${total === 1 ? '' : 's'}${model.message === undefined ? '' : `  ${model.message}`}`;
}
export function formatGitLines(model: GitPanelReadModel, width: number, maxRows = 12, scrollOffset = 0): readonly string[] {
  const safeWidth = Math.max(1, width);
  const rows = [` ${statusLine(model)}`.slice(0, safeWidth), ` ${HINT_TEXT}`.slice(0, safeWidth)];
  const offset = Math.max(0, Math.trunc(scrollOffset));
  for (const item of expandGitItems(model.sections).slice(offset, offset + Math.max(0, Math.trunc(maxRows) - HEADER_ROWS))) rows.push((item.kind === 'heading' ? ` ${item.section.collapsed ? '▸' : '▾'} ${item.section.label} (${item.section.count})` : `  ${item.row.id === model.selectedId ? '▶' : ' '} ${item.row.letter} ${item.row.path}`).slice(0, safeWidth));
  return Object.freeze(rows);
}
export function gitRowIds(model: GitPanelReadModel, offset: number, rows: number): readonly (string | undefined)[] {
  return [undefined, undefined, ...expandGitItems(model.sections).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, rows - HEADER_ROWS)).map(item => item.kind === 'row' ? item.row.id : `git-section:${item.section.id}`)].slice(0, Math.max(0, rows));
}
