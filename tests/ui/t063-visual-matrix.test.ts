import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUtf16Offset, type CellColumn, type DocumentId, type LineIndex, type SelectionId, type Utf16Column, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { WorkbenchRenderable, type WorkbenchTheme } from '../../packages/ui/src/index';

const source = 'alpha 😀 beta\n\n\tCJK界 é 👩‍💻\nlast line';
const documentId = id<DocumentId>('T063-visual-document');
const viewId = id<ViewId>('T063-visual-view');
const lowColorTheme: WorkbenchTheme = {
  background: '#000000', surface: '#202020', surfaceActive: '#404040', foreground: '#FFFFFF', muted: '#AAAAAA',
  border: '#808080', accent: '#FFFFFF', error: '#FFFFFF',
};

interface RenderedFixture {
  readonly fixture: string;
  readonly width: number;
  readonly height: number;
  readonly ascii: boolean;
  readonly colorMode: 'truecolor' | 'no-color';
  readonly chars: string;
  readonly rows: number;
  readonly frameSelections: number;
  readonly selectedCells: number;
  readonly secondarySelectedCells: number;
  readonly cursor: { readonly row: number; readonly column: number } | null;
  readonly spans: readonly number[];
}

const rendered: RenderedFixture[] = [];

const opened = openTextDocument(documentId, new TextEncoder().encode(source));
assert.equal(opened.kind, 'editable', 'T063-VISUAL-DOC-01 source opens through document owner');
if (opened.kind !== 'editable') throw new Error('T063-visual-open');
const snapshot = opened.document.snapshot();

await renderFixture('E16-normal-unicode', normalSet(snapshot), { width: 120, height: 40, colorMode: 'truecolor', ascii: false });
await renderFixture('E16-visual-character-forward', visualCharacterSet(snapshot), { width: 120, height: 40, colorMode: 'truecolor', ascii: false });
await renderFixture('E16-visual-line', visualLineSet(snapshot), { width: 120, height: 40, colorMode: 'truecolor', ascii: false });
await renderFixture('E16-visual-block', visualBlockSet(snapshot), { width: 120, height: 40, colorMode: 'truecolor', ascii: false });
await renderFixture('E16-empty-line', emptyLineSet(snapshot), { width: 80, height: 24, colorMode: 'truecolor', ascii: false });
await renderFixture('E16-eof', eofSet(snapshot), { width: 80, height: 24, colorMode: 'truecolor', ascii: false });
const narrow = await renderFixture('E16-narrow-ascii', normalSet(snapshot), { width: 60, height: 18, colorMode: 'no-color', ascii: true });

assert.equal(narrow.frameSelections, 2, 'T063-NARROW-01 both cursors remain projected at 60x18');
assert.equal(narrow.selectedCells, 0, 'T063-NARROW-02 Normal cursors are not painted as selections');
assert.ok(narrow.spans.some((attributes) => (attributes & TextAttributes.INVERSE) !== 0), 'T063-NOCOLOR-01 primary cursor uses reverse');
assert.ok(narrow.spans.some((attributes) => (attributes & TextAttributes.UNDERLINE) !== 0), 'T063-NOCOLOR-02 secondary cursor uses underline');
assert.doesNotMatch(narrow.chars, /▾|▌|●/u, 'T063-ASCII-01 narrow ASCII mode uses width-one markers');
for (const fixture of rendered) {
  assert.ok(fixture.rows <= fixture.height - 1, `T063-FRAME-ROWS-${fixture.fixture} frame has bounded rows`);
  assert.ok(fixture.chars.split('\n').every((line) => [...line].length <= fixture.width), `T063-FRAME-WIDTH-${fixture.fixture} output does not overflow its viewport`);
}

const artifact = resolve(process.cwd(), '.artifacts/ui/t063-frame-matrix.json');
await mkdir(resolve(process.cwd(), '.artifacts/ui'), { recursive: true });
await writeFile(artifact, `${JSON.stringify({
  schemaVersion: 1,
  fixture: 'T063-FRAME-MATRIX-01',
  sourceUtf16Units: source.length,
  cases: rendered,
  reviewedStates: ['normal-unicode', 'visual-character', 'visual-line', 'visual-block', 'empty-line', 'eof', 'narrow-ascii-no-color'],
  unrepresentedStates: ['search-overlay', 'diagnostics-overlay', 'focused-inactive-view', 'loading-error-recovery'],
}, null, 2)}\n`, 'utf8');
console.log(`T063 visual frame matrix passed ${rendered.length} production WorkbenchRenderable states; artifact=${artifact}`);

