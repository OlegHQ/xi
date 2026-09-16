import type { CancellationToken, ClipboardPort, PlatformFailure } from '../../contracts/src/index';
import type { DocumentEdit, DocumentSnapshot, LineIndex, Result, Utf16Offset } from '../../document/src/index';
import { normalizeAtomicEdits } from '../transactions/multi-command';

/** Vim's register name vocabulary, including the unnamed and black-hole names. */
export type VimRegisterName = '"' | '-' | '_' | '+' | '*' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | `${UppercaseLetter}` | `${LowercaseLetter}`;
type UppercaseLetter = 'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H'|'I'|'J'|'K'|'L'|'M'|'N'|'O'|'P'|'Q'|'R'|'S'|'T'|'U'|'V'|'W'|'X'|'Y'|'Z';
type LowercaseLetter = Lowercase<UppercaseLetter>;

export type VimRegisterType = 'characterwise' | 'linewise' | 'blockwise';

export interface VimRegisterValue {
  readonly lines: readonly string[];
  readonly type: VimRegisterType;
  /** Display-cell width for blockwise values. Required only for blockwise data. */
  readonly blockWidth?: number;
}

/** Ordered fragments captured by one multi-cursor command. */
export interface VimRegisterVector {
  readonly fragments: readonly VimRegisterValue[];
  /** Fragment that is mirrored by the native scalar register value. */
  readonly primaryIndex: number;
}

export interface VimRegisterVectorWrite {
  readonly name: VimRegisterName;
  readonly vector: VimRegisterVector;
  /** Uppercase named writes append corresponding fragments. */
  readonly append?: boolean;
}

export interface VimRegisterWrite {
  readonly name: VimRegisterName;
  readonly value: VimRegisterValue;
  /** Uppercase named writes append to the corresponding lowercase register. */
  readonly append?: boolean;
}

export type VimRegisterFailure =
  | { readonly kind: 'invalid-register-name' }
  | { readonly kind: 'invalid-register-value' }
  | { readonly kind: 'invalid-block-width' }
  | { readonly kind: 'invalid-register-vector' }
  | { readonly kind: 'empty-register-vector' }
  | { readonly kind: 'invalid-primary-index' }
  | { readonly kind: 'mixed-register-types'; readonly expected: VimRegisterType; readonly actual: VimRegisterType }
  | { readonly kind: 'vector-arity-mismatch'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'black-hole-read' };

export interface VimRegisterSnapshot {
  readonly generation: number;
  readonly values: ReadonlyMap<VimRegisterName, VimRegisterValue>;
  readonly vectors: ReadonlyMap<VimRegisterName, VimRegisterVector>;
}

const registerNames: readonly VimRegisterName[] = [
  '"', '-', '_', '+', '*', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  ...('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' as unknown as readonly VimRegisterName[]),
];

const emptyValue: VimRegisterValue = Object.freeze({ lines: Object.freeze([]), type: 'characterwise' });

/**
 * Immutable Vim register state. Register writes return a new bank, which lets
 * command preparation fail without losing a prior yank or delete.
 */
export class VimRegisterBank {
  readonly #values: ReadonlyMap<VimRegisterName, VimRegisterValue>;
  readonly #vectors: ReadonlyMap<VimRegisterName, VimRegisterVector>;
  readonly generation: number;

  constructor(
    values?: ReadonlyMap<VimRegisterName, VimRegisterValue>,
    generation = 0,
    vectors?: ReadonlyMap<VimRegisterName, VimRegisterVector>,
  ) {
    this.#values = cloneValues(values ?? new Map());
    this.#vectors = cloneVectors(vectors ?? new Map());
    this.generation = generation;
    Object.freeze(this);
  }

