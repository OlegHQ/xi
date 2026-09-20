import { strict as assert } from 'node:assert';
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import type { WorkbenchTabSnapshot } from '../../packages/workbench/session/index';
import { SidebarController, type SidebarOutlineModelPort, type SidebarReadModel } from '../../packages/workbench/sidebar/index';
import {
  WorkbenchPointerRouter,
  type PointerControlEvent,
  type PointerExplorerPort,
  type PointerPickerModelPort,
  type PointerPickerPort,
  type PointerProblemsPort,
  type PointerSearchPort,
  type PointerWorkbenchEvent,
} from '../../packages/workbench/input/pointer-router';
import { WorkbenchRenderable, calculateWorkbenchLayout, computeSidebarTabLayout, computeTabLayout, type WorkbenchTheme } from '../../packages/ui/src/workbench';
import { createChromeSurfaceNode, createThemeBridge, mountSolidRoot } from '../../packages/ui/src/solid/composition';
import { parseColor } from '@opentui/core/renderer';
import { wireControllerPanels } from '../../apps/xi/src/wiring/pointer';

const VIEW_ID = id<ViewId>('SB-view');
const DOCUMENT_ID = id<DocumentId>('SB-document');

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'SB-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function makeWorkbench(): WorkbenchReadPort {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode('alpha\nbeta\ngamma'));
  assert.equal(opened.kind, 'editable', 'SB-DOC-01 fixture uses the document owner');
  if (opened.kind !== 'editable') throw new Error('SB-open');
  const snapshot: DocumentSnapshot = opened.document.snapshot();
  const primary = id<SelectionId>('SB-primary');
  const zero = asUtf16Offset(0);
  const one = asUtf16Offset(1);
  if (!zero.ok || !one.ok) throw new Error('SB-offset');
  const selections = createSelectionSet(snapshot, {
    primaryId: primary,
    selectionGeneration: 0,
    members: [{ id: primary, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: zero.value, after: one.value }, head: { kind: 'character', offset: zero.value, after: one.value } }],
  });
  if (!selections.ok) throw new Error(`SB-selection:${selections.error.kind}`);
  const view: WorkbenchViewSnapshot = {
    session: { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selections.value.selectionSet, mode: 'normal' },
    document: snapshot,
    selections: selections.value.selectionSet,
    scrollTop: 0,
    scrollLeft: 0,
  };
  const document: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) => expectedVersion === snapshot.version ? snapshot.slice(start, end) : { ok: false, error: { kind: 'stale-version' } },
  };
  return { activeViewId: VIEW_ID, readView: (viewId) => viewId === VIEW_ID ? view : undefined, readDocument: (viewId) => viewId === VIEW_ID ? document : undefined };
}

class FakeOutline implements SidebarOutlineModelPort {
  hasSymbols = false;
}

async function renderWithSidebar(sidebar: () => SidebarReadModel, ascii = false): Promise<{ readonly chars: string; readonly setup: Awaited<ReturnType<typeof createTestRenderer>> }> {
  const setup = await createTestRenderer({ width: 120, height: 30, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: makeWorkbench(), fileLabel: 'editor.ts', sidebar, ascii });
  setup.renderer.root.add(viewport);
  await mountSolidRoot(setup.renderer, [createChromeSurfaceNode({
    workbench: makeWorkbench(),
    theme: viewport.theme,
    fileLabel: 'editor.ts',
    ascii,
    showBottomPanel: false,
    sidebar,
  }, createThemeBridge(viewport.theme))]);
  await setup.renderOnce();
  return { chars: setup.captureCharFrame(), setup };
}

