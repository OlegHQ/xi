import type { CellWidthPolicy } from './types';

export interface GraphemeCluster {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function splitGraphemes(text: string): readonly GraphemeCluster[] {
  const clusters: GraphemeCluster[] = [];
  let previousScalar = '';
  let start = 0;
  let offset = 0;
  let regionalCount = 0;
  for (const scalar of text) {
    const nextOffset = offset + scalar.length;
    if (offset === 0) {
      start = offset;
      regionalCount = isRegionalIndicator(scalar) ? 1 : 0;
    } else if (joinsCluster(previousScalar, scalar, regionalCount)) {
      if (isRegionalIndicator(scalar)) regionalCount += 1;
      else if (scalar !== '\u200d' && !isExtender(scalar)) regionalCount = 0;
    } else {
      clusters.push(Object.freeze({ text: text.slice(start, offset), start, end: offset }));
      start = offset;
      regionalCount = isRegionalIndicator(scalar) ? 1 : 0;
    }
    previousScalar = scalar;
    offset = nextOffset;
  }
  if (offset > 0) clusters.push(Object.freeze({ text: text.slice(start, offset), start, end: offset }));
  return Object.freeze(clusters);
}

function joinsCluster(previous: string, next: string, regionalCount: number): boolean {
  if (isExtender(next) || next === '\u200d' || previous === '\u200d') return true;
  return isRegionalIndicator(next) && regionalCount === 1;
}

function isExtender(value: string): boolean {
  return /\p{M}/u.test(value)
    || /\p{Emoji_Modifier}/u.test(value)
    || isVariationSelector(value)
    || isEmojiTag(value);
}

function isVariationSelector(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isEmojiTag(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code >= 0xe0020 && code <= 0xe007f;
}

function isRegionalIndicator(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

function defaultClusterWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  if (cluster.includes('\u200d') || /\p{Extended_Pictographic}/u.test(cluster)
    || /\p{Emoji_Modifier}/u.test(cluster) || /\uFE0F/u.test(cluster)
    || /\u20E3/u.test(cluster) || Array.from(cluster).filter(isRegionalIndicator).length >= 2) return 2;
  let width = 0;
  for (const scalar of cluster) {
    if (isExtender(scalar) || scalar === '\u200d') continue;
    const code = scalar.codePointAt(0) ?? 0;
    if (isWideCodePoint(code)) return 2;
    width = Math.max(width, 1);
  }
  return width;
}

function isWideCodePoint(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x20000 && code <= 0x3fffd)
  );
}

export const DEFAULT_WIDTH_POLICY: CellWidthPolicy = Object.freeze({
  id: 'xi-default-terminal-width',
  generation: 1,
  widthOfCluster: defaultClusterWidth,
});

/** Default deterministic width policy: combining marks are zero-width, East Asian and emoji are two. */
export function defaultCellWidthPolicy(): CellWidthPolicy {
  return DEFAULT_WIDTH_POLICY;
}
