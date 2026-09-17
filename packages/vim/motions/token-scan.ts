/** Generic token-boundary scan: given `text`, a zero-based `cursor` offset into it, and a
 * caller-supplied character classifier, returns the `[start, end)` bounds of the run of
 * classifier-matching characters containing `cursor`, or `undefined` when the character at
 * `cursor` does not match. Vim owns this scan (word/token boundary semantics); callers such as
 * `gf`/tag host commands supply their own classifier (filename-token characters, not
 * `iskeyword`) and only handle document-to-text extraction themselves. */
export function tokenBoundsAt(
  text: string,
  cursor: number,
  isTokenCharacter: (character: string) => boolean,
): { readonly start: number; readonly end: number } | undefined {
  // @xi-perf H0 DOC-COORDINATES -- Scalar token-boundary scan bounded to the run containing cursor; numeric locals only.
  if (cursor < 0 || cursor >= text.length || !isTokenCharacter(text[cursor] ?? '')) return undefined;
  let start = cursor;
  while (start > 0 && isTokenCharacter(text[start - 1] ?? '')) start -= 1;
  let end = cursor + 1;
  while (end < text.length && isTokenCharacter(text[end] ?? '')) end += 1;
  return { start, end };
}
