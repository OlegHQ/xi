/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';
import { For, createMemo, createSignal, onCleanup } from 'solid-js';
import type { BoxRenderable } from '@opentui/core';
import type { Disposable } from '../../../contracts/src/index';
import { PanelHitMap, PanelScroll, type WorkbenchPanel, type WorkbenchPanelPointerEvent } from '../panel-pointer';

export interface SurfaceRowSegment {
  readonly text: string;
  readonly foreground?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface SurfaceRow {
  readonly text?: string;
  readonly segments?: readonly SurfaceRowSegment[];
  readonly foreground?: string;
  readonly background?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface RowsSurfaceSpec<T> {
  readonly read: { readonly model: T; subscribe(listener: (model: T) => void): Disposable };
  readonly isOpen: () => boolean;
  readonly format: (model: T, width: number, maxRows: number, offset?: number) => readonly string[];
  readonly formatRows?: (model: T, width: number, maxRows: number, offset: number, hoveredId: string | undefined) => readonly SurfaceRow[];
  readonly maxRows: number;
  readonly background: string;
  readonly foreground: string;
  readonly accent?: string;
  readonly muted?: string;
  readonly selectedBackground?: string;
  readonly hoverBackground?: string;
  readonly bounds: (width: number, height: number) => { readonly width: number; readonly height: number; readonly left: number; readonly top: number };
  readonly subscribeVisibility?: (listener: () => void) => Disposable;
  readonly onTheme?: (setTheme: (background: string, foreground: string, accent?: string, muted?: string, selectedBackground?: string, hoverBackground?: string) => void) => Disposable | undefined;
  readonly panel?: WorkbenchPanel;
  readonly generation?: (model: T) => number;
  readonly rowIds?: (model: T, offset: number, rows: number) => readonly (string | undefined)[];
  readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  readonly onScroll?: (delta: number) => void;
  readonly headerRows?: number;
  readonly totalRows?: (model: T) => number;
  readonly selectedId?: (model: T) => string | undefined;
  readonly selectedIndex?: (model: T) => number;
  readonly zIndex?: number;
  readonly onMouse?: (event: MouseEvent, row: number, column: number) => boolean;
}

/** Shared bounded panel presentation for every read-only row surface. */
export function RowsSurface<T>(spec: RowsSurfaceSpec<T>): JSX.Element {
  const dimensions = useTerminalDimensions();
  const [model, setModel] = createSignal(spec.read.model);
  const [theme, setTheme] = createSignal({
    background: spec.background,
    foreground: spec.foreground,
    accent: spec.accent ?? '#1F5FBF',
    muted: spec.muted ?? spec.foreground,
    selectedBackground: spec.selectedBackground ?? spec.background,
    hoverBackground: spec.hoverBackground ?? spec.selectedBackground ?? spec.background,
  });
  const [version, setVersion] = createSignal(0);
  const [hoveredId, setHoveredId] = createSignal<string>();
  const hitMap = new PanelHitMap();
  const scroll = new PanelScroll();
  const headerRows = Math.max(0, spec.headerRows ?? 0);
  let box!: BoxRenderable;

  const dataSubscription = spec.read.subscribe(setModel);
  const visibilitySubscription = spec.subscribeVisibility?.(() => setVersion(value => value + 1));
  const themeSubscription = spec.onTheme?.((background, foreground, accent, muted, selectedBackground, hoverBackground) => setTheme(current => ({
    background,
    foreground,
    accent: accent ?? current.accent,
    muted: muted ?? current.muted,
    selectedBackground: selectedBackground ?? current.selectedBackground,
    hoverBackground: hoverBackground ?? selectedBackground ?? current.hoverBackground,
  })));
  const layout = createMemo(() => {
    // Some surfaces derive their bounds from their live model (command-line candidate
    // height, context-menu position/items). Keep those closures reactive too.
    model();
    version();
    const size = dimensions();
    return spec.bounds(size.width, size.height);
  });
  const open = () => {
    // Visibility can change with the panel's own read model (prefix help is the
    // simplest example), independently of the workbench-wide wake subscription.
    model();
    version();
    return spec.isOpen();
  };
  const rows = () => {
    version();
    theme();
    const size = layout();
    if (!open()) {
      hitMap.publish(0, []);
      return [];
    }
    const current = model();
    const total = spec.totalRows?.(current) ?? 0;
    const viewport = Math.max(0, size.height - headerRows);
    if (spec.selectedIndex !== undefined) scroll.follow(spec.selectedId?.(current), () => spec.selectedIndex!(current), total, viewport);
    const offset = spec.panel === undefined ? 0 : scroll.offset;
    const rowIds = spec.rowIds?.(current, offset, size.height) ?? [];
    hitMap.publish(spec.generation?.(current) ?? 0, rowIds);
    const rowLimit = Math.min(spec.maxRows, Math.max(0, size.height));
    const selected = spec.selectedId?.(current);
    const formatted: readonly SurfaceRow[] = spec.formatRows?.(current, Math.max(1, size.width), rowLimit, offset, hoveredId())
      ?? spec.format(current, Math.max(1, size.width), rowLimit, offset).map((text, index) => {
        const id = rowIds[index];
        const isSelected = id !== undefined && id === selected;
        const isHovered = id !== undefined && id === hoveredId();
        return {
          text,
          foreground: index < headerRows ? theme().accent : isSelected ? theme().foreground : theme().muted,
          background: isSelected ? theme().selectedBackground : isHovered ? theme().hoverBackground : theme().background,
          bold: index < headerRows || isSelected,
        };
      });
    return formatted;
  };
  const scrollbar = () => {
    version();
    const size = layout();
    const thumb = scroll.thumb(spec.totalRows?.(model()) ?? 0, Math.max(0, size.height - headerRows));
    return thumb === undefined ? undefined : { left: Math.max(0, size.width - 1), top: headerRows + thumb.start, height: thumb.size };
  };

  const onMouse = (event: MouseEvent): void => {
    const row = event.y - box.screenY;
    const column = event.x - box.screenX;
    if (spec.onMouse?.(event, row, column) === true) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (spec.panel === undefined || spec.generation === undefined) return;
    if (event.type === 'move' || event.type === 'over') {
      setHoveredId(hitMap.resolve(row, spec.generation(model())));
      return;
    }
    if (event.type === 'out') {
      setHoveredId(undefined);
      return;
    }
    if (event.type === 'scroll') {
      const delta = event.scroll === undefined ? 0 : Math.max(1, event.scroll.delta) * (event.scroll.direction === 'up' ? -1 : 1);
      if (delta !== 0) spec.onScroll?.(delta);
      if (delta !== 0 && scroll.scrollBy(delta, spec.totalRows?.(model()) ?? 0, Math.max(0, box.height - headerRows))) {
        setVersion(value => value + 1);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (scroll.dragging && (event.type === 'drag' || event.type === 'drag-end' || event.type === 'up')) {
      let changed = true;
      if (event.type === 'drag') changed = scroll.dragTo(row, spec.totalRows?.(model()) ?? 0, Math.max(0, box.height - headerRows));
      else scroll.endDrag();
      if (changed) setVersion(value => value + 1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.type !== 'down' || (event.button !== 0 && event.button !== 2)) return;
    if (event.button === 0 && scroll.thumb(spec.totalRows?.(model()) ?? 0, Math.max(0, box.height - headerRows)) !== undefined && column === box.width - 1) {
      scroll.beginDrag(row);
      setVersion(value => value + 1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const itemId = hitMap.resolve(row, spec.generation(model()));
    if (itemId === undefined) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (spec.onPointer?.({
      panel: spec.panel,
      action: event.button === 0 ? 'activate' : 'context',
      itemId,
      generation: hitMap.generation,
      row,
      column,
      button: event.button,
      screenX: event.x,
      screenY: event.y,
    }) === true) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  onCleanup(() => {
    dataSubscription.dispose();
    visibilitySubscription?.dispose();
    themeSubscription?.dispose();
  });

  return (
    <box ref={node => { box = node; }} onMouse={onMouse} position="absolute" zIndex={spec.zIndex ?? 80}
      left={layout().left} top={layout().top} width={layout().width} height={layout().height}
      visible={open()} backgroundColor={theme().background}>
      <For each={rows()}>{(row, index) => (
        <box position="absolute" left={0} top={index()} width="100%" height={1}
          backgroundColor={row.background ?? theme().background}>
          <text fg={row.foreground ?? theme().foreground}>
            {row.segments === undefined
              ? <span style={{
                fg: row.foreground ?? theme().foreground,
                bg: row.background ?? theme().background,
                bold: row.bold ?? false,
                italic: row.italic ?? false,
              }}>{row.text ?? ''}</span>
              : row.segments.map(segment => <span style={{
                fg: segment.foreground ?? row.foreground ?? theme().foreground,
                bg: row.background ?? theme().background,
                bold: segment.bold ?? false,
                italic: segment.italic ?? false,
              }}>{segment.text}</span>)}
          </text>
        </box>
      )}</For>
      <text position="absolute" left={scrollbar()?.left ?? 0} top={scrollbar()?.top ?? 0}
        width={1} height={scrollbar()?.height ?? 1} visible={scrollbar() !== undefined}
        selectable={false} content={' '.repeat(scrollbar()?.height ?? 0)} fg="#FFFFFF" style={{ bg: theme().accent }} />
    </box>
  );
}
