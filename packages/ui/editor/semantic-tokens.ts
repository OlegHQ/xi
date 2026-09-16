export interface SemanticDecoration { readonly line: number; readonly startUtf16: number; readonly endUtf16: number; readonly tokenType: string; readonly modifiers: readonly string[]; }
export interface SemanticReadModel { readonly documentVersion: number; readonly spans: readonly SemanticDecoration[]; }
/** Merge semantic decorations over syntax spans by range; semantic tokens remain paint metadata. */
export function projectSemanticRow(model: SemanticReadModel | undefined, line: number, startUtf16: number, endUtf16: number, maxSpans = 2048): readonly SemanticDecoration[] {
  if (model === undefined || model.spans.length === 0 || maxSpans <= 0) return Object.freeze([]);
  const output: SemanticDecoration[] = [];
  for (const span of model.spans) { if (span.line !== line || span.startUtf16 >= endUtf16 || span.endUtf16 <= startUtf16) continue; output.push(Object.freeze({ ...span, startUtf16: Math.max(startUtf16, span.startUtf16), endUtf16: Math.min(endUtf16, span.endUtf16) })); if (output.length >= maxSpans) break; }
  return Object.freeze(output);
}
