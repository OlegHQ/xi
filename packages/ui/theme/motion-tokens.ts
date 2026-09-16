import { parseColor, type RGBA } from '@opentui/core/renderer';

/** Paint mode selected by the terminal capability adapter or a deterministic fixture. */
export type EditorColorMode = 'truecolor' | 'ansi256' | 'no-color';
export type MotionTrailMode = 'off' | 'last-motion';

export interface MotionPaintTokens {
  readonly selectionPrimary: string;
  readonly selectionSecondary: string;
  readonly cursorPrimary: string;
  readonly cursorSecondary: string;
  readonly motionTrail: string;
  readonly operatorPreview: string;
}

export interface MotionPaintThemeSource {
  readonly selectionPrimary?: string;
  readonly selectionSecondary?: string;
  readonly cursorPrimary?: string;
  readonly cursorSecondary?: string;
  readonly motionTrail?: string;
  readonly operatorPreview?: string;
}

export const DEFAULT_MOTION_PAINT_TOKENS: MotionPaintTokens = Object.freeze({
  selectionPrimary: '#D6E5F2',
  selectionSecondary: '#E4ECF3',
  cursorPrimary: '#1A2835',
  cursorSecondary: '#405B72',
  motionTrail: '#EEF2F4',
  operatorPreview: '#C4D8E8',
});

/** Resolve optional theme tokens while retaining T034's small theme contract. */
export function resolveMotionPaintTokens(theme: MotionPaintThemeSource): MotionPaintTokens {
  return Object.freeze({
    selectionPrimary: theme.selectionPrimary ?? DEFAULT_MOTION_PAINT_TOKENS.selectionPrimary,
    selectionSecondary: theme.selectionSecondary ?? DEFAULT_MOTION_PAINT_TOKENS.selectionSecondary,
    cursorPrimary: theme.cursorPrimary ?? DEFAULT_MOTION_PAINT_TOKENS.cursorPrimary,
    cursorSecondary: theme.cursorSecondary ?? DEFAULT_MOTION_PAINT_TOKENS.cursorSecondary,
    motionTrail: theme.motionTrail ?? DEFAULT_MOTION_PAINT_TOKENS.motionTrail,
    operatorPreview: theme.operatorPreview ?? DEFAULT_MOTION_PAINT_TOKENS.operatorPreview,
  });
}

/** Convert a theme color to a stable 256-color approximation for terminal fallback. */
export function resolvePaintColor(value: string, mode: EditorColorMode): RGBA {
  const color = parseColor(value);
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
