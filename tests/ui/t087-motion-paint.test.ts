import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { DARK_WORKBENCH_THEME, WorkbenchRenderable, type EditorPresentationRead, type WorkbenchRenderableOptions } from '../../packages/ui/src/index';

const VIEW_ID = id<ViewId>('T087-view');
const DOCUMENT_ID = id<DocumentId>('T087-document');
const observations: Array<{ readonly fixture: string; readonly stats: WorkbenchRenderable['lastPaintStats'] }> = [];

interface Fixture {
  readonly workbench: WorkbenchReadPort;
  readonly snapshot: DocumentSnapshot;
  readonly view: WorkbenchViewSnapshot;
}

function makeFixture(kind: 'normal' | 'visual'): Fixture {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode('alpha 😀 beta\nsecond line\nthird line'));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('T087-open');
  const snapshot = opened.document.snapshot();
  const primary = id<SelectionId>('T087-primary');
  const secondary = id<SelectionId>('T087-secondary');
  const offset = (value: number) => {
    const result = asUtf16Offset(value);
    if (!result.ok) throw new Error(`T087-offset:${value}`);
    return result.value;
  };
  const desired = { logicalUtf16: 0 as number & { readonly __xiBrand: 'Utf16Column' }, displayCell: 0 as number & { readonly __xiBrand: 'CellColumn' } };
  const members = kind === 'normal'
    ? [
      { id: primary, kind: 'normal-cursor' as const, direction: 'forward' as const, anchor: { kind: 'character' as const, offset: offset(0), after: offset(1) }, head: { kind: 'character' as const, offset: offset(0), after: offset(1) }, desiredColumn: desired },
      { id: secondary, kind: 'normal-cursor' as const, direction: 'forward' as const, anchor: { kind: 'character' as const, offset: offset(10), after: offset(11) }, head: { kind: 'character' as const, offset: offset(10), after: offset(11) }, desiredColumn: desired },
    ]
    : [
      { id: primary, kind: 'visual-character' as const, direction: 'forward' as const, anchor: { kind: 'character' as const, offset: offset(0), after: offset(1) }, head: { kind: 'character' as const, offset: offset(4), after: offset(5) }, inclusive: true, desiredColumn: desired, anchorDesiredColumn: desired },
      { id: secondary, kind: 'visual-character' as const, direction: 'forward' as const, anchor: { kind: 'character' as const, offset: offset(16), after: offset(17) }, head: { kind: 'character' as const, offset: offset(21), after: offset(22) }, inclusive: true, desiredColumn: desired, anchorDesiredColumn: desired },
    ];
  const selections = createSelectionSet(snapshot, { primaryId: primary, selectionGeneration: 7, members });
  if (!selections.ok) throw new Error(`T087-selection:${selections.error.kind}`);
  const selectionSet = selections.value.selectionSet;
  const session = { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selectionSet, mode: kind } as const;
  const view: WorkbenchViewSnapshot = { session, document: snapshot, selections: selectionSet, scrollTop: 0, scrollLeft: 0 };
  const document: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) => expectedVersion === snapshot.version ? snapshot.slice(start, end) : { ok: false, error: { kind: 'stale-version' } },
  };
  return { snapshot, view, workbench: { activeViewId: VIEW_ID, readView: (viewId) => viewId === VIEW_ID ? view : undefined, readDocument: (viewId) => viewId === VIEW_ID ? document : undefined } };
}

function motionPreview(fixture: Fixture, overrides: Partial<EditorPresentationRead> = {}): EditorPresentationRead {
  return {
    motionTrail: 'last-motion',
    reducedMotion: true,
    colorMode: 'truecolor',
    motionPreview: {
      documentId: fixture.snapshot.id,
      documentVersion: fixture.snapshot.version,
      selectionGeneration: fixture.view.selections.selectionGeneration,
      operatorKey: 'w',
      count: 1,
      members: [
        { memberId: 'T087-primary', source: 0, destination: 10, moved: true, extent: { kind: 'characterwise', start: 0, end: 11 } },
        { memberId: 'T087-secondary', source: 10, destination: 16, moved: true, extent: { kind: 'characterwise', start: 10, end: 17 } },
      ],
    },
    operatorPreview: {
      documentId: fixture.snapshot.id,
      documentVersion: fixture.snapshot.version,
      selectionGeneration: fixture.view.selections.selectionGeneration,
      members: [{ memberId: 'T087-primary', kind: 'characterwise', start: 1, end: 4 }],
    },
    ...overrides,
  };
}

