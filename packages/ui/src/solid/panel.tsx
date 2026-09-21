/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import type { MouseEvent, RGBA } from '@opentui/core/renderer';
import { Index, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import type { BoxRenderable } from '@opentui/core';
import type { Disposable } from '../../../contracts/src/index';
import { PanelHitMap, PanelScroll, type WorkbenchPanel, type WorkbenchPanelPointerEvent } from '../panel-pointer';
import { readableTextColor } from '../../theme/readability';
import { helixTextAttributes, themeColor } from '../../theme/color-input';

type UiColor = string | RGBA;

export interface SurfaceRowSegment {
  readonly text: string;
  readonly foreground?: UiColor;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly style?: SurfaceThemeStyle;
}

export interface SurfaceRow {
  readonly text?: string;
  readonly segments?: readonly SurfaceRowSegment[];
  readonly foreground?: UiColor;
  readonly background?: UiColor;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly style?: SurfaceThemeStyle;
}

export interface SurfaceThemeStyle {
  readonly fg?: string;
  readonly bg?: string;
  readonly modifiers?: readonly string[];
  readonly underline?: { readonly color?: string; readonly style?: string };
}

function mergeSurfaceStyles(base: SurfaceThemeStyle | undefined, overlay: SurfaceThemeStyle | undefined): SurfaceThemeStyle | undefined {
  if (base === undefined) return overlay;
  if (overlay === undefined) return base;
  const modifiers = [...new Set([...(base.modifiers ?? []), ...(overlay.modifiers ?? [])])];
  return {
    ...(base.fg === undefined ? {} : { fg: base.fg }), ...(base.bg === undefined ? {} : { bg: base.bg }),
    ...(base.underline === undefined ? {} : { underline: base.underline }),
    ...(modifiers.length === 0 ? {} : { modifiers }),
    ...(overlay.fg === undefined ? {} : { fg: overlay.fg }), ...(overlay.bg === undefined ? {} : { bg: overlay.bg }),
    ...(overlay.underline === undefined ? {} : { underline: overlay.underline }),
  };
}

function surfaceColor(style: SurfaceThemeStyle | undefined, channel: 'fg' | 'bg', fallback: UiColor): UiColor {
  return themeColor(style?.[channel] ?? fallback, channel);
}

function surfaceForeground(style: SurfaceThemeStyle | undefined, candidate: UiColor, background: UiColor, fallback: UiColor): UiColor {
  return readableTextColor(surfaceColor(style, 'fg', candidate), surfaceColor(style, 'bg', background), fallback);
}

export interface RowsSurfaceSpec<T> {
  readonly read: { readonly model: T; subscribe(listener: (model: T) => void): Disposable };
  readonly isOpen: () => boolean;
  readonly format: (model: T, width: number, maxRows: number, offset?: number) => readonly string[];
  readonly formatRows?: (model: T, width: number, maxRows: number, offset: number, hoveredId: string | undefined) => readonly SurfaceRow[];
  readonly maxRows: number;
  readonly background: UiColor;
  readonly foreground: UiColor;
  readonly accent?: UiColor;
  readonly muted?: UiColor;
  readonly selectedBackground?: UiColor;
  readonly hoverBackground?: UiColor;
  readonly scrollForeground?: UiColor;
  readonly scrollBackground?: UiColor;
  readonly bounds: (width: number, height: number) => { readonly width: number; readonly height: number; readonly left: number; readonly top: number };
  readonly subscribeVisibility?: (listener: () => void) => Disposable;
  readonly onTheme?: (setTheme: (background: UiColor, foreground: UiColor, accent?: UiColor, muted?: UiColor, selectedBackground?: UiColor, hoverBackground?: UiColor, scrollForeground?: UiColor, scrollBackground?: UiColor, style?: SurfaceThemeStyle, selectedStyle?: SurfaceThemeStyle, headerStyle?: SurfaceThemeStyle) => void) => Disposable | undefined;
  readonly panel?: WorkbenchPanel;
  readonly generation?: (model: T) => number;
  readonly rowIds?: (model: T, offset: number, rows: number) => readonly (string | undefined)[];
  readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  readonly onScroll?: (delta: number) => void;
  readonly headerRows?: number;
  readonly footerRows?: number;
  readonly onViewportRows?: (rows: number) => void;
  readonly totalRows?: (model: T) => number;
  readonly selectedId?: (model: T) => string | undefined;
  readonly selectedIndex?: (model: T) => number;
  readonly zIndex?: number;
  /** Requests a rounded frame while retaining the shared rows, scrolling and hit map. */
  readonly border?: boolean;
  /** Hover is normally visual-only; previewing is opt-in for the theme picker. */
  readonly previewOnHover?: (model: T) => boolean;
  readonly onMouse?: (event: MouseEvent, row: number, column: number) => boolean;
}

/** Shared bounded panel presentation for every read-only row surface. */
export function RowsSurface<T>(spec: RowsSurfaceSpec<T>): JSX.Element {
  const dimensions = useTerminalDimensions();
  const [model, setModel] = createSignal(spec.read.model);
  const [theme, setTheme] = createSignal({
    background: themeColor(spec.background, 'bg'),
    foreground: themeColor(spec.foreground, 'fg'),
    accent: themeColor(spec.accent ?? '#1F5FBF', 'fg'),
    muted: themeColor(spec.muted ?? spec.foreground, 'fg'),
    selectedBackground: themeColor(spec.selectedBackground ?? spec.background, 'bg'),
    hoverBackground: themeColor(spec.hoverBackground ?? spec.selectedBackground ?? spec.background, 'bg'),
    scrollForeground: themeColor(spec.scrollForeground ?? '#FFFFFF', 'fg'),
    scrollBackground: themeColor(spec.scrollBackground ?? spec.accent ?? '#1F5FBF', 'bg'),
    style: undefined as SurfaceThemeStyle | undefined,
    selectedStyle: undefined as SurfaceThemeStyle | undefined,
    headerStyle: undefined as SurfaceThemeStyle | undefined,
  });
  const [version, setVersion] = createSignal(0);
  const [hoveredId, setHoveredId] = createSignal<string>();
  const hitMap = new PanelHitMap();
  const scroll = new PanelScroll();
  const headerRows = Math.max(0, spec.headerRows ?? 0);
  const footerRows = Math.max(0, spec.footerRows ?? 0);
  let box!: BoxRenderable;

  const dataSubscription = spec.read.subscribe(setModel);
  const visibilitySubscription = spec.subscribeVisibility?.(() => setVersion(value => value + 1));
  const themeSubscription = spec.onTheme?.((background, foreground, accent, muted, selectedBackground, hoverBackground, scrollForeground, scrollBackground, style, selectedStyle, headerStyle) => setTheme(current => ({
    background: themeColor(background, 'bg'),
    foreground: themeColor(foreground),
    accent: themeColor(accent ?? current.accent),
    muted: themeColor(muted ?? current.muted, 'fg'),
    selectedBackground: themeColor(selectedBackground ?? current.selectedBackground, 'bg'),
    hoverBackground: themeColor(hoverBackground ?? selectedBackground ?? current.hoverBackground, 'bg'),
    scrollForeground: themeColor(scrollForeground ?? current.scrollForeground, 'fg'),
    scrollBackground: themeColor(scrollBackground ?? current.scrollBackground, 'bg'),
    style,
    selectedStyle,
    headerStyle,
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
    const visible = spec.isOpen();
    if (!visible) scroll.reset();
    return visible;
  };
  const contentSize = () => ({
    width: Math.max(0, layout().width - (spec.border === true ? 2 : 0)),
    height: Math.max(0, layout().height - (spec.border === true ? 2 : 0)),
  });
  const viewportRows = () => Math.max(0, Math.min(spec.maxRows, contentSize().height) - headerRows - footerRows);
  const rows = () => {
    version();
    theme();
    const size = contentSize();
    if (!open()) {
      hitMap.publish(0, []);
      scroll.reset();
      return [];
    }
    const current = model();
    const total = spec.totalRows?.(current) ?? 0;
    const viewport = viewportRows();
    spec.onViewportRows?.(viewport);
    if (spec.selectedIndex !== undefined) scroll.follow(spec.selectedId?.(current), () => spec.selectedIndex!(current), total, viewport);
    const offset = spec.panel === undefined ? 0 : scroll.offset;
    const rowLimit = Math.min(spec.maxRows, Math.max(0, size.height));
    const rowIds = spec.rowIds?.(current, offset, rowLimit) ?? [];
    hitMap.publish(spec.generation?.(current) ?? 0, rowIds);
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
    return formatted.map((row, index) => {
      const id = rowIds[index];
      const stateStyle = index < headerRows ? theme().headerStyle : id !== undefined && id === selected ? theme().selectedStyle : undefined;
      const style = mergeSurfaceStyles(row.style, stateStyle);
      return style === undefined ? row : { ...row, style };
    });
  };
  const scrollbar = () => {
    version();
    const size = contentSize();
    const thumb = scroll.thumb(spec.totalRows?.(model()) ?? 0, viewportRows());
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
      const itemId = column < 0 || column >= box.width ? undefined : hitMap.resolve(row, spec.generation(model()));
      setHoveredId(itemId);
      if (spec.previewOnHover?.(model()) === true && itemId !== undefined && itemId !== spec.selectedId?.(model())) spec.onPointer?.({
        panel: spec.panel,
        action: 'preview',
        itemId,
        generation: hitMap.generation,
        row,
        column,
        button: 0,
        screenX: event.x,
        screenY: event.y,
      });
      return;
    }
    if (event.type === 'out') {
      setHoveredId(undefined);
      return;
    }
    if (event.type === 'scroll') {
      const delta = event.scroll === undefined ? 0 : Math.max(1, event.scroll.delta) * (event.scroll.direction === 'up' ? -1 : 1);
      if (delta !== 0) spec.onScroll?.(delta);
      if (delta !== 0 && scroll.scrollBy(delta, spec.totalRows?.(model()) ?? 0, viewportRows())) {
        setVersion(value => value + 1);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (scroll.dragging && (event.type === 'drag' || event.type === 'drag-end' || event.type === 'up')) {
      let changed = true;
      if (event.type === 'drag') changed = scroll.dragTo(row, spec.totalRows?.(model()) ?? 0, viewportRows());
      else scroll.endDrag();
      if (changed) setVersion(value => value + 1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.type !== 'down' || (event.button !== 0 && event.button !== 2)) return;
    if (event.button === 0 && row >= headerRows && row < headerRows + viewportRows() && scroll.thumb(spec.totalRows?.(model()) ?? 0, viewportRows()) !== undefined && column === box.width - 1) {
      scroll.beginDrag(row);
      setVersion(value => value + 1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const itemId = column < 0 || column >= box.width ? undefined : hitMap.resolve(row, spec.generation(model()));
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
    <Show when={open()} fallback={() => null}>
    <box onMouse={onMouse} position="absolute" zIndex={spec.zIndex ?? 80}
      left={layout().left} top={layout().top} width={layout().width} height={layout().height}
      visible={open()} backgroundColor={theme().background}
      {...(spec.border !== true ? {} : { borderStyle: 'rounded' as const, borderColor: theme().accent })}>
      <box ref={node => { box = node; }} width={contentSize().width} height={contentSize().height} overflow="hidden">
      <Index each={rows()}>{(row, index) => (
        <box position="absolute" left={0} top={index} width="100%" height={1}
          backgroundColor={surfaceColor(mergeSurfaceStyles(theme().style, row().style), 'bg', row().background ?? theme().background)}>
          <text fg={surfaceForeground(mergeSurfaceStyles(theme().style, row().style), row().foreground ?? theme().foreground, row().background ?? theme().background, theme().foreground)}>
            {row().segments === undefined
              ? <span style={{
                ...helixTextAttributes(mergeSurfaceStyles(theme().style, row().style)),
                fg: surfaceForeground(mergeSurfaceStyles(theme().style, row().style), row().foreground ?? theme().foreground, row().background ?? theme().background, theme().foreground),
                bg: surfaceColor(mergeSurfaceStyles(theme().style, row().style), 'bg', row().background ?? theme().background),
                bold: row().bold === true || helixTextAttributes(mergeSurfaceStyles(theme().style, row().style)).bold,
                italic: row().italic === true || helixTextAttributes(mergeSurfaceStyles(theme().style, row().style)).italic,
              }}>{row().text ?? ''}</span>
              : row().segments?.map(segment => {
                const style = mergeSurfaceStyles(mergeSurfaceStyles(theme().style, segment.style), row().style);
                const attributes = helixTextAttributes(style);
                return <span style={{
                  ...attributes,
                  fg: surfaceForeground(style, segment.foreground ?? row().foreground ?? theme().foreground, row().background ?? theme().background, theme().foreground),
                  bg: surfaceColor(style, 'bg', row().background ?? theme().background),
                  bold: segment.bold === true || attributes.bold,
                  italic: segment.italic === true || attributes.italic,
                }}>{segment.text}</span>;
              })}
          </text>
        </box>
      )}</Index>
      <text position="absolute" zIndex={1} left={scrollbar()?.left ?? 0} top={scrollbar()?.top ?? 0}
        width={1} height={scrollbar()?.height ?? 1} visible={scrollbar() !== undefined}
        selectable={false} content={'█'.repeat(scrollbar()?.height ?? 0)} fg={theme().scrollForeground} style={{ bg: theme().scrollBackground }} />
      </box>
    </box>
    </Show>
  );
}
