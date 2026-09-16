export type Brand<T, Name extends string> = T & { readonly __xiBrand: Name };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type ViewId = Brand<string, 'ViewId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type ProviderId = Brand<string, 'ProviderId'>;
export type SelectionId = Brand<string, 'SelectionId'>;
export type DocumentVersion = Brand<number, 'DocumentVersion'>;
/** Identity of a content/history state; unlike DocumentVersion it may be restored by undo. */
export type RevisionId = Brand<number, 'RevisionId'>;
export type UndoGroupId = Brand<string, 'UndoGroupId'>;
export type SelectionGeneration = Brand<number, 'SelectionGeneration'>;
/** Zero-based UTF-16 code-unit offset into one document version. */
export type Utf16Offset = Brand<number, 'Utf16Offset'>;
/** Zero-based absolute UTF-8 byte offset into normalized document text. */
export type Utf8ByteOffset = Brand<number, 'Utf8ByteOffset'>;
/** Absolute Unicode scalar-value offset; this is not a grapheme or Vim character index. */
export type Utf32Offset = Brand<number, 'Utf32Offset'>;
/** Zero-based UTF-16 code-unit column within one logical line. */
export type Utf16Column = Brand<number, 'Utf16Column'>;
/** Zero-based UTF-8 byte column within one logical line. */
export type Utf8ByteColumn = Brand<number, 'Utf8ByteColumn'>;
/** Unicode scalar-value column; this is not a grapheme or Vim character index. */
export type Utf32Column = Brand<number, 'Utf32Column'>;
/** Zero-based logical line number in one document version. */
export type LineIndex = Brand<number, 'LineIndex'>;
/** Zero-based terminal display-cell column; width policy belongs to layout. */
export type CellColumn = Brand<number, 'CellColumn'>;

/**
 * JSON-shaped, feature-neutral selection intent retained by document undo history.
 * It carries no methods, prototypes, mutable references, or Vim/selections imports.
 */
export type SerializedSelectionValue = null | boolean | number | string
  | readonly SerializedSelectionValue[]
  | { readonly [key: string]: SerializedSelectionValue };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ValidationIssue {
  readonly path: string;
  readonly code: 'invalid-type' | 'invalid-value' | 'missing-field' | 'unknown-discriminant';
  readonly message: string;
}

const MAX_SELECTION_VALUE_DEPTH = 64;
const MAX_SELECTION_VALUE_NODES = 100_000;
const MAX_SELECTION_VALUE_STRING_LENGTH = 1_000_000;

/** Validate and defensively clone inert selection history data at the document boundary. */
export function cloneSerializedSelectionValue(value: unknown): Result<SerializedSelectionValue, ValidationIssue> {
  let visited = 0;
  const clone = (candidate: unknown, path: string, depth: number): Result<SerializedSelectionValue, ValidationIssue> => {
    visited += 1;
    if (visited > MAX_SELECTION_VALUE_NODES || depth > MAX_SELECTION_VALUE_DEPTH) {
      return { ok: false, error: { path, code: 'invalid-value', message: 'selection history value exceeds its structural limit' } };
    }
    if (candidate === null || typeof candidate === 'boolean') return { ok: true, value: candidate };
    if (typeof candidate === 'string') {
      return candidate.length <= MAX_SELECTION_VALUE_STRING_LENGTH
        ? { ok: true, value: candidate }
        : { ok: false, error: { path, code: 'invalid-value', message: 'selection history string is too long' } };
    }
    if (typeof candidate === 'number') {
      return Number.isFinite(candidate)
        ? { ok: true, value: Object.is(candidate, -0) ? 0 : candidate }
        : { ok: false, error: { path, code: 'invalid-value', message: 'selection history numbers must be finite' } };
    }
    if (typeof candidate !== 'object') {
      return { ok: false, error: { path, code: 'invalid-type', message: 'selection history values must be JSON data' } };
    }

    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype || candidate.length > MAX_SELECTION_VALUE_NODES) {
          return { ok: false, error: { path, code: 'invalid-value', message: 'selection history array is not plain JSON data' } };
        }
        const output: SerializedSelectionValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) {
            return { ok: false, error: { path: `${path}[${index}]`, code: 'invalid-value', message: 'selection history arrays cannot contain holes' } };
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            return { ok: false, error: { path: `${path}[${index}]`, code: 'invalid-value', message: 'selection history arrays cannot contain accessors' } };
          }
          const child = clone(descriptor.value, `${path}[${index}]`, depth + 1);
          if (!child.ok) return child;
          output.push(child.value);
        }
        const extraKeys = Reflect.ownKeys(candidate).filter((key) => key !== 'length'
          && !(typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < candidate.length));
        if (extraKeys.length !== 0) {
          return { ok: false, error: { path, code: 'invalid-value', message: 'selection history arrays cannot have extra properties' } };
        }
        return { ok: true, value: Object.freeze(output) };
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        return { ok: false, error: { path, code: 'invalid-value', message: 'selection history objects must be plain JSON data' } };
      }
      const ownKeys = Reflect.ownKeys(candidate);
      if (ownKeys.some((key) => typeof key !== 'string') || ownKeys.length > MAX_SELECTION_VALUE_NODES) {
        return { ok: false, error: { path, code: 'invalid-value', message: 'selection history objects may only have bounded string keys' } };
      }
      const output: Record<string, SerializedSelectionValue> = Object.create(null) as Record<string, SerializedSelectionValue>;
      for (const key of ownKeys as string[]) {
        if (key.length > MAX_SELECTION_VALUE_STRING_LENGTH) {
          return { ok: false, error: { path, code: 'invalid-value', message: 'selection history key is too long' } };
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          return { ok: false, error: { path: `${path}.${key}`, code: 'invalid-value', message: 'selection history objects cannot contain accessors or hidden properties' } };
        }
        const child = clone(descriptor.value, `${path}.${key}`, depth + 1);
        if (!child.ok) return child;
        output[key] = child.value;
      }
      return { ok: true, value: Object.freeze(output) };
    } catch {
      return { ok: false, error: { path, code: 'invalid-value', message: 'selection history data could not be inspected' } };
    }
  };
  return clone(value, 'selectionHistory', 0);
}

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface CancellationToken {
  readonly isCancelled: boolean;
  onCancel(listener: () => void): Disposable;
}