async function render(fixture: Fixture, presentation: EditorPresentationRead, options: Omit<WorkbenchRenderableOptions, 'workbench' | 'presentation'> = {}): Promise<{ readonly setup: Awaited<ReturnType<typeof createTestRenderer>>; readonly viewport: WorkbenchRenderable }> {
  const setup = await createTestRenderer({ width: typeof options.width === 'number' ? options.width : 120, height: typeof options.height === 'number' ? options.height : 40, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: fixture.workbench, presentation: { readPresentation: () => presentation }, fileLabel: 'editor.ts', ...options });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  return { setup, viewport };
}

async function testLayersAndLifecycle(): Promise<void> {
  const normal = makeFixture('normal');
  const on = await render(normal, motionPreview(normal));
  const onStats = on.viewport.lastPaintStats;
  observations.push({ fixture: 'E23-on-truecolor', stats: onStats });
  assert.ok(onStats !== undefined && onStats.trailCells > 0, 'T087-PAINT-01 last-motion paints only visible trail cells');
  assert.ok(onStats !== undefined && onStats.operatorPreviewCells > 0, 'T087-PAINT-02 exact operator preview has a visible layer');
  assert.equal(onStats?.selectedCells, 0, 'T087-PAINT-03 Normal motion trail does not become a Visual selection');
  const onEnd = asUtf16Offset(normal.snapshot.lengthUtf16 as number);
  if (!onEnd.ok) throw new Error('T087-end-offset');
  const onStart = asUtf16Offset(0);
  if (!onStart.ok) throw new Error('T087-start-offset');
  const onRead = normal.snapshot.slice(onStart.value, onEnd.value);
  if (!onRead.ok) throw new Error('T087-read-bytes');
  const onBytes = onRead.value;
  assert.equal(onBytes, 'alpha 😀 beta\nsecond line\nthird line', 'T087-E23-01 trail paint leaves document bytes unchanged');
  assert.equal(normal.view.selections.selectionGeneration, 7, 'T087-E23-02 trail paint leaves selection generation unchanged');
  on.setup.renderer.destroy();

  const off = await render(normal, motionPreview(normal, { motionTrail: 'off' }));
  observations.push({ fixture: 'E23-off-truecolor', stats: off.viewport.lastPaintStats });
  assert.equal(off.viewport.lastPaintStats?.trailCells, 0, 'T087-PAINT-04 off mode clears trail paint');
  assert.ok((off.viewport.lastPaintStats?.operatorPreviewCells ?? 0) > 0, 'T087-PAINT-05 operator preview remains independent of trail setting');
  off.setup.renderer.destroy();

  const visual = makeFixture('visual');
  const visualRendered = await render(visual, motionPreview(visual));
  observations.push({ fixture: 'MC01-visual-layers', stats: visualRendered.viewport.lastPaintStats });
  assert.equal(visualRendered.viewport.lastPaintStats?.trailCells, 0, 'T087-PAINT-06 Visual mode suppresses motion trail');
  assert.ok((visualRendered.viewport.lastPaintStats?.selectedCells ?? 0) > 0, 'T087-PAINT-07 primary Visual selection has a distinct fill');
  assert.ok((visualRendered.viewport.lastPaintStats?.secondarySelectedCells ?? 0) > 0, 'T087-PAINT-08 secondary Visual selection has a distinct fill');
  visualRendered.setup.renderer.destroy();
}

