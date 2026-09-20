import { parseColor, RGBA } from '@opentui/core/renderer';
import { themeColor } from './color-input';
import type { ThemeColor } from './workbench-themes';

/** Paint mode selected by the terminal capability adapter or a deterministic fixture. */
export type EditorColorMode = 'truecolor' | 'ansi256' | 'no-color';
export type MotionTrailMode = 'off' | 'last-motion';

export interface MotionPaintTokens {
  readonly selectionPrimary: ThemeColor;
  readonly selectionSecondary: ThemeColor;
  readonly cursorPrimary: ThemeColor;
  readonly cursorSecondary: ThemeColor;
  /** Cursor background used when the cursor's cell also falls inside a visual selection,
   * so the two states blend into one readable color instead of the selection color
   * hiding under (or clashing with) the plain cursor color. */
  readonly cursorOnSelection: ThemeColor;
  readonly motionTrail: ThemeColor;
  readonly operatorPreview: ThemeColor;
  /** Background of workspace-search matches shown in the editor while the Search panel is open. */
  readonly searchMatch: ThemeColor;
}

export interface MotionPaintThemeSource {
  readonly background?: ThemeColor;
  readonly selectionPrimary?: ThemeColor;
  readonly selectionSecondary?: ThemeColor;
  readonly cursorPrimary?: ThemeColor;
  readonly cursorSecondary?: ThemeColor;
  readonly cursorOnSelection?: ThemeColor;
  readonly motionTrail?: ThemeColor;
  readonly operatorPreview?: ThemeColor;
  readonly searchMatch?: ThemeColor;
}

export const DEFAULT_MOTION_PAINT_TOKENS: MotionPaintTokens = Object.freeze({
  selectionPrimary: '#D6E5F2',
  selectionSecondary: '#E4ECF3',
  cursorPrimary: '#1A2835',
  cursorSecondary: '#405B72',
  cursorOnSelection: '#6B3FA0',
  motionTrail: '#EEF2F4',
  operatorPreview: '#C4D8E8',
  searchMatch: '#F5E3A1',
});

/** Resolve optional theme tokens while retaining T034's small theme contract. */
export function resolveMotionPaintTokens(theme: MotionPaintThemeSource): MotionPaintTokens {
  const neutral = theme.background ?? DEFAULT_MOTION_PAINT_TOKENS.selectionPrimary;
  const background = parseColor(themeColor(theme.background ?? neutral, 'bg'));
  const selection = parseColor(themeColor(theme.selectionPrimary ?? neutral, 'bg'));
  const trail = RGBA.fromValues(background.r * 0.65 + selection.r * 0.35,
    background.g * 0.65 + selection.g * 0.35, background.b * 0.65 + selection.b * 0.35, background.a);
  return Object.freeze({
    selectionPrimary: themeColor(theme.selectionPrimary ?? neutral, 'bg'),
    selectionSecondary: themeColor(theme.selectionSecondary ?? theme.background ?? DEFAULT_MOTION_PAINT_TOKENS.selectionSecondary, 'bg'),
    cursorPrimary: themeColor(theme.cursorPrimary ?? theme.background ?? DEFAULT_MOTION_PAINT_TOKENS.cursorPrimary, 'bg'),
    cursorSecondary: themeColor(theme.cursorSecondary ?? theme.background ?? DEFAULT_MOTION_PAINT_TOKENS.cursorSecondary, 'bg'),
    cursorOnSelection: themeColor(theme.cursorOnSelection ?? theme.selectionPrimary ?? neutral, 'bg'),
    motionTrail: themeColor(theme.motionTrail ?? trail, 'bg'),
    operatorPreview: themeColor(theme.operatorPreview ?? DEFAULT_MOTION_PAINT_TOKENS.operatorPreview, 'bg'),
    searchMatch: themeColor(theme.searchMatch ?? theme.background ?? DEFAULT_MOTION_PAINT_TOKENS.searchMatch, 'bg'),
  });
}

/** WCAG 2.x relative luminance of a resolved color (0..1). Shared by paint-time
 * cursor-foreground selection and tests/ui/t063-contrast.test.ts. */
function relativeLuminance(color: RGBA): number {
  const [r, g, b] = color.toInts();
  const channels = [r ?? 0, g ?? 0, b ?? 0].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** WCAG 2.x contrast ratio between two resolved colors. */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Channel-inverted ("photographic negative") copy of a resolved color. */
export function reverseColor(color: RGBA): RGBA {
  const [r, g, b] = color.toInts();
  const channel = (value: number): string => Math.max(0, Math.min(255, 255 - value)).toString(16).padStart(2, '0');
  return parseColor(`#${channel(r ?? 0)}${channel(g ?? 0)}${channel(b ?? 0)}`);
}

/**
 * Foreground for a real glyph painted under a solid cursor background: the token's own
 * color inverted, when that still reads clearly against the cursor color (>=4.5:1, WCAG AA
 * body text); otherwise whichever of the editor's foreground/background contrasts more.
 */
export function pickCursorForeground(tokenForeground: RGBA, cursorBackground: RGBA, themeForeground: RGBA, themeBackground: RGBA): RGBA {
  const reversed = reverseColor(tokenForeground);
  if (contrastRatio(reversed, cursorBackground) >= 4.5) return reversed;
  return contrastRatio(themeForeground, cursorBackground) >= contrastRatio(themeBackground, cursorBackground) ? themeForeground : themeBackground;
}

/** Convert a theme color to a stable 256-color approximation for terminal fallback. */
export function resolvePaintColor(value: ThemeColor, mode: EditorColorMode): RGBA {
  const color = parseColor(themeColor(value));
  if (mode !== 'ansi256') return color;
  const red = quantize256(color.r);
  const green = quantize256(color.g);
  const blue = quantize256(color.b);
  return parseColor(rgbHex(red, green, blue));
}

function quantize256(value: number): number {
  const level = Math.max(0, Math.min(5, Math.round((value / 255) * 5)));
  return Math.round(level * 255 / 5);
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}
