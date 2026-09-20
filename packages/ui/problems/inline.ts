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

/** Visible-only virtual lines. Reuses layout's non-editable filler rows and hit maps. */
export function inlineDiagnosticLines(snapshot: WorkbenchViewSnapshot['document'], problems: readonly Problem[], top: number, width: number, height: number, gutter: number, scrollLeft = 0): readonly DiagnosticLine[] {
  const rows: DiagnosticLine[] = [];
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
    const available = Math.max(1, width - column - 4);
    const moreAtAnchor = problems[index + 1]?.range.startLine === line && problems[index + 1]?.range.startUtf16 === problem.range.startUtf16;
    let first = true;
    const append = (text: string): void => {
      if (rows.length >= height) return;
      rows.push({ id: `diagnostic-${String(rows.length).padStart(5, '0')}`, documentVersion: snapshot.version,
        beforeLine: (line + 1) as DiffFillerRow['beforeLine'], problem, column,
        text: `${first ? moreAtAnchor ? '├─ ' : '└─ ' : moreAtAnchor ? '│  ' : '   '}${text}` });
      first = false;
    };
    const message = `${problem.code === undefined ? '' : `${problem.code}: `}${problem.message.slice(0, width * height * 2)}`;
    // At most a viewport of message text is needed, even for a hostile server payload.
    for (const paragraph of clean(message.slice(0, width * height * 2)).split('\n')) {
      let text = '';
      let cells = 0;
      for (const { segment } of graphemes.segment(paragraph)) {
        const size = cellWidth.widthOfCluster(segment);
        if (cells + size > available && text.length > 0) { append(text); text = ''; cells = 0; }
        if (rows.length >= height) break;
        text += segment;
        cells += size;
      }
      if (rows.length >= height) break;
      append(text);
    }
  }
  return rows;
}
