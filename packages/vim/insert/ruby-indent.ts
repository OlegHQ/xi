import type { DocumentSnapshot } from '../../document/src/index';
import type { LineIndex, Utf16Offset } from '../../contracts/src/index';

/** Ruby's common line-oriented blocks; endless method definitions are already complete. */
export function rubyBlockOpener(text: string): boolean {
  const code = text.trim();
  if (/^[#'"`]/u.test(code) || /;\s*end\b/u.test(code)) return false;
  if (/^def\s+[\w.]+[!?]?(?:\([^\n]*\))?\s*=(?!=|~|>)/u.test(code)) return false;
  return /^(?:class|module|def|if|unless|case|begin|for|while|until)\b/u.test(code)
    || /\bdo(?:\s*\|[^|]*\|)?\s*(?:#.*)?$/u.test(code);
}

/** Find the indentation of the block closed by a newly typed, standalone `end`. */
export function rubyEndIndent(snapshot: DocumentSnapshot, lineStart: number): string | undefined {
  const current = snapshot.lineIndexAt(lineStart as Utf16Offset);
  if (!current.ok) return undefined;
  let depth = 0;
  let remaining = 8192;
  // ponytail: line-oriented Ruby blocks within 128 lines/8 Ki units; syntax-tree indent queries
  // are needed for multiline strings/heredocs and blocks spanning a wider context.
  for (let line = Number(current.value) - 1, count = 0; line >= 0 && count < 128; line -= 1, count += 1) {
    const start = snapshot.lineStartOffset(line as LineIndex);
    const end = snapshot.lineStartOffset((line + 1) as LineIndex);
    if (!start.ok || !end.ok || Number(end.value) - Number(start.value) > remaining) return undefined;
    remaining -= Number(end.value) - Number(start.value);
    const read = snapshot.slice(start.value, end.value);
    if (!read.ok) return undefined;
    const text = read.value.trim();
    if (/^end\b/u.test(text)) depth += 1;
    else if (rubyBlockOpener(text)) {
      if (depth === 0) return /^[ \t]*/u.exec(read.value)?.[0];
      depth -= 1;
    }
  }
  return undefined;
}
