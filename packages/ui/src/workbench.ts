import {
  RGBA,
  Renderable,
  type MouseEvent,
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
import { ViewportLayout, type CellHitTarget, type ProjectedSelection, type VisibleFrame } from '../../layout/src/index';
import {
  paintEditorFrame,
  type EditorPresentationRead,
  type EditorPresentationReadPort,
  type MotionPaintStats,
} from '../editor/motion-paint';
import {
  resolveMotionPaintTokens,
  type EditorColorMode,
  type MotionTrailMode,
} from '../theme/motion-tokens';

export interface WorkbenchTheme {
  readonly background: string;
  readonly surface: string;
  readonly surfaceActive: string;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly error: string;
  /** Optional editor layer tokens. Existing themes receive stable defaults. */
  readonly selectionPrimary?: string;
  readonly selectionSecondary?: string;
  readonly cursorPrimary?: string;
  readonly cursorSecondary?: string;
  readonly motionTrail?: string;
  readonly operatorPreview?: string;
}

export const LIGHT_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  background: '#FAF9F6',
  surface: '#F1F0EC',
  surfaceActive: '#E7EDF4',
  foreground: '#24292E',
  muted: '#60666D',
  border: '#D5D4CF',
  accent: '#245A88',
  error: '#A52A36',
  selectionPrimary: '#D6E5F2',
  selectionSecondary: '#E4ECF3',
  cursorPrimary: '#1A2835',
  cursorSecondary: '#405B72',
  motionTrail: '#EEF2F4',
  operatorPreview: '#C4D8E8',
});

export const ASCII_WORKBENCH_THEME: WorkbenchTheme = Object.freeze({
  ...LIGHT_WORKBENCH_THEME,
  border: '#60666D',
});

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
    readonly kind: 'tree' | 'tab' | 'picker' | 'button' | 'splitter';
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
}

export interface WorkbenchRenderableOptions extends RenderableOptions<WorkbenchRenderable> {
  readonly workbench: WorkbenchReadPort;
  readonly theme?: WorkbenchTheme;
  readonly ascii?: boolean;
  readonly fileLabel?: string;
  readonly showBottomPanel?: boolean;
  /** Optional immutable presentation read model supplied by the workbench. */
  readonly presentation?: EditorPresentationReadPort;
  readonly motionTrail?: MotionTrailMode;
  readonly reducedMotion?: boolean;
  readonly colorMode?: EditorColorMode;
  readonly onPointer?: (event: WorkbenchPointerEvent) => boolean;
  readonly onPointerCancel?: (reason: 'resize' | 'dispose' | 'escape' | 'suspend') => void;
}

export interface WorkbenchFrameRead {
  readonly layout: WorkbenchLayout;
  readonly frame: VisibleFrame | undefined;
  readonly view: WorkbenchViewSnapshot | undefined;
  readonly paint?: MotionPaintStats;
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

/** Calculate shell geometry without owning document or selection state. */
export function calculateWorkbenchLayout(width: number, height: number, showBottomPanel = false): WorkbenchLayout {
  const safeWidth = Math.max(0, Math.trunc(width));
  const safeHeight = Math.max(0, Math.trunc(height));
  const compact = safeWidth < 40 || safeHeight < 10;
  const sidebarVisible = !compact && safeWidth >= 100;
  const sidebarWidth = sidebarVisible
    ? Math.min(Math.max(22, Math.floor(safeWidth * 0.25)), Math.min(40, Math.floor(safeWidth * 0.35)))
    : 0;
  const editorX = sidebarVisible ? sidebarWidth + 1 : 0;
  const editorWidth = Math.max(1, safeWidth - editorX);
  const statusRow = Math.max(0, safeHeight - 1);
  const bottomHeight = !compact && showBottomPanel && safeHeight >= 16 ? Math.min(10, Math.max(3, Math.floor(safeHeight * 0.25))) : 0;
  const bottomTop = Math.max(0, statusRow - bottomHeight);
  const editorTop = compact ? 0 : 1;
  const editorHeight = Math.max(1, bottomTop - editorTop);
  return Object.freeze({ compact, sidebarVisible, sidebarWidth, editorX, editorWidth, editorTop, editorHeight, bottomTop, bottomHeight, statusRow });
}

/** A document-backed OpenTUI shell for the first Xi workbench surface. */
export class WorkbenchRenderable extends Renderable {
  readonly #workbench: WorkbenchReadPort;
  readonly #theme: WorkbenchTheme;
  readonly #ascii: boolean;
  readonly #fileLabel: string;
  readonly #showBottomPanel: boolean;
  readonly #presentation: EditorPresentationReadPort | undefined;
  readonly #motionTrail: MotionTrailMode;
  readonly #reducedMotion: boolean;
  readonly #colorMode: EditorColorMode;
  readonly #onPointer: ((event: WorkbenchPointerEvent) => boolean) | undefined;
  readonly #onPointerCancel: ((reason: 'resize' | 'dispose' | 'escape' | 'suspend') => void) | undefined;
  readonly #layout = new ViewportLayout();
  readonly #paneLayouts = new Map<string, ViewportLayout>();
  readonly #paneRects = new Map<string, PaneRect>();
  readonly #paneFrames = new Map<string, VisibleFrame>();
  readonly #splitters = new Map<string, SplitterRect>();
  #splitterCapture: string | undefined;
  readonly #background: RGBA;
  readonly #surface: RGBA;
  readonly #active: RGBA;
  readonly #foreground: RGBA;
  readonly #muted: RGBA;
  readonly #border: RGBA;
  readonly #accent: RGBA;
  #lastShellSize: { readonly width: number; readonly height: number } | undefined;
  #lastFrame: WorkbenchFrameRead | undefined;
  #lastPresentation: EditorPresentationRead | undefined;
  #lastPaintStats: MotionPaintStats | undefined;
  #lastHeaderText: string | undefined;
  #lastStatusText: string | undefined;
  #pointerFrameId: number | undefined;

