import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseColor } from '@opentui/core/renderer';
import {
  ASCII_WORKBENCH_THEME,
  DARK_WORKBENCH_THEME,
  LIGHT_WORKBENCH_THEME,
  resolveMotionPaintTokens,
  themeColor,
  type ThemeColor,
  type WorkbenchTheme,
} from '../../packages/ui/src/index';
import { contrastRatio as rgbaContrastRatio, pickCursorForeground } from '../../packages/ui/theme/motion-tokens';

const themes: readonly { readonly name: string; readonly theme: WorkbenchTheme }[] = [
  { name: 'xi-light', theme: LIGHT_WORKBENCH_THEME },
  { name: 'xi-dark', theme: DARK_WORKBENCH_THEME },
  { name: 'xi-ascii', theme: ASCII_WORKBENCH_THEME },
];

const results: { readonly theme: string; readonly id: string; readonly ratio: number; readonly minimum: number }[] = [];

function check(themeName: string, id: string, foreground: ThemeColor, background: ThemeColor, minimum: number): void {
  const ratio = contrastRatio(foreground, background);
  assert.ok(ratio >= minimum, `T063-CONTRAST-${themeName}-${id} ratio ${ratio.toFixed(2)} >= ${minimum.toFixed(2)}`);
  results.push({ theme: themeName, id, ratio, minimum });
}

for (const { name, theme } of themes) {
  const paint = resolveMotionPaintTokens(theme);
  check(name, 'body-on-background', theme.foreground, theme.background, 4.5);
  check(name, 'muted-on-surface', theme.muted, theme.surface, 4.5);
  check(name, 'accent-on-background', theme.accent, theme.background, 4.5);
  check(name, 'error-on-background', theme.error, theme.background, 4.5);
  check(name, 'body-on-primary-selection', theme.foreground, paint.selectionPrimary, 4.5);
  check(name, 'body-on-secondary-selection', theme.foreground, paint.selectionSecondary, 4.5);
  // Cursor cells are non-text focus indicators. The painter uses the canvas
  // background as the marker glyph foreground in color modes.
  check(name, 'primary-cursor-marker', theme.background, paint.cursorPrimary, 3);
  check(name, 'secondary-cursor-marker', theme.background, paint.cursorSecondary, 3);

  // T063 follow-up: the Normal/Visual block cursor now paints the real glyph (see
  // packages/ui/editor/motion-paint.ts), so the token's own color -- not just the theme's
  // plain foreground/background -- must still read against the cursor's background once
  // `pickCursorForeground` (packages/ui/theme/motion-tokens.ts) resolves it.
  const cursorPrimary = parseColor(themeColor(paint.cursorPrimary, 'bg'));
  const themeForeground = parseColor(themeColor(theme.foreground));
  const themeBackground = parseColor(themeColor(theme.background, 'bg'));
  const tokenColors = [theme.foreground, theme.accent, ...Object.values(theme.syntax ?? {})];
  for (const [index, tokenColor] of tokenColors.entries()) {
    if (tokenColor === undefined) continue;
    const resolvedFg = pickCursorForeground(parseColor(themeColor(tokenColor)), cursorPrimary, themeForeground, themeBackground);
    check(name, `token-fg-under-cursor-${index}`, toHex(resolvedFg), paint.cursorPrimary, 3);
  }

  // Cursor-on-selection: the blended token must stay readable, using the same
  // contrast-resolution rule as a plain cursor.
  const cursorOnSelection = parseColor(themeColor(paint.cursorOnSelection, 'bg'));
  const onSelectionFg = pickCursorForeground(themeForeground, cursorOnSelection, themeForeground, themeBackground);
  check(name, 'cursor-on-selection-marker', toHex(onSelectionFg), paint.cursorOnSelection, 3);
}

const artifact = resolve(process.cwd(), '.artifacts/ui/t063-contrast.json');
await mkdir(resolve(process.cwd(), '.artifacts/ui'), { recursive: true });
await writeFile(artifact, `${JSON.stringify({ schemaVersion: 2, fixture: 'T063-CONTRAST-01', results }, null, 2)}\n`, 'utf8');
console.log(`T063 palette contrast passed ${results.length} checks across ${themes.length} themes; artifact=${artifact}`);

function toHex(color: ReturnType<typeof parseColor>): string {
  const [r, g, b] = color.toInts();
  const channel = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${channel(r ?? 0)}${channel(g ?? 0)}${channel(b ?? 0)}`;
}

function contrastRatio(foreground: ThemeColor, background: ThemeColor): number {
  return rgbaContrastRatio(parseColor(themeColor(foreground)), parseColor(themeColor(background, 'bg')));
}
