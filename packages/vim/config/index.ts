import type { Result } from '../../contracts/src/index.ts';

/** Modal contexts in which Vim mappings may be installed. */
export type VimMappingMode =
  | 'normal' | 'visual' | 'select' | 'operator-pending' | 'insert' | 'replace' | 'command-line';

export type VimConfigProfile = 'strict' | 'xi' | 'personal';

export interface VimKeyMapping {
  readonly mode: VimMappingMode;
  /** Canonical key tokens, for example `['g', 'd']` or `['<Space>', 'm', 'a']`. */
  readonly lhs: readonly string[];
  /** Canonical key tokens emitted after the mapping is selected. */
  readonly rhs: readonly string[];
  /** Recursive mappings re-enter the active mapping table; false is noremap. */
  readonly recursive?: boolean;
  readonly description?: string;
}

export interface VimMappingCompileOptions {
  readonly timeoutMilliseconds?: number;
  readonly maxRecursion?: number;
}

export type VimMappingCompileFailure =
  | { readonly kind: 'invalid-profile' }
  | { readonly kind: 'invalid-mapping'; readonly index: number; readonly reason: string }
  | { readonly kind: 'duplicate-mapping'; readonly mode: VimMappingMode; readonly lhs: readonly string[] }
  | { readonly kind: 'native-key-collision'; readonly mode: VimMappingMode; readonly lhs: readonly string[] }
  | { readonly kind: 'invalid-timeout' }
  | { readonly kind: 'invalid-recursion-limit' };

export type VimMappingFailure =
  | { readonly kind: 'mapping-recursion'; readonly trace: readonly string[] }
  | { readonly kind: 'mapping-timeout' }
  | { readonly kind: 'invalid-input' };

export interface VimMappingState {
  readonly mode: VimMappingMode;
  readonly pending: readonly string[];
  readonly startedAtMilliseconds: number | null;
}

export type VimMappingResolution =
  | { readonly kind: 'pending'; readonly state: VimMappingState }
  | { readonly kind: 'expanded'; readonly state: VimMappingState; readonly keys: readonly string[]; readonly mapping: VimKeyMapping }
  | { readonly kind: 'passthrough'; readonly state: VimMappingState; readonly keys: readonly string[] }
  | { readonly kind: 'failed'; readonly state: VimMappingState; readonly failure: VimMappingFailure };

export interface VimMappingTable {
  readonly profile: VimConfigProfile;
  readonly timeoutMilliseconds: number;
  readonly maxRecursion: number;
  readonly mappings: readonly VimKeyMapping[];
  readonly nativeReservations: readonly (readonly string[])[];
}

/** Compile profile-scoped mappings without installing them into the parser. */
export function compileVimMappings(
  profile: VimConfigProfile,
  mappings: readonly VimKeyMapping[] = [],
  options: VimMappingCompileOptions = {},
): Result<VimMappingTable, VimMappingCompileFailure> {
  if (profile !== 'strict' && profile !== 'xi' && profile !== 'personal') return failure({ kind: 'invalid-profile' });
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 500;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 0) return failure({ kind: 'invalid-timeout' });
  const maxRecursion = options.maxRecursion ?? 32;
  if (!Number.isSafeInteger(maxRecursion) || maxRecursion < 1 || maxRecursion > 1_024) return failure({ kind: 'invalid-recursion-limit' });

  const seen = new Set<string>();
  const compiled: VimKeyMapping[] = [];
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];
    if (!isValidMapping(mapping)) return failure({ kind: 'invalid-mapping', index, reason: 'mode, key sequences and tokens must be nonempty' });
    const key = mappingKey(mapping.mode, mapping.lhs);
    if (seen.has(key)) return failure({ kind: 'duplicate-mapping', mode: mapping.mode, lhs: mapping.lhs });
    seen.add(key);
    if (profile === 'strict' && hasNativeConflict(mapping.mode, mapping.lhs)) {
      return failure({ kind: 'native-key-collision', mode: mapping.mode, lhs: mapping.lhs });
    }
    if (profile === 'xi' && hasNativeConflict(mapping.mode, mapping.lhs) && !startsWithLeader(mapping.lhs)) {
      return failure({ kind: 'native-key-collision', mode: mapping.mode, lhs: mapping.lhs });
    }
    compiled.push(Object.freeze({
      mode: mapping.mode,
      lhs: Object.freeze([...mapping.lhs]),
      rhs: Object.freeze([...mapping.rhs]),
      recursive: mapping.recursive === true,
      ...(mapping.description === undefined ? {} : { description: mapping.description }),
    }));
  }
  const reservations = Object.freeze(NATIVE_RESERVATIONS.map((sequence) => Object.freeze([...sequence])));
  return {
    ok: true,
    value: Object.freeze({
      profile,
      timeoutMilliseconds,
      maxRecursion,
      mappings: Object.freeze(compiled),
      nativeReservations: reservations,
    }),
  };
}

