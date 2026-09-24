import type { Disposable } from '../../contracts/src/index';
import type { ExCommandLineReadModel } from '../../workbench/src/index';
export interface ExCommandLineReadPort { readonly model: ExCommandLineReadModel | undefined; subscribe?(listener: (model: ExCommandLineReadModel | undefined) => void): Disposable; }
export interface ExCommandLineTheme { readonly background: string; readonly surface: string; readonly foreground: string; readonly muted: string; readonly accent: string; readonly border: string; readonly error: string; }
export const DEFAULT_EX_COMMAND_LINE_THEME: ExCommandLineTheme = Object.freeze({ background: '#F1F0EC', surface: '#E7E5DE', foreground: '#24292E', muted: '#60666D', accent: '#245A88', border: '#B7B2A6', error: '#A52A36' });
function candidateText(candidate: ExCommandLineReadModel['candidates'][number], selected: boolean): string {
  const marker = selected ? '>' : ' ';
  const state = candidate.available ? '' : ` [${candidate.disabledReason ?? 'unavailable'}]`;
  return `${marker} ${candidate.label} — ${candidate.detail}${state}`;
}
export function formatExCommandLineLines(model: ExCommandLineReadModel, width: number, maxRows: number): readonly string[] {
  if (width <= 0 || maxRows <= 0) return Object.freeze([]);
  const safeWidth = Math.max(1, Math.trunc(width));
  const rows = Math.max(1, Math.trunc(maxRows));
  const output: string[] = [];
  if (model.parseFailure !== undefined && rows > 1) {
    const detail = 'reason' in model.parseFailure ? model.parseFailure.reason : model.parseFailure.kind;
    output.push(clip(detail, safeWidth));
  }
  output.push(clip(model.source, safeWidth));
  if (model.parseFailure === undefined && output.length < rows) output.push(clip(model.acceptanceHint, safeWidth));
  for (let index = 0; index < model.candidates.length && output.length < rows; index += 1) {
    const candidate = model.candidates[index];
    if (candidate !== undefined) output.push(clip(candidateText(candidate, index === model.selectedIndex), safeWidth));
  }
  return Object.freeze(output);
}

function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

/** Helix prompt completion geometry (`ui/prompt.rs`): columns at least 30 cells wide, filled
 * column-major, at most 10 rows, paged so the highlighted item stays visible. */
export interface ExCompletionGrid { readonly columns: number; readonly columnWidth: number; readonly rows: number; readonly offset: number; readonly highlighted: number | undefined; }
const COMPLETION_BASE_WIDTH = 30;

export function exCompletionGrid(model: ExCommandLineReadModel | undefined, width: number, maxRows = 10): ExCompletionGrid {
  const candidates = model?.candidates ?? [];
  const longest = candidates.reduce((max, candidate) => Math.max(max, [...candidate.label].length), COMPLETION_BASE_WIDTH);
  const columns = Math.max(1, Math.floor(width / longest));
  const columnWidth = Math.max(1, Math.floor((width - columns) / columns));
  const rows = Math.min(maxRows, Math.ceil(candidates.length / columns));
  const highlighted = exHighlightedCandidate(model);
  const perPage = Math.max(1, rows * columns);
  return { columns, columnWidth, rows, offset: highlighted === undefined ? 0 : Math.floor(highlighted / perPage) * perPage, highlighted };
}

/** Helix highlights a completion only once it has been accepted into the line (Tab); before
 * that the list is a plain preview. */
function exHighlightedCandidate(model: ExCommandLineReadModel | undefined): number | undefined {
  const selected = model?.candidates[model.selectedIndex];
  return selected !== undefined && model !== undefined && model.position.typedName.length > 0 && selected.label === model.position.typedName ? model.selectedIndex : undefined;
}

/** Doc popup text for the command being typed (Helix `doc_fn`); like Helix, a line that does
 * not name a command shows none (Enter reports the error). */
export function exCommandDoc(model: ExCommandLineReadModel | undefined): { readonly lines: readonly string[]; readonly error: boolean } | undefined {
  if (model === undefined || model.position.typedName.length === 0 || model.parseFailure !== undefined) return undefined;
  // `:w` names `write`: the parser resolves abbreviations and Vim aliases to the canonical name.
  const names = [model.position.typedName, model.parsed?.name].filter(name => name !== undefined);
  const candidate = model.candidates.find(item => names.includes(item.label) || (item.commandName !== undefined && names.includes(item.commandName)));
  if (candidate === undefined || candidate.detail.length === 0) return undefined;
  const lines = [candidate.detail];
  if (candidate.alias !== undefined && candidate.commandId !== undefined) lines.push(`Alias for ${String(candidate.commandId)}`);
  if (!candidate.available) lines.push(candidate.disabledReason ?? 'Unavailable');
  return { lines, error: false };
}

/** Word-wraps doc lines to `width` cells (Helix wraps its doc popup text the same way). */
export function wrapDocLines(lines: readonly string[], width: number): readonly string[] {
  const wrapped: string[] = [];
  for (const line of lines) {
    let current = '';
    for (const word of line.split(' ')) {
      if (current.length > 0 && current.length + 1 + word.length > width) { wrapped.push(current); current = ''; }
      current = current.length === 0 ? word : `${current} ${word}`;
    }
    wrapped.push(current);
  }
  return wrapped;
}