// T-SIDEBAR-TABS-01: default sections render with chevrons -- Files collapsed (▸) until the
// Explorer opens, Outline collapsed (▸) while its outline model has no symbols yet.
async function testSectionChevronsDefault(): Promise<void> {
  const controller = new SidebarController({ outline: new FakeOutline() });
  const { chars, setup } = await renderWithSidebar(() => controller.readModel());
  assert.match(chars, /▸ .*Files/u, 'T-SIDEBAR-TABS-01a Files renders collapsed with a right chevron until the Explorer opens');
  assert.match(chars, /▸ Outline/u, 'T-SIDEBAR-TABS-01b Outline renders collapsed with a right chevron while empty');
  assert.match(chars, /󰉋 Files/u, 'T-SIDEBAR-TABS-01c Files has its navigation icon');
  assert.match(chars, / Search/u, 'T-SIDEBAR-TABS-01d Search has its navigation icon');
  assert.match(chars, / Git/u, 'T-SIDEBAR-TABS-01e Git has its navigation icon');
  setup.renderer.destroy();
}

// T-SIDEBAR-TABS-02: once the outline model has symbols, the Outline section auto-expands
// (chevron flips), matching `SidebarController.refreshOutline`'s auto-toggle contract.
async function testSectionChevronsOutlineExpanded(): Promise<void> {
  const outline = new FakeOutline();
  outline.hasSymbols = true;
  const controller = new SidebarController({ outline });
  const { chars, setup } = await renderWithSidebar(() => controller.readModel());
  assert.match(chars, /▾ Outline/u, 'T-SIDEBAR-TABS-02 Outline expands with a down chevron once it has symbols');
  setup.renderer.destroy();
}

// T-SIDEBAR-TABS-03: the ASCII theme renders plain one-character chevrons ('v'/'>') instead
// of the Unicode triangles, matching the rest of the ASCII fallback policy.
async function testSectionChevronsAscii(): Promise<void> {
  const controller = new SidebarController({ outline: new FakeOutline() });
  controller.expandSection('files');
  const { chars, setup } = await renderWithSidebar(() => controller.readModel(), true);
  assert.match(chars, /v Files/u, 'T-SIDEBAR-TABS-03a ASCII Files chevron is a plain "v"');
  assert.match(chars, /> Outline/u, 'T-SIDEBAR-TABS-03b ASCII Outline chevron is a plain ">"');
  setup.renderer.destroy();
}

function tab(overrides: { readonly id: string; readonly label?: string; readonly dirty?: boolean; readonly preview?: boolean; readonly pinned?: boolean; readonly active?: boolean }): WorkbenchTabSnapshot {
  return {
    id: id<DocumentId>(overrides.id),
    label: overrides.label ?? overrides.id,
    dirty: overrides.dirty ?? false,
    preview: overrides.preview ?? false,
    pinned: overrides.pinned ?? false,
    active: overrides.active ?? false,
  };
}

// T-SIDEBAR-TABS-04: the tab strip renders the active tab bold-on-accent, a preview tab
// italic, and a dirty marker on a modified tab.
async function testTabBarAttributes(): Promise<void> {
  const tabs: readonly WorkbenchTabSnapshot[] = [
    tab({ id: 'a.ts', label: 'a.ts', pinned: true }),
    tab({ id: 'b.ts', label: 'b.ts', preview: true }),
    tab({ id: 'c.ts', label: 'c.ts', active: true, dirty: true }),
  ];
  const setup = await createTestRenderer({ width: 120, height: 30, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: makeWorkbench(), fileLabel: 'editor.ts', tabs: () => tabs });
  setup.renderer.root.add(viewport);
  const chromeTheme: WorkbenchTheme = { ...viewport.theme, styles: { 'ui.bufferline.active': { underline: { color: '#123456', style: 'double_line' } } } };
  await mountSolidRoot(setup.renderer, [createChromeSurfaceNode({
    workbench: makeWorkbench(),
    theme: chromeTheme,
    fileLabel: 'editor.ts',
    showBottomPanel: false,
    tabs: () => tabs,
  }, createThemeBridge(chromeTheme))]);
  await setup.renderOnce();
  const frame = setup.captureSpans();
  const headerRow = frame.lines[0];
  assert.ok(headerRow !== undefined, 'T-SIDEBAR-TABS-04 header row is painted');
  const spans = headerRow?.spans ?? [];
  const previewSpan = spans.find((span) => span.text.includes('b.ts'));
  const activeSpan = spans.find((span) => span.text.includes('c.ts'));
  const dirtySpan = spans.find((span) => span.text.includes('●'));
  assert.ok(previewSpan !== undefined, 'T-SIDEBAR-TABS-04a preview tab label is painted');
  assert.notEqual((previewSpan?.attributes ?? 0) & TextAttributes.ITALIC, 0, 'T-SIDEBAR-TABS-04b preview tab is italic');
  assert.ok(activeSpan !== undefined, 'T-SIDEBAR-TABS-04c active tab label is painted');
  assert.notEqual((activeSpan?.attributes ?? 0) & TextAttributes.BOLD, 0, 'T-SIDEBAR-TABS-04d active tab is bold');
  assert.deepEqual(activeSpan?.bg, parseColor(viewport.theme.accent), 'T-SIDEBAR-TABS-04e active tab paints an accent background');
  assert.ok(dirtySpan !== undefined, 'T-SIDEBAR-TABS-04f the dirty marker is painted for the modified tab');
  assert.ok(setup.renderer.currentRenderBuffer.buffers.attributes.slice(0, 120).some(attributes =>
    (attributes & TextAttributes.UNDERLINE_STYLE_DOUBLE) === TextAttributes.UNDERLINE_STYLE_DOUBLE), 'T-SIDEBAR-TABS-04g active tab keeps Helix underline shape');
  setup.renderer.destroy();
}

