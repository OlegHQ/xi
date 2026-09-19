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
