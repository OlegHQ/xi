import type { Disposable } from '../../contracts/src/index';

export interface SearchRange { readonly startUtf16: number; readonly endUtf16: number; }
export interface SearchQuery { readonly rootId: string; readonly rootPath: string; readonly query: string; readonly regex?: boolean; readonly caseSensitive?: boolean; readonly wholeWord?: boolean; readonly includeHidden?: boolean; readonly includeIgnored?: boolean; readonly globs?: readonly string[]; readonly maxResults?: number; }
export interface SearchMatch { readonly id: string; readonly rootId: string; readonly path: string; readonly line: number; readonly range: SearchRange; readonly lineText: string; readonly snippet: string; readonly source: 'disk' | 'buffer'; readonly documentVersion?: number; readonly diskHash?: string; readonly generation: number; }
export interface SearchReadModel { readonly contractVersion: 1; readonly query: SearchQuery; readonly generation: number; readonly state: 'idle' | 'loading' | 'ready' | 'empty' | 'stale' | 'error'; readonly matches: readonly SearchMatch[]; readonly totalMatches: number; readonly truncated: boolean; readonly message: string | undefined; }
export interface SearchReadPort { readonly model: SearchReadModel; subscribe(listener: (model: SearchReadModel) => void): Disposable; }
export type SearchPanelMode = 'insert' | 'replace' | 'normal';
export interface SearchUiState { readonly mode: SearchPanelMode; readonly replaceInput: string; readonly collapsed: ReadonlySet<string>; readonly includeHidden: boolean; readonly includeIgnored: boolean; }

const searchFlags = (query: SearchQuery): string => [query.regex === true ? 'regex' : 'literal', query.caseSensitive === true ? 'case' : 'ignore-case', query.wholeWord === true ? 'word' : 'no-word', query.includeHidden === true ? 'hidden' : 'no-hidden', query.includeIgnored === true ? 'ignored' : 'no-ignored'].join(' ');
type SearchContentItem = { readonly kind: 'heading'; readonly path: string } | { readonly kind: 'match'; readonly match: SearchMatch };
function expandSearchItems(matches: readonly SearchMatch[]): readonly SearchContentItem[] {
  const items: SearchContentItem[] = [];
  let previousPath: string | undefined;
  for (const match of matches) {
    if (match.path !== previousPath) { items.push({ kind: 'heading', path: match.path }); previousPath = match.path; }
    items.push({ kind: 'match', match });
  }
  return items;
}
function summaryText(model: SearchReadModel): string {
  if (model.message !== undefined && model.matches.length === 0) return model.message;
  if (model.state === 'loading') return 'Searching…';
  if (model.matches.length === 0) return 'No results';
  const fileCount = new Set(model.matches.map(match => match.path)).size;
  return `${model.totalMatches} result${model.totalMatches === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`;
}
export function formatSearchLines(model: SearchReadModel, width: number, maxRows = 12, selectedId?: string, scrollOffset = 0, replaceInput = ''): readonly string[] {
  const safeWidth = Math.max(1, width);
  const rows = [`${model.query.query.length === 0 ? 'Search' : model.query.query}  [${searchFlags(model.query)}]`.slice(0, safeWidth), `Replace: ${replaceInput}`.slice(0, safeWidth), summaryText(model).slice(0, safeWidth)];
  const items = expandSearchItems(model.matches);
  const offset = Math.max(0, Math.trunc(scrollOffset));
  const limit = Math.max(0, Math.trunc(maxRows) - rows.length);
  for (const item of items.slice(offset, offset + limit)) rows.push((item.kind === 'heading' ? `[${item.path}]` : `${item.match.id === selectedId ? '> ' : '  '}${item.match.path}:${item.match.line + 1}:${item.match.range.startUtf16 + 1} ${item.match.snippet}`).slice(0, safeWidth));
  if (model.truncated && offset + limit >= items.length && rows.length < maxRows) rows.push(`… ${model.totalMatches - model.matches.length} more matches`.slice(0, safeWidth));
  return Object.freeze(rows);
}
export function searchRowIds(model: SearchReadModel, offset: number, rows: number): readonly (string | undefined)[] {
  const result: (string | undefined)[] = [undefined, undefined, undefined];
  for (const item of expandSearchItems(model.matches).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, rows - 3))) result.push(item.kind === 'match' ? item.match.id : `file:${item.path}`);
  return result.slice(0, Math.max(0, rows));
}
