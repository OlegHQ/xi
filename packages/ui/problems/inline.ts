import type { WorkbenchViewSnapshot } from '../../workbench/src/index';
import { defaultCellWidthPolicy, type DiffFillerRow } from '../../layout/src/index';
import type { Problem } from './index';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cellWidth = defaultCellWidthPolicy();
const clean = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '').replace(/\t/gu, '    ');

export interface DiagnosticLine extends DiffFillerRow {
  readonly problem: Problem;
  readonly text: string;
  readonly column: number;
}

export type InlineDiagnosticsFilter = 'disable' | 'hint' | 'info' | 'warning' | 'error';

function allows(problem: Problem, filter: InlineDiagnosticsFilter): boolean {
  if (filter === 'disable') return false;
  const threshold = filter === 'error' ? 1 : filter === 'warning' ? 2 : filter === 'info' ? 3 : 4;
  return (problem.severity ?? 1) <= threshold;
}

export interface EndOfLineDiagnostic {
  readonly problem: Problem;
  readonly text: string;
}

/** Selects the highest-severity diagnostic that the inline policy left visible. */
export function endOfLineDiagnosticLines(snapshot: WorkbenchViewSnapshot['document'], problems: readonly Problem[], top: number, height: number, width: number, maxDiagnostics = 10, cursorLine = -1, cursorLineFilter: InlineDiagnosticsFilter = 'error', otherLinesFilter: InlineDiagnosticsFilter = 'error', endOfLineFilter: InlineDiagnosticsFilter = 'disable', prefixLen = 1, minDiagnosticWidth = 40): readonly EndOfLineDiagnostic[] {
  if (endOfLineFilter === 'disable' || height <= 0) return [];
  const firstLine = Math.max(0, Math.trunc(top));
  const lastLine = Math.min(snapshot.lineCount, firstLine + Math.max(0, Math.trunc(height)));
  const byLine = new Map<number, Problem[]>();
  for (const problem of problems) {
    const line = problem.range.startLine;
    if (line < firstLine || line >= lastLine || line >= snapshot.lineCount) continue;
    if (problem.documentVersion !== undefined && problem.documentVersion !== Number(snapshot.version)) continue;
    const lineProblems = byLine.get(line);
    if (lineProblems === undefined) byLine.set(line, [problem]);
    else lineProblems.push(problem);
  }
  const barCount = Number.isSafeInteger(prefixLen) && prefixLen >= 0 ? Math.min(prefixLen, 1_000) : 1;
  const minWidth = Number.isSafeInteger(minDiagnosticWidth) && minDiagnosticWidth >= 0 ? Math.min(minDiagnosticWidth, 1_000) : 40;
  const inlineEnabled = width >= minWidth + barCount;
  const result: EndOfLineDiagnostic[] = [];
  for (const [line, lineProblems] of byLine) {
    const inlineFilter = line === cursorLine ? cursorLineFilter : otherLinesFilter;
    const inline = new Set<Problem>();
    if (inlineEnabled) {
      for (const problem of lineProblems) {
        if (!allows(problem, inlineFilter)) continue;
        if (inline.size >= maxDiagnostics) break;
        inline.add(problem);
      }
    }
    const candidate = lineProblems
      .filter(problem => !inline.has(problem) && allows(problem, endOfLineFilter))
      .sort((left, right) => (left.severity ?? 1) - (right.severity ?? 1) || left.range.startUtf16 - right.range.startUtf16)[0];
    if (candidate !== undefined) {
      const message = `${candidate.code === undefined ? '' : `${candidate.code}: `}${candidate.message.slice(0, Math.max(1, width) * 2)}`;
      result.push({ problem: candidate, text: ` ${clean(message)}` });
    }
  }
  return result;
}