  snapshot(): VimRegisterSnapshot {
    return Object.freeze({ generation: this.generation, values: this.#values, vectors: this.#vectors });
  }

  read(name: VimRegisterName): Result<VimRegisterValue, VimRegisterFailure> {
    if (!isRegisterName(name)) return { ok: false, error: { kind: 'invalid-register-name' } };
    if (name === '_') return { ok: false, error: { kind: 'black-hole-read' } };
    return { ok: true, value: this.#values.get(name) ?? emptyValue };
  }

  /** Read Xi's vector metadata; an absent vector is distinct from a singleton scalar. */
  readVector(name: VimRegisterName): Result<VimRegisterVector | undefined, VimRegisterFailure> {
    if (!isRegisterName(name)) return { ok: false, error: { kind: 'invalid-register-name' } };
    if (name === '_') return { ok: false, error: { kind: 'black-hole-read' } };
    return { ok: true, value: this.#vectors.get(name) };
  }

  /** Read vector metadata, or represent an ordinary scalar as one fragment. */
  readVectorOrScalar(name: VimRegisterName): Result<VimRegisterVector, VimRegisterFailure> {
    const vector = this.readVector(name);
    if (!vector.ok) return vector;
    if (vector.value !== undefined) return { ok: true, value: vector.value };
    const scalar = this.read(name);
    if (!scalar.ok) return scalar;
    return { ok: true, value: singletonVector(scalar.value) };
  }

  /** Write a value to a named register, applying uppercase append semantics. */
  write(write: VimRegisterWrite): Result<VimRegisterBank, VimRegisterFailure> {
    const checked = normalizeValue(write.value);
    if (!checked.ok) return checked;
    if (!isRegisterName(write.name)) return { ok: false, error: { kind: 'invalid-register-name' } };
    if (write.name === '_') return { ok: true, value: this }; // black-hole discards by definition
    const destination = isUppercaseNamedRegister(write.name) ? write.name.toLowerCase() as VimRegisterName : write.name;
    const shouldAppend = write.append === true || isUppercaseNamedRegister(write.name);
    const values = new Map(this.#values);
    const vectors = new Map(this.#vectors);
    const prior = values.get(destination);
    values.set(destination, shouldAppend && prior !== undefined ? appendValues(prior, checked.value) : checked.value);
    clearVectors(vectors, destination);
    if (destination !== '"') {
      values.set('"', values.get(destination) ?? checked.value);
      clearVectors(vectors, '"');
    }
    return { ok: true, value: new VimRegisterBank(values, this.generation + 1, vectors) };
  }

  /** Yank writes unnamed and register 0, with an optional explicit destination. */
  yank(value: VimRegisterValue, destination: VimRegisterName = '"'): Result<VimRegisterBank, VimRegisterFailure> {
    const checked = normalizeValue(value);
    if (!checked.ok) return checked;
    if (!isRegisterName(destination)) return { ok: false, error: { kind: 'invalid-register-name' } };
    if (destination === '_') return { ok: true, value: this };
    const values = new Map(this.#values);
    const vectors = new Map(this.#vectors);
    const named = isUppercaseNamedRegister(destination) ? destination.toLowerCase() as VimRegisterName : destination;
    const append = isUppercaseNamedRegister(destination);
    const next = append && values.has(named) ? appendValues(values.get(named)!, checked.value) : checked.value;
    if (destination === '"') {
      values.set('"', next);
      values.set('0', next);
      clearVectors(vectors, '"');
      clearVectors(vectors, '0');
    } else {
      values.set(named, next);
      values.set('"', next);
      clearVectors(vectors, named);
      clearVectors(vectors, '"');
    }
    return { ok: true, value: new VimRegisterBank(values, this.generation + 1, vectors) };
  }

  /** Capture ordered fragments once for a multi-cursor yank command. */
  yankMany(
    fragments: readonly VimRegisterValue[],
    destination: VimRegisterName = '"',
    primaryIndex = 0,
  ): Result<VimRegisterBank, VimRegisterFailure> {
    const vector = normalizeVector({ fragments, primaryIndex });
    if (!vector.ok) return vector;
    if (vector.value.fragments.length === 1) {
      const fragment = vector.value.fragments[0];
      if (fragment === undefined) return { ok: false, error: { kind: 'empty-register-vector' } };
      return this.yank(fragment, destination);
    }
    return this.writeVector({ name: destination, vector: vector.value });
  }

  /** Delete writes unnamed, rotates 1..9, or writes the small-delete register. */
  delete(value: VimRegisterValue, options: { readonly destination?: VimRegisterName; readonly small?: boolean } = {}): Result<VimRegisterBank, VimRegisterFailure> {
    const checked = normalizeValue(value);
    if (!checked.ok) return checked;
    const destination = options.destination ?? '"';
    if (!isRegisterName(destination)) return { ok: false, error: { kind: 'invalid-register-name' } };
    if (destination === '_') return { ok: true, value: this };
    const values = new Map(this.#values);
    const vectors = new Map(this.#vectors);
    const named = isUppercaseNamedRegister(destination) ? destination.toLowerCase() as VimRegisterName : destination;
    if (options.small === true || destination === '-') {
      values.set('-', checked.value);
      clearVectors(vectors, '-');
    } else if (destination === '"') {
      for (let index = 9; index >= 2; index -= 1) {
        const target = String(index) as VimRegisterName;
        const source = String(index - 1) as VimRegisterName;
        values.set(target, values.get(source) ?? emptyValue);
        copyVector(vectors, source, target);
      }
      values.set('1', checked.value);
      clearVectors(vectors, '1');
    }
    values.set('"', checked.value);
    clearVectors(vectors, '"');
    if (named !== '"') {
      const appended = isUppercaseNamedRegister(destination) && values.has(named)
        ? appendValues(values.get(named)!, checked.value)
        : checked.value;
      values.set(named, appended);
      values.set('"', appended);
      clearVectors(vectors, named);
      clearVectors(vectors, '"');
    }
    return { ok: true, value: new VimRegisterBank(values, this.generation + 1, vectors) };
  }

  /** Capture ordered fragments once for a multi-cursor delete command. */
  deleteMany(
    fragments: readonly VimRegisterValue[],
    options: { readonly destination?: VimRegisterName; readonly small?: boolean; readonly primaryIndex?: number } = {},
  ): Result<VimRegisterBank, VimRegisterFailure> {
    const vector = normalizeVector({ fragments, primaryIndex: options.primaryIndex ?? 0 });
    if (!vector.ok) return vector;
    if (vector.value.fragments.length === 1) {
      const fragment = vector.value.fragments[0];
      if (fragment === undefined) return { ok: false, error: { kind: 'empty-register-vector' } };
      return this.delete(fragment, options);
    }
    if (options.small === true || options.destination === '-') {
      return this.writeVector({ name: '-', vector: vector.value });
    }
    const destination = options.destination ?? '"';
    if (destination !== '"') return this.writeVector({ name: destination, vector: vector.value, append: isUppercaseNamedRegister(destination) });
    const current = this.snapshot();
    const values = new Map(current.values);
    const vectors = new Map(current.vectors);
    for (let index = 9; index >= 2; index -= 1) {
      const target = String(index) as VimRegisterName;
      const source = String(index - 1) as VimRegisterName;
      const prior = vectors.get(source);
      if (prior === undefined) vectors.delete(target);
      else { vectors.set(target, prior); values.set(target, prior.fragments[prior.primaryIndex] ?? emptyValue); }
    }
    vectors.set('1', vector.value);
    values.set('1', vector.value.fragments[vector.value.primaryIndex] ?? emptyValue);
    setVector(values, vectors, '"', vector.value);
    return { ok: true, value: new VimRegisterBank(values, this.generation + 1, vectors) };
  }

  /** Write vector metadata and mirror its primary fragment in the native scalar register. */
  writeVector(write: VimRegisterVectorWrite): Result<VimRegisterBank, VimRegisterFailure> {
    const checked = normalizeVector(write.vector);
    if (!checked.ok) return checked;
    if (!isRegisterName(write.name)) return { ok: false, error: { kind: 'invalid-register-name' } };
    if (write.name === '_') return { ok: true, value: this };
    const destination = isUppercaseNamedRegister(write.name) ? write.name.toLowerCase() as VimRegisterName : write.name;
    const shouldAppend = write.append === true || isUppercaseNamedRegister(write.name);
    const next = shouldAppend
      ? appendVectorToExisting(this, destination, checked.value)
      : { ok: true as const, value: checked.value };
    if (!next.ok) return next;
    const values = new Map(this.#values);
    const vectors = new Map(this.#vectors);
    setVector(values, vectors, destination, next.value);
    if (destination !== '"') setVector(values, vectors, '"', next.value);
    return { ok: true, value: new VimRegisterBank(values, this.generation + 1, vectors) };
  }

  /** Replace a bank's clipboard-facing register without touching internal yanks. */
  withClipboardValue(value: VimRegisterValue): Result<VimRegisterBank, VimRegisterFailure> {
    return this.write({ name: '+', value });
  }
}

export function createVimRegisterBank(initial?: Readonly<Record<string, VimRegisterValue>>): VimRegisterBank {
  if (initial === undefined) return new VimRegisterBank();
  const values = new Map<VimRegisterName, VimRegisterValue>();
  for (const [name, value] of Object.entries(initial)) {
    if (!isRegisterName(name)) continue;
    const checked = normalizeValue(value);
    if (checked.ok) values.set(name, checked.value);
  }
  return new VimRegisterBank(values);
}

export function isRegisterName(value: string): value is VimRegisterName {
  return registerNames.includes(value as VimRegisterName);
}

export function isUppercaseNamedRegister(name: VimRegisterName): boolean {
  return name.length === 1 && name >= 'A' && name <= 'Z';
}

function normalizeValue(value: VimRegisterValue): Result<VimRegisterValue, VimRegisterFailure> {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.lines)
    || !value.lines.every((line) => typeof line === 'string')
    || !['characterwise', 'linewise', 'blockwise'].includes(value.type)) {
    return { ok: false, error: { kind: 'invalid-register-value' } };
  }
  if (value.type === 'blockwise' && (!Number.isSafeInteger(value.blockWidth) || (value.blockWidth as number) < 1)) {
    return { ok: false, error: { kind: 'invalid-block-width' } };
  }
  return { ok: true, value: Object.freeze({
    lines: Object.freeze([...value.lines]),
    type: value.type,
    ...(value.blockWidth === undefined ? {} : { blockWidth: value.blockWidth }),
  }) };
}

function cloneValues(values: ReadonlyMap<VimRegisterName, VimRegisterValue>): ReadonlyMap<VimRegisterName, VimRegisterValue> {
  const result = new Map<VimRegisterName, VimRegisterValue>();
  for (const [name, value] of values) {
    const checked = normalizeValue(value);
    if (checked.ok) result.set(name, checked.value);
  }
  return result;
}

function cloneVectors(vectors: ReadonlyMap<VimRegisterName, VimRegisterVector>): ReadonlyMap<VimRegisterName, VimRegisterVector> {
  const result = new Map<VimRegisterName, VimRegisterVector>();
  for (const [name, vector] of vectors) {
    const checked = normalizeVector(vector);
    if (checked.ok) result.set(name, checked.value);
  }
  return result;
}

function normalizeVector(vector: VimRegisterVector): Result<VimRegisterVector, VimRegisterFailure> {
  if (vector === null || typeof vector !== 'object' || !Array.isArray(vector.fragments)) {
    return { ok: false, error: { kind: 'invalid-register-vector' } };
  }
  if (vector.fragments.length === 0) return { ok: false, error: { kind: 'empty-register-vector' } };
  if (!Number.isSafeInteger(vector.primaryIndex)
    || vector.primaryIndex < 0 || vector.primaryIndex >= vector.fragments.length) {
    return { ok: false, error: { kind: 'invalid-primary-index' } };
  }
  const fragments: VimRegisterValue[] = [];
  let expectedType: VimRegisterType | undefined;
  for (const fragment of vector.fragments) {
    const checked = normalizeValue(fragment);
    if (!checked.ok) return checked;
    if (expectedType !== undefined && checked.value.type !== expectedType) {
      return { ok: false, error: { kind: 'mixed-register-types', expected: expectedType, actual: checked.value.type } };
    }
    expectedType = checked.value.type;
    fragments.push(checked.value);
  }
  return { ok: true, value: Object.freeze({ fragments: Object.freeze(fragments), primaryIndex: vector.primaryIndex }) };
}

function singletonVector(value: VimRegisterValue): VimRegisterVector {
  return Object.freeze({ fragments: Object.freeze([value]), primaryIndex: 0 });
}

function clearVectors(vectors: Map<VimRegisterName, VimRegisterVector>, ...names: readonly VimRegisterName[]): void {
  for (const name of names) vectors.delete(name);
}

function copyVector(vectors: Map<VimRegisterName, VimRegisterVector>, source: VimRegisterName, target: VimRegisterName): void {
  const vector = vectors.get(source);
  if (vector === undefined) vectors.delete(target);
  else vectors.set(target, vector);
}

function setVector(
  values: Map<VimRegisterName, VimRegisterValue>,
  vectors: Map<VimRegisterName, VimRegisterVector>,
  name: VimRegisterName,
  vector: VimRegisterVector,
): void {
  const primary = vector.fragments[vector.primaryIndex];
  if (primary === undefined) throw new Error('register-vector-primary-missing');
  vectors.set(name, vector);
  values.set(name, primary);
}

function appendVectorToExisting(
  bank: VimRegisterBank,
  destination: VimRegisterName,
  incoming: VimRegisterVector,
): Result<VimRegisterVector, VimRegisterFailure> {
  const current = bank.snapshot();
  let prior = current.vectors.get(destination);
  if (prior === undefined) {
    const scalar = current.values.get(destination);
    if (scalar === undefined) return { ok: true, value: incoming };
    if (incoming.fragments.length !== 1) {
      return { ok: false, error: { kind: 'vector-arity-mismatch', expected: 1, actual: incoming.fragments.length } };
    }
    prior = singletonVector(scalar);
  }
  if (prior.fragments.length !== incoming.fragments.length) {
    return { ok: false, error: { kind: 'vector-arity-mismatch', expected: prior.fragments.length, actual: incoming.fragments.length } };
  }
  const fragments: VimRegisterValue[] = [];
  for (let index = 0; index < prior.fragments.length; index += 1) {
    const left = prior.fragments[index];
    const right = incoming.fragments[index];
    if (left === undefined || right === undefined) return { ok: false, error: { kind: 'invalid-register-vector' } };
    if (left.type !== right.type) {
      return { ok: false, error: { kind: 'mixed-register-types', expected: left.type, actual: right.type } };
    }
    fragments.push(appendValues(left, right));
  }
  return { ok: true, value: Object.freeze({ fragments: Object.freeze(fragments), primaryIndex: incoming.primaryIndex }) };
}

function appendValues(left: VimRegisterValue, right: VimRegisterValue): VimRegisterValue {
  if (left.type === right.type && left.type === 'blockwise') {
    return Object.freeze({ lines: Object.freeze([...left.lines, ...right.lines]), type: 'blockwise', blockWidth: Math.max(left.blockWidth ?? 1, right.blockWidth ?? 1) });
  }
  if (left.type === right.type) return Object.freeze({ lines: Object.freeze([...left.lines, ...right.lines]), type: left.type });
  return Object.freeze({ lines: Object.freeze([...left.lines, ...right.lines]), type: 'characterwise' });
}

export type VimPutCommand = 'p' | 'P' | 'gp' | 'gP';
export type VimPutSelectionKind = 'characterwise' | 'linewise' | 'blockwise';

export interface VimPutSelection {
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  readonly kind: VimPutSelectionKind;
  /** Optional zero-based logical rectangle for a blockwise visual put. */
  readonly firstLine?: number;
  readonly lastLine?: number;
  readonly firstColumn?: number;
  readonly lastColumn?: number;
}

export interface VimPutContext {
  readonly snapshot: DocumentSnapshot;
  readonly cursor: Utf16Offset;
  readonly register: VimRegisterValue;
  readonly command: VimPutCommand;
  readonly selection?: VimPutSelection;
  readonly tabstop?: number;
}

export interface VimPutPlan {
  readonly edits: readonly DocumentEdit[];
  readonly cursor: Utf16Offset;
  readonly insertedStart: Utf16Offset;
  readonly insertedEnd: Utf16Offset;
  readonly register: VimRegisterValue;
}

export interface VimMultiPutMemberInput {
  readonly id: string;
  readonly context: Omit<VimPutContext, 'register'>;
}

export interface VimMultiPutMember {
  readonly id: string;
  readonly status: 'prepared';
  readonly plan: VimPutPlan;
}

export interface VimMultiPutPlan {
  readonly documentId: DocumentSnapshot['id'];
  readonly expectedVersion: DocumentSnapshot['version'];
  readonly edits: readonly DocumentEdit[];
  readonly members: readonly VimMultiPutMember[];
  readonly register: VimRegisterVector;
}

export type VimMultiPutFailure = VimPutFailure
  | { readonly kind: 'stale-snapshot' }
  | { readonly kind: 'vector-arity-mismatch'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'edit-conflict' };

export type VimPutFailure =
  | { readonly kind: 'invalid-context' }
  | { readonly kind: 'stale-snapshot' }
  | { readonly kind: 'invalid-selection' }
  | { readonly kind: 'invalid-register-value' }
  | { readonly kind: 'line-out-of-range' };

/** Prepare one atomic put for every member, distributing typed fragments in canonical order. */
export function prepareVimMultiPut(input: {
  readonly members: readonly VimMultiPutMemberInput[];
  readonly register: VimRegisterVector;
}): Result<VimMultiPutPlan, VimMultiPutFailure | VimRegisterFailure> {
  const checked = normalizeVector(input.register);
  if (!checked.ok) return checked;
  if (input.members.length === 0) return { ok: false, error: { kind: 'vector-arity-mismatch', expected: 1, actual: 0 } };
  if (checked.value.fragments.length !== input.members.length) {
    return { ok: false, error: { kind: 'vector-arity-mismatch', expected: input.members.length, actual: checked.value.fragments.length } };
  }
  const first = input.members[0];
  if (first === undefined) return { ok: false, error: { kind: 'vector-arity-mismatch', expected: 1, actual: 0 } };
  const base = first.context.snapshot;
  const plans: VimMultiPutMember[] = [];
  const edits: DocumentEdit[] = [];
  for (let index = 0; index < input.members.length; index += 1) {
    const member = input.members[index];
    const fragment = checked.value.fragments[index];
    if (member === undefined || fragment === undefined) return { ok: false, error: { kind: 'vector-arity-mismatch', expected: input.members.length, actual: checked.value.fragments.length } };
    if (member.context.snapshot.id !== base.id || member.context.snapshot.version !== base.version) return { ok: false, error: { kind: 'stale-snapshot' } };
    const prepared = prepareVimPut({ ...member.context, register: fragment });
    if (!prepared.ok) return prepared;
    plans.push(Object.freeze({ id: member.id, status: 'prepared', plan: prepared.value }));
    edits.push(...prepared.value.edits);
  }
  const normalized = normalizeAtomicEdits(base, edits);
  if (!normalized.ok) return { ok: false, error: { kind: 'edit-conflict' } };
  return { ok: true, value: Object.freeze({ documentId: base.id, expectedVersion: base.version, edits: normalized.value, members: Object.freeze(plans), register: checked.value }) };
}

/** Prepare p/P/gp/gP without mutating the document, cursor, or register bank. */
export function prepareVimPut(context: VimPutContext): Result<VimPutPlan, VimPutFailure> {
  const checked = normalizeValue(context.register);
  if (!checked.ok) return { ok: false, error: { kind: 'invalid-register-value' } };
  const cursor = context.cursor as number;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > context.snapshot.lengthUtf16 || context.snapshot.slice(context.cursor, context.cursor).ok === false) {
    return { ok: false, error: { kind: 'invalid-context' } };
  }
  if (context.selection !== undefined) {
    const selection = context.selection;
    if (!validRange(selection.start as number, selection.end as number, context.snapshot.lengthUtf16)
      || selection.end < selection.start) return { ok: false, error: { kind: 'invalid-selection' } };
    return prepareVisualPut(context, checked.value);
  }
  if (checked.value.lines.length === 0) return { ok: true, value: emptyPlan(checked.value, context.cursor) };
  if (checked.value.type === 'blockwise') return prepareBlockPut(context, checked.value);
  if (checked.value.type === 'linewise') return prepareLinePut(context, checked.value);
  return prepareCharacterPut(context, checked.value);
}

/** Convenience planner that reads a named register and leaves the bank untouched. */
export function prepareVimPutFromBank(context: Omit<VimPutContext, 'register'> & { readonly bank: VimRegisterBank; readonly registerName: VimRegisterName }): Result<VimPutPlan, VimPutFailure | VimRegisterFailure> {
  const value = context.bank.read(context.registerName);
  if (!value.ok) return value;
  return prepareVimPut({ ...context, register: value.value });
}

export async function exportVimRegisterToClipboard(
  value: VimRegisterValue,
  clipboard: ClipboardPort,
  cancellation: CancellationToken,
): Promise<Result<void, PlatformFailure | VimRegisterFailure>> {
  const checked = normalizeValue(value);
  if (!checked.ok) return checked;
  const text = checked.value.type === 'linewise' ? `${checked.value.lines.join('\n')}\n` : checked.value.lines.join('\n');
  return clipboard.writeText(text, cancellation);
}

export async function importVimRegisterFromClipboard(
  bank: VimRegisterBank,
  clipboard: ClipboardPort,
  cancellation: CancellationToken,
): Promise<Result<VimRegisterBank, PlatformFailure | VimRegisterFailure>> {
  const read = await clipboard.readText(cancellation);
  if (!read.ok) return read; // internal bank is intentionally unchanged on denial/failure
  return bank.withClipboardValue({ lines: read.value.split('\n'), type: 'characterwise' });
}

export async function exportVimRegisterVectorToClipboard(
  vector: VimRegisterVector,
  clipboard: ClipboardPort,
  cancellation: CancellationToken,
): Promise<Result<void, PlatformFailure | VimRegisterFailure>> {
  const checked = normalizeVector(vector);
  if (!checked.ok) return checked;
  const text = checked.value.fragments.map((fragment) => fragment.type === 'linewise' ? `${fragment.lines.join('\n')}\n` : fragment.lines.join('\n')).join('');
  return clipboard.writeText(text, cancellation);
}

export async function importVimRegisterVectorFromClipboard(
  bank: VimRegisterBank,
  clipboard: ClipboardPort,
  cancellation: CancellationToken,
): Promise<Result<VimRegisterBank, PlatformFailure | VimRegisterFailure>> {
  const read = await clipboard.readText(cancellation);
  if (!read.ok) return read;
  return bank.writeVector({ name: '+', vector: { fragments: [{ lines: read.value.split('\n'), type: 'characterwise' }], primaryIndex: 0 } });
}

function prepareCharacterPut(context: VimPutContext, value: VimRegisterValue): Result<VimPutPlan, VimPutFailure> {
  const text = value.lines.join('\n');
  const cursor = context.cursor as number;
  const before = context.command === 'P' || context.command === 'gP' ? cursor : nextCharacterBoundary(context.snapshot, cursor);
  const edit = Object.freeze({ start: before as Utf16Offset, end: before as Utf16Offset, text });
  const insertedStart = before;
  const insertedEnd = before + text.length;
  const targetCursor = context.command === 'gp' || context.command === 'gP'
    ? insertedEnd
    : Math.max(insertedStart, insertedEnd - 1);
  return { ok: true, value: Object.freeze({ edits: Object.freeze([edit]), cursor: targetCursor as Utf16Offset, insertedStart: insertedStart as Utf16Offset, insertedEnd: insertedEnd as Utf16Offset, register: value }) };
}

function prepareLinePut(context: VimPutContext, value: VimRegisterValue): Result<VimPutPlan, VimPutFailure> {
  const line = context.snapshot.lineIndexAt(context.cursor);
  if (!line.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
  const start = context.snapshot.lineStartOffset(line.value);
  if (!start.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
  const text = value.lines.join('\n');
  const lineText = context.snapshot.slice(start.value, context.snapshot.lengthUtf16 as Utf16Offset);
  if (!lineText.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
  const lineEndRelative = lineText.value.indexOf('\n');
  const lineEnd = (start.value as number) + (lineEndRelative < 0 ? lineText.value.length : lineEndRelative);
  const beforeLine = context.command === 'P' || context.command === 'gP';
  const after = beforeLine ? start.value as number : (lineEnd < context.snapshot.lengthUtf16 ? lineEnd + 1 : context.snapshot.lengthUtf16);
  const payload = beforeLine
    ? `${text}\n`
    : (after < context.snapshot.lengthUtf16 ? `${text}\n` : `\n${text}`);
  const insertedEnd = after + payload.length;
  const targetCursor = context.command === 'gp' || context.command === 'gP' ? insertedEnd : Math.max(after, insertedEnd - 1);
  return { ok: true, value: Object.freeze({ edits: Object.freeze([{ start: after as Utf16Offset, end: after as Utf16Offset, text: payload }]), cursor: targetCursor as Utf16Offset, insertedStart: after as Utf16Offset, insertedEnd: insertedEnd as Utf16Offset, register: value }) };
}

function prepareBlockPut(context: VimPutContext, value: VimRegisterValue): Result<VimPutPlan, VimPutFailure> {
  const line = context.snapshot.lineIndexAt(context.cursor);
  if (!line.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
  const lineStart = context.snapshot.lineStartOffset(line.value);
  if (!lineStart.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
  const logicalColumn = (context.cursor as number) - (lineStart.value as number);
  const lines = value.lines;
  const edits: DocumentEdit[] = [];
  let firstStart = logicalColumn;
  let lastEnd = logicalColumn;
  for (let index = 0; index < lines.length; index += 1) {
    const targetLine = (line.value as number) + index;
    const targetStart = context.snapshot.lineStartOffset(targetLine as LineIndex);
    if (!targetStart.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
    const lineSlice = context.snapshot.slice(targetStart.value, context.snapshot.lengthUtf16 as Utf16Offset);
    if (!lineSlice.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
    const newline = lineSlice.value.indexOf('\n');
    const lineEnd = (targetStart.value as number) + (newline < 0 ? lineSlice.value.length : newline);
    const at = Math.min(lineEnd, (targetStart.value as number) + logicalColumn);
    const text = lines[index] ?? '';
    const lineLength = lineEnd - (targetStart.value as number);
    const padding = logicalColumn > lineLength ? ' '.repeat(logicalColumn - lineLength) : '';
    edits.push(Object.freeze({ start: at as Utf16Offset, end: at as Utf16Offset, text: `${padding}${text}` }));
    if (index === 0) firstStart = at;
    lastEnd = at + text.length;
  }
  const targetCursor = context.command === 'gp' || context.command === 'gP' ? lastEnd : Math.max(firstStart, lastEnd - 1);
  return { ok: true, value: Object.freeze({ edits: Object.freeze(edits), cursor: targetCursor as Utf16Offset, insertedStart: firstStart as Utf16Offset, insertedEnd: lastEnd as Utf16Offset, register: value }) };
}

function prepareVisualPut(context: VimPutContext, value: VimRegisterValue): Result<VimPutPlan, VimPutFailure> {
  const selection = context.selection;
  if (selection === undefined) return { ok: false, error: { kind: 'invalid-selection' } };
  if (selection.kind === 'blockwise' || value.type === 'blockwise') {
    if (selection.firstLine !== undefined && selection.lastLine !== undefined
      && selection.firstColumn !== undefined && selection.lastColumn !== undefined) {
      if (!Number.isSafeInteger(selection.firstLine) || !Number.isSafeInteger(selection.lastLine)
        || !Number.isSafeInteger(selection.firstColumn) || !Number.isSafeInteger(selection.lastColumn)
        || selection.firstLine < 0 || selection.lastLine < selection.firstLine
        || selection.firstColumn < 0 || selection.lastColumn < selection.firstColumn) {
        return { ok: false, error: { kind: 'invalid-selection' } };
      }
      const edits: DocumentEdit[] = [];
      let insertedStart = Number.MAX_SAFE_INTEGER;
      let insertedEnd = 0;
      const width = selection.lastColumn - selection.firstColumn + 1;
      for (let lineIndex = selection.firstLine; lineIndex <= selection.lastLine; lineIndex += 1) {
        const start = context.snapshot.lineStartOffset(lineIndex as LineIndex);
        if (!start.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
        const suffix = context.snapshot.slice(start.value, context.snapshot.lengthUtf16 as Utf16Offset);
        if (!suffix.ok) return { ok: false, error: { kind: 'line-out-of-range' } };
        const newline = suffix.value.indexOf('\n');
        const lineEnd = (start.value as number) + (newline < 0 ? suffix.value.length : newline);
        const at = Math.min(lineEnd, (start.value as number) + selection.firstColumn);
        const fragment = value.lines[lineIndex - selection.firstLine] ?? '';
        const replacement = fragment.padEnd(width, ' ');
        const end = Math.min(lineEnd, at + width);
        edits.push(Object.freeze({ start: at as Utf16Offset, end: end as Utf16Offset, text: replacement }));
        insertedStart = Math.min(insertedStart, at);
        insertedEnd = Math.max(insertedEnd, at + replacement.length);
      }
      const targetCursor = context.command === 'gp' || context.command === 'gP' ? insertedEnd : Math.max(insertedStart, insertedEnd - 1);
      return { ok: true, value: Object.freeze({ edits: Object.freeze(edits), cursor: targetCursor as Utf16Offset, insertedStart: insertedStart as Utf16Offset, insertedEnd: insertedEnd as Utf16Offset, register: value }) };
    }
    const replacement = value.lines.join('\n');
    const edit = Object.freeze({ start: selection.start, end: selection.end, text: replacement });
    const end = (selection.start as number) + replacement.length;
    return { ok: true, value: Object.freeze({ edits: Object.freeze([edit]), cursor: (context.command === 'gp' || context.command === 'gP' ? end : Math.max(selection.start as number, end - 1)) as Utf16Offset, insertedStart: selection.start, insertedEnd: end as Utf16Offset, register: value }) };
  }
  const text = value.lines.join('\n');
  const end = (selection.start as number) + text.length;
  return { ok: true, value: Object.freeze({ edits: Object.freeze([{ start: selection.start, end: selection.end, text }]), cursor: (context.command === 'gp' || context.command === 'gP' ? end : Math.max(selection.start as number, end - 1)) as Utf16Offset, insertedStart: selection.start, insertedEnd: end as Utf16Offset, register: value }) };
}

function nextCharacterBoundary(snapshot: DocumentSnapshot, offset: number): number {
  const tail = snapshot.slice(offset as Utf16Offset, snapshot.lengthUtf16 as Utf16Offset);
  if (!tail.ok || tail.value.length === 0) return snapshot.lengthUtf16;
  const scalar = tail.value.codePointAt(0);
  return offset + (scalar !== undefined && scalar > 0xffff ? 2 : 1);
}

function validRange(start: number, end: number, length: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= length;
}

function emptyPlan(value: VimRegisterValue, cursor: Utf16Offset): VimPutPlan {
  return Object.freeze({ edits: Object.freeze([]), cursor, insertedStart: cursor, insertedEnd: cursor, register: value });
}
