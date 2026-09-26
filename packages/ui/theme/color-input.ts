import { RGBA } from '@opentui/core/renderer';
import { helixThemeStyle, type HelixThemeStyle, type ThemeColor, type WorkbenchTheme } from './workbench-themes';

type UnderlineStyle = 'line' | 'curl' | 'dashed' | 'dotted' | 'double_line';

export interface HelixTextAttributes {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly underlineStyle?: UnderlineStyle;
  readonly underlineColor?: ThemeColor;
  readonly strikethrough: boolean;
  readonly dim: boolean;
  readonly reverse: boolean;
  readonly blink: boolean;
  readonly rapidBlink: boolean;
  readonly hidden: boolean;
}

/** Convert private service sentinels for Helix's terminal palette names only at the renderer
 * boundary, preserving the indexed/default intent OpenTUI uses when emitting terminal SGR. */
export function themeColor(value: ThemeColor, channel: 'fg' | 'bg' = 'fg'): ThemeColor {
  if (typeof value !== 'string') return value;
  const indexed = /^\u0000xi-terminal-index:(\d+)$/u.exec(value);
  if (indexed !== null) return RGBA.fromIndex(Number(indexed[1]));
  if (value === '\u0000xi-terminal-default') return channel === 'bg' ? RGBA.defaultBackground() : RGBA.defaultForeground();
  return value;
}

export function helixThemeColor(theme: WorkbenchTheme, scope: string, channel: 'fg' | 'bg', fallback: ThemeColor): ThemeColor {
  return themeColor(helixThemeStyle(theme, scope)?.[channel] ?? fallback, channel);
}

export function helixTextAttributes(style: Pick<HelixThemeStyle, 'modifiers' | 'underline'> | undefined): HelixTextAttributes {
  const modifiers = style?.modifiers;
  const candidate = style?.underline?.style;
  const underlineStyle: UnderlineStyle | undefined = candidate === 'line' || candidate === 'curl' || candidate === 'dashed'
    || candidate === 'dotted' || candidate === 'double_line' ? candidate : undefined;
  const underlineColor = style?.underline?.color;
  return {
    bold: modifiers?.includes('bold') === true,
    italic: modifiers?.includes('italic') === true,
    underline: underlineStyle !== undefined || modifiers?.includes('underlined') === true,
    ...(underlineStyle === undefined ? {} : { underlineStyle }),
    ...(underlineColor === undefined ? {} : { underlineColor: themeColor(underlineColor) }),
    strikethrough: modifiers?.includes('crossed_out') === true,
    dim: modifiers?.includes('dim') === true,
    reverse: modifiers?.includes('reversed') === true,
    blink: modifiers?.includes('slow_blink') === true,
    rapidBlink: modifiers?.includes('rapid_blink') === true,
    hidden: modifiers?.includes('hidden') === true,
  };
}
