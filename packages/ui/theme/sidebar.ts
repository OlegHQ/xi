import { parseColor } from '@opentui/core/renderer';
import { helixThemeColor, themeColor } from './color-input';
import { readableTextColor } from './readability';
import { contrastRatio } from './motion-tokens';
import type { ThemeColor, WorkbenchTheme } from './workbench-themes';

const cache = new WeakMap<WorkbenchTheme, WorkbenchTheme>();

/** Sidebar navigation is persistent editor chrome, not a popup menu. Keep Helix's
 * original scopes intact; optional ui.sidebar scopes belong to Xi's adapter. */
export function sidebarTheme(theme: WorkbenchTheme): WorkbenchTheme {
  const cached = cache.get(theme);
  if (cached !== undefined) return cached;
  const surface = helixThemeColor(theme, 'ui.sidebar', 'bg', theme.background);
  const foreground = readableTextColor(helixThemeColor(theme, 'ui.sidebar', 'fg', theme.foreground), surface, theme.foreground);
  const surfaceActive = helixThemeColor(theme, 'ui.sidebar.selected', 'bg', helixThemeColor(theme, 'ui.text.focus', 'bg', theme.selectionPrimary ?? theme.surfaceActive));
  const hover = helixThemeColor(theme, 'ui.sidebar.hover', 'bg', helixThemeColor(theme, 'ui.cursorline.primary', 'bg', surfaceActive));
  const muted = helixThemeColor(theme, 'ui.sidebar.inactive', 'fg', theme.muted);
  const result = Object.freeze({
    ...theme, surface, surfaceActive, foreground, selectionSecondary: hover,
    muted: readableSidebarForeground(muted, foreground, [surface, surfaceActive, hover]),
  });
  cache.set(theme, result);
  return result;
}

export function readableSidebarForeground(muted: ThemeColor, foreground: ThemeColor, backgrounds: readonly ThemeColor[]): ThemeColor {
  // Indexed/default colors depend on the user's terminal palette. Preserve their intent;
  // the rendered audit reports unresolved pairs instead of inventing an RGB value.
  if (typeof muted !== 'string' || !muted.startsWith('#')) return muted;
  for (const background of backgrounds) {
    if (typeof background !== 'string' || !background.startsWith('#')) continue;
    if (contrastRatio(parseColor(themeColor(muted)), parseColor(themeColor(background, 'bg'))) < 4.5) return foreground;
  }
  return muted;
}