export function initialVimMappingState(mode: VimMappingMode): VimMappingState {
  return Object.freeze({ mode, pending: Object.freeze([]), startedAtMilliseconds: null });
}

/** Feed one canonical key through a compiled mapping table. */
export function resolveVimMapping(
  table: VimMappingTable,
  state: VimMappingState,
  key: string,
  atMilliseconds: number,
): VimMappingResolution {
  if (!isMappingMode(state.mode) || key.length === 0 || !Number.isFinite(atMilliseconds) || atMilliseconds < 0) {
    return failedMapping(state, { kind: 'invalid-input' });
  }
  if (state.pending.length === 0 && !hasAnyPrefix(table, state.mode, [key])) {
    return passthrough(state, [key]);
  }

  const pending = [...state.pending, key];
  const startedAt = state.startedAtMilliseconds ?? atMilliseconds;
  const exact = findMapping(table, state.mode, pending);
  const longerPrefix = hasLongerPrefix(table, state.mode, pending);
  const expired = atMilliseconds - startedAt >= table.timeoutMilliseconds;

  if (exact !== undefined && (!longerPrefix || expired)) {
    const expanded = expandMapping(table, exact, [], 0, []);
    if (!expanded.ok) return failedMapping(emptyState(state.mode), expanded.error);
    return {
      kind: 'expanded',
      state: emptyState(state.mode),
      keys: Object.freeze(expanded.value),
      mapping: exact,
    };
  }
  if (longerPrefix && !expired) return { kind: 'pending', state: pendingState(state.mode, pending, startedAt) };

  // A longer sequence stopped matching. Resolve the longest exact mapping,
  // then feed the unmatched suffix as ordinary input. This is the native
  // timeout rule for an exact mapping followed by an unrelated key.
  const fallback = longestExact(table, state.mode, pending);
  if (fallback !== undefined) {
    const prefixLength = fallback.mapping.lhs.length;
    const expanded = expandMapping(table, fallback.mapping, [], 0, []);
    if (!expanded.ok) return failedMapping(emptyState(state.mode), expanded.error);
    const suffix = pending.slice(prefixLength);
    const suffixResult = passthrough(emptyState(state.mode), suffix);
    return {
      kind: 'expanded',
      state: suffixResult.state,
      keys: Object.freeze([...expanded.value, ...suffixResult.keys]),
      mapping: fallback.mapping,
    };
  }
  return passthrough(emptyState(state.mode), pending);
}

/** Resolve a pending exact mapping when its deterministic timeout expires. */
export function flushVimMapping(table: VimMappingTable, state: VimMappingState, atMilliseconds: number): VimMappingResolution {
  if (!Number.isFinite(atMilliseconds) || atMilliseconds < 0) return failedMapping(state, { kind: 'invalid-input' });
  if (state.pending.length === 0 || state.startedAtMilliseconds === null) return passthrough(state, []);
  if (atMilliseconds - state.startedAtMilliseconds < table.timeoutMilliseconds) {
    return { kind: 'pending', state };
  }
  const exact = findMapping(table, state.mode, state.pending);
  if (exact === undefined) return passthrough(state, state.pending);
  const expanded = expandMapping(table, exact, [], 0, []);
  if (!expanded.ok) return failedMapping(emptyState(state.mode), expanded.error);
  return { kind: 'expanded', state: emptyState(state.mode), keys: expanded.value, mapping: exact };
}

export type VimOptionName =
  | 'backspace' | 'cpoptions' | 'expandtab' | 'iskeyword' | 'joinspaces' | 'matchpairs'
  | 'nrformats' | 'paragraphs' | 'sections' | 'scrolloff' | 'selection' | 'shiftwidth'
  | 'sidescrolloff' | 'startofline' | 'tabstop' | 'timeout' | 'timeoutlen' | 'ttimeoutlen'
  | 'virtualedit' | 'whichwrap' | 'wrap' | 'wrapscan' | 'autoindent';

export type VimOptionValue = string | number | boolean;
export type VimOptionScope = 'global' | 'buffer' | 'window';

export interface VimOptionChange {
  readonly name: VimOptionName;
  readonly value: VimOptionValue;
  readonly scope?: VimOptionScope;
}

export interface VimOptionState {
  readonly profile: VimConfigProfile;
  readonly version: number;
  readonly values: Readonly<Record<VimOptionName, VimOptionValue>>;
}

export interface VimOptionTransaction {
  readonly expectedVersion: number;
  readonly changes: readonly VimOptionChange[];
}

