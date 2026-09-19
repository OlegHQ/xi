import type { Disposable } from '../../contracts/src/index';
export interface CompletionItemRead { readonly id: string; readonly label: string; readonly detail?: string; readonly documentation?: string; }
export interface CompletionReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly items: readonly CompletionItemRead[]; readonly selectedId: string | undefined; readonly documentation: string | undefined; readonly documentationOffset?: number; readonly message: string | undefined; }
export interface CompletionReadPort { readonly model: CompletionReadModel; subscribe(listener: (model: CompletionReadModel) => void): Disposable; }
export interface CompletionPopupTheme { readonly background: string; readonly foreground: string; readonly muted: string; readonly accent: string; readonly selectedBackground: string; }
export function formatCompletionLines(model: CompletionReadModel, width: number, maxRows = 8): readonly string[] {
  if (model.state === 'idle') return Object.freeze([]);
  const rows: string[] = [model.message ?? (model.state === 'loading' ? 'Loading completions…' : 'Completions')];
  for (const item of model.items.slice(0, Math.max(0, maxRows - 1))) rows.push(`${item.id === model.selectedId ? '▸ ' : '  '}${item.label}${item.detail === undefined ? '' : ` — ${item.detail}`}`.slice(0, Math.max(1, width)));
  return Object.freeze(rows);
}
export interface SignatureReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly label: string | undefined; readonly documentation: string | undefined; readonly activeParameter: number | undefined; readonly message: string | undefined; }
export interface SignatureReadPort { readonly model: SignatureReadModel; subscribe(listener: (model: SignatureReadModel) => void): Disposable; }
export function formatSignatureLines(model: SignatureReadModel, width: number, maxRows: number): readonly string[] {
  if (model.state === 'idle') return Object.freeze([]);
  const rows = [model.label ?? model.message ?? (model.state === 'loading' ? 'Loading signature…' : 'Signature help')];
  if (model.documentation !== undefined) rows.push(...model.documentation.split('\n').slice(0, Math.max(0, maxRows - 1)));
  return Object.freeze(rows.map(row => row.slice(0, Math.max(1, width))));
}
