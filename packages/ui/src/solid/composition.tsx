/** @jsxImportSource @opentui/solid */
import type { JSX } from '@opentui/solid';
import type { Disposable } from '../../../contracts/src/index';
import type { WorkbenchTheme } from '../workbench';
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
  colors: (theme: WorkbenchTheme) => { readonly background: string; readonly foreground: string } = current => ({ background: current.surface, foreground: current.foreground }),
): SolidNode {
  if (theme === undefined) return () => <RowsSurface {...spec} />;
  return () => <ThemedRowsSurface {...spec} theme={theme} colors={colors} />;
}

export function ThemedRowsSurface<T>(props: RowsSurfaceSpec<T> & {
  readonly theme: SolidThemeBridge<WorkbenchTheme>;
  readonly colors?: (theme: WorkbenchTheme) => { readonly background: string; readonly foreground: string };
}): JSX.Element {
  const { theme, colors = current => ({ background: current.surface, foreground: current.foreground }), ...spec } = props;
  return <RowsSurface {...spec} onTheme={setTheme => theme.subscribe(next => {
    const panel = colors(next);
    setTheme(panel.background, panel.foreground, next.accent, next.muted, next.surfaceActive, next.selectionSecondary ?? next.surfaceActive);
  })} />;
}

export { mountSolidRoot, type SolidNode };
