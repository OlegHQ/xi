import {
  RGBA,
  Renderable,
  MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  parseColor,
} from '@opentui/core/renderer';
import type {
  WorkbenchLayoutRead,
  WorkbenchReadPort,
  WorkbenchSplitSnapshot,
  WorkbenchViewSnapshot,
} from '../../workbench/src/index.ts';
import type { SidebarReadModel, WorkbenchTabSnapshot } from '../../workbench/src/entrypoints/launch';
import { ComparisonEditor, type ComparisonReadPort, type ComparisonPaint } from '../git/editor';
import { resolveScrollAnchor, ViewportLayout, type CellHitTarget, type ProjectedSelection, type ViewportAnchor, type VisibleFrame } from '../../layout/src/index';
import type { SyntaxRead, SyntaxReadPort, SyntaxSpan } from '../../contracts/src/index';
import {
  paintEditorFrame,
  type EditorPresentationRead,
  type EditorPresentationReadPort,
  type MotionPaintStats,
  type SyntaxFallbackRow,
} from '../editor/motion-paint';
import {
  resolveMotionPaintTokens,
  type EditorColorMode,
  type MotionTrailMode,
} from '../theme/motion-tokens';

export { LIGHT_WORKBENCH_THEME, ASCII_WORKBENCH_THEME, DARK_WORKBENCH_THEME, BUILTIN_WORKBENCH_THEMES, helixThemeStyle, type HelixThemeStyle, type ThemeColor, type WorkbenchTheme } from '../theme/workbench-themes';
export { helixTextAttributes, helixThemeColor, themeColor } from '../theme/color-input';
import { LIGHT_WORKBENCH_THEME, ASCII_WORKBENCH_THEME, DARK_WORKBENCH_THEME, type WorkbenchTheme } from '../theme/workbench-themes';
import { themeColor } from '../theme/color-input';

export interface WorkbenchLayout {
  readonly compact: boolean;
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly editorX: number;
  readonly editorWidth: number;
  readonly editorTop: number;
  readonly editorHeight: number;
  readonly bottomTop: number;
  readonly bottomHeight: number;
  readonly statusRow: number;
}

/** Normalized editor pointer coordinates; semantic placement stays in Vim. */
export interface WorkbenchPointerEvent {
  readonly phase: 'down' | 'move' | 'up' | 'wheel';
  readonly viewId: string;
  readonly cell: { readonly row: number; readonly column: number };
  /** Text target copied from the immutable frame hit map; absent for wheel events. */
  readonly target?: {
    readonly lineIndex: number;
    readonly offset: number;
    readonly displayCellColumn: number;
    readonly virtualCell: number;
    readonly cellPart: 'glyph' | 'wide-continuation' | 'tab-fill' | 'clipped-glyph' | 'padding';
  };
  /** Stable workbench control identity; editor text targets and controls are exclusive. */
  readonly control?: {
    readonly id: string;
    readonly viewId?: string;
    readonly kind: 'tree' | 'tab' | 'tab-close' | 'picker' | 'button' | 'splitter';
    readonly action: 'activate' | 'begin' | 'move' | 'commit';
    readonly axis?: 'horizontal' | 'vertical';
    readonly firstSize?: number;
    readonly secondSize?: number;
    readonly availableCells?: number;
  };
  readonly button: number | null;
  readonly modifiers: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean };
  readonly wheelDelta: number;
  readonly frameId: number;
  readonly viewportHeight: number;
  /** Monotonic capture time (`performance.now()`), taken here at the platform-facing edge --
   * mirrors `packages/vim/pointer`'s `PointerEvent.timestampMilliseconds`. */
  readonly timestampMilliseconds: number;
}

export interface WorkbenchRenderableOptions extends RenderableOptions<WorkbenchRenderable> {
  readonly comparison?: ComparisonReadPort;
  readonly workbench: WorkbenchReadPort;
  readonly theme?: WorkbenchTheme;
  readonly ascii?: boolean;
  readonly fileLabel?: string;
  /** Read port for the current Git branch, polled once per render (like the rest of the
   * status text); returns `undefined` outside a Git workspace or before the first status
   * refresh. */
  readonly gitBranch?: () => string | undefined;
  readonly showBottomPanel?: boolean;
  /** Live sidebar section/width read model (`SidebarController.readModel()`); omitted keeps
   * the legacy static "Files  Search  Git" sidebar header for callers with no controller. */
  readonly sidebar?: () => SidebarReadModel;
  /** Live buffer tab strip (`WorkbenchSession.readTabs()`); omitted keeps the legacy single
   * `<fileLabel> ●` header. */
  readonly tabs?: (viewId?: string) => readonly WorkbenchTabSnapshot[];
  /** Optional immutable presentation read model supplied by the workbench. */
  readonly presentation?: EditorPresentationReadPort;
  /** Optional read-only syntax boundary; painted only when its version matches the frame's. */
  readonly syntax?: SyntaxReadPort;
  readonly motionTrail?: MotionTrailMode;
  readonly reducedMotion?: boolean;
  readonly colorMode?: EditorColorMode;
  readonly onPointer?: (event: WorkbenchPointerEvent) => boolean;
  readonly onPointerCancel?: (reason: 'resize' | 'dispose' | 'escape' | 'suspend') => void;
  /**
   * Called after a render moves a view's cursor-follow scroll anchor, so the
   * composition root can persist it back through `WorkbenchSession.setViewScroll`
   * (the UI layer has no write access to session state). Not calling this back
   * only loses persistence across resize/reopen; on-screen scrolling still works
   * because the renderable keeps its own last-anchor cache.
   */
  readonly onViewportAnchorChange?: (viewId: string, scrollTop: number, scrollLeft: number) => void;
  /** Reported once per view whenever its laid-out row count changes (resize, split, panel). */
  readonly onViewportSizeChange?: (viewId: string, heightCells: number) => void;
}

export interface WorkbenchFrameRead {
  readonly layout: WorkbenchLayout;
  readonly frame: VisibleFrame | undefined;
  readonly view: WorkbenchViewSnapshot | undefined;
  readonly paint?: MotionPaintStats;
}

/** A syntax read plus the row snapshot it colored the last time it was current for a
 * frame; see `WorkbenchRenderable#lastCurrentSyntax`/`SyntaxFallbackRow`. */
interface CurrentSyntaxSnapshot {
  readonly read: SyntaxRead;
  readonly rows: readonly SyntaxFallbackRow[];
  /** Frozen copy of the spans actually used to paint each row (indexed like `rows`) the
   * last time this read was current, so a later frame can detect a coloring change by
   * comparing against what was really painted instead of re-querying the live (and
   * possibly since-filled) read -- see `calculatePaintRanges`'s syntax-diff branch. */
  readonly spans: readonly (readonly SyntaxSpan[])[];
}

/** `syntax` is current for `frame` iff its `documentVersion` matches. */
function syntaxFallbackRowsFor(current: CurrentSyntaxSnapshot | undefined, syntaxRead: SyntaxRead | undefined): readonly SyntaxFallbackRow[] | undefined {
  return current !== undefined && syntaxRead !== undefined && current.read === syntaxRead ? current.rows : undefined;
}

function snapshotSyntaxRowsIfCurrent(
  frame: VisibleFrame,
  syntaxRead: SyntaxRead | undefined,
  previous: CurrentSyntaxSnapshot | undefined,
): CurrentSyntaxSnapshot | undefined {
  if (syntaxRead === undefined || (syntaxRead.documentVersion as unknown as number) !== (frame.identity.documentVersion as unknown as number)) return undefined;
  // Reused only when it's a snapshot of this exact read: `spansInRange` is called again
  // for any row whose own start/end/text shifted, but an unchanged row's already-sliced
  // spans are reused by reference instead of re-querying the read every render (this ran
  // for every visible row on every frame regardless of whether anything changed).
  const reusable = previous?.read === syntaxRead ? previous : undefined;
  const rows = frame.rows.map((row) => ({ startOffset: row.startOffset as number | null, endOffset: row.endOffset as number | null, text: row.text }));
  const spans = frame.rows.map((row, index) => {
    const start = row.startOffset as number | null;
    const end = row.endOffset as number | null;
    const previousRow = reusable?.rows[index];
    if (previousRow !== undefined && previousRow.startOffset === start && previousRow.endOffset === end && previousRow.text === row.text) {
      return reusable?.spans[index] ?? [];
    }
    return start === null || end === null || end <= start ? [] : syntaxRead.spansInRange(start, end).slice();
  });
  return { read: syntaxRead, rows, spans };
}