async function renderFixture(
  fixture: string,
  selections: SelectionSetSnapshot,
  options: { readonly width: number; readonly height: number; readonly colorMode: 'truecolor' | 'no-color'; readonly ascii: boolean },
): Promise<RenderedFixture> {
  const selectionSet = selections;
  const view: WorkbenchViewSnapshot = {
    session: { viewId, documentId, documentVersion: snapshot.version, selections: selectionSet, mode: selectionSet.members[0]?.kind.startsWith('visual') === true ? 'visual' : 'normal' },
    document: snapshot,
    selections: selectionSet,
    scrollTop: 0,
    scrollLeft: 0,
  };
  const document: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) => expectedVersion === snapshot.version ? snapshot.slice(start, end) : { ok: false, error: { kind: 'stale-version' } },
  };
  const workbench: WorkbenchReadPort = {
    activeViewId: viewId,
    readView: (candidate) => candidate === viewId ? view : undefined,
    readDocument: (candidate) => candidate === viewId ? document : undefined,
  };
  const setup = await createTestRenderer({ width: options.width, height: options.height, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench,
    fileLabel: fixture,
    ascii: options.ascii,
    colorMode: options.colorMode,
    ...(options.colorMode === 'no-color' ? { theme: lowColorTheme } : {}),
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const chars = setup.captureCharFrame();
  const stats = viewport.lastPaintStats;
  const frame = viewport.lastFrame?.frame;
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans.map((span) => span.attributes));
  const result: RenderedFixture = {
    fixture,
    width: options.width,
    height: options.height,
    ascii: options.ascii,
    colorMode: options.colorMode,
    chars,
    rows: frame?.rows.length ?? 0,
    frameSelections: frame?.selections.length ?? 0,
    selectedCells: stats?.selectedCells ?? 0,
    secondarySelectedCells: stats?.secondarySelectedCells ?? 0,
    cursor: stats?.primaryCursor === null || stats?.primaryCursor === undefined ? null : stats.primaryCursor,
    spans,
  };
  rendered.push(result);
  if (fixture.includes('visual-character')) assert.ok(result.selectedCells > 0, 'T063-VISUAL-CHAR-01 selection fill is painted');
  if (fixture.includes('visual-line')) assert.ok(result.selectedCells > 0, 'T063-VISUAL-LINE-01 line fill is painted');
  if (fixture.includes('visual-block')) assert.ok(result.selectedCells > 0, 'T063-VISUAL-BLOCK-01 block fill is painted');
  if (fixture.includes('empty-line') || fixture.includes('eof')) assert.notEqual(result.cursor, null, `T063-ENDPOINT-${fixture} endpoint cursor is visible`);
  setup.renderer.destroy();
  return result;
}

function normalSet(base: DocumentSnapshot) {
  return makeSet(base, [
    { id: id<SelectionId>('T063-normal-primary'), kind: 'normal-cursor', direction: 'forward', anchor: character(0, 1), head: character(0, 1) },
    { id: id<SelectionId>('T063-normal-secondary'), kind: 'normal-cursor', direction: 'forward', anchor: character(6, 8), head: character(6, 8) },
  ]);
}

function visualCharacterSet(base: DocumentSnapshot) {
  return makeSet(base, [{ id: id<SelectionId>('T063-vchar-primary'), kind: 'visual-character', direction: 'forward', anchor: character(0, 1), head: character(4, 5), inclusive: true }]);
}

function visualLineSet(base: DocumentSnapshot) {
  return makeSet(base, [{ id: id<SelectionId>('T063-vline-primary'), kind: 'visual-line', direction: 'forward', anchor: { kind: 'line', lineIndex: line(0) }, head: { kind: 'line', lineIndex: line(2) } }]);
}

function visualBlockSet(base: DocumentSnapshot) {
  return makeSet(base, [{ id: id<SelectionId>('T063-vblock-primary'), kind: 'visual-block', direction: 'forward', anchor: block(0, 1, 1), head: block(15, 2, 2) }]);
}

function emptyLineSet(base: DocumentSnapshot) {
  return makeSet(base, [{ id: id<SelectionId>('T063-empty-primary'), kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'empty-line', lineIndex: line(1) }, head: { kind: 'empty-line', lineIndex: line(1) } }]);
}

function eofSet(base: DocumentSnapshot) {
  return makeSet(base, [{ id: id<SelectionId>('T063-eof-primary'), kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'eof' }, head: { kind: 'eof' } }]);
}

function makeSet(base: DocumentSnapshot, members: readonly SelectionMemberInput[]) {
  const primaryId = members[0]?.id;
  if (primaryId === undefined) throw new Error('T063-visual-empty-members');
  const result = createSelectionSet(base, { primaryId, members });
  if (!result.ok) throw new Error(`T063-visual-selection:${result.error.kind}`);
  return result.value.selectionSet;
}

function character(start: number, after: number) {
  return { kind: 'character' as const, offset: offset(start), after: offset(after) };
}

function block(value: number, lineIndex: number, displayColumn: number) {
  return { kind: 'block-cell' as const, offset: offset(value), lineIndex: line(lineIndex), logicalUtf16Column: column(displayColumn), displayCellColumn: cell(displayColumn), virtualCells: 0 };
}

function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T063-offset:${value}`);
  return result.value;
}

function line(value: number) { return value as LineIndex; }
function column(value: number) { return value as Utf16Column; }
function cell(value: number) { return value as CellColumn; }

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T063-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