export class CancellationSource implements Disposable {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  readonly token: CancellationToken;

  constructor() {
    const source = this;
    this.token = {
      get isCancelled() {
        return source.cancelled;
      },
      onCancel(listener) {
        if (source.cancelled) {
          listener();
          return noOpDisposable;
        }
        source.listeners.add(listener);
        let active = true;
        return {
          dispose() {
            if (active) {
              active = false;
              source.listeners.delete(listener);
            }
          },
        };
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }

  dispose(): void {
    this.cancel();
  }
}

const noOpDisposable: Disposable = { dispose() {} };

/** Owns resources for one application/workspace/document/view/feature lifetime. */
export class DisposableScope implements Disposable {
  private readonly resources: Disposable[] = [];
  private readonly owned = new Set<Disposable>();
  private disposal: Promise<void> | undefined;

  get isDisposed(): boolean {
    return this.disposal !== undefined;
  }

  add<T extends Disposable>(resource: T): T {
    if (this.disposal !== undefined) throw new Error('scope-already-disposing');
    if (this.owned.has(resource)) throw new Error('resource-already-owned');
    this.owned.add(resource);
    this.resources.push(resource);
    return resource;
  }

  child(): DisposableScope {
    return this.add(new DisposableScope());
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.disposal = Promise.resolve().then(() => this.disposeOwnedResources());
    return this.disposal;
  }

  private async disposeOwnedResources(): Promise<void> {
    const failures: unknown[] = [];
    while (this.resources.length > 0) {
      const resource = this.resources.pop();
      if (resource === undefined) continue;
      try {
        await resource.dispose();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    this.owned.clear();
    if (failures.length > 0) throw new AggregateError(failures, 'scope-disposal-failed');
  }
}

/** A local typed signal. Its subscriptions are removable and can be scope-owned. */
export class ScopedSignal<T> implements Disposable {
  private readonly listeners = new Map<Disposable, (event: T) => void>();
  private disposed = false;

  subscribe(listener: (event: T) => void, owner: DisposableScope): Disposable {
    if (this.disposed) throw new Error('signal-disposed');
    const subscription: Disposable = {
      dispose: () => { this.listeners.delete(subscription); },
    };
    owner.add(subscription);
    this.listeners.set(subscription, listener);
    return subscription;
  }

  emit(event: T): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners.values()]) listener(event);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export const asIdentifier = <T extends string>(value: unknown, label: string): Result<T, ValidationIssue> => {
  if (typeof value !== 'string') {
    return { ok: false, error: { path: label, code: 'invalid-type', message: `${label} must be a string` } };
  }
  if (value.length === 0 || value.trim() !== value || value.includes('\0')) {
    return { ok: false, error: { path: label, code: 'invalid-value', message: `${label} must be a nonempty trimmed identifier` } };
  }
  return { ok: true, value: value as T };
};

export const asDocumentVersion = (value: unknown): Result<DocumentVersion, ValidationIssue> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: { path: 'documentVersion', code: 'invalid-value', message: 'documentVersion must be a nonnegative safe integer' } };
  }
  return { ok: true, value: value as DocumentVersion };
};

export const asRevisionId = (value: unknown): Result<RevisionId, ValidationIssue> =>
  asNonnegativeInteger<RevisionId>(value, 'revisionId');

export const asUndoGroupId = (value: unknown): Result<UndoGroupId, ValidationIssue> => {
  return asIdentifier<UndoGroupId>(value, 'undoGroupId');
};

export const asUtf16Offset = (value: unknown): Result<Utf16Offset, ValidationIssue> =>
  asNonnegativeInteger<Utf16Offset>(value, 'utf16Offset');

export const asUtf8ByteOffset = (value: unknown): Result<Utf8ByteOffset, ValidationIssue> =>
  asNonnegativeInteger<Utf8ByteOffset>(value, 'utf8ByteOffset');

export const asUtf32Offset = (value: unknown): Result<Utf32Offset, ValidationIssue> =>
  asNonnegativeInteger<Utf32Offset>(value, 'utf32Offset');

export const asUtf16Column = (value: unknown): Result<Utf16Column, ValidationIssue> =>
  asNonnegativeInteger<Utf16Column>(value, 'utf16Column');

export const asUtf8ByteColumn = (value: unknown): Result<Utf8ByteColumn, ValidationIssue> =>
  asNonnegativeInteger<Utf8ByteColumn>(value, 'utf8ByteColumn');

export const asUtf32Column = (value: unknown): Result<Utf32Column, ValidationIssue> =>
  asNonnegativeInteger<Utf32Column>(value, 'utf32Column');

export const asLineIndex = (value: unknown): Result<LineIndex, ValidationIssue> =>
  asNonnegativeInteger<LineIndex>(value, 'lineIndex');

export const asCellColumn = (value: unknown): Result<CellColumn, ValidationIssue> =>
  asNonnegativeInteger<CellColumn>(value, 'cellColumn');

function asNonnegativeInteger<T extends number>(value: unknown, label: string): Result<T, ValidationIssue> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: { path: label, code: 'invalid-value', message: `${label} must be a nonnegative safe integer` } };
  }
  return { ok: true, value: value as T };
}