interface PaneRect {
  readonly viewId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SplitterRect {
  readonly id: string;
  readonly axis: 'horizontal' | 'vertical';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly availableCells: number;
  readonly firstSize: number;
  readonly secondSize: number;
}

/** Calculate shell geometry without owning document or selection state. `sidebarWidthOverride`
 * -- the resizable `SidebarController`'s current width -- replaces the width formula below
 * when supplied (clamped to leave the editor at least 20 cells); omitting it keeps the old
 * terminal-width-derived default for callers with no sidebar controller (tests, `[No Name]`
 * launches before one exists). */
// Keep the pure geometry calculation cheap for the viewport and Solid chrome, which both read
// the same terminal-cell layout during a frame.
let lastWorkbenchLayout: { readonly width: number; readonly height: number; readonly showBottomPanel: boolean; readonly sidebarWidthOverride: number | undefined; readonly showSidebar: boolean; readonly value: WorkbenchLayout } | undefined;

export function calculateWorkbenchLayout(width: number, height: number, showBottomPanel = false, sidebarWidthOverride?: number, showSidebar = true): WorkbenchLayout {
  if (lastWorkbenchLayout !== undefined && lastWorkbenchLayout.width === width && lastWorkbenchLayout.height === height
    && lastWorkbenchLayout.showBottomPanel === showBottomPanel && lastWorkbenchLayout.sidebarWidthOverride === sidebarWidthOverride && lastWorkbenchLayout.showSidebar === showSidebar) {
    return lastWorkbenchLayout.value;
  }
  const safeWidth = Math.max(0, Math.trunc(width));
  const safeHeight = Math.max(0, Math.trunc(height));
  const compact = safeWidth < 40 || safeHeight < 10;
  const sidebarVisible = showSidebar && !compact && safeWidth >= 100;
  const sidebarWidth = sidebarVisible
    ? sidebarWidthOverride !== undefined
      ? Math.max(22, Math.min(Math.min(40, safeWidth - 20), Math.trunc(sidebarWidthOverride)))
      : Math.min(Math.max(22, Math.floor(safeWidth * 0.25)), Math.min(40, Math.floor(safeWidth * 0.35)))
    : 0;
  const editorX = sidebarVisible ? sidebarWidth + 1 : 0;
  const editorWidth = Math.max(1, safeWidth - editorX);
  const statusRow = Math.max(0, safeHeight - 1);
  const bottomHeight = !compact && showBottomPanel && safeHeight >= 16 ? Math.min(10, Math.max(3, Math.floor(safeHeight * 0.25))) : 0;
  const bottomTop = Math.max(0, statusRow - bottomHeight);
  const editorTop = compact ? 0 : 1;
  const editorHeight = Math.max(1, bottomTop - editorTop);
  const value = Object.freeze({ compact, sidebarVisible, sidebarWidth, editorX, editorWidth, editorTop, editorHeight, bottomTop, bottomHeight, statusRow });
  lastWorkbenchLayout = { width, height, showBottomPanel, sidebarWidthOverride, showSidebar, value };
  return value;
}

export interface SidebarSectionLayout {
  /** Row 1, below the Files/Search/Git tab bar -- the `▾ Files` chevron header. */
  readonly filesHeaderRow: number;
  readonly filesContentTop: number;
  /** 0 when Files is collapsed: no inline tree/explorer surface is shown. */
  readonly filesContentHeight: number;
  /** Directly under Files' content (or under its header, when Files is collapsed). */
  readonly outlineHeaderRow: number;
  readonly outlineContentTop: number;
  /** 0 when Outline is collapsed. */
  readonly outlineContentHeight: number;
}

export type SidebarTabId = 'files' | 'search' | 'git';

export interface SidebarTabLayout {
  readonly id: SidebarTabId;
  readonly x: number;
  readonly width: number;
}

/** Three full-cell sidebar targets. Search receives the odd cell first because its label is
 * widest; the same rectangles are used by Solid presentation and native pointer routing. */
export function computeSidebarTabLayout(width: number): readonly SidebarTabLayout[] {
  const safeWidth = Math.max(0, Math.trunc(width));
  const base = Math.floor(safeWidth / 3);
  const remainder = safeWidth % 3;
  const widths = [base + (remainder > 1 ? 1 : 0), base + (remainder > 0 ? 1 : 0), base] as const;
  return Object.freeze([
    Object.freeze({ id: 'files', x: 0, width: widths[0] }),
    Object.freeze({ id: 'search', x: widths[0], width: widths[1] }),
    Object.freeze({ id: 'git', x: widths[0] + widths[1], width: widths[2] }),
  ]);
}

/** Row bounds for the sidebar's two inline sections, shared by Solid chrome and the
 * composition root (Explorer/Outline surface placement) so both agree on
 * exactly where each section's content lives. Files takes all remaining rows when Outline is
 * collapsed; both expanded split 60/40 with a 3-row floor each (docs/plan sidebar contract).
 * `totalRows` is the sidebar's usable row count above the status row -- callers pass
 * `geometry.statusRow`, not the full terminal height, so inline content never gets bottom-row painted over by the status bar. */
export function computeSidebarSectionLayout(sidebar: SidebarReadModel, totalRows: number): SidebarSectionLayout {
  // Only the Files tab hosts the inline sections; Search/Git own the whole column below row 0.
  const filesExpanded = sidebar.panel === 'files' && (sidebar.sections.find((section) => section.id === 'files')?.expanded ?? false);
  const outlineExpanded = sidebar.panel === 'files' && (sidebar.sections.find((section) => section.id === 'outline')?.expanded ?? false);
  // Row 0 is the Files/Search/Git tab bar; the two section headers need one row each.
  const available = Math.max(0, Math.trunc(totalRows) - 3);
  let filesContentHeight = 0;
  let outlineContentHeight = 0;
  if (filesExpanded && outlineExpanded) {
    if (available >= 6) {
      filesContentHeight = Math.min(available - 3, Math.max(3, Math.round(available * 0.6)));
      outlineContentHeight = available - filesContentHeight;
    } else {
      // Too little room to give both sections their 3-row floor: Files (the primary section)
      // keeps whatever is left; Outline's header still shows but with no content rows.
      filesContentHeight = available;
    }
  } else if (filesExpanded) {
    filesContentHeight = available;
  } else if (outlineExpanded) {
    outlineContentHeight = available;
  }
  const filesContentTop = 2;
  const outlineHeaderRow = filesContentTop + filesContentHeight;
  const outlineContentTop = outlineHeaderRow + 1;
  return Object.freeze({ filesHeaderRow: 1, filesContentTop, filesContentHeight, outlineHeaderRow, outlineContentTop, outlineContentHeight });
}

/** A document-backed OpenTUI shell for the first Xi workbench surface. */
export class WorkbenchRenderable extends Renderable {
  readonly #comparison: ComparisonReadPort | undefined;
  readonly #comparisonEditor = new ComparisonEditor();
  #comparisonPaint: ComparisonPaint | undefined;
  readonly #workbench: WorkbenchReadPort;
  #theme: WorkbenchTheme;
  readonly #ascii: boolean;
  readonly #showBottomPanel: boolean;
  readonly #presentation: EditorPresentationReadPort | undefined;
  readonly #sidebar: (() => SidebarReadModel) | undefined;
  readonly #tabs: ((viewId?: string) => readonly WorkbenchTabSnapshot[]) | undefined;
  #sidebarSplitterCapture = false;
  readonly #syntax: SyntaxReadPort | undefined;
  readonly #motionTrail: MotionTrailMode;
  readonly #reducedMotion: boolean;
  readonly #colorMode: EditorColorMode;
  readonly #onPointer: ((event: WorkbenchPointerEvent) => boolean) | undefined;
  readonly #onPointerCancel: ((reason: 'resize' | 'dispose' | 'escape' | 'suspend') => void) | undefined;
  readonly #onViewportAnchorChange: ((viewId: string, scrollTop: number, scrollLeft: number) => void) | undefined;
  readonly #onViewportSizeChange: ((viewId: string, heightCells: number) => void) | undefined;
  readonly #reportedViewportHeights = new Map<string, number>();
  /** Anchors resolved by `syncAnchors()` ahead of the frame; `renderSelf`/`renderSplit`
   * only read this, never resolve or report an anchor themselves. Keyed by viewId. */
  readonly #resolvedAnchors = new Map<string, { readonly anchor: ViewportAnchor; readonly scrollLeft: number }>();
  /** Last resolver inputs per view so `refresh()` + the pre-render sync do not re-resolve unchanged state. */
  readonly #anchorMemo = new Map<string, { readonly document: unknown; readonly selections: unknown; readonly top: number; readonly left: number; readonly width: number; readonly height: number; readonly result: { readonly anchor: ViewportAnchor; readonly scrollLeft: number } }>();
  readonly #layout = new ViewportLayout();
  readonly #paneLayouts = new Map<string, ViewportLayout>();
  readonly #paneRects = new Map<string, PaneRect>();
  readonly #paneFrames = new Map<string, VisibleFrame>();
  readonly #splitters = new Map<string, SplitterRect>();
  /** Per-pane previous frame/presentation, so split panes can paint only their
   * damaged rows instead of a full repaint every frame (mirrors the single-view
   * `#lastFrame`/`#lastPresentation`). */
  readonly #paneLastFrames = new Map<string, WorkbenchFrameRead>();
  readonly #paneLastPresentations = new Map<string, EditorPresentationRead | undefined>();
  readonly #paneLastSyntaxReads = new Map<string, SyntaxRead | undefined>();
  /** Per-pane last-known-current syntax snapshot; see `#lastCurrentSyntax`. */
  readonly #paneLastCurrentSyntax = new Map<string, CurrentSyntaxSnapshot>();
  /** `resolveMotionPaintTokens` only depends on the theme; recomputed in `setTheme`
   * instead of once per paint range per frame. */
  #motionPaintTokens: ReturnType<typeof resolveMotionPaintTokens>;
  /** `layout` only depends on size and `#showBottomPanel` (constant); avoid recomputing it
   * from every `renderSelf`/pointer-hit-test access at up to 30x/s while idle. */
  #cachedLayout: { readonly width: number; readonly height: number; readonly sidebarWidth: number | undefined; readonly showSidebar: boolean; readonly value: WorkbenchLayout } | undefined;
  #splitterCapture: string | undefined;
  #tabPress: { readonly control: NonNullable<WorkbenchPointerEvent['control']>; readonly x: number; readonly y: number; dragging: boolean } | undefined;
  #background: RGBA;
  #surface: RGBA;
  #foreground: RGBA;
  #muted: RGBA;
  #border: RGBA;
  #accent: RGBA;
  #lastViewportSize: { readonly width: number; readonly height: number; readonly editorWidth: number; readonly editorHeight: number } | undefined;
  #lastPaintedSplitRoot: WorkbenchLayoutRead['split']['root'] | undefined;
  #lastFrame: WorkbenchFrameRead | undefined;
  #lastPresentation: EditorPresentationRead | undefined;
  #lastSyntaxRead: SyntaxRead | undefined;
  /** The active view's rows the last time `#lastSyntaxRead` (or its predecessor) was
   * confirmed current, so a still-stale read can keep coloring unaffected rows
   * instead of painting the whole viewport plain for one frame; see
   * `SyntaxFallbackRow` and `rowSyntaxCursor` in editor/motion-paint.ts. */
  #lastCurrentSyntax: CurrentSyntaxSnapshot | undefined;
  #lastPaintStats: MotionPaintStats | undefined;
  #pointerFrameId: number | undefined;
  /** Screen cell (0-based) of the active view's primary cursor as of the last paint, for
   * anchoring popups (hover, completion, signature) next to it. */
  #cursorCell: { readonly x: number; readonly y: number } | undefined;