// T-SIDEBAR-TABS-05: overflow keeps the active tab visible and elides the rest with a single
// "…" marker once the strip no longer fits.
function testTabOverflowKeepsActiveVisible(): void {
  const many: WorkbenchTabSnapshot[] = [];
  for (let index = 0; index < 20; index += 1) many.push(tab({ id: `f${index}.ts`, label: `file-${index}.ts`, active: index === 15 }));
  const entries = computeTabLayout(many, 60);
  const activeEntry = entries.find((entry) => entry.tab?.id === many[15]?.id);
  assert.ok(activeEntry !== undefined, 'T-SIDEBAR-TABS-05a the active tab stays laid out under overflow');
  const totalWidth = entries.reduce((sum, entry) => sum + entry.width, 0);
  assert.ok(totalWidth <= 60, 'T-SIDEBAR-TABS-05b the laid-out strip never exceeds the available width');
  assert.ok(entries.some((entry) => entry.tab === undefined), 'T-SIDEBAR-TABS-05c an ellipsis marker replaces the elided tabs');
}

const noopPicker: PointerPickerPort = { activateEntry: async () => {} };
const noopPickerModel: PointerPickerModelPort = { model: { generation: 0, entries: [] }, select: () => true };
const noopExplorer: PointerExplorerPort = {
  handlePointerActivate: () => true,
  selectForContextMenu: () => undefined,
  activateContextMenuAction: () => {},
};
const noopSearch: PointerSearchPort = { readModel: () => undefined, setSelectedIndex: () => {}, openMatch: async () => {}, previewSelected: () => {}, focusQuery: () => {}, focusReplace: () => {}, toggleCollapsed: () => {} };
const noopProblems: PointerProblemsPort = { model: { generation: 0, all: [] }, setSelectedProblemIndex: () => {}, openProblem: async () => {} };

function sidebarSplitterEvent(action: PointerControlEvent['action'], firstSize: number, secondSize: number): PointerWorkbenchEvent {
  return {
    phase: action === 'begin' ? 'down' : action === 'commit' ? 'up' : 'move',
    viewId: 'view-1',
    cell: { row: 0, column: 0 },
    button: action === 'begin' ? 0 : null,
    control: { id: 'splitter:sidebar', kind: 'splitter', action, firstSize, secondSize, availableCells: 100 },
  };
}