async function testStaleColorAndReducedMotion(): Promise<void> {
  const fixture = makeFixture('normal');
  const stale = await render(fixture, motionPreview(fixture, { motionPreview: { ...motionPreview(fixture).motionPreview!, documentVersion: (fixture.snapshot.version as number) + 1 } }));
  observations.push({ fixture: 'E23-stale-document', stats: stale.viewport.lastPaintStats });
  assert.equal(stale.viewport.lastPaintStats?.trailCells, 0, 'T087-STALE-01 old preview after a document revision is rejected');
  assert.equal(stale.viewport.lastPaintStats?.rejectedStalePreview, true, 'T087-STALE-02 stale preview rejection is observable in the paint readback');
  stale.setup.renderer.destroy();

  const noColor = await render(fixture, motionPreview(fixture, { colorMode: 'no-color' }));
  observations.push({ fixture: 'E23-no-color', stats: noColor.viewport.lastPaintStats });
  assert.equal(noColor.viewport.lastPaintStats?.trailCells, 0, 'T087-NOCOLOR-01 decorative trail is disabled when colors cannot distinguish it');
  const spans = noColor.setup.captureSpans();
  const attributes = spans.lines.flatMap((line) => line.spans.map((span) => span.attributes));
  assert.ok(attributes.some((value) => (value & TextAttributes.UNDERLINE) !== 0), 'T087-NOCOLOR-02 operator/cursor distinction uses underline');
  assert.ok(attributes.some((value) => (value & TextAttributes.INVERSE) !== 0), 'T087-NOCOLOR-03 primary selection/cursor distinction uses reverse');
  noColor.setup.renderer.destroy();

  const reduced = await render(fixture, motionPreview(fixture, { reducedMotion: true, colorMode: 'ansi256' }));
  observations.push({ fixture: 'E23-reduced-motion-256', stats: reduced.viewport.lastPaintStats });
  assert.ok((reduced.viewport.lastPaintStats?.trailCells ?? 0) > 0, 'T087-REDUCED-01 reduced-motion mode keeps one static trail paint');
  assert.equal(reduced.viewport.lastPaintStats?.secondaryCursors, 1, 'T087-REDUCED-02 secondary cursor remains visible without animation');
  await reduced.setup.waitForVisualIdle({ maxFrames: 2, quietFrames: 1 });
  assert.equal(reduced.setup.renderer.getSchedulerState().hasScheduledRender, false, 'T087-IDLE-01 static trail leaves no continuous render loop');
  reduced.setup.renderer.destroy();

  const narrow = await render(fixture, motionPreview(fixture, { colorMode: 'ansi256' }), { width: 60, height: 18, ascii: true });
  assert.ok((narrow.viewport.lastPaintStats?.trailCells ?? 0) > 0, 'T087-NARROW-01 60x18 keeps trail and cursor paint readable');
  assert.equal(narrow.viewport.layout.sidebarVisible, false, 'T087-NARROW-02 narrow review hides the sidebar without changing the editor paint');
  narrow.setup.renderer.destroy();
}

async function testCurrentSearchContrast(): Promise<void> {
  const fixture = makeFixture('normal');
  const searchHighlight = { documentId: String(fixture.snapshot.id), documentVersion: Number(fixture.snapshot.version),
    ranges: [{ start: 1, end: 3 }, { start: 9, end: 10 }], current: { start: 9, end: 10 } };
  for (const [name, options] of [['light', {}], ['dark', { theme: DARK_WORKBENCH_THEME }]] as const) {
    const rendered = await render(fixture, { colorMode: 'truecolor', searchHighlight }, options);
    const spans = rendered.setup.captureSpans().lines.flatMap(line => line.spans);
    const other = spans.find(span => span.text.includes('lp'));
    const current = spans.find(span => span.text === 'b');
    assert.ok(other && current && !other.bg.equals(current.bg), `T087-SEARCH-CURRENT-${name} current match contrasts with other matches`);
    rendered.setup.renderer.destroy();
  }
  const monochrome = await render(fixture, { colorMode: 'no-color', searchHighlight });
  const current = monochrome.setup.captureSpans().lines.flatMap(line => line.spans).find(span => span.text === 'b');
  assert.ok(current && (current.attributes & TextAttributes.INVERSE) !== 0, 'T087-SEARCH-CURRENT-NOCOLOR current match uses reverse video');
  monochrome.setup.renderer.destroy();
}

await testLayersAndLifecycle();
await testStaleColorAndReducedMotion();
await testCurrentSearchContrast();
const artifactRoot = resolve(process.cwd(), '.artifacts/ui');
await mkdir(artifactRoot, { recursive: true });
await writeFile(resolve(artifactRoot, 't087-paint.json'), `${JSON.stringify({ fixtures: observations }, null, 2)}\n`, 'utf8');
console.log('T087 motion paint passed E23 equivalence, selection precedence, stale preview, no-color and reduced-motion fixtures');

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T087-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