  constructor(ctx: RenderContext, options: WorkbenchRenderableOptions) {
    const renderOptions: RenderableOptions<WorkbenchRenderable> = {
      width: options.width ?? '100%',
      height: options.height ?? '100%',
      buffered: options.buffered ?? true,
      ...(options.id === undefined ? {} : { id: options.id }),
    };
    super(ctx, renderOptions);
    this.#workbench = options.workbench;
    this.#comparison = options.comparison;
    this.#ascii = options.ascii ?? false;
    this.#theme = options.theme ?? (this.#ascii ? ASCII_WORKBENCH_THEME : LIGHT_WORKBENCH_THEME);
    this.#showBottomPanel = options.showBottomPanel ?? false;
    this.#presentation = options.presentation;
    this.#sidebar = options.sidebar;
    this.#tabs = options.tabs;
    this.#syntax = options.syntax;
    this.#motionTrail = options.motionTrail ?? 'off';
    this.#reducedMotion = options.reducedMotion ?? true;
    this.#colorMode = options.colorMode ?? 'truecolor';
    this.#onPointer = options.onPointer;
    this.#onPointerCancel = options.onPointerCancel;
    this.#onViewportAnchorChange = options.onViewportAnchorChange;
    this.#onViewportSizeChange = options.onViewportSizeChange;
    this.#background = parseColor(themeColor(this.#theme.background, 'bg'));
    this.#surface = parseColor(themeColor(this.#theme.surface, 'bg'));
    this.#foreground = parseColor(themeColor(this.#theme.foreground));
    this.#muted = parseColor(themeColor(this.#theme.muted));
    this.#border = parseColor(themeColor(this.#theme.border));
    this.#accent = parseColor(themeColor(this.#theme.accent));
    this.#motionPaintTokens = resolveMotionPaintTokens(this.#theme);
    this.onMouse = (event: MouseEvent): void => {
      if (this.#onPointer === undefined || event.target !== this) return;
      const phase = pointerPhase(event.type);
      if (phase === undefined) return;
      const geometry = this.layout;
      const comparison = this.#comparisonPaint;
      if (comparison !== undefined && event.y >= geometry.editorTop && event.y < geometry.editorTop + geometry.editorHeight && event.x >= geometry.editorX) {
        if (phase === 'wheel') {
          this.#comparison?.onPointer(event.scroll === undefined ? 0 : (event.scroll.direction === 'up' ? -event.scroll.delta : event.scroll.delta));
          event.preventDefault();
          this.refresh();
          return;
        }
        const row = event.y - comparison.y;
        const column = event.x - comparison.x;
        const frame = comparison.frame;
        const target = frame?.rows[row]?.cells[column]?.target;
        if (target?.kind !== 'text' || frame === undefined) return;
        const frameId = phase === 'down' ? Number(frame.identity.frameId) : this.#pointerFrameId ?? Number(frame.identity.frameId);
        const handled = this.#onPointer({ phase, viewId: String(frame.identity.viewId), cell: { row, column: Math.max(0, column - comparison.gutter) }, target: pointerTarget(target)!, button: event.button, modifiers: { ...event.modifiers, meta: false }, wheelDelta: 0, frameId, viewportHeight: comparison.height, timestampMilliseconds: performance.now() });
        if (phase === 'down' && handled) this.#pointerFrameId = frameId;
        if (phase === 'up') this.#pointerFrameId = undefined;
        if (handled) { event.preventDefault(); this.refresh(); }
        return;
      }
      const pane = this.paneAt(event.x, event.y);
      let frameColumn = pane === undefined ? event.x - geometry.editorX : event.x - pane.x;
      const activeViewForGutter = this.#workbench.readView((pane?.viewId ?? this.#workbench.activeViewId) as import('../../contracts/src/index').ViewId);
      const gutter = gutterWidthFor(activeViewForGutter?.document.lineCount ?? 0);
      let column = frameColumn - gutter;
      let row = pane === undefined ? event.y - geometry.editorTop : event.y - pane.y;
      const insideEditor = pane === undefined
        ? column >= 0 && row >= 0 && column < Math.max(1, geometry.editorWidth - gutter) && row < geometry.editorHeight
        : column >= 0 && row >= 0 && column < Math.max(1, pane.width - gutter) && row < pane.height;
      const activeViewId = pane?.viewId ?? this.#workbench.activeViewId;
      if (activeViewId === undefined) return;
      const currentFrame = pane === undefined ? this.#lastFrame?.frame : this.#paneFrames.get(String(activeViewId));
      const currentFrameId = Number(currentFrame?.identity.frameId ?? 0);
      const dispatchFrameId = phase === 'down' ? currentFrameId : this.#pointerFrameId ?? currentFrameId;
      let chromeControl = phase === 'wheel' || this.#splitterCapture !== undefined || this.#sidebarSplitterCapture ? undefined : this.#chromeControlAt(event.x, event.y, geometry);
      if (phase === 'down' && (chromeControl?.kind === 'tab' || chromeControl?.kind === 'tab-close')) {
        const splitter = [...this.#splitters.values()].find(candidate => candidate.axis === 'horizontal'
          && event.x >= candidate.x && event.x < candidate.x + candidate.width && event.y === candidate.y);
        if (splitter !== undefined) this.#tabPress = { control: chromeControl, x: event.x, y: event.y, dragging: false };
      }
      const tabPress = this.#tabPress;
      let splitterControl: WorkbenchPointerEvent['control'] | undefined;
      if (tabPress !== undefined && phase === 'move' && (event.x !== tabPress.x || event.y !== tabPress.y)) {
        tabPress.dragging = true;
        chromeControl = undefined;
        splitterControl = this.splitterControlAt(
          this.#splitterCapture === undefined ? tabPress.x : event.x,
          this.#splitterCapture === undefined ? tabPress.y : event.y,
          this.#splitterCapture === undefined ? 'down' : 'move',
        );
      } else if (tabPress?.dragging === true && phase === 'up') {
        chromeControl = undefined;
        splitterControl = this.splitterControlAt(event.x, event.y, 'up');
      } else if (tabPress !== undefined && phase === 'up') {
        chromeControl = tabPress.control;
      }
      splitterControl ??= phase === 'wheel' || chromeControl !== undefined ? undefined : this.splitterControlAt(event.x, event.y, phase) ?? this.#sidebarSplitterControlAt(event.x, event.y, phase);
      const control = phase === 'wheel' ? undefined : chromeControl ?? splitterControl ?? workbenchControlAt(geometry, event.x, event.y);
      if (phase === 'up') this.#tabPress = undefined;
      // A drag gesture already captured by this pointer (`#pointerFrameId` set) must keep
      // receiving 'move'/'up' even when the pointer strays into the gutter, past the last
      // shaped row/line-end, or below end-of-file (still inside the viewport, but over a
      // `kind: 'filler'` row with no text target), so the gesture controller always gets
      // the head update and the eventual release instead of leaving the selection stuck
      // mid-drag.
      const draggingCapture = this.#pointerFrameId !== undefined && (phase === 'move' || phase === 'up');
      if (phase !== 'wheel' && !insideEditor && control === undefined && !draggingCapture) return;
      if (draggingCapture) {
        const rows = currentFrame?.rows ?? [];
        let firstTextRow = -1;
        let lastTextRow = -1;
        for (let index = 0; index < rows.length; index += 1) {
          if (rows[index]?.kind === 'text') {
            if (firstTextRow < 0) firstTextRow = index;
            lastTextRow = index;
          }
        }
        row = lastTextRow >= 0 ? Math.min(Math.max(row, firstTextRow), lastTextRow) : Math.max(0, row);
        const lineLength = rows[row]?.text.length ?? 0;
        column = Math.min(Math.max(0, column), lineLength);
        frameColumn = column + gutter;
      }
      const layout = pane === undefined ? this.#layout : this.#paneLayouts.get(String(activeViewId));
      const hit = phase === 'wheel' || layout === undefined
        ? undefined
        : layout.hitTest(currentFrameId as import('../../layout/src/index').LayoutFrameId, { row, column: frameColumn });
      const target = hit?.ok === true && hit.value.target.kind === 'text' ? pointerTarget(hit.value.target) : undefined;
      if (phase !== 'wheel' && target === undefined && control === undefined && !draggingCapture) return;
      const handled = this.#onPointer({
        phase,
        viewId: String(activeViewId),
        cell: { row: Math.max(0, row), column: Math.max(0, column) },
        ...(target === undefined ? {} : { target }),
        ...(control === undefined ? {} : { control }),
        button: phase === 'wheel' ? null : event.button,
        modifiers: { shift: event.modifiers.shift, alt: event.modifiers.alt, ctrl: event.modifiers.ctrl, meta: false },
        wheelDelta: event.scroll === undefined ? 0 : (event.scroll.direction === 'up' || event.scroll.direction === 'left' ? -event.scroll.delta : event.scroll.delta),
        frameId: dispatchFrameId,
        viewportHeight: pane?.height ?? geometry.editorHeight,
        timestampMilliseconds: performance.now(),
      });
      if (handled) {
        event.preventDefault();
        if (phase === 'down') this.#pointerFrameId = dispatchFrameId;
        else if (phase === 'up') this.#pointerFrameId = undefined;
        if (phase !== 'down') this.refresh();
      }
    };
    this.requestRender();
  }