// T-SIDEBAR-TABS-06: dragging the sidebar splitter through `WorkbenchPointerRouter` resizes
// `SidebarController`'s width, clamped to [22, 40] -- not the editor session's split tree.
function testSidebarSplitterDragChangesWidth(): void {
  const controller = new SidebarController({ outline: new FakeOutline(), initialWidth: 28 });
  const sessionResizeCalls: unknown[] = [];
  const router = new WorkbenchPointerRouter({
    session: { resizeSplit: (...args: unknown[]) => { sessionResizeCalls.push(args); return { ok: true }; } } as never,
    marker: () => {},
    clock: { monotonicMilliseconds: () => 0, schedule: () => ({ dispose: () => {} }), sleep: async () => ({ ok: true, value: undefined }) },
    pointerCapture: { dispatch: () => true, cancel: () => {}, dispose: () => {} } as never,
    contextMenu: { openAt: () => {} },
    picker: noopPicker,
    pickerModel: noopPickerModel,
    explorer: noopExplorer,
    search: noopSearch,
    problems: noopProblems,
    sidebar: controller,
  });

  assert.equal(router.handleControl(sidebarSplitterEvent('begin', 28, 72)), true);
  assert.equal(router.handleControl(sidebarSplitterEvent('move', 35, 65)), true);
  assert.equal(controller.width, 35, 'T-SIDEBAR-TABS-06a moving the splitter resizes the sidebar controller');
  assert.equal(router.handleControl(sidebarSplitterEvent('commit', 35, 65)), true);
  assert.equal(controller.width, 35, 'T-SIDEBAR-TABS-06b the width is committed');

  router.handleControl(sidebarSplitterEvent('begin', 35, 65));
  // 15 clears `WorkbenchPointerRouter`'s own generic 12-cell drag-gesture minimum (guarding
  // every splitter, editor panes included) but is still below the sidebar's own 22-cell
  // minimum, which `SidebarController.moveResize` clamps to.
  router.handleControl(sidebarSplitterEvent('move', 15, 85));
  assert.equal(controller.width, 22, 'T-SIDEBAR-TABS-06c dragging below the sidebar minimum clamps to 22');
  router.handleControl(sidebarSplitterEvent('move', 85, 15));
  assert.equal(controller.width, 40, 'T-SIDEBAR-TABS-06d dragging above the maximum clamps to 40');
  router.handleControl(sidebarSplitterEvent('commit', 85, 15));

  assert.equal(sessionResizeCalls.length, 0, 'T-SIDEBAR-TABS-06e the sidebar splitter never touches the editor split tree');
  router.dispose();
}

// T-SIDEBAR-TABS-07: `layout.sidebarWidth` follows the controller's width once one is
// supplied, replacing the terminal-width-derived default.
function testLayoutHonorsSidebarWidthOverride(): void {
  const withOverride = calculateWorkbenchLayout(160, 40, false, 26);
  assert.equal(withOverride.sidebarWidth, 26, 'T-SIDEBAR-TABS-07a the layout uses the controller width verbatim within bounds');
  const clampedLow = calculateWorkbenchLayout(160, 40, false, 10);
  assert.equal(clampedLow.sidebarWidth, 22, 'T-SIDEBAR-TABS-07b a too-small override is clamped to the 22-cell minimum');
  const clampedHigh = calculateWorkbenchLayout(160, 40, false, 90);
  assert.equal(clampedHigh.sidebarWidth, 40, 'T-SIDEBAR-TABS-07c a too-large override is clamped to the 40-cell maximum');
}

function testSidebarTabTargetsFillHeader(): void {
  const tabs = computeSidebarTabLayout(22);
  assert.deepEqual(tabs.map(tab => [tab.id, tab.x, tab.width]), [
    ['files', 0, 7], ['search', 7, 8], ['git', 15, 7],
  ], 'T-SIDEBAR-TABS-08a the narrow header gives Search enough room for its wider label');
  assert.equal(tabs.reduce((sum, tab) => sum + tab.width, 0), 22, 'T-SIDEBAR-TABS-08b the visible tabs fill the entire clickable header');
  for (let column = 0; column < 22; column += 1) {
    assert.equal(tabs.filter(tab => column >= tab.x && column < tab.x + tab.width).length, 1, `T-SIDEBAR-TABS-08c column ${column} belongs to exactly one visible tab`);
  }
}

