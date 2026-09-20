/** @jsxImportSource @opentui/solid */
import type { JSX } from '@opentui/solid';
import type { Disposable } from '../../../contracts/src/index';
import type { HelixThemeStyle, ThemeColor, WorkbenchTheme } from '../workbench';
import { ChromeSurface, type ChromeSurfaceSpec } from './chrome';
import { RowsSurface, type RowsSurfaceSpec } from './panel';
import { mountSolidRoot, type SolidNode } from './root';

export interface SolidThemeBridge<T> {
  readonly current: () => T;
  readonly bind: (setter: (value: T) => void) => { dispose: () => void };
  readonly subscribe: (setter: (value: T) => void) => { dispose: () => void };
  readonly set: (value: T) => void;
}

export function createThemeBridge<T>(initial: T): SolidThemeBridge<T> {
  let pending = initial;
  const setters = new Set<(value: T) => void>();
  const subscribe = (nextSetter: (value: T) => void): Disposable => {
    setters.add(nextSetter);
    nextSetter(pending);
    return { dispose: () => { setters.delete(nextSetter); } };
  };
  return {
    current: () => pending,
    bind: subscribe,
    subscribe,
    set: nextValue => { pending = nextValue; for (const setter of setters) setter(nextValue); },
  };
}

export function createChromeSurfaceNode(spec: ChromeSurfaceSpec, theme: SolidThemeBridge<WorkbenchTheme>): SolidNode {
  return () => <ChromeSurface {...spec} setTheme={theme.bind} />;
}

export function createRowsSurfaceNode<T>(
  spec: RowsSurfaceSpec<T>,
  theme?: SolidThemeBridge<WorkbenchTheme>,
  colors: PanelThemeColors = (current: WorkbenchTheme): ReturnType<PanelThemeColors> => ({ background: current.surface, foreground: current.foreground }),
): SolidNode {
  if (theme === undefined) return () => <RowsSurface {...spec} />;
  return () => <ThemedRowsSurface {...spec} theme={theme} colors={colors} />;
}

type PanelThemeColors = (theme: WorkbenchTheme) => {
  readonly background: ThemeColor;
  readonly foreground: ThemeColor;
  readonly accent?: ThemeColor;
  readonly muted?: ThemeColor;
  readonly selectedBackground?: ThemeColor;
  readonly hoverBackground?: ThemeColor;
  readonly scrollForeground?: ThemeColor;
  readonly scrollBackground?: ThemeColor;
  readonly style?: HelixThemeStyle;
  readonly selectedStyle?: HelixThemeStyle;
  readonly headerStyle?: HelixThemeStyle;
};

export function ThemedRowsSurface<T>(props: RowsSurfaceSpec<T> & {
  readonly theme: SolidThemeBridge<WorkbenchTheme>;
  readonly colors?: PanelThemeColors;
}): JSX.Element {
  const { theme, colors = ((current: WorkbenchTheme): ReturnType<PanelThemeColors> => ({ background: current.surface, foreground: current.foreground })), ...spec } = props;
  return <RowsSurface {...spec} onTheme={setTheme => theme.subscribe(next => {
    const panel = colors(next);
    setTheme(panel.background, panel.foreground, panel.accent ?? next.accent, panel.muted ?? next.muted, panel.selectedBackground ?? next.surfaceActive, panel.hoverBackground ?? next.selectionSecondary ?? next.surfaceActive, panel.scrollForeground, panel.scrollBackground, panel.style, panel.selectedStyle, panel.headerStyle);
  })} />;
}

export { mountSolidRoot, type SolidNode };