  /** Forward pointer events received by the declarative chrome to the viewport's existing
   * semantic hit testing and pointer router. */
  forwardPointerEvent(event: MouseEvent): void {
    this.processMouseEvent(new MouseEvent(this, event));
  }

  get layout(): WorkbenchLayout {
    const sidebar = this.#sidebar?.();
    const sidebarWidth = sidebar?.width;
    const showSidebar = sidebar?.visible !== false;
    const cached = this.#cachedLayout;
    if (cached !== undefined && cached.width === this.width && cached.height === this.height && cached.sidebarWidth === sidebarWidth && cached.showSidebar === showSidebar) return cached.value;
    const value = calculateWorkbenchLayout(this.width, this.height, this.#showBottomPanel, sidebarWidth, showSidebar);
    this.#cachedLayout = { width: this.width, height: this.height, sidebarWidth, showSidebar, value };
    return value;
  }
  get tabStrips() { return this.getTabStrips(this.width, this.height); }
  getTabStrips(width: number, height: number): readonly { readonly viewId: string; readonly x: number; readonly y: number; readonly width: number }[] {
    const sidebar = this.#sidebar?.();
    const geometry = calculateWorkbenchLayout(width, height, this.#showBottomPanel, sidebar?.width, sidebar?.visible !== false);
    const layoutRead = this.#workbench.readLayout?.();
    if (layoutRead?.split.root?.kind === 'split') return this.#collectPanes(geometry, layoutRead).panes.map(pane => ({ viewId: pane.viewId, x: pane.x, y: pane.y - 1, width: pane.width }));
    return [{ viewId: String(this.#workbench.activeViewId ?? ''), x: geometry.editorX, y: 0, width: geometry.editorWidth }];
  }
  get lastFrame(): WorkbenchFrameRead | undefined { return this.#lastFrame; }
  get cursorCell(): { readonly x: number; readonly y: number } | undefined { return this.#cursorCell; }
  get lastPaintStats(): MotionPaintStats | undefined { return this.#lastPaintStats; }
  /** State changed: resolve cursor-follow anchors (memoized per view state) and mark for paint. */
  refresh(): void { this.syncAnchors(); this.markDirty(); }
  get theme(): WorkbenchTheme { return this.#theme; }
  /** Apply a new theme immediately, live -- used for the theme picker's preview/cancel/commit
   * flow. Every color the renderer paints with is cached from `#theme` at construction time
   * only; this reassigns those same cached fields and requests one fresh frame. */
  setTheme(theme: WorkbenchTheme): void {
    this.#theme = theme;
    this.#background = parseColor(themeColor(theme.background, 'bg'));
    this.#surface = parseColor(themeColor(theme.surface, 'bg'));
    this.#foreground = parseColor(themeColor(theme.foreground));
    this.#muted = parseColor(themeColor(theme.muted));
    this.#border = parseColor(themeColor(theme.border));
    this.#accent = parseColor(themeColor(theme.accent));
    this.#motionPaintTokens = resolveMotionPaintTokens(theme);
    this.#lastViewportSize = undefined;
    // The composition requests the frame after updating all themed surfaces.
    this.markDirty();
  }
  cancelPointerCapture(): void {
    this.#pointerFrameId = undefined;
    this.#splitterCapture = undefined;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.#onPointerCancel?.('resize');
    this.#pointerFrameId = undefined;
    this.#layout.dispose();
    for (const layout of this.#paneLayouts.values()) layout.dispose();
    this.#paneLayouts.clear();
    this.#paneLastFrames.clear();
    this.#paneLastPresentations.clear();
    this.#paneLastSyntaxReads.clear();
    this.#paneLastCurrentSyntax.clear();
    this.#paneRects.clear();
    this.#paneFrames.clear();
    this.#splitters.clear();
    this.#splitterCapture = undefined;
    this.#lastSyntaxRead = undefined;
    this.#lastCurrentSyntax = undefined;
    this.#resolvedAnchors.clear();
    // Re-resolve (and report through `onViewportAnchorChange`) anchors for the new
    // dimensions here, as part of OpenTUI's pre-paint layout pass, so `renderSelf`
    // never has to -- see its doc comment and `syncAnchors`'s doc comment.
    this.syncAnchors();
    // Core is already laying out this frame; do not schedule another for the resize.
    this.markDirty();
  }

  protected override destroySelf(): void {
    this.#comparisonEditor.dispose();
    this.#onPointerCancel?.('dispose');
    this.#pointerFrameId = undefined;
    this.#layout.dispose();
    for (const layout of this.#paneLayouts.values()) layout.dispose();
    this.#paneLayouts.clear();
    this.#paneLastFrames.clear();
    this.#paneLastPresentations.clear();
    this.#paneLastSyntaxReads.clear();
    this.#paneLastCurrentSyntax.clear();
    this.#paneRects.clear();
    this.#paneFrames.clear();
    this.#splitters.clear();
    this.#splitterCapture = undefined;
    this.#lastFrame = undefined;
    this.#lastPresentation = undefined;
    this.#lastSyntaxRead = undefined;
    this.#lastCurrentSyntax = undefined;
    this.#resolvedAnchors.clear();
    this.#lastPaintStats = undefined;
    super.destroySelf();
  }

  /**
   * Cursor-follow scroll anchor for one view (docs/plan/01-architecture.md "Input,
   * effects and rendering"; fixes the viewport never scrolling past the first
   * screen). Seeds from the read model's `scrollTop` (authoritative, written by
   * wheel scroll and restored layouts through `WorkbenchSession.setViewScroll`) so
   * a scroll written through the session is rendered, then adjusts it so a cursor
   * below the fold still pulls the viewport down instead of `project()` silently
   * falling back to line 0. Only reports back when the resolved anchor differs
   * from the read model's value, to avoid a report/read feedback loop.
   *
   * This is the one place that writes back through `onViewportAnchorChange`; it is
   * called only from `syncAnchors()`, never from `renderSelf`/`renderSplit`, so
   * painting stays a read-only projection of already-resolved anchors (see
   * `syncAnchors`'s doc comment).
   */
  #resolveAndReportAnchor(
    viewId: string, view: WorkbenchViewSnapshot, widthCells: number, heightCells: number,
  ): { readonly anchor: ViewportAnchor; readonly scrollLeft: number } | undefined {
    const previousTop = view.scrollTop;
    const previousLeft = view.scrollLeft;
    if (this.#reportedViewportHeights.get(viewId) !== heightCells) {
      this.#reportedViewportHeights.set(viewId, heightCells);
      this.#onViewportSizeChange?.(viewId, heightCells);
    }
    const memo = this.#anchorMemo.get(viewId);
    if (memo !== undefined && memo.document === view.document && memo.selections === view.selections && memo.top === previousTop
      && memo.left === previousLeft && memo.width === widthCells && memo.height === heightCells) return memo.result;
    const resolved = resolveScrollAnchor(view.document, view.selections, previousTop, heightCells, widthCells, previousLeft);
    if (!resolved.ok) return undefined;
    this.#anchorMemo.set(viewId, { document: view.document, selections: view.selections, top: previousTop, left: previousLeft, width: widthCells, height: heightCells,
      result: { anchor: resolved.value.anchor, scrollLeft: resolved.value.scrollLeft } });
    if (resolved.value.scrollTop !== previousTop || resolved.value.scrollLeft !== previousLeft) {
      this.#onViewportAnchorChange?.(viewId, resolved.value.scrollTop, resolved.value.scrollLeft);
    }
    return { anchor: resolved.value.anchor, scrollLeft: resolved.value.scrollLeft };
  }

  /**
   * Resolve (and report, via `onViewportAnchorChange`) the cursor-follow scroll
   * anchor for every currently-visible view -- the active single view, or every
   * split pane -- ahead of the frame that will read it. The composition root calls
   * this once before each explicit render (`refreshAfterKey`/pointer/resize in
   * terminal.ts), keeping the scroll-follow *decision* a pre-render step and
   * `renderSelf`/`renderSplit` themselves read-only: they only look up what this
   * already resolved, in `#resolvedAnchors`, instead of computing and writing back
   * scroll state while painting.
   */
  syncAnchors(): void {
    const geometry = this.layout;
    if (geometry.compact) {
      this.#resolvedAnchors.clear();
      return;
    }
    const comparison = this.#comparison?.readComparison();
    if (comparison !== undefined) {
      const view = this.#workbench.readView(comparison.viewId);
      if (view !== undefined) {
        const width = geometry.editorWidth >= 110 ? Math.ceil((geometry.editorWidth - 1) / 2) : geometry.editorWidth;
        const gutter = Math.max(5, String(Math.max(comparison.left.lineCount, comparison.right.lineCount)).length + 2);
        this.#resolveAndReportAnchor(String(comparison.viewId), view, width - gutter, Math.max(1, geometry.editorHeight - 1));
      }
      return;
    }
    const layoutRead = this.#workbench.readLayout?.();
    if (layoutRead?.split.root?.kind === 'split' && this.width >= 80) {
      const { panes } = this.#collectPanes(geometry, layoutRead);
      const liveViewIds = new Set<string>();
      for (const pane of panes) {
        const view = this.#workbench.readView(pane.viewId as import('../../contracts/src/index').ViewId);
        if (view === undefined) continue;
        liveViewIds.add(pane.viewId);
        const anchor = this.#resolveAndReportAnchor(pane.viewId, view, pane.width - gutterWidthFor(view.document.lineCount), pane.height);
        if (anchor !== undefined) this.#resolvedAnchors.set(pane.viewId, anchor);
      }
      for (const viewId of this.#resolvedAnchors.keys()) {
        if (!liveViewIds.has(viewId)) this.#resolvedAnchors.delete(viewId);
      }
      return;
    }
    this.#resolvedAnchors.clear();
    const activeViewId = this.#workbench.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#workbench.readView(activeViewId);
    if (activeViewId === undefined || view === undefined) return;
    const anchor = this.#resolveAndReportAnchor(String(activeViewId), view, geometry.editorWidth - gutterWidthFor(view.document.lineCount), geometry.editorHeight);
    if (anchor !== undefined) this.#resolvedAnchors.set(String(activeViewId), anchor);
  }

  /** Shared pane/splitter geometry for one split frame; used by both `syncAnchors`
   * (read-only anchor resolution) and `renderSplit` (painting) so the two never
   * disagree about where each pane sits. */
  #collectPanes(geometry: WorkbenchLayout, layoutRead: WorkbenchLayoutRead): { readonly panes: readonly PaneRect[]; readonly splitters: readonly SplitterRect[] } {
    const panes: PaneRect[] = [];
    const splitters: SplitterRect[] = [];
    collectSplitGeometry(layoutRead.split.root, {
      x: geometry.editorX,
      y: geometry.editorTop - 1,
      width: geometry.editorWidth,
      height: geometry.editorHeight + 1,
    }, panes, splitters, layoutRead.split.minimumPaneSize, String(this.#workbench.activeViewId ?? ''));
    return { panes: panes.map(pane => ({ ...pane, y: pane.y + 1, height: Math.max(1, pane.height - 1) })), splitters };
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const geometry = this.layout;
    const lastViewport = this.#lastViewportSize;
    const splitRoot = this.#workbench.readLayout?.().split.root;
    const fullRepaint = splitRoot !== this.#lastPaintedSplitRoot || lastViewport?.width !== this.width || lastViewport?.height !== this.height
      || lastViewport.editorWidth !== geometry.editorWidth || lastViewport.editorHeight !== geometry.editorHeight;
    this.#lastPaintedSplitRoot = splitRoot;
    // Anchors for a width/height change are re-resolved by `onResize` (OpenTUI's own
    // pre-paint layout hook, which fires before this method with the new dimensions
    // already applied), not here -- renderSelf only reads `#resolvedAnchors`, never
    // resolves or reports them, so painting never triggers the `onViewportAnchorChange`
    // business action as a side effect of rendering.
    if (fullRepaint) {
      buffer.fillRect(geometry.editorX, geometry.editorTop, geometry.editorWidth, geometry.editorHeight, this.#background);
      this.#lastViewportSize = Object.freeze({ width: this.width, height: this.height, editorWidth: geometry.editorWidth, editorHeight: geometry.editorHeight });
    }

    const activeViewId = this.#workbench.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#workbench.readView(activeViewId);
    // Read-only: the anchor itself is resolved (and reported back through
    // `onViewportAnchorChange`) by `syncAnchors()` before this render, not here.
    const anchor = activeViewId === undefined ? undefined : this.#resolvedAnchors.get(String(activeViewId));
    const comparison = this.#comparison?.readComparison();
    if (comparison !== undefined && view !== undefined && !geometry.compact) {
      this.#comparisonPaint = this.#comparisonEditor.paint(buffer, comparison, view, { x: geometry.editorX, y: geometry.editorTop, width: geometry.editorWidth, height: geometry.editorHeight }, this.#theme, this.#syntax, this.#ascii, this.#colorMode);
      this.#cursorCell = this.#comparisonPaint.cursor;
      this.#lastFrame = undefined;
      this.ctx.setCursorPosition(0, 0, false);
      return;
    }
    this.#comparisonPaint = undefined;
    const projected = activeViewId === undefined || view === undefined || geometry.compact
      ? undefined
      : this.#layout.project({
        viewId: activeViewId,
        snapshot: view.document,
        selection: view.selections,
        widthCells: geometry.editorWidth,
        heightCells: geometry.editorHeight,
        options: { wrap: false, gutterWidthCells: gutterWidthFor(view.document.lineCount), horizontalScrollCells: anchor?.scrollLeft ?? 0 },
        ...(anchor === undefined ? {} : { anchor: anchor.anchor }),
      });
    const frame = projected?.ok === true ? projected.value : undefined;
    const presentation = this.#presentation === undefined || activeViewId === undefined
      ? undefined
      : this.#presentation.readPresentation(activeViewId);
    const syntaxRead = this.#syntax === undefined || view === undefined ? undefined : this.#syntax.readSyntax(view.document.id);
    const previous = this.#lastFrame;
    this.#lastFrame = Object.freeze({ layout: geometry, frame, view });

    if (geometry.compact) {
      this.#lastPaintStats = undefined;
      buffer.fillRect(0, 0, this.width, this.height, this.#surface);
      drawText(buffer, 'Xi: terminal too small', 1, Math.max(0, Math.floor(this.height / 2)), this.#foreground, this.#surface, this.width - 2);
      drawText(buffer, 'Resize to continue  ·  :q quit', 1, Math.min(this.height - 1, Math.floor(this.height / 2) + 1), this.#muted, this.#surface, this.width - 2);
      this.ctx.setCursorPosition(0, 0, false);
      this.#lastPresentation = undefined;
      this.#lastSyntaxRead = undefined;
      this.#lastCurrentSyntax = undefined;
      return;
    }

    const layoutRead = this.#workbench.readLayout?.();
    if (layoutRead?.split.root?.kind === 'split' && this.width >= 80) {
      this.renderSplit(buffer, geometry, layoutRead, fullRepaint);
      return;
    }

    if (frame !== undefined && view !== undefined) {
      const syntaxFallbackRows = syntaxFallbackRowsFor(this.#lastCurrentSyntax, syntaxRead);
      const paintRanges = calculatePaintRanges(previous, frame, view, presentation, this.#lastPresentation, fullRepaint, syntaxRead, this.#lastSyntaxRead, this.#lastCurrentSyntax?.spans);
      let paintStats: MotionPaintStats | undefined;
      for (const rows of paintRanges) {
        paintStats = drawFrame(buffer, frame, geometry.editorX, geometry.editorTop, this.#foreground, this.#muted, this.#background, this.#accent, this.#ascii, {
          presentation,
          motionTrail: this.#motionTrail,
          reducedMotion: this.#reducedMotion,
          colorMode: this.#colorMode,
          mode: view.session.mode,
          theme: this.#motionPaintTokens,
          ...(syntaxRead === undefined ? {} : { syntax: syntaxRead }),
          ...(this.#theme.syntax === undefined ? {} : { syntaxColors: this.#theme.syntax }),
          ...(this.#theme.styles === undefined && this.#theme.syntaxStyles === undefined ? {} : { syntaxStyles: this.#theme.styles ?? this.#theme.syntaxStyles! }),
          ...(syntaxFallbackRows === undefined ? {} : { syntaxFallbackRows }),
          rows,
        });
      }
      this.#lastPaintStats = paintStats ?? this.#lastPaintStats;
      this.#lastCurrentSyntax = snapshotSyntaxRowsIfCurrent(frame, syntaxRead, this.#lastCurrentSyntax) ?? this.#lastCurrentSyntax;
      const primary = frame.selections.find((selection) => selection.primary);
      const point = primary?.head.position;
      if (point !== null && point !== undefined) {
        // The cursor is software-painted onto the cell (see motion-paint.ts), so the
        // terminal's own hardware cursor must stay hidden or the two would overlay.
        this.#cursorCell = { x: geometry.editorX + point.column, y: geometry.editorTop + point.row };
        this.ctx.setCursorPosition(geometry.editorX + point.column + 1, geometry.editorTop + point.row + 1, false);
      } else {
        this.#cursorCell = undefined;
        this.ctx.setCursorPosition(0, 0, false);
      }
    } else {
      this.#lastPaintStats = undefined;
      drawText(buffer, 'No editable buffer', geometry.editorX + 1, geometry.editorTop, this.#muted, this.#background, geometry.editorWidth - 2);
      this.ctx.setCursorPosition(0, 0, false);
    }
    this.#lastPresentation = presentation;
    this.#lastSyntaxRead = syntaxRead;

  }

  private renderSplit(buffer: OptimizedBuffer, geometry: WorkbenchLayout, layoutRead: WorkbenchLayoutRead, fullRepaint: boolean): void {
    const { panes, splitters } = this.#collectPanes(geometry, layoutRead);
    this.#paneRects.clear();
    this.#paneFrames.clear();
    this.#splitters.clear();
    for (const pane of panes) this.#paneRects.set(pane.viewId, pane);
    for (const splitter of splitters) this.#splitters.set(splitter.id, splitter);

    if (fullRepaint) {
      buffer.fillRect(geometry.editorX, geometry.editorTop, geometry.editorWidth, geometry.editorHeight, this.#background);
      this.#lastViewportSize = Object.freeze({ width: this.width, height: this.height, editorWidth: geometry.editorWidth, editorHeight: geometry.editorHeight });
    }

    let activeFrame: VisibleFrame | undefined;
    let activeView: WorkbenchViewSnapshot | undefined;
    let activePresentation: EditorPresentationRead | undefined;
    let activePaint: MotionPaintStats | undefined;
    for (const pane of panes) {
      const view = this.#workbench.readView(pane.viewId as import('../../contracts/src/index').ViewId);
      if (view === undefined) continue;
      let paneLayout = this.#paneLayouts.get(pane.viewId);
      if (paneLayout === undefined) {
        paneLayout = new ViewportLayout();
        this.#paneLayouts.set(pane.viewId, paneLayout);
      }
      // Read-only: resolved (and reported) by `syncAnchors()` before this render.
      const paneAnchor = this.#resolvedAnchors.get(pane.viewId);
      const projected = paneLayout.project({
        viewId: pane.viewId as import('../../contracts/src/index').ViewId,
        snapshot: view.document,
        selection: view.selections,
        widthCells: pane.width,
        heightCells: pane.height,
        options: { wrap: false, gutterWidthCells: gutterWidthFor(view.document.lineCount), horizontalScrollCells: paneAnchor?.scrollLeft ?? 0 },
        ...(paneAnchor === undefined ? {} : { anchor: paneAnchor.anchor }),
      });
      if (!projected.ok) {
        drawText(buffer, 'No editable buffer', pane.x + 1, pane.y, this.#muted, this.#background, pane.width - 2);
        this.#paneLastFrames.delete(pane.viewId);
        this.#paneLastPresentations.delete(pane.viewId);
        this.#paneLastSyntaxReads.delete(pane.viewId);
        this.#paneLastCurrentSyntax.delete(pane.viewId);
        continue;
      }
      const frame = projected.value;
      this.#paneFrames.set(pane.viewId, frame);
      const presentation = this.#presentation?.readPresentation(pane.viewId as import('../../contracts/src/index').ViewId);
      const syntaxRead = this.#syntax?.readSyntax(view.document.id);
      const previousPaneFrame = this.#paneLastFrames.get(pane.viewId);
      const previousPanePresentation = this.#paneLastPresentations.get(pane.viewId);
      const previousPaneSyntaxRead = this.#paneLastSyntaxReads.get(pane.viewId);
      const previousPaneCurrentSyntax = this.#paneLastCurrentSyntax.get(pane.viewId);
      const paneSyntaxFallbackRows = syntaxFallbackRowsFor(previousPaneCurrentSyntax, syntaxRead);
      const paneRanges = calculatePaintRanges(previousPaneFrame, frame, view, presentation, previousPanePresentation, fullRepaint, syntaxRead, previousPaneSyntaxRead, previousPaneCurrentSyntax?.spans);
      let paint: MotionPaintStats | undefined;
      for (const rows of paneRanges) {
        paint = drawFrame(buffer, frame, pane.x, pane.y, this.#foreground, this.#muted, this.#background, this.#accent, this.#ascii, {
          presentation,
          motionTrail: this.#motionTrail,
          reducedMotion: this.#reducedMotion,
          colorMode: this.#colorMode,
          mode: view.session.mode,
          theme: this.#motionPaintTokens,
          ...(syntaxRead === undefined ? {} : { syntax: syntaxRead }),
          ...(this.#theme.syntax === undefined ? {} : { syntaxColors: this.#theme.syntax }),
          ...(this.#theme.styles === undefined && this.#theme.syntaxStyles === undefined ? {} : { syntaxStyles: this.#theme.styles ?? this.#theme.syntaxStyles! }),
          ...(paneSyntaxFallbackRows === undefined ? {} : { syntaxFallbackRows: paneSyntaxFallbackRows }),
          rows,
        });
      }
      this.#paneLastFrames.set(pane.viewId, Object.freeze({ layout: geometry, frame, view }));
      this.#paneLastPresentations.set(pane.viewId, presentation);
      this.#paneLastSyntaxReads.set(pane.viewId, syntaxRead);
      const paneCurrentSyntax = snapshotSyntaxRowsIfCurrent(frame, syntaxRead, previousPaneCurrentSyntax);
      if (paneCurrentSyntax !== undefined) this.#paneLastCurrentSyntax.set(pane.viewId, paneCurrentSyntax);
      if (String(this.#workbench.activeViewId) === pane.viewId) {
        activeFrame = frame;
        activeView = view;
        activePresentation = presentation;
        activePaint = paint;
        const primary = frame.selections.find((selection) => selection.primary);
        const point = primary?.head.position;
        this.#cursorCell = point === null || point === undefined ? undefined : { x: pane.x + point.column, y: pane.y + point.row };
        if (point !== null && point !== undefined) this.ctx.setCursorPosition(pane.x + point.column + 1, pane.y + point.row + 1, false);
      }
    }
    for (const splitter of splitters) {
      if (splitter.axis === 'vertical') buffer.fillRect(splitter.x, splitter.y, splitter.width, splitter.height, this.#border);
    }
    this.#lastFrame = Object.freeze({ layout: geometry, frame: activeFrame, view: activeView });
    this.#lastPresentation = activePresentation;
    this.#lastPaintStats = activePaint ?? (fullRepaint ? undefined : this.#lastPaintStats);
  }

  private paneAt(x: number, y: number): PaneRect | undefined {
    for (const pane of this.#paneRects.values()) {
      if (x >= pane.x && x < pane.x + pane.width && y >= pane.y && y < pane.y + pane.height) return pane;
    }
    return undefined;
  }

  private splitterControlAt(x: number, y: number, phase: WorkbenchPointerEvent['phase']): WorkbenchPointerEvent['control'] | undefined {
    let splitter: SplitterRect | undefined;
    if (this.#splitterCapture !== undefined) splitter = this.#splitters.get(this.#splitterCapture);
    if (splitter === undefined) {
      for (const candidate of this.#splitters.values()) {
        if (x >= candidate.x && x < candidate.x + candidate.width && y >= candidate.y && y < candidate.y + candidate.height) {
          splitter = candidate;
          break;
        }
      }
    }
    if (splitter === undefined) return undefined;
    if (this.#splitterCapture === undefined && phase !== 'down') return undefined;
    const firstSize = splitter.axis === 'vertical'
      ? clampSplitSize(x - splitter.originX, splitter.availableCells)
      : clampSplitSize(y - splitter.originY, splitter.availableCells);
    const control: WorkbenchPointerEvent['control'] = {
      id: splitter.id,
      kind: 'splitter',
      action: this.#splitterCapture === undefined ? 'begin' : phase === 'up' ? 'commit' : 'move',
      axis: splitter.axis,
      firstSize,
      secondSize: splitter.availableCells - firstSize,
      availableCells: splitter.availableCells,
    };
    if (control.action === 'begin') this.#splitterCapture = splitter.id;
    if (control.action === 'commit') {
      this.#splitterCapture = undefined;
    }
    return control;
  }

  /** The 1-cell resize splitter at the sidebar/editor boundary; independent of `#splitters`
   * (only populated for editor pane splits) since it exists whenever the sidebar is visible,
   * split view or not. */
  #sidebarSplitterControlAt(x: number, y: number, phase: WorkbenchPointerEvent['phase']): WorkbenchPointerEvent['control'] | undefined {
    const geometry = this.layout;
    if (!geometry.sidebarVisible) return undefined;
    if (!this.#sidebarSplitterCapture && (x !== geometry.sidebarWidth || y < 0 || y >= this.height)) return undefined;
    // Only a button press begins a resize; a hover ('move') over the splitter column must not
    // capture it, or moving the pointer across the sidebar would drag its width around.
    if (!this.#sidebarSplitterCapture && phase !== 'down') return undefined;
    const availableCells = Math.max(23, this.width - 20);
    const firstSize = clampSplitSize(x, availableCells);
    const control: WorkbenchPointerEvent['control'] = {
      id: 'splitter:sidebar',
      kind: 'splitter',
      action: this.#sidebarSplitterCapture ? (phase === 'up' ? 'commit' : 'move') : 'begin',
      axis: 'vertical',
      firstSize,
      secondSize: availableCells - firstSize,
      availableCells,
    };
    if (control.action === 'begin') this.#sidebarSplitterCapture = true;
    if (control.action === 'commit') this.#sidebarSplitterCapture = false;
    return control;
  }

  /** Outline section-header and tab-bar hit-testing, resolved ahead of the legacy
   * `workbenchControlAt` fallback. Row 0's sidebar zone is deliberately left to that legacy
   * fallback -- it already returns `sidebar.files`/`sidebar.search`/`sidebar.git` by x-third,
   * and `sidebar.files`'s own registered handler (in the composition root) is what now also
   * flips the Files chevron, so those existing hit targets stay exactly where callers
   * (including PTY fixtures) already expect them. Row 1 (`▸ Outline`) was unclaimed chrome
   * before this ticket, so it gets its own new control id here. */
  #chromeControlAt(x: number, y: number, geometry: WorkbenchLayout): WorkbenchPointerEvent['control'] | undefined {
    const sidebarModel = this.#sidebar?.();
    if (sidebarModel !== undefined && geometry.sidebarVisible) {
      if (y === 0) {
        const tab = computeSidebarTabLayout(geometry.sidebarWidth).find(entry => x >= entry.x && x < entry.x + entry.width);
        if (tab !== undefined) return { id: `sidebar.${tab.id}`, kind: tab.id === 'files' ? 'tree' : 'button', action: 'activate' };
      }
      const sections = computeSidebarSectionLayout(sidebarModel, geometry.statusRow);
      if (y === sections.outlineHeaderRow && x >= 0 && x < geometry.sidebarWidth) {
        return { id: 'sidebar-section.outline', kind: 'button', action: 'activate' };
      }
    }
    if (this.#tabs !== undefined) {
      const strip = this.tabStrips.find(candidate => y === candidate.y && x >= candidate.x && x < candidate.x + candidate.width);
      if (strip !== undefined) return this.#tabControlAt(x - strip.x, strip.width, strip.viewId);
    }
    return undefined;
  }

  #tabControlAt(column: number, width: number, viewId: string): WorkbenchPointerEvent['control'] | undefined {
    const tabs = this.#tabs?.(viewId);
    if (tabs === undefined) return undefined;
    for (const entry of computeTabLayout(tabs, width)) {
      if (entry.tab === undefined || column < entry.x || column >= entry.x + entry.width) continue;
      if (entry.hasClose && column >= entry.x + entry.width - 3) return { id: entry.tab.id, viewId, kind: 'tab-close', action: 'activate' };
      return { id: entry.tab.id, viewId, kind: 'tab', action: 'activate' };
    }
    return undefined;
  }
}

function collectSplitGeometry(
  node: WorkbenchSplitSnapshot['root'],
  rect: Omit<PaneRect, 'viewId'>,
  panes: PaneRect[],
  splitters: SplitterRect[],
  minimumPaneSize: number,
  activeViewId: string,
): void {
  if (node === undefined) return;
  if (node.kind === 'leaf') {
    panes.push(Object.freeze({ viewId: String(node.viewId), ...rect }));
    return;
  }
  const horizontal = node.orientation === 'horizontal';
  const availableCells = horizontal ? rect.height : rect.width - 1;
  if (availableCells < minimumPaneSize * 2) {
    const viewId = containsView(node.first, activeViewId) || !containsView(node.second, activeViewId)
      ? firstView(node.first)
      : firstView(node.second);
    if (viewId !== undefined) panes.push(Object.freeze({ viewId: String(viewId), ...rect }));
    return;
  }
  const firstSize = Math.max(minimumPaneSize, Math.min(availableCells - minimumPaneSize, Math.floor(availableCells * node.ratio)));
  const secondSize = availableCells - firstSize;
  const firstRect = horizontal
    ? { x: rect.x, y: rect.y, width: rect.width, height: firstSize }
    : { x: rect.x, y: rect.y, width: firstSize, height: rect.height };
  const secondRect = horizontal
    ? { x: rect.x, y: rect.y + firstSize, width: rect.width, height: secondSize }
    : { x: rect.x + firstSize + 1, y: rect.y, width: secondSize, height: rect.height };
  const splitter = horizontal
    ? { x: rect.x, y: rect.y + firstSize, width: rect.width, height: 1 }
    : { x: rect.x + firstSize, y: rect.y, width: 1, height: rect.height };
  splitters.push(Object.freeze({
    id: `splitter:${node.nodeId}`,
    axis: horizontal ? 'horizontal' : 'vertical',
    ...splitter,
    originX: rect.x,
    originY: rect.y,
    availableCells,
    firstSize,
    secondSize,
  }));
  collectSplitGeometry(node.first, firstRect, panes, splitters, minimumPaneSize, activeViewId);
  collectSplitGeometry(node.second, secondRect, panes, splitters, minimumPaneSize, activeViewId);
}

function containsView(node: WorkbenchSplitSnapshot['root'], viewId: string): boolean {
  if (node === undefined) return false;
  if (node.kind === 'leaf') return String(node.viewId) === viewId;
  return containsView(node.first, viewId) || containsView(node.second, viewId);
}

function firstView(node: WorkbenchSplitSnapshot['root']): string | undefined {
  if (node === undefined) return undefined;
  return node.kind === 'leaf' ? String(node.viewId) : firstView(node.first) ?? firstView(node.second);
}

function clampSplitSize(value: number, availableCells: number): number {
  return Math.max(1, Math.min(Math.max(1, availableCells - 1), Math.trunc(value)));
}

function pointerTarget(target: Extract<CellHitTarget, { readonly kind: 'text' }>): WorkbenchPointerEvent['target'] {
  return Object.freeze({
    lineIndex: target.lineIndex as number,
    offset: target.offset as number,
    displayCellColumn: target.displayCellColumn as number,
    virtualCell: target.virtualCell,
    cellPart: target.cellPart,
  });
}

function pointerPhase(type: MouseEvent['type']): WorkbenchPointerEvent['phase'] | undefined {
  if (type === 'scroll') return 'wheel';
  if (type === 'drag-end' || type === 'drop') return 'up';
  if (type === 'over' || type === 'out') return 'move';
  if (type === 'down' || type === 'move' || type === 'up') return type;
  if (type === 'drag') return 'move';
  return undefined;
}

function workbenchControlAt(layout: WorkbenchLayout, x: number, y: number): WorkbenchPointerEvent['control'] | undefined {
  if (y === layout.statusRow) return { id: 'status', kind: 'button', action: 'activate' };
  if (y !== 0) return undefined;
  if (layout.sidebarVisible && x >= 0 && x < layout.sidebarWidth) {
    const tab = computeSidebarTabLayout(layout.sidebarWidth).find(entry => x >= entry.x && x < entry.x + entry.width);
    if (tab !== undefined) return { id: `sidebar.${tab.id}`, kind: tab.id === 'files' ? 'tree' : 'button', action: 'activate' };
  }
  if (x >= layout.editorX && x < layout.editorX + layout.editorWidth) return { id: 'tab.active', kind: 'tab', action: 'activate' };
  return undefined;
}

interface EditorPaintSettings {
  readonly presentation: import('../editor/motion-paint').EditorPresentationRead | undefined;
  readonly motionTrail: MotionTrailMode;
  readonly reducedMotion: boolean;
  readonly colorMode: EditorColorMode;
  readonly mode: string;
  readonly theme: import('../theme/motion-tokens').MotionPaintTokens;
  readonly syntax?: SyntaxRead;
  readonly syntaxColors?: WorkbenchTheme['syntax'];
  readonly syntaxStyles?: WorkbenchTheme['styles'] | WorkbenchTheme['syntaxStyles'];
  readonly syntaxFallbackRows?: readonly (SyntaxFallbackRow | undefined)[];
  readonly rows?: { readonly start: number; readonly end: number };
}

function drawFrame(buffer: OptimizedBuffer, frame: VisibleFrame, x: number, y: number, foreground: RGBA, muted: RGBA, background: RGBA, accent: RGBA, ascii: boolean, settings: EditorPaintSettings): MotionPaintStats {
  return paintEditorFrame(buffer, {
    frame,
    presentation: {
      ...(settings.presentation ?? {}),
      motionTrail: settings.presentation?.motionTrail ?? settings.motionTrail,
      reducedMotion: settings.presentation?.reducedMotion ?? settings.reducedMotion,
      colorMode: settings.presentation?.colorMode ?? settings.colorMode,
    },
    ...(settings.syntax === undefined ? {} : { syntax: settings.syntax }),
    ...(settings.syntaxColors === undefined ? {} : { syntaxColors: settings.syntaxColors }),
    ...(settings.syntaxStyles === undefined ? {} : { syntaxStyles: settings.syntaxStyles }),
    ...(settings.syntaxFallbackRows === undefined ? {} : { syntaxFallbackRows: settings.syntaxFallbackRows }),
    mode: settings.mode,
    theme: settings.theme,
    foreground,
    muted,
    background,
    accent,
    colorMode: settings.colorMode,
    ascii,
    x,
    y,
    ...(settings.rows === undefined ? {} : { rows: settings.rows }),
  });
}

/** Exported for direct unit testing of the row-level paint diff (see tests/ui). */
export function calculatePaintRanges(
  previous: WorkbenchFrameRead | undefined,
  current: VisibleFrame,
  view: WorkbenchViewSnapshot,
  presentation: EditorPresentationRead | undefined,
  previousPresentation: EditorPresentationRead | undefined,
  fullRepaint: boolean,
  syntaxRead?: SyntaxRead,
  previousSyntaxRead?: SyntaxRead,
  /** Spans actually painted for each of `previous.frame.rows`, frozen at the time they
   * were painted; see `CurrentSyntaxSnapshot.spans`. Comparing against these (rather than
   * re-calling `previousSyntaxRead.spansInRange` now) matters because a windowed/lazy read
   * can keep filling in the background under the same read reference: querying it "now"
   * would return today's filled result for both sides and hide the very change that needs
   * repainting (the first-open "colors never appear" bug). */
  previousPaintedSpans?: readonly (readonly SyntaxSpan[])[],
): readonly { readonly start: number; readonly end: number }[] {
  if (fullRepaint || previous?.frame === undefined || previous.view === undefined) return [{ start: 0, end: current.rows.length }];
  if (previous.frame.widthCells !== current.widthCells || previous.frame.heightCells !== current.heightCells
    || previous.frame.identity.viewId !== current.identity.viewId
    || presentation !== previousPresentation) return [{ start: 0, end: current.rows.length }];

  const dirty = new Set<number>();
  for (let row = 0; row < current.rows.length; row += 1) {
    const previousRow = previous.frame.rows[row];
    const currentRow = current.rows[row];
    // `contentKey` is stable across a base-offset shift for an otherwise-identical row (see its
    // doc comment in packages/layout/src/index.ts), so comparing it instead of row-object
    // identity keeps an edit on one line from marking every later row dirty just because the
    // edit shifted their absolute offsets. Fall back to identity when either side has no
    // reusable content identity (`null`).
    const same = previousRow?.contentKey !== null && previousRow?.contentKey !== undefined
      && currentRow?.contentKey !== null && currentRow?.contentKey !== undefined
      ? previousRow.contentKey === currentRow.contentKey
      : previousRow === currentRow;
    if (!same) dirty.add(row);
  }

  if (syntaxRead !== previousSyntaxRead) {
    const currentIsCurrent = syntaxRead !== undefined
      && (syntaxRead.documentVersion as unknown as number) === (current.identity.documentVersion as unknown as number);
    const previousWasCurrent = previousSyntaxRead !== undefined
      && (previousSyntaxRead.documentVersion as unknown as number) === (previous.frame.identity.documentVersion as unknown as number);
    if (currentIsCurrent && previousWasCurrent) {
      // Both frames had a syntax read that was current for themselves (e.g. a cold
      // scan's empty result, then the drained result, for a document version that
      // never advanced in between -- see t053-syntax-paint's "first paint is plain,
      // second is colored" fixture). Dirty exactly the rows whose resolved spans
      // differ; a typical reparse leaves most visible rows' spans unchanged.
      for (let row = 0; row < current.rows.length; row += 1) {
        if (dirty.has(row)) continue;
        const currentRow = current.rows[row];
        const start = currentRow?.startOffset as number | null | undefined;
        const end = currentRow?.endOffset as number | null | undefined;
        if (currentRow === undefined || start === null || start === undefined || end === null || end === undefined || end <= start) continue;
        const paintedSpans = previousPaintedSpans?.[row] ?? previousSyntaxRead.spansInRange(start, end);
        if (!sameSpans(paintedSpans, syntaxRead.spansInRange(start, end))) dirty.add(row);
      }
    } else if (currentIsCurrent && !previousWasCurrent) {
      // The common "a fresh parse just landed after a stale keystroke frame"
      // transition. `rowSyntaxCursor`'s stale-fallback rule (editor/motion-paint.ts)
      // already reused the *same* read's spans, by the *same* offsets, for every row
      // whose offset didn't shift -- so those rows already show the exact colors a
      // fully current read would produce and never needed this frame's repaint. Only
      // a row whose offset shifted (fallback couldn't apply to it, so it painted
      // plain) actually changes appearance now that its own offsets are current.
      for (let row = 0; row < current.rows.length; row += 1) {
        if (dirty.has(row)) continue;
        const previousRow = previous.frame.rows[row];
        const currentRow = current.rows[row];
        if (previousRow?.startOffset !== currentRow?.startOffset || previousRow?.endOffset !== currentRow?.endOffset) dirty.add(row);
      }
    } else {
      // The read just went stale (or neither side is current) -- the painted colors
      // can't be cheaply predicted from spans alone, so fall back to a full repaint,
      // same as before this row-level diff existed.
      return [{ start: 0, end: current.rows.length }];
    }
  }

  const previousSelections = previous.view.selections;
  const currentSelections = view.selections;
  if (previousSelections.selectionGeneration !== currentSelections.selectionGeneration) {
    if (!cursorOnly(previousSelections.members) || !cursorOnly(currentSelections.members)
      || previousSelections.members.length !== currentSelections.members.length) {
      return [{ start: 0, end: current.rows.length }];
    }
    addCursorRows(dirty, previous.frame.selections);
    addCursorRows(dirty, current.selections);
  }
  if (previous.view.session.mode !== view.session.mode
    && (!cursorOnly(previousSelections.members) || !cursorOnly(currentSelections.members))) {
    return [{ start: 0, end: current.rows.length }];
  }
  return mergePaintRanges(dirty, current.rows.length);
}

/** Structural equality of two spans-in-range results; both are sorted by start (the
 * `SyntaxRead.spansInRange` contract), so a positional comparison suffices. */
function sameSpans(a: readonly SyntaxSpan[], b: readonly SyntaxSpan[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || left.start !== right.start || left.end !== right.end || left.kind !== right.kind || left.scope !== right.scope) return false;
  }
  return true;
}

function cursorOnly(members: readonly { readonly kind: string }[]): boolean {
  return members.every((member) => member.kind === 'normal-cursor' || member.kind === 'insert-caret');
}

function addCursorRows(rows: Set<number>, selections: readonly ProjectedSelection[]): void {
  for (const selection of selections) {
    if (selection.head.position !== null) rows.add(selection.head.position.row);
  }
}

function mergePaintRanges(rows: Set<number>, rowCount: number): readonly { readonly start: number; readonly end: number }[] {
  if (rows.size === 0) return [];
  if (rows.size * 2 > rowCount) return [{ start: 0, end: rowCount }];
  const sorted = [...rows].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  let start = sorted[0] as number;
  let end = start + 1;
  for (let index = 1; index < sorted.length; index += 1) {
    const row = sorted[index] as number;
    if (row <= end) end = row + 1;
    else { ranges.push({ start, end }); start = row; end = row + 1; }
  }
  ranges.push({ start, end });
  return Object.freeze(ranges);
}

function drawText(buffer: OptimizedBuffer, text: string, x: number, y: number, foreground: RGBA, background: RGBA, maxWidth: number, attributes = 0): void {
  if (maxWidth <= 0 || x < 0 || y < 0) return;
  buffer.drawText(text.slice(0, maxWidth), x, y, foreground, background, attributes);
}

interface TabLayoutEntry {
  readonly tab?: WorkbenchTabSnapshot;
  readonly x: number;
  readonly width: number;
  readonly hasClose: boolean;
}

/** Vim `numberwidth`-style gutter: at least three digits plus one blank separator column. */
export function gutterWidthFor(lineCount: number): number {
  return Math.max(3, String(Math.max(1, lineCount)).length) + 1;
}

const TAB_MIN_WIDTH = 8;
const TAB_MAX_WIDTH = 22;

/** Lay out the tab strip left to right; when everything doesn't fit, keeps the active tab
 * visible and grows outward from it (right first, then left) until the width budget runs
 * out, replacing whatever's left over with a single `…` marker on each overflowing side. */
export function computeTabLayout(tabs: readonly WorkbenchTabSnapshot[], availableWidth: number): readonly TabLayoutEntry[] {
  if (tabs.length === 0 || availableWidth <= 0) return [];
  const widths = tabs.map((tab) => Math.max(TAB_MIN_WIDTH, Math.min(tab.kind === 'comparison' ? 40 : TAB_MAX_WIDTH, tab.label.length + (tab.dirty ? 2 : 0) + 6)));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (totalWidth <= availableWidth) {
    let x = 0;
    return tabs.map((tab, index) => {
      const width = widths[index] as number;
      const entry: TabLayoutEntry = { tab, x, width, hasClose: width >= TAB_MIN_WIDTH + 2 };
      x += width;
      return entry;
    });
  }
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.active));
  const included = new Set<number>([activeIndex]);
  let used = widths[activeIndex] as number;
  let left = activeIndex - 1;
  let right = activeIndex + 1;
  const budget = Math.max(1, availableWidth - 2);
  for (;;) {
    if (right < tabs.length && used + (widths[right] as number) <= budget) { included.add(right); used += widths[right] as number; right += 1; continue; }
    if (left >= 0 && used + (widths[left] as number) <= budget) { included.add(left); used += widths[left] as number; left -= 1; continue; }
    break;
  }
  const entries: TabLayoutEntry[] = [];
  let x = 0;
  if (left >= 0) { entries.push({ x, width: 1, hasClose: false }); x += 1; }
  for (let index = 0; index < tabs.length; index += 1) {
    if (!included.has(index)) continue;
    const tab = tabs[index];
    if (tab === undefined) continue;
    const remaining = Math.max(1, availableWidth - x - (right < tabs.length ? 1 : 0));
    const width = Math.min(widths[index] as number, remaining);
    entries.push({ tab, x, width, hasClose: width >= TAB_MIN_WIDTH + 2 });
    x += width;
  }
  if (right < tabs.length && x < availableWidth) entries.push({ x, width: Math.max(1, availableWidth - x), hasClose: false });
  return entries;
}

function tabLabelText(tab: WorkbenchTabSnapshot, ascii: boolean, width: number): string {
  const dirtyMark = tab.dirty ? (ascii ? ' *' : ' ●') : '';
  const raw = ` ${tab.label}${dirtyMark}`;
  if (width <= 0) return '';
  if (raw.length <= width) return raw + ' '.repeat(width - raw.length);
  if (width === 1) return raw.slice(0, 1);
  return `${raw.slice(0, width - 1)}…`;
}