export type VimOptionFailure =
  | { readonly kind: 'invalid-profile' }
  | { readonly kind: 'stale-version'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'invalid-option'; readonly name: string }
  | { readonly kind: 'invalid-value'; readonly name: VimOptionName }
  | { readonly kind: 'scope-collision'; readonly name: VimOptionName; readonly expected: VimOptionScope; readonly received: VimOptionScope };

const DEFAULT_OPTIONS: Readonly<Record<VimOptionName, VimOptionValue>> = Object.freeze({
  backspace: 'indent,eol,start', cpoptions: 'aABceFs_', expandtab: false,
  iskeyword: '@,48-57,_,192-255', joinspaces: false, matchpairs: '(:),{:},[:]',
  nrformats: 'bin,hex', paragraphs: 'IPLPPPQPP TPHPLIPpLpItpplpipbp', sections: 'SHNHH HUnhsh',
  scrolloff: 0, selection: 'inclusive', shiftwidth: 8, sidescrolloff: 0,
  startofline: false, tabstop: 8, timeout: true, timeoutlen: 1_000, ttimeoutlen: -1,
  virtualedit: '', whichwrap: 'b,s', wrap: true, wrapscan: true, autoindent: false,
});

const OPTION_SCOPES: Readonly<Record<VimOptionName, VimOptionScope>> = Object.freeze({
  backspace: 'buffer', cpoptions: 'global', expandtab: 'buffer', iskeyword: 'buffer',
  joinspaces: 'buffer', matchpairs: 'buffer', nrformats: 'buffer', paragraphs: 'global',
  sections: 'global', scrolloff: 'window', selection: 'global', shiftwidth: 'buffer',
  sidescrolloff: 'window', startofline: 'global', tabstop: 'buffer', timeout: 'global',
  timeoutlen: 'global', ttimeoutlen: 'global', virtualedit: 'global', whichwrap: 'global',
  wrap: 'window', wrapscan: 'global', autoindent: 'buffer',
});

export function createVimOptionState(
  profile: VimConfigProfile,
  changes: readonly VimOptionChange[] = [],
): Result<VimOptionState, VimOptionFailure> {
  if (profile !== 'strict' && profile !== 'xi' && profile !== 'personal') return optionFailure({ kind: 'invalid-profile' });
  const initial: VimOptionState = Object.freeze({ profile, version: 0, values: { ...DEFAULT_OPTIONS } });
  if (changes.length === 0) return { ok: true, value: initial };
  return applyVimOptionChanges(initial, { expectedVersion: 0, changes });
}

/** Apply a complete option batch only when it targets the current version. */
export function applyVimOptionChanges(
  state: VimOptionState,
  transaction: VimOptionTransaction,
): Result<VimOptionState, VimOptionFailure> {
  if (transaction.expectedVersion !== state.version) {
    return optionFailure({ kind: 'stale-version', expected: transaction.expectedVersion, actual: state.version });
  }
  const values: Record<VimOptionName, VimOptionValue> = { ...state.values };
  for (const change of transaction.changes) {
    if (!isOptionName(change.name)) return optionFailure({ kind: 'invalid-option', name: String(change.name) });
    const expectedScope = OPTION_SCOPES[change.name];
    const receivedScope = change.scope ?? expectedScope;
    if (receivedScope !== expectedScope) {
      return optionFailure({ kind: 'scope-collision', name: change.name, expected: expectedScope, received: receivedScope });
    }
    if (!validOptionValue(change.name, change.value)) return optionFailure({ kind: 'invalid-value', name: change.name });
    values[change.name] = change.value;
  }
  return {
    ok: true,
    value: Object.freeze({ profile: state.profile, version: state.version + 1, values: Object.freeze(values) }),
  };
}

export function vimOptionScope(name: VimOptionName): VimOptionScope { return OPTION_SCOPES[name]; }

const NATIVE_RESERVATIONS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['U']), Object.freeze(['>']), Object.freeze(['g', 'd']), Object.freeze(['<Space>']),
]);

function isValidMapping(value: VimKeyMapping | undefined): value is VimKeyMapping {
  return value !== undefined && typeof value === 'object' && isMappingMode(value.mode)
    && Array.isArray(value.lhs) && Array.isArray(value.rhs)
    && value.lhs.length > 0 && value.rhs.length > 0
    && value.lhs.every(isKeyToken) && value.rhs.every(isKeyToken)
    && (value.description === undefined || (typeof value.description === 'string' && value.description.length <= 512));
}

function isKeyToken(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 256; }

function isMappingMode(value: string): value is VimMappingMode {
  return value === 'normal' || value === 'visual' || value === 'select' || value === 'operator-pending'
    || value === 'insert' || value === 'replace' || value === 'command-line';
}

function startsWithLeader(lhs: readonly string[]): boolean { return lhs[0] === '<Space>'; }