/** Regression: Files (expanded) -> Search -> Git -> Files used to toggle the Files section
 * closed (its content was already hidden by the other panel), leaving the sidebar blank. */
function testFilesTabSwitchesBackFromOtherPanels(): void {
  const panels = new Map<string, { isOpen(): boolean; close(): void }>();
  const host = {
    registerPanel: (name: string, panel: { isOpen(): boolean; close(): void }) => { panels.set(name, panel); },
    closeAllPanels: (keep?: string) => { for (const [name, panel] of panels) if (name !== keep && panel.isOpen()) panel.close(); },
    notifySurfaceChange: () => {},
  };
  const feature = (name: string) => {
    let open = false;
    return { get isOpen() { return open; }, open: () => { host.closeAllPanels(name); open = true; }, close: () => { open = false; }, hide: () => { open = false; } };
  };
  const explorerFeature = feature('explorer');
  const searchFeature = feature('search');
  const pickerFeature = feature('picker');
  const picker = { get isOpen() { return pickerFeature.isOpen; }, mode: 'git', close: async () => { pickerFeature.close(); } };
  const gitPanelFeature = feature('git');
  const gitDiffFeature = feature('git-diff');
  const sidebarController = new SidebarController({
    outline: { hasSymbols: false },
    panelState: () => (searchFeature.isOpen ? 'search' : gitPanelFeature.isOpen ? 'git' : 'files'),
  });
  const controls = new Map<string, () => void>();
  const controllers = {
    pointerRouter: { publishControls: (list: readonly { id: string; activate: () => void }[]) => { for (const control of list) controls.set(control.id, control.activate); } },
    host, sidebarController, explorerFeature, searchFeature, gitPanelFeature, picker, gitDiffFeature,
    problemsFeature: { isProblemsOpen: false, isOutputOpen: false },
    overlayFeature: { isOutlineOpen: false, isHoverOpen: false },
    completionFeature: { isCompletionOpen: false, isSignatureOpen: false },
    directoryDraftController: { isReviewOpen: false },
    workbench: {},
    ensureGitAndOpenPicker: async () => { pickerFeature.open(); },
  };
  wireControllerPanels(controllers as unknown as Parameters<typeof wireControllerPanels>[0]);
  const click = (id: string): void => { const activate = controls.get(id); assert.ok(activate, `SB-TAB-${id}`); activate(); };
  click('sidebar.files');
  assert.equal(sidebarController.readModel().panel, 'files');
  assert.ok(explorerFeature.isOpen, 'SB-TAB-01 Files opens the explorer');
  click('sidebar.search');
  assert.equal(sidebarController.readModel().panel, 'search');
  click('sidebar.git');
  assert.equal(sidebarController.readModel().panel, 'git');
  assert.ok(!searchFeature.isOpen, 'SB-TAB-02 Git closes Search');
  click('sidebar.files');
  assert.equal(sidebarController.readModel().panel, 'files', 'SB-TAB-03 Files closes the Git picker');
  assert.ok(explorerFeature.isOpen, 'SB-TAB-03 Files reopens the explorer instead of collapsing it');
  assert.equal(sidebarController.readModel().sections[0]?.expanded, true, 'SB-TAB-03 Files section stays expanded');
  click('sidebar.files');
  assert.ok(!explorerFeature.isOpen, 'SB-TAB-04 the chevron still toggles while on the Files panel');
}

await testSectionChevronsDefault();
testFilesTabSwitchesBackFromOtherPanels();
await testSectionChevronsOutlineExpanded();
await testSectionChevronsAscii();
await testTabBarAttributes();
testTabOverflowKeepsActiveVisible();
testSidebarSplitterDragChangesWidth();
testLayoutHonorsSidebarWidthOverride();
testSidebarTabTargetsFillHeader();
console.log('T-SIDEBAR-TABS sidebar/tab chrome passed section-chevron, files-tab-switchback, outline auto-expand, ASCII fallback, tab-attribute, overflow, splitter-drag and layout-override fixtures');
