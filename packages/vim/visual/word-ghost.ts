import type { DocumentSnapshot, Utf16Offset } from '../../document/src/index';

// Helix movement.rs word_move/range_to_target: half-open ranges, boundary-sensitive
// anchors, newline skipping and only the final word of a counted motion. Xi keeps
// this presentation range separate from its Vim cursor. Research/fixtures: T147.
export function wordGhostRange(snapshot: DocumentSnapshot, at: number, after: number, key: string, count: number): { start: number; end: number } | undefined {
  const backward = key === 'b' || key === 'B';
  const startTarget = key === 'w' || key === 'W';
  const big = key.endsWith('W') || key.endsWith('B') || key.endsWith('E');
  let anchor = backward ? after : at;
  let head = backward ? at : after;
  let windowStart = 0;
  let windowText = '';
  // Bounded source windows, never a whole-line/document copy or a slice per scalar.
  const unit = (offset: number): number => {
    if (offset < 0 || offset >= snapshot.lengthUtf16) return -1;
    if (offset < windowStart || offset >= windowStart + windowText.length) {
      let start = Math.max(0, offset - (backward ? 1024 : 1));
      let end = Math.min(snapshot.lengthUtf16, start + 2048);
      if (!snapshot.slice(start as Utf16Offset, start as Utf16Offset).ok) start -= 1;
      if (!snapshot.slice(end as Utf16Offset, end as Utf16Offset).ok) end += 1;
      const read = snapshot.slice(start as Utf16Offset, end as Utf16Offset);
      if (!read.ok) return -1;
      windowStart = start;
      windowText = read.value;
    }
    return windowText.charCodeAt(offset - windowStart);
  };
  const previous = (offset: number): number => {
    const last = unit(offset - 1);
    return offset - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1);
  };
  const codePoint = (offset: number): number => {
    const high = unit(offset);
    return high >= 0xd800 && high <= 0xdbff ? 0x10000 + (high - 0xd800) * 1024 + unit(offset + 1) - 0xdc00 : high;
  };
  for (let step = 0; step < count; step += 1) {
    if (backward ? head === 0 : head === snapshot.lengthUtf16) break;
    let prev = category(codePoint(backward ? head : previous(head)), big);
    while (backward ? head > 0 : head < snapshot.lengthUtf16) {
      const next = backward ? previous(head) : head;
      const scalar = codePoint(next);
      if (category(scalar, big) !== 0) break;
      prev = 0;
      head = backward ? next : head + (scalar > 0xffff ? 2 : 1);
    }
    if (prev === 0) anchor = head;
    const origin = head;
    while (backward ? head > 0 : head < snapshot.lengthUtf16) {
      const next = backward ? previous(head) : head;
      const scalar = codePoint(next);
      const nextCategory = category(scalar, big);
      const boundary = prev < 0 || (prev !== nextCategory && (startTarget ? nextCategory === 0 || nextCategory > 1 : prev > 1 || nextCategory === 0));
      if (boundary) {
        if (head === origin) anchor = head;
        else break;
      }
      prev = nextCategory;
      head = backward ? next : head + (scalar > 0xffff ? 2 : 1);
    }
  }
  return anchor === head ? undefined : { start: Math.min(anchor, head), end: Math.max(anchor, head) };
}

// EOL / whitespace / word / punctuation / other, matching helix-core/chars.rs.
function category(codePoint: number, big: boolean): number {
  // @xi-perf H1 ENGINE-STEP -- Unicode classification allocates one scalar string; ASCII uses numeric categories and source reads are windowed.
  if (codePoint < 0) return -1;
  if (codePoint === 10 || codePoint === 13 || codePoint === 11 || codePoint === 12 || codePoint === 0x85 || codePoint === 0x2028 || codePoint === 0x2029) return 0;
  if (codePoint === 32 || codePoint === 9) return 1;
  if (codePoint === 95 || codePoint >= 48 && codePoint <= 57 || codePoint >= 65 && codePoint <= 90 || codePoint >= 97 && codePoint <= 122) return 2;
  if (codePoint >= 33 && codePoint <= 126) return big ? 2 : 3;
  const scalar = String.fromCodePoint(codePoint);
  if (/\p{White_Space}/u.test(scalar)) return 1;
  if (/[\p{Alphabetic}\p{N}]/u.test(scalar)) return 2;
  if (/[\p{P}\p{Sm}\p{Sc}\p{Sk}]/u.test(scalar)) return big ? 2 : 3;
  return 4;
}
