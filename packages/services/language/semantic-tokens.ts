import type { Disposable, Result } from '../../contracts/src/index';

export interface SemanticTokenLegend { readonly tokenTypes: readonly string[]; readonly tokenModifiers: readonly string[]; }
export interface SemanticTokenSpan { readonly line: number; readonly startUtf16: number; readonly lengthUtf16: number; readonly tokenType: string; readonly modifiers: readonly string[]; }
export interface SemanticTokenRequest { readonly documentId: string; readonly documentVersion: number; readonly generation: number; readonly legend: SemanticTokenLegend; }
export interface SemanticTokenFullResult extends SemanticTokenRequest { readonly kind: 'full'; readonly data: readonly number[]; readonly resultId?: string; }
export interface SemanticTokenDeltaEdit { readonly start: number; readonly deleteCount: number; readonly data?: readonly number[]; }
export interface SemanticTokenDeltaResult extends SemanticTokenRequest { readonly kind: 'delta'; readonly previousResultId: string; readonly edits: readonly SemanticTokenDeltaEdit[]; readonly resultId: string; }
export interface SemanticTokenRangeResult extends SemanticTokenRequest { readonly kind: 'range'; readonly data: readonly number[]; readonly startLine: number; readonly endLine: number; }
export type SemanticTokenResult = SemanticTokenFullResult | SemanticTokenDeltaResult | SemanticTokenRangeResult;
export type SemanticTokenFailure = { readonly kind: 'stale' | 'invalid-delta' | 'legend-changed' | 'invalid-data' | 'disposed'; readonly message: string };
export interface SemanticTokenSnapshot { readonly documentId: string; readonly documentVersion: number; readonly generation: number; readonly spans: readonly SemanticTokenSpan[]; readonly resultId: string | undefined; readonly legend: SemanticTokenLegend; }

/** Applies versioned full/delta/range semantic token responses without touching documents. */
export class SemanticTokenStore implements Disposable {
  readonly #snapshots = new Map<string, SemanticTokenSnapshot>();
  #disposed = false;
  get(documentId: string): SemanticTokenSnapshot | undefined { return this.#snapshots.get(documentId); }

  apply(result: SemanticTokenResult): Result<SemanticTokenSnapshot, SemanticTokenFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'semantic token store is disposed' } };
    const current = this.#snapshots.get(result.documentId);
    if (current !== undefined && (result.generation < current.generation || result.documentVersion < current.documentVersion)) return { ok: false, error: { kind: 'stale', message: 'semantic tokens target an older document generation' } };
    if (current !== undefined && !sameLegend(current.legend, result.legend)) return { ok: false, error: { kind: 'legend-changed', message: 'semantic token legend changed; request a full result' } };
    let spans: readonly SemanticTokenSpan[];
    let resultId: string | undefined;
    if (result.kind === 'full' || result.kind === 'range') {
      const decoded = decodeData(result.data, result.legend, result.kind === 'range' ? result.startLine : 0);
      if (!decoded.ok) return decoded;
      spans = decoded.value; resultId = result.kind === 'full' ? result.resultId : current?.resultId;
    } else {
      if (current === undefined || current.resultId === undefined || current.resultId !== result.previousResultId) return { ok: false, error: { kind: 'invalid-delta', message: 'delta result has no matching full baseline' } };
      const encoded = encodeSpans(current.spans, result.legend);
      const next = applyDelta(encoded, result.edits);
      if (!next.ok) return next;
      const decoded = decodeData(next.value, result.legend, 0);
      if (!decoded.ok) return decoded;
      spans = decoded.value; resultId = result.resultId;
    }
    const snapshot: SemanticTokenSnapshot = Object.freeze({ documentId: result.documentId, documentVersion: result.documentVersion, generation: result.generation, spans: Object.freeze([...spans]), resultId, legend: freezeLegend(result.legend) });
    this.#snapshots.set(result.documentId, snapshot);
    return { ok: true, value: snapshot };
  }

  clear(documentId: string): void { this.#snapshots.delete(documentId); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#snapshots.clear(); }
}

function decodeData(data: readonly number[], legend: SemanticTokenLegend, baseLine: number): Result<readonly SemanticTokenSpan[], SemanticTokenFailure> {
  if (data.length % 5 !== 0) return { ok: false, error: { kind: 'invalid-data', message: 'semantic token data length must be divisible by five' } };
  const output: SemanticTokenSpan[] = []; let line = baseLine; let start = 0;
  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = data[index] ?? -1; const deltaStart = data[index + 1] ?? -1; const length = data[index + 2] ?? -1; const typeIndex = data[index + 3] ?? -1; const modifierBits = data[index + 4] ?? -1;
    if (![deltaLine, deltaStart, length, typeIndex, modifierBits].every((value) => Number.isSafeInteger(value) && value >= 0) || length === 0 || typeIndex >= legend.tokenTypes.length) return { ok: false, error: { kind: 'invalid-data', message: 'semantic token contains an invalid field' } };
    line += deltaLine; start = deltaLine === 0 ? start + deltaStart : deltaStart;
    const modifiers = legend.tokenModifiers.filter((_name, bit) => (modifierBits & (1 << bit)) !== 0);
    output.push(Object.freeze({ line, startUtf16: start, lengthUtf16: length, tokenType: legend.tokenTypes[typeIndex] ?? 'unknown', modifiers: Object.freeze(modifiers) }));
  }
  return { ok: true, value: Object.freeze(output) };
}

function encodeSpans(spans: readonly SemanticTokenSpan[], legend: SemanticTokenLegend): number[] {
  const output: number[] = []; let previousLine = 0; let previousStart = 0;
  for (const span of spans) { const deltaLine = span.line - previousLine; const deltaStart = deltaLine === 0 ? span.startUtf16 - previousStart : span.startUtf16; const type = Math.max(0, legend.tokenTypes.indexOf(span.tokenType)); let modifiers = 0; for (const modifier of span.modifiers) { const bit = legend.tokenModifiers.indexOf(modifier); if (bit >= 0 && bit < 31) modifiers |= 1 << bit; } output.push(deltaLine, deltaStart, span.lengthUtf16, type, modifiers); previousLine = span.line; previousStart = span.startUtf16; }
  return output;
}
function applyDelta(data: readonly number[], edits: readonly SemanticTokenDeltaEdit[]): Result<number[], SemanticTokenFailure> {
  const output = [...data]; let shift = 0;
  for (const edit of edits) { if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.deleteCount) || edit.start < 0 || edit.deleteCount < 0 || edit.start + edit.deleteCount > output.length) return { ok: false, error: { kind: 'invalid-delta', message: 'semantic token delta range is outside the baseline' } }; output.splice(edit.start + shift, edit.deleteCount, ...(edit.data ?? [])); shift += (edit.data?.length ?? 0) - edit.deleteCount; }
  return { ok: true, value: output };
}
function sameLegend(left: SemanticTokenLegend, right: SemanticTokenLegend): boolean { return left.tokenTypes.length === right.tokenTypes.length && left.tokenTypes.every((v, i) => v === right.tokenTypes[i]) && left.tokenModifiers.length === right.tokenModifiers.length && left.tokenModifiers.every((v, i) => v === right.tokenModifiers[i]); }
function freezeLegend(legend: SemanticTokenLegend): SemanticTokenLegend { return Object.freeze({ tokenTypes: Object.freeze([...legend.tokenTypes]), tokenModifiers: Object.freeze([...legend.tokenModifiers]) }); }
