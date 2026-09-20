import { parseColor } from '@opentui/core/renderer';
import type { ThemeColor } from './workbench-themes';
import { contrastRatio } from './motion-tokens';

const cache = new Map<string, ThemeColor>();
const rgb = (color: ThemeColor): boolean => typeof color === 'string' ? color.startsWith('#') : color.intent === 'rgb';

/** Adapt UI text after its surface/state styles are composed; never rewrite source themes.
 * Indexed/default colors retain terminal intent because their actual palette is unknown. */
export function readableTextColor(candidate: ThemeColor, background: ThemeColor, fallback: ThemeColor): ThemeColor {
  if (!rgb(candidate) || !rgb(background) || !rgb(fallback)) return candidate;
  const key = `${candidate}|${background}|${fallback}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const bg = parseColor(background);
  const fg = parseColor(candidate);
  if (bg.a !== 1 || fg.a !== 1) return candidate;
  const result = contrastRatio(fg, bg) >= 4.5 ? candidate
    : contrastRatio(parseColor(fallback), bg) >= 4.5 ? fallback
      : contrastRatio(parseColor('#000000'), bg) >= contrastRatio(parseColor('#ffffff'), bg) ? '#000000' : '#ffffff';
  // ponytail: cap at 512 color pairs with clear-on-full; use per-theme caches if profiling shows switching churn.
  if (cache.size >= 512) cache.clear();
  cache.set(key, result);
  return result;
}
