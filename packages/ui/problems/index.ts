import type { Disposable } from '../../contracts/src/index';
import { helixThemeColor } from '../theme/color-input';
import type { WorkbenchTheme, ThemeColor } from '../theme/workbench-themes';

export function diagnosticColor(theme: WorkbenchTheme, severity: Problem['severity']): ThemeColor {
  const name = severity === 1 ? 'error' : severity === 2 ? 'warning' : severity === 3 ? 'info' : 'hint';
  return helixThemeColor(theme, `diagnostic.${name}`, 'fg', helixThemeColor(theme, name, 'fg', severity === 1 ? theme.error : theme.accent));
}

export interface ProblemRange { readonly startLine: number; readonly startUtf16: number; readonly endLine: number; readonly endUtf16: number; }
export interface Problem {
  readonly id: string; readonly uri: string; readonly range: ProblemRange; readonly message: string;
  readonly severity: 1 | 2 | 3 | 4 | undefined; readonly source: string | undefined; readonly code: string | number | undefined;
  readonly serverId: string; readonly documentVersion: number | undefined; readonly generation: number;
}
export interface ProblemsReadModel { readonly contractVersion: 1; readonly generation: number; readonly all: readonly Problem[]; /** URIs whose diagnostics were cut at the service's per-URI admission limit. */ readonly truncatedUris?: ReadonlySet<string>; }
export interface ProblemsReadPort { readonly model: ProblemsReadModel; subscribe(listener: (model: ProblemsReadModel) => void): Disposable; }
export function formatProblemsLines(model: ProblemsReadModel, width: number, maxRows = 10, scrollOffset = 0): readonly string[] {
  const rowLimit = Math.max(1, Math.trunc(maxRows));
  const truncated = model.truncatedUris?.size ?? 0;
  const rows: string[] = [`Problems ${model.all.length}${truncated === 0 ? '' : ` (${truncated} file${truncated === 1 ? '' : 's'} truncated)`}`];
  const problemLimit = Math.max(0, rowLimit - 1);
  const safeOffset = Math.max(0, Math.trunc(scrollOffset));
  const slice = model.all.slice(safeOffset, safeOffset + problemLimit);
  for (const problem of slice) rows.push(`${problem.uri}:${problem.range.startLine + 1}:${problem.range.startUtf16 + 1} ${problem.message}`.slice(0, Math.max(1, width)));
  if (safeOffset + problemLimit < model.all.length && rows.length < rowLimit) rows.push(`… ${model.all.length - safeOffset - problemLimit} more`.slice(0, Math.max(1, width)));
  return Object.freeze(rows);
}
