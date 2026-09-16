import { cloneSerializedSelectionValue } from '../../contracts/src/index';
import type { Result, SerializedSelectionValue } from '../../document/src/index';

export const VIM_SELECTION_HISTORY_LIMIT = 100;
export const VIM_SELECTION_HISTORY_MAX_BYTES = 4 * 1024 * 1024;

export type SelectionOnlyHistoryFailure =
  | { readonly kind: 'nothing-to-undo' }
  | { readonly kind: 'nothing-to-redo' }
  | { readonly kind: 'unmappable-history' }
  | { readonly kind: 'history-state-mismatch' }
  | { readonly kind: 'invalid-history-state' }
  | { readonly kind: 'history-limit' };

interface SelectionHistoryEntry {
  readonly before: SerializedSelectionValue;
  readonly after: SerializedSelectionValue;
  readonly mappable: boolean;
  readonly retainedBytes: number;
}

/**
 * Bounded, branch-aware history for selection-only state. It is deliberately
 * independent of document revisions, dirty state and native text undo.
 * Stored payloads are validated JSON snapshots; selection coordinates retain
 * the selection owner's UTF-16 units and document identity/version fields.
 */
export class VimSelectionHistory {
  readonly #limit: number;
  #entries: SelectionHistoryEntry[] = [];
  #cursor = 0;
  #retainedBytes = 0;

  constructor(limit = VIM_SELECTION_HISTORY_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('invalid-selection-history-limit');
    this.#limit = limit;
  }

  get size(): number { return this.#entries.length; }
  get cursor(): number { return this.#cursor; }
  get retainedBytes(): number { return this.#retainedBytes; }

  record(before: unknown, after: unknown): Result<boolean, SelectionOnlyHistoryFailure> {
    const clonedBefore = cloneSerializedSelectionValue(before);
    const clonedAfter = cloneSerializedSelectionValue(after);
    if (!clonedBefore.ok || !clonedAfter.ok) return { ok: false, error: { kind: 'invalid-history-state' } };
    if (sameJsonValue(clonedBefore.value, clonedAfter.value)) return { ok: true, value: false };

    const retainedBytes = serializedBytes(clonedBefore.value) + serializedBytes(clonedAfter.value);
    if (retainedBytes > VIM_SELECTION_HISTORY_MAX_BYTES) {
      return { ok: false, error: { kind: 'history-limit' } };
    }

    for (const entry of this.#entries.splice(this.#cursor)) this.#retainedBytes -= entry.retainedBytes;
    this.#entries.push(Object.freeze({ before: clonedBefore.value, after: clonedAfter.value, mappable: true, retainedBytes }));
    this.#retainedBytes += retainedBytes;
    this.#cursor = this.#entries.length;
    while (this.#entries.length > this.#limit || this.#retainedBytes > VIM_SELECTION_HISTORY_MAX_BYTES) {
      const removed = this.#entries.shift();
      if (removed === undefined) break;
      this.#retainedBytes -= removed.retainedBytes;
      this.#cursor = Math.max(0, this.#cursor - 1);
    }
    return { ok: true, value: true };
  }

  undo(current: unknown): Result<SerializedSelectionValue, SelectionOnlyHistoryFailure> {
    if (this.#cursor === 0) return { ok: false, error: { kind: 'nothing-to-undo' } };
    const entry = this.#entries[this.#cursor - 1];
    if (entry === undefined) return { ok: false, error: { kind: 'nothing-to-undo' } };
    if (!entry.mappable) return { ok: false, error: { kind: 'unmappable-history' } };
    const clonedCurrent = cloneSerializedSelectionValue(current);
    if (!clonedCurrent.ok) return { ok: false, error: { kind: 'invalid-history-state' } };
    if (!sameJsonValue(clonedCurrent.value, entry.after)) return { ok: false, error: { kind: 'history-state-mismatch' } };
    this.#cursor -= 1;
    return { ok: true, value: entry.before };
  }

  redo(current: unknown): Result<SerializedSelectionValue, SelectionOnlyHistoryFailure> {
    if (this.#cursor >= this.#entries.length) return { ok: false, error: { kind: 'nothing-to-redo' } };
    const entry = this.#entries[this.#cursor];
    if (entry === undefined) return { ok: false, error: { kind: 'nothing-to-redo' } };
    if (!entry.mappable) return { ok: false, error: { kind: 'unmappable-history' } };
    const clonedCurrent = cloneSerializedSelectionValue(current);
    if (!clonedCurrent.ok) return { ok: false, error: { kind: 'invalid-history-state' } };
    if (!sameJsonValue(clonedCurrent.value, entry.before)) return { ok: false, error: { kind: 'history-state-mismatch' } };
    this.#cursor += 1;
    return { ok: true, value: entry.after };
  }

  /**
   * Move retained states through one committed text change. A failed mapping
   * marks just that transition as an explicit history boundary.
   */
  map(mapper: (value: SerializedSelectionValue) => Result<SerializedSelectionValue, unknown>): void {
    this.#retainedBytes = 0;
    this.#entries = this.#entries.map((entry) => {
      if (!entry.mappable) {
        this.#retainedBytes += entry.retainedBytes;
        return entry;
      }
      const before = mapper(entry.before);
      const after = mapper(entry.after);
      if (!before.ok || !after.ok) {
        this.#retainedBytes += entry.retainedBytes;
        return Object.freeze({ ...entry, mappable: false });
      }
      const clonedBefore = cloneSerializedSelectionValue(before.value);
      const clonedAfter = cloneSerializedSelectionValue(after.value);
      if (!clonedBefore.ok || !clonedAfter.ok) {
        this.#retainedBytes += entry.retainedBytes;
        return Object.freeze({ ...entry, mappable: false });
      }
      const retainedBytes = serializedBytes(clonedBefore.value) + serializedBytes(clonedAfter.value);
      this.#retainedBytes += retainedBytes;
      return Object.freeze({ before: clonedBefore.value, after: clonedAfter.value, mappable: true, retainedBytes });
    });
    while (this.#entries.length > this.#limit || this.#retainedBytes > VIM_SELECTION_HISTORY_MAX_BYTES) {
      const removed = this.#entries.shift();
      if (removed === undefined) break;
      this.#retainedBytes -= removed.retainedBytes;
      this.#cursor = Math.max(0, this.#cursor - 1);
    }
  }
}

function sameJsonValue(left: SerializedSelectionValue, right: SerializedSelectionValue): boolean {
  return stableJson(withoutGeneration(left)) === stableJson(withoutGeneration(right));
}

function withoutGeneration(value: SerializedSelectionValue): SerializedSelectionValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as { readonly [key: string]: SerializedSelectionValue };
  const normalized: Record<string, SerializedSelectionValue> = {};
  for (const key of Object.keys(record)) {
    if (key !== 'selectionGeneration') normalized[key] = record[key] as SerializedSelectionValue;
  }
  return normalized;
}

function stableJson(value: SerializedSelectionValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as { readonly [key: string]: SerializedSelectionValue };
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key] as SerializedSelectionValue)}`).join(',')}}`;
}

function serializedBytes(value: SerializedSelectionValue): number {
  return stableJson(value).length * 2;
}