/** Visible-only virtual lines. Reuses layout's non-editable filler rows and hit maps. */
export function inlineDiagnosticLines(snapshot: WorkbenchViewSnapshot['document'], problems: readonly Problem[], top: number, width: number, height: number, gutter: number, scrollLeft = 0, maxDiagnostics = 10, cursorLine = -1, cursorLineFilter: InlineDiagnosticsFilter = 'error', otherLinesFilter: InlineDiagnosticsFilter = 'error', prefixLen = 1, maxWrap = 20, minDiagnosticWidth = 40): readonly DiagnosticLine[] {
  const rows: DiagnosticLine[] = [];
  const shownByLine = new Map<number, number>();
  const barCount = Number.isSafeInteger(prefixLen) && prefixLen >= 0 ? Math.min(prefixLen, 1_000) : 1;
  const bars = '─'.repeat(barCount);
  const continuation = ' '.repeat(barCount + 1);
  const final = ' '.repeat(barCount + 2);
  const wrapFreeSpace = Number.isSafeInteger(maxWrap) && maxWrap >= 0 ? Math.min(maxWrap, 1_000) : 20;
  const minWidth = Number.isSafeInteger(minDiagnosticWidth) && minDiagnosticWidth >= 0 ? Math.min(minDiagnosticWidth, 1_000) : 40;
  if (width < minWidth + barCount) return rows;
  const maxDiagnosticStart = width - minWidth - barCount;
  // The store sorts by source position; skip offscreen diagnostics without walking them per key.
  let low = 0;
  let high = problems.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (problems[mid]!.range.startLine < top) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < problems.length && rows.length < height; index++) {
    const problem = problems[index]!;
    const line = problem.range.startLine;
    if (line >= top + height || line >= snapshot.lineCount) break;
    if (problem.documentVersion !== undefined && problem.documentVersion !== Number(snapshot.version)) continue;
    if (!allows(problem, line === cursorLine ? cursorLineFilter : otherLinesFilter)) continue;
    if ((shownByLine.get(line) ?? 0) >= maxDiagnostics) continue;
    shownByLine.set(line, (shownByLine.get(line) ?? 0) + 1);
    const start = snapshot.lineStartOffset(line as Parameters<typeof snapshot.lineStartOffset>[0]);
    if (!start.ok) continue;
    let column = gutter;
    // Read a bounded prefix only; diagnostics far along a giant line anchor at the right edge.
    const end = Math.min(Number(start.value) + problem.range.startUtf16, Number(start.value) + width * 8, snapshot.lengthUtf16);
    const prefix = snapshot.slice(start.value, end as Parameters<typeof snapshot.slice>[1]);
    if (prefix.ok) for (const { segment } of graphemes.segment(prefix.value)) {
      column += segment === '\t' ? 8 - (column - gutter) % 8 : cellWidth.widthOfCluster(segment);
    }
    column = Math.max(gutter, Math.min(column - scrollLeft, Math.floor(width / 2)));
    const available = Math.max(1, column > maxDiagnosticStart ? minWidth : width - column - (barCount + 3));
    const moreAtAnchor = problems[index + 1]?.range.startLine === line && problems[index + 1]?.range.startUtf16 === problem.range.startUtf16;
    let first = true;
    const append = (text: string): void => {
      if (rows.length >= height) return;
      rows.push({ id: `diagnostic-${String(rows.length).padStart(5, '0')}`, documentVersion: snapshot.version,
        beforeLine: (line + 1) as DiffFillerRow['beforeLine'], problem, column,
        text: `${first ? `${moreAtAnchor ? '├' : '└'}${bars} ` : moreAtAnchor ? `│${continuation}` : final}${text}` });
      first = false;
    };
    const message = `${problem.code === undefined ? '' : `${problem.code}: `}${problem.message.slice(0, width * height * 2)}`;
    // At most a viewport of message text is needed, even for a hostile server payload.
    for (const paragraph of clean(message.slice(0, width * height * 2)).split('\n')) {
      const segments = [...graphemes.segment(paragraph)].map(({ segment }) => ({ segment, cells: cellWidth.widthOfCluster(segment) }));
      if (segments.length === 0) { append(''); continue; }
      let start = 0;
      while (start < segments.length && rows.length < height) {
        let end = start;
        let cells = 0;
        let breakEnd = -1;
        let breakCells = 0;
        while (end < segments.length) {
          const current = segments[end]!;
          if (cells + current.cells > available && end > start) break;
          cells += current.cells;
          end += 1;
          if (/\s/u.test(current.segment)) {
            breakEnd = end - 1;
            breakCells = cells - current.cells;
          }
        }
        if (end === segments.length) {
          append(segments.slice(start).map(({ segment }) => segment).join(''));
          break;
        }
        if (breakEnd > start && available - breakCells <= wrapFreeSpace) {
          append(segments.slice(start, breakEnd).map(({ segment }) => segment).join(''));
          start = breakEnd;
          while (start < segments.length && /\s/u.test(segments[start]!.segment)) start += 1;
        } else {
          const forcedEnd = Math.max(start + 1, end);
          append(segments.slice(start, forcedEnd).map(({ segment }) => segment).join(''));
          start = forcedEnd;
        }
      }
    }
  }
  return rows;
}