function hasNativeConflict(mode: VimMappingMode, lhs: readonly string[]): boolean {
  if (mode !== 'normal' && mode !== 'visual' && mode !== 'select' && mode !== 'operator-pending') return false;
  return NATIVE_RESERVATIONS.some((reserved) => isPrefix(lhs, reserved) || isPrefix(reserved, lhs));
}

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
  if (left.length > right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function mappingKey(mode: VimMappingMode, keys: readonly string[]): string { return JSON.stringify([mode, keys]); }

function findMapping(table: VimMappingTable, mode: VimMappingMode, keys: readonly string[]): VimKeyMapping | undefined {
  return table.mappings.find((mapping) => mapping.mode === mode && sameKeys(mapping.lhs, keys));
}

function hasAnyPrefix(table: VimMappingTable, mode: VimMappingMode, keys: readonly string[]): boolean {
  return table.mappings.some((mapping) => mapping.mode === mode && isPrefix(keys, mapping.lhs));
}

function hasLongerPrefix(table: VimMappingTable, mode: VimMappingMode, keys: readonly string[]): boolean {
  return table.mappings.some((mapping) => mapping.mode === mode && mapping.lhs.length > keys.length && isPrefix(keys, mapping.lhs));
}

function longestExact(table: VimMappingTable, mode: VimMappingMode, keys: readonly string[]): { readonly mapping: VimKeyMapping } | undefined {
  let found: VimKeyMapping | undefined;
  for (const mapping of table.mappings) {
    if (mapping.mode === mode && isPrefix(mapping.lhs, keys) && (found === undefined || mapping.lhs.length > found.lhs.length)) found = mapping;
  }
  return found === undefined ? undefined : { mapping: found };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expandMapping(
  table: VimMappingTable,
  mapping: VimKeyMapping,
  disabled: readonly string[],
  depth: number,
  trace: readonly string[],
): Result<readonly string[], VimMappingFailure> {
  if (!mapping.recursive) return { ok: true, value: Object.freeze([...mapping.rhs]) };
  const identity = mappingKey(mapping.mode, mapping.lhs);
  if (depth >= table.maxRecursion || disabled.includes(identity)) {
    return { ok: false, error: { kind: 'mapping-recursion', trace: Object.freeze([...trace, identity]) } };
  }
  const output: string[] = [];
  let index = 0;
  while (index < mapping.rhs.length) {
    let candidate: VimKeyMapping | undefined;
    for (const next of table.mappings) {
      if (!next.recursive || next.mode !== mapping.mode || !isPrefix(next.lhs, mapping.rhs.slice(index))) continue;
      if (candidate === undefined || next.lhs.length > candidate.lhs.length) candidate = next;
    }
    if (candidate === undefined) {
      output.push(mapping.rhs[index] as string);
      index += 1;
      continue;
    }
    const nested = expandMapping(table, candidate, [...disabled, identity], depth + 1, [...trace, identity]);
    if (!nested.ok) return nested;
    output.push(...nested.value);
    index += candidate.lhs.length;
  }
  return { ok: true, value: Object.freeze(output) };
}

function emptyState(mode: VimMappingMode): VimMappingState { return Object.freeze({ mode, pending: Object.freeze([]), startedAtMilliseconds: null }); }
function pendingState(mode: VimMappingMode, pending: readonly string[], startedAtMilliseconds: number): VimMappingState {
  return Object.freeze({ mode, pending: Object.freeze([...pending]), startedAtMilliseconds });
}
function passthrough(state: VimMappingState, keys: readonly string[]): Extract<VimMappingResolution, { readonly kind: 'passthrough' }> {
  return { kind: 'passthrough', state: emptyState(state.mode), keys: Object.freeze([...keys]) };
}
function failedMapping(state: VimMappingState, failure: VimMappingFailure): VimMappingResolution {
  return { kind: 'failed', state, failure };
}
function failure<T extends VimMappingCompileFailure>(error: T): Result<never, T> { return { ok: false, error }; }
function optionFailure<T extends VimOptionFailure>(error: T): Result<never, T> { return { ok: false, error }; }

function isOptionName(value: string): value is VimOptionName {
  return Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, value);
}

function validOptionValue(name: VimOptionName, value: VimOptionValue): boolean {
  const defaultValue = DEFAULT_OPTIONS[name];
  if (typeof value !== typeof defaultValue) return false;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return false;
    if (name === 'tabstop') return value >= 1 && value <= 1_000;
    if (name === 'shiftwidth') return value >= 0 && value <= 1_000;
    if (name === 'ttimeoutlen') return value >= -1 && value <= 86_400_000;
    if (name === 'timeoutlen' || name === 'scrolloff' || name === 'sidescrolloff') return value >= 0 && value <= 86_400_000;
  }
  if (name === 'selection' && value !== 'inclusive' && value !== 'old' && value !== 'exclusive') return false;
  return true;
}
