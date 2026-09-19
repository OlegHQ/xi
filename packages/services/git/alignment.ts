export interface ComparisonLine { readonly kind: 'context' | 'added' | 'removed'; readonly oldLine?: number; readonly newLine?: number; }
export interface ComparisonRow { readonly left: number | null; readonly right: number | null; readonly removed: boolean; readonly added: boolean; }
export interface ComparisonAlignment { readonly rows: readonly ComparisonRow[]; readonly rowForRightLine: readonly number[]; }
/** One-based Git coordinates become zero-based document rows once, outside paint. */
export async function prepareComparison(lines: readonly ComparisonLine[], split: boolean): Promise<ComparisonAlignment> {
  const iterator = alignmentSteps(lines, split);
  let result = iterator.next();
  while (!result.done) { await new Promise<void>(resolve => setTimeout(resolve, 0)); result = iterator.next(); }
  return result.value;
}

function* alignmentSteps(lines: readonly ComparisonLine[], split: boolean): Generator<void, ComparisonAlignment> {
  const rows: ComparisonRow[] = [];
  for (let index = 0; index < lines.length;) {
    if (index % 1024 === 0) yield;
    const line = lines[index]!;
    if (!split || line.kind === 'context') {
      rows.push({ left: line.oldLine === undefined ? null : line.oldLine - 1, right: line.newLine === undefined ? null : line.newLine - 1, removed: line.kind === 'removed', added: line.kind === 'added' });
      index += 1;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (index < lines.length && lines[index]!.kind !== 'context') {
      if (index % 1024 === 0) yield;
      const changed = lines[index++]!;
      if (changed.oldLine !== undefined) removed.push(changed.oldLine - 1);
      if (changed.newLine !== undefined) added.push(changed.newLine - 1);
    }
    for (let row = 0; row < Math.max(removed.length, added.length); row += 1) { rows.push({ left: removed[row] ?? null, right: added[row] ?? null, removed: row < removed.length, added: row < added.length }); if (row % 1024 === 0) yield; }
  }
  const rowForRightLine: number[] = [];
  for (let index = 0; index < rows.length; index += 1) { const line = rows[index]!.right; if (line !== null) rowForRightLine[line] = index; if (index % 1024 === 0) yield; }
  return { rows: Object.freeze(rows), rowForRightLine: Object.freeze(rowForRightLine) };
}