  constructor(ctx: RenderContext, options: WorkbenchRenderableOptions) {
    const renderOptions: RenderableOptions<WorkbenchRenderable> = {
      width: options.width ?? '100%',
      height: options.height ?? '100%',
      buffered: options.buffered ?? true,
      ...(options.id === undefined ? {} : { id: options.id }),
    };
    super(ctx, renderOptions);
    this.#workbench = options.workbench;
    this.#ascii = options.ascii ?? false;
    this.#theme = options.theme ?? (this.#ascii ? ASCII_WORKBENCH_THEME : LIGHT_WORKBENCH_THEME);
    this.#fileLabel = options.fileLabel ?? '[No Name]';
    this.#showBottomPanel = options.showBottomPanel ?? false;
    this.#presentation = options.presentation;
    this.#motionTrail = options.motionTrail ?? 'off';
    this.#reducedMotion = options.reducedMotion ?? true;
    this.#colorMode = options.colorMode ?? 'truecolor';
    this.#onPointer = options.onPointer;
    this.#onPointerCancel = options.onPointerCancel;
    this.#background = parseColor(this.#theme.background);
    this.#surface = parseColor(this.#theme.surface);
    this.#active = parseColor(this.#theme.surfaceActive);
    this.#foreground = parseColor(this.#theme.foreground);
    this.#muted = parseColor(this.#theme.muted);
    this.#border = parseColor(this.#theme.border);
    this.#accent = parseColor(this.#theme.accent);
    this.onMouse = (event: MouseEvent): void => {
      if (this.#onPointer === undefined || event.target !== this) return;
      const phase = pointerPhase(event.type);
      if (phase === undefined) return;
      const geometry = this.layout;
      const pane = this.paneAt(event.x, event.y);
      const frameColumn = pane === undefined ? event.x - geometry.editorX : event.x - pane.x;
      const column = frameColumn - 6;
      const row = pane === undefined ? event.y - geometry.editorTop : event.y - pane.y;
      const insideEditor = pane === undefined
        ? column >= 0 && row >= 0 && column < Math.max(1, geometry.editorWidth - 6) && row < geometry.editorHeight
        : column >= 0 && row >= 0 && column < Math.max(1, pane.width - 6) && row < pane.height;
      const activeViewId = pane?.viewId ?? this.#workbench.activeViewId;
      if (activeViewId === undefined) return;
      const currentFrame = pane === undefined ? this.#lastFrame?.frame : this.#paneFrames.get(String(activeViewId));
      const currentFrameId = Number(currentFrame?.identity.frameId ?? 0);
      const dispatchFrameId = phase === 'down' ? currentFrameId : this.#pointerFrameId ?? currentFrameId;
      const splitterControl = phase === 'wheel' ? undefined : this.splitterControlAt(event.x, event.y, phase);
      const control = phase === 'wheel' ? undefined : splitterControl ?? workbenchControlAt(geometry, event.x, event.y);
      if (phase !== 'wheel' && !insideEditor && control === undefined) return;
      const layout = pane === undefined ? this.#layout : this.#paneLayouts.get(String(activeViewId));
      const hit = phase === 'wheel' || layout === undefined
        ? undefined
        : layout.hitTest(currentFrameId as import('../../layout/src/index').LayoutFrameId, { row, column: frameColumn });
      const target = hit?.ok === true && hit.value.target.kind === 'text' ? pointerTarget(hit.value.target) : undefined;
      if (phase !== 'wheel' && target === undefined && control === undefined) return;
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

  get layout(): WorkbenchLayout { return calculateWorkbenchLayout(this.width, this.height, this.#showBottomPanel); }
  get lastFrame(): WorkbenchFrameRead | undefined { return this.#lastFrame; }
  get lastPaintStats(): MotionPaintStats | undefined { return this.#lastPaintStats; }
  refresh(): void { this.requestRender(); }
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
    this.#paneRects.clear();
    this.#paneFrames.clear();
    this.#splitters.clear();
    this.#splitterCapture = undefined;
    this.requestRender();
  }

  protected override destroySelf(): void {
    this.#onPointerCancel?.('dispose');
    this.#pointerFrameId = undefined;
    this.#layout.dispose();
    for (const layout of this.#paneLayouts.values()) layout.dispose();
    this.#paneLayouts.clear();
    this.#paneRects.clear();
    this.#paneFrames.clear();
    this.#splitters.clear();
    this.#splitterCapture = undefined;
    this.#lastShellSize = undefined;
    this.#lastFrame = undefined;
    this.#lastPresentation = undefined;
    this.#lastPaintStats = undefined;
    this.#lastHeaderText = undefined;
    this.#lastStatusText = undefined;
    super.destroySelf();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const geometry = this.layout;
    const fullRepaint = this.#lastShellSize?.width !== this.width || this.#lastShellSize?.height !== this.height;
    if (fullRepaint) {
      buffer.fillRect(0, 0, this.width, this.height, this.#background);
      this.#lastShellSize = Object.freeze({ width: this.width, height: this.height });
    }

    const activeViewId = this.#workbench.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#workbench.readView(activeViewId);
    const projected = activeViewId === undefined || view === undefined || geometry.compact
      ? undefined
      : this.#layout.project({
        viewId: activeViewId,
        snapshot: view.document,
        selection: view.selections,
        widthCells: geometry.editorWidth,
        heightCells: geometry.editorHeight,
        options: { wrap: false, gutterWidthCells: 6 },
      });
    const frame = projected?.ok === true ? projected.value : undefined;
    const presentation = this.#presentation === undefined || activeViewId === undefined
      ? undefined
      : this.#presentation.readPresentation(activeViewId);
    const previous = this.#lastFrame;
    this.#lastFrame = Object.freeze({ layout: geometry, frame, view });

    if (geometry.compact) {
      this.#lastPaintStats = undefined;
      buffer.fillRect(0, 0, this.width, this.height, this.#surface);
      drawText(buffer, 'Xi: terminal too small', 1, Math.max(0, Math.floor(this.height / 2)), this.#foreground, this.#surface, this.width - 2);
      drawText(buffer, 'Resize to continue  ·  Ctrl-C quit', 1, Math.min(this.height - 1, Math.floor(this.height / 2) + 1), this.#muted, this.#surface, this.width - 2);
      this.ctx.setCursorPosition(0, 0, false);
      this.#lastPresentation = undefined;
      return;
    }

    const layoutRead = this.#workbench.readLayout?.();
    if (layoutRead?.split.root?.kind === 'split' && this.width >= 80) {
      this.renderSplit(buffer, geometry, layoutRead, fullRepaint);
      return;
    }

    if (fullRepaint && geometry.sidebarVisible) {
      buffer.fillRect(0, 0, geometry.sidebarWidth, this.height, this.#surface);
      buffer.fillRect(0, 0, geometry.sidebarWidth, 1, this.#active);
      drawText(buffer, 'Files  Search  Git', 1, 0, this.#foreground, this.#active, geometry.sidebarWidth - 2);
      drawText(buffer, `${this.#ascii ? '> ' : '▾ '}${this.#fileLabel}`, 1, 2, this.#foreground, this.#surface, geometry.sidebarWidth - 2);
      drawText(buffer, `${this.#ascii ? '> ' : '  '}Outline`, 1, 4, this.#muted, this.#surface, geometry.sidebarWidth - 2);
      buffer.fillRect(geometry.sidebarWidth, 0, 1, this.height, this.#border);
    }

    const headerText = `${this.#fileLabel}  ${this.#ascii ? '*' : '●'}`;
    if (fullRepaint || this.#lastHeaderText !== headerText) {
      buffer.fillRect(geometry.editorX, 0, geometry.editorWidth, 1, this.#active);
      drawText(buffer, headerText, geometry.editorX + 1, 0, this.#foreground, this.#active, geometry.editorWidth - 2);
      this.#lastHeaderText = headerText;
    }
    if (frame !== undefined && view !== undefined) {
      const paintRanges = calculatePaintRanges(previous, frame, view, presentation, this.#lastPresentation, fullRepaint);
      let paintStats: MotionPaintStats | undefined;
      for (const rows of paintRanges) {
        paintStats = drawFrame(buffer, frame, geometry.editorX, geometry.editorTop, this.#foreground, this.#muted, this.#background, this.#accent, this.#ascii, {
          presentation,
          motionTrail: this.#motionTrail,
          reducedMotion: this.#reducedMotion,
          colorMode: this.#colorMode,
          mode: view.session.mode,
          theme: resolveMotionPaintTokens(this.#theme),
          rows,
        });
      }
      this.#lastPaintStats = paintStats ?? this.#lastPaintStats;
      const primary = frame.selections.find((selection) => selection.primary);
      const point = primary?.head.position;
      if (point !== null && point !== undefined) {
        this.ctx.setCursorPosition(geometry.editorX + point.column + 1, geometry.editorTop + point.row + 1, true);
      } else {
        this.ctx.setCursorPosition(0, 0, false);
      }
    } else {
      this.#lastPaintStats = undefined;
      drawText(buffer, 'No editable buffer', geometry.editorX + 1, geometry.editorTop, this.#muted, this.#background, geometry.editorWidth - 2);
      this.ctx.setCursorPosition(0, 0, false);
    }
    this.#lastPresentation = presentation;

    if (geometry.bottomHeight > 0) {
      buffer.fillRect(geometry.editorX, geometry.bottomTop, geometry.editorWidth, geometry.bottomHeight, this.#surface);
      buffer.fillRect(geometry.editorX, geometry.bottomTop, geometry.editorWidth, 1, this.#border);
      drawText(buffer, 'Problems 0   Output   Tasks', geometry.editorX + 1, geometry.bottomTop + 1, this.#foreground, this.#surface, geometry.editorWidth - 2);
    }
    const count = view?.selections.members.length ?? 0;
    const mode = view?.session.mode.toUpperCase() ?? 'NORMAL';
    const statusText = ` ${mode}   ${this.#fileLabel}   ${count} cursor${count === 1 ? '' : 's'}`;
    if (fullRepaint || this.#lastStatusText !== statusText) {
      buffer.fillRect(0, geometry.statusRow, this.width, 1, this.#surface);
      drawText(buffer, statusText, 1, geometry.statusRow, this.#foreground, this.#surface, Math.max(0, this.width - 2));
      this.#lastStatusText = statusText;
    }
  }

  private renderSplit(buffer: OptimizedBuffer, geometry: WorkbenchLayout, layoutRead: WorkbenchLayoutRead, fullRepaint: boolean): void {
    const panes: PaneRect[] = [];
    const splitters: SplitterRect[] = [];
    collectSplitGeometry(layoutRead.split.root, {
      x: geometry.editorX,
      y: geometry.editorTop,
      width: geometry.editorWidth,
      height: geometry.editorHeight,
    }, panes, splitters, layoutRead.split.minimumPaneSize, String(this.#workbench.activeViewId ?? ''));
    this.#paneRects.clear();
    this.#paneFrames.clear();
    this.#splitters.clear();
    for (const pane of panes) this.#paneRects.set(pane.viewId, pane);
    for (const splitter of splitters) this.#splitters.set(splitter.id, splitter);

    buffer.fillRect(geometry.editorX, 0, geometry.editorWidth, geometry.bottomTop, this.#background);
    if (geometry.sidebarVisible) {
      buffer.fillRect(0, 0, geometry.sidebarWidth, this.height, this.#surface);
      buffer.fillRect(0, 0, geometry.sidebarWidth, 1, this.#active);
      drawText(buffer, 'Files  Search  Git', 1, 0, this.#foreground, this.#active, geometry.sidebarWidth - 2);
      drawText(buffer, `${this.#ascii ? '> ' : '▾ '}${this.#fileLabel}`, 1, 2, this.#foreground, this.#surface, geometry.sidebarWidth - 2);
      drawText(buffer, `${this.#ascii ? '> ' : '  '}Outline`, 1, 4, this.#muted, this.#surface, geometry.sidebarWidth - 2);
      buffer.fillRect(geometry.sidebarWidth, 0, 1, this.height, this.#border);
    }
    const headerText = `${this.#fileLabel}  ${this.#ascii ? '*' : '●'}`;
    buffer.fillRect(geometry.editorX, 0, geometry.editorWidth, 1, this.#active);
    drawText(buffer, headerText, geometry.editorX + 1, 0, this.#foreground, this.#active, geometry.editorWidth - 2);
    this.#lastHeaderText = headerText;

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
      const projected = paneLayout.project({
        viewId: pane.viewId as import('../../contracts/src/index').ViewId,
        snapshot: view.document,
        selection: view.selections,
        widthCells: pane.width,
        heightCells: pane.height,
        options: { wrap: false, gutterWidthCells: 6 },
      });
      if (!projected.ok) {
        drawText(buffer, 'No editable buffer', pane.x + 1, pane.y, this.#muted, this.#background, pane.width - 2);
        continue;
      }
      const frame = projected.value;
      this.#paneFrames.set(pane.viewId, frame);
      const presentation = this.#presentation?.readPresentation(pane.viewId as import('../../contracts/src/index').ViewId);
      const paint = drawFrame(buffer, frame, pane.x, pane.y, this.#foreground, this.#muted, this.#background, this.#accent, this.#ascii, {
        presentation,
        motionTrail: this.#motionTrail,
        reducedMotion: this.#reducedMotion,
        colorMode: this.#colorMode,
        mode: view.session.mode,
        theme: resolveMotionPaintTokens(this.#theme),
      });
      if (String(this.#workbench.activeViewId) === pane.viewId) {
        activeFrame = frame;
        activeView = view;
        activePresentation = presentation;
        activePaint = paint;
        const primary = frame.selections.find((selection) => selection.primary);
        const point = primary?.head.position;
        if (point !== null && point !== undefined) this.ctx.setCursorPosition(pane.x + point.column + 1, pane.y + point.row + 1, true);
      }
    }
    for (const splitter of splitters) {
      buffer.fillRect(splitter.x, splitter.y, splitter.width, splitter.height, this.#border);
    }
    if (geometry.bottomHeight > 0) {
      buffer.fillRect(geometry.editorX, geometry.bottomTop, geometry.editorWidth, geometry.bottomHeight, this.#surface);
      buffer.fillRect(geometry.editorX, geometry.bottomTop, geometry.editorWidth, 1, this.#border);
      drawText(buffer, 'Problems 0   Output   Tasks', geometry.editorX + 1, geometry.bottomTop + 1, this.#foreground, this.#surface, geometry.editorWidth - 2);
    }
    const count = activeView?.selections.members.length ?? 0;
    const mode = activeView?.session.mode.toUpperCase() ?? 'NORMAL';
    const statusText = ` ${mode}   ${this.#fileLabel}   ${count} cursor${count === 1 ? '' : 's'}`;
    buffer.fillRect(0, geometry.statusRow, this.width, 1, this.#surface);
    drawText(buffer, statusText, 1, geometry.statusRow, this.#foreground, this.#surface, Math.max(0, this.width - 2));
    this.#lastStatusText = statusText;
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
  const availableCells = (horizontal ? rect.height : rect.width) - 1;
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
    ? { x: rect.x, y: rect.y + firstSize + 1, width: rect.width, height: secondSize }
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
    const section = x < Math.ceil(layout.sidebarWidth / 3) ? 'files' : x < Math.ceil(layout.sidebarWidth * 2 / 3) ? 'search' : 'git';
    return { id: `sidebar.${section}`, kind: section === 'files' ? 'tree' : 'button', action: 'activate' };
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

function calculatePaintRanges(
  previous: WorkbenchFrameRead | undefined,
  current: VisibleFrame,
  view: WorkbenchViewSnapshot,
  presentation: EditorPresentationRead | undefined,
  previousPresentation: EditorPresentationRead | undefined,
  fullRepaint: boolean,
): readonly { readonly start: number; readonly end: number }[] {
  if (fullRepaint || previous?.frame === undefined || previous.view === undefined) return [{ start: 0, end: current.rows.length }];
  if (previous.frame.widthCells !== current.widthCells || previous.frame.heightCells !== current.heightCells
    || previous.frame.identity.viewId !== current.identity.viewId
    || presentation !== previousPresentation) return [{ start: 0, end: current.rows.length }];

  const dirty = new Set<number>();
  for (let row = 0; row < current.rows.length; row += 1) {
    if (previous.frame.rows[row] !== current.rows[row]) dirty.add(row);
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

function drawText(buffer: OptimizedBuffer, text: string, x: number, y: number, foreground: RGBA, background: RGBA, maxWidth: number): void {
  if (maxWidth <= 0 || x < 0 || y < 0) return;
  buffer.drawText(text.slice(0, maxWidth), x, y, foreground, background, 0);
}
