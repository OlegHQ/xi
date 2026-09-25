import type {
  CommandAlias,
  CommandAvailabilityContext,
  CommandId,
  CommandRegistrySnapshot,
  Disposable,
  Result,
} from '../../contracts/src/index.ts';
import {
  parseVimExCommand,
  type VimExCommand,
  type VimExParseFailure,
} from '../../vim/src/index';
import { CommandRegistry } from './registry';

/** The native commands reserved by the Xi profile's Ex boundary. */
export interface NativeExCommandSpec {
  readonly name: string;
  /** Vim accepts these spellings as abbreviations for this command. */
  readonly abbreviations: readonly string[];
  readonly title: string;
  readonly detail: string;
  readonly acceptsBang: boolean;
  readonly acceptsRange: boolean;
}

/** Keep native spellings explicit: generic fuzzy/unique-prefix matching is not Vim resolution. */
export const DEFAULT_NATIVE_EX_COMMANDS: readonly NativeExCommandSpec[] = Object.freeze([
  Object.freeze({ name: 'quit', abbreviations: Object.freeze(['q', 'qu', 'qui', 'quit']), title: 'Quit window', detail: 'Native close-window semantics; dirty buffers report an error.', acceptsBang: true, acceptsRange: false }),
  Object.freeze({ name: 'write', abbreviations: Object.freeze(['w', 'wr', 'wri', 'writ', 'write']), title: 'Write buffer', detail: 'Native write semantics; no implicit quit.', acceptsBang: true, acceptsRange: true }),
  Object.freeze({ name: 'wq', abbreviations: Object.freeze(['wq']), title: 'Write and quit', detail: 'Native write-then-close semantics.', acceptsBang: true, acceptsRange: true }),
  Object.freeze({ name: 'x', abbreviations: Object.freeze(['x']), title: 'Write if modified and quit', detail: 'Native :x semantics; writes only when modified.', acceptsBang: true, acceptsRange: false }),
  Object.freeze({ name: 'qa', abbreviations: Object.freeze(['qa']), title: 'Quit all', detail: 'Native close-all semantics; dirty buffers report an error.', acceptsBang: true, acceptsRange: false }),
  Object.freeze({ name: 'wa', abbreviations: Object.freeze(['wa']), title: 'Write all', detail: 'Native write-all semantics.', acceptsBang: true, acceptsRange: false }),
  Object.freeze({ name: 'recover', abbreviations: Object.freeze(['recover']), title: 'Recover unsaved version', detail: 'Choose a retained crash checkpoint.', acceptsBang: false, acceptsRange: false }),
  Object.freeze({ name: 'Xi', abbreviations: Object.freeze(['Xi']), title: 'Xi command namespace', detail: 'Dispatch an exact namespaced Xi command.', acceptsBang: false, acceptsRange: false }),
]);

export type ExCommandCandidateKind = 'native' | 'xi-command' | 'alias' | 'argument';

export interface ExCommandCandidate {
  readonly kind: ExCommandCandidateKind;
  readonly label: string;
  readonly insertText: string;
  readonly detail: string;
  readonly commandName: string | undefined;
  readonly commandId: CommandId | undefined;
  readonly alias: string | undefined;
  readonly available: boolean;
  readonly disabledReason: string | undefined;
  /** True only when Enter may execute this candidate without first accepting it. */
  readonly exact: boolean;
  /** Replacement span in the original source, measured in UTF-16 code units. */
  readonly replaceStart: number;
  readonly replaceEnd: number;
}

export interface ExCommandPosition {
  readonly source: string;
  readonly segmentStart: number;
  readonly segmentEnd: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly commandNameStart: number;
  readonly commandNameEnd: number;
  readonly argumentStart: number;
  readonly argumentEnd: number;
  readonly separatorStart: number | null;
  readonly typedName: string;
  readonly typedBang: boolean;
}

export interface ExCommandLineContext {
  readonly source: string;
  /** UTF-16 source offset. Defaults to source.length. */
  readonly cursorOffset?: number;
  readonly registry: CommandRegistry;
  readonly availability?: CommandAvailabilityContext;
  readonly nativeCommands?: readonly NativeExCommandSpec[];
}

export interface ExCommandLineReadModel {
  readonly source: string;
  readonly cursorOffset: number;
  readonly registryGeneration: number;
  readonly position: ExCommandPosition;
  readonly parsed: VimExCommand | undefined;
  readonly parseFailure: VimExParseFailure | undefined;
  readonly candidates: readonly ExCommandCandidate[];
  readonly selectedIndex: number;
  readonly acceptanceHint: string;
  readonly typedCommandExact: boolean;
  readonly canExecute: boolean;
  readonly execution: ExExecution | undefined;
}

export type ExExecution =
  | {
    readonly kind: 'native-close' | 'native-write' | 'native-write-close' | 'native-write-all' | 'native-quit-all' | 'native-x';
    readonly commandName: string;
    readonly bang: boolean;
    readonly source: string;
    readonly parsed: VimExCommand | undefined;
  }
  | {
    readonly kind: 'xi-command';
    readonly commandId: CommandId;
    readonly source: string;
    readonly parsed: VimExCommand | undefined;
  }
  | {
    readonly kind: 'xi-alias';
    readonly alias: string;
    readonly commandId: CommandId;
    readonly source: string;
    readonly parsed: VimExCommand | undefined;
  };

export type ExExecutionFailure =
  | { readonly kind: 'empty-command'; readonly message: string }
  | { readonly kind: 'unknown-command'; readonly typedName: string }
  | { readonly kind: 'ambiguous-command'; readonly typedName: string }
  | { readonly kind: 'incomplete-xi-command'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'invalid-native-arguments'; readonly message: string }
  | { readonly kind: 'parse-failed'; readonly failure: VimExParseFailure };

export type ExExecutionResult = Result<ExExecution, ExExecutionFailure>;

export interface ExAliasSpec {
  readonly name: string;
  readonly target: CommandId;
}

export type ExAliasValidationFailure =
  | { readonly kind: 'invalid-alias'; readonly alias: string; readonly message: string }
  | { readonly kind: 'native-ex-collision'; readonly alias: string; readonly nativeCommand: string }
  | { readonly kind: 'duplicate-alias'; readonly alias: string }
  | { readonly kind: 'missing-command'; readonly alias: string; readonly commandId: string };

/**
 * Validate friendly aliases before they are registered. Exact aliases never
 * participate in Vim's native abbreviation resolver.
 */
export function validateNativeSafeAliases(
  aliases: readonly ExAliasSpec[],
  snapshot: CommandRegistrySnapshot,
  nativeCommands: readonly NativeExCommandSpec[] = DEFAULT_NATIVE_EX_COMMANDS,
): Result<readonly CommandAlias[], readonly ExAliasValidationFailure[]> {
  const failures: ExAliasValidationFailure[] = [];
  const seen = new Set<string>();
  const nativeReserved = new Map<string, string>();
  for (const command of nativeCommands) {
    for (const spelling of command.abbreviations) nativeReserved.set(spelling.toLowerCase(), command.name);
  }
  const commandIds = new Set(snapshot.commands.map((row) => String(row.descriptor.id)));
  const result: CommandAlias[] = [];
  for (const alias of aliases) {
    const normalized = normalizeAlias(alias.name);
    if (normalized === undefined) {
      failures.push({ kind: 'invalid-alias', alias: alias.name, message: 'alias must be a lowercase-safe Ex word' });
      continue;
    }
    const native = nativeReserved.get(normalized) ?? nativeCommands.find((command) => command.name.toLowerCase().startsWith(normalized) || command.abbreviations.some((spelling) => spelling.toLowerCase().startsWith(normalized)))?.name;
    if (native !== undefined) {
      failures.push({ kind: 'native-ex-collision', alias: alias.name, nativeCommand: native });
      continue;
    }
    if (seen.has(normalized)) {
      failures.push({ kind: 'duplicate-alias', alias: alias.name });
      continue;
    }
    seen.add(normalized);
    const commandId = String(alias.target);
    if (!commandIds.has(commandId)) {
      failures.push({ kind: 'missing-command', alias: alias.name, commandId });
      continue;
    }
    result.push(Object.freeze({ name: alias.name, target: { kind: 'command' as const, id: alias.target } }));
  }
  return failures.length === 0
    ? { ok: true, value: Object.freeze(result) }
    : { ok: false, error: Object.freeze(failures) };
}

/** Register a validated friendly alias bundle atomically through T074's registry. */
export function registerNativeSafeAliases(
  registry: CommandRegistry,
  aliases: readonly ExAliasSpec[],
  nativeCommands: readonly NativeExCommandSpec[] = DEFAULT_NATIVE_EX_COMMANDS,
): Result<Disposable, ExAliasValidationFailure | { readonly kind: 'registry-rejected'; readonly message: string }> {
  const checked = validateNativeSafeAliases(aliases, registry.snapshot, nativeCommands);
  if (!checked.ok) return checked.error[0] === undefined
    ? { ok: false, error: { kind: 'registry-rejected', message: 'alias validation failed without a diagnostic' } }
    : { ok: false, error: checked.error[0] };
  const registered = registry.register({ aliases: checked.value, commands: [] });
  return registered.ok
    ? { ok: true, value: registered.value }
    : { ok: false, error: { kind: 'registry-rejected', message: registered.error.message } };
}

export function buildExCommandLineReadModel(context: ExCommandLineContext, selectedIndex = 0): ExCommandLineReadModel {
  const cursorOffset = context.cursorOffset ?? context.source.length;
  if (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0 || cursorOffset > context.source.length) {
    throw new TypeError('Ex cursor offset must be a UTF-16 source offset');
  }
  const nativeCommands = context.nativeCommands ?? DEFAULT_NATIVE_EX_COMMANDS;
  const position = inspectExPosition(context.source, cursorOffset);
  const parsedResult = parseVimExCommand(context.source, position.segmentStart);
  const parsed = parsedResult.ok && parsedResult.value.metadata.commandNameEnd <= position.segmentEnd
    ? parsedResult.value
    : undefined;
  const parseFailure = parsedResult.ok ? undefined : parsedResult.error;
  const candidates = buildCandidates(context, position, nativeCommands);
  const safeSelected = candidates.length === 0 ? 0 : Math.max(0, Math.min(Math.trunc(selectedIndex), candidates.length - 1));
  const execution = context.availability === undefined
    ? resolveExExecution(context.source, context.registry, { nativeCommands })
    : resolveExExecution(context.source, context.registry, { availability: context.availability, nativeCommands });
  return Object.freeze({
    source: context.source,
    cursorOffset,
    registryGeneration: context.registry.snapshot.generation,
    position,
    parsed,
    parseFailure: execution.ok ? undefined : parseFailure,
    candidates: Object.freeze(candidates),
    selectedIndex: safeSelected,
    acceptanceHint: 'Enter: execute · Tab: complete · Esc: cancel',
    typedCommandExact: isExactCommandToken(position, nativeCommands, context.registry.snapshot),
    canExecute: execution.ok,
    execution: execution.ok ? execution.value : undefined,
  });
}

/** Resolve only a fully typed command. Completion rows are never implicit execution. */
export function resolveExExecution(
  source: string,
  registry: CommandRegistry,
  options: {
    readonly availability?: CommandAvailabilityContext;
    readonly nativeCommands?: readonly NativeExCommandSpec[];
  } = {},
): ExExecutionResult {
  const nativeCommands = options.nativeCommands ?? DEFAULT_NATIVE_EX_COMMANDS;
  const position = inspectExPosition(source, source.length);
  if (position.typedName.length === 0) return { ok: false, error: { kind: 'empty-command', message: 'Enter a command after :' } };
  const native = resolveNativeCommand(position.typedName, nativeCommands);
  const parsedResult = parseVimExCommand(source, position.segmentStart);
  const parsed = parsedResult.ok ? parsedResult.value : undefined;
  if (native.kind === 'ambiguous') return { ok: false, error: { kind: 'ambiguous-command', typedName: position.typedName } };
  if (native.kind === 'match') {
    const command = native.command;
    if (command.name === 'Xi') return resolveXiExecution(source, position, parsed, registry, options.availability);
    if (position.typedBang && !command.acceptsBang) return { ok: false, error: { kind: 'invalid-native-arguments', message: `:${command.name}! does not accept !` } };
    nativeAvailability(command, options.availability);
    if (!parsedResult.ok && isVimNativeCommand(command.name)) return { ok: false, error: { kind: 'parse-failed', failure: parsedResult.error } };
    return { ok: true, value: Object.freeze({
      kind: nativeExecutionKind(command.name), commandName: command.name, bang: position.typedBang, source, parsed,
    }) };
  }
  if (position.typedName.toLowerCase() === 'xi') return resolveXiExecution(source, position, parsed, registry, options.availability);
  const aliasInspection = registry.inspect({ kind: 'alias', name: position.typedName }, options.availability);
  if (aliasInspection !== undefined && aliasInspection.alias !== undefined) {
    if (!aliasInspection.available) return { ok: false, error: { kind: 'unavailable', reason: aliasInspection.disabledReason ?? 'Xi alias is unavailable.' } };
    return { ok: true, value: Object.freeze({
      kind: 'xi-alias', alias: aliasInspection.alias.name, commandId: aliasInspection.descriptor.id, source, parsed,
    }) };
  }
  return { ok: false, error: { kind: 'unknown-command', typedName: position.typedName } };
}

/** Perform a visible Tab replacement without changing the command's execution state. */
export function acceptExCompletion(source: string, candidate: ExCommandCandidate): string {
  if (candidate.replaceStart < 0 || candidate.replaceEnd < candidate.replaceStart || candidate.replaceEnd > source.length) {
    throw new RangeError('Ex completion replacement is outside the UTF-16 source');
  }
  return `${source.slice(0, candidate.replaceStart)}${candidate.insertText}${source.slice(candidate.replaceEnd)}`;
}

function buildCandidates(context: ExCommandLineContext, position: ExCommandPosition, nativeCommands: readonly NativeExCommandSpec[]): ExCommandCandidate[] {
  const typed = position.typedName;
  const output: ExCommandCandidate[] = [];
  const commandStart = position.commandNameStart;
  const commandEnd = position.commandNameEnd;
  const availability = context.availability;
  const nativeMatches = nativeCommands.filter((command) => command.abbreviations.some((spelling) => spelling.toLowerCase().startsWith(typed.toLowerCase())));
  for (const command of nativeMatches) {
    const exact = command.abbreviations.some((spelling) => spelling === typed);
    output.push(Object.freeze({
      kind: 'native', label: command.name, insertText: command.name, detail: command.detail,
      commandName: command.name, commandId: undefined, alias: undefined, available: true, disabledReason: undefined,
      exact, replaceStart: commandStart, replaceEnd: commandEnd,
    }));
  }
  if (typed.length === 0 || 'xi'.startsWith(typed.toLowerCase())) {
    const xi = nativeCommands.find((command) => command.name === 'Xi');
    if (xi !== undefined && !output.some((candidate) => candidate.label === xi.name)) {
      output.push(Object.freeze({ kind: 'native', label: xi.name, insertText: xi.name, detail: xi.detail, commandName: xi.name, commandId: undefined, alias: undefined, available: true, disabledReason: undefined, exact: typed === xi.name, replaceStart: commandStart, replaceEnd: commandEnd }));
    }
  }
  const cursorOffset = context.cursorOffset ?? context.source.length;
  if (typed.length > 0 && typed.toLowerCase() === 'xi' && position.argumentStart <= cursorOffset) {
    const argument = context.source.slice(position.argumentStart, cursorOffset);
    const argumentStart = position.argumentStart + (argument.length - argument.trimStart().length);
    const commandToken = argument.trim().split(/\s+/u)[0] ?? '';
    for (const row of context.registry.snapshot.commands) {
      const id = String(row.descriptor.id);
      if (!id.toLowerCase().startsWith(commandToken.toLowerCase())) continue;
      const inspection = context.registry.inspect({ kind: 'command', id: row.descriptor.id }, availability);
      output.push(Object.freeze({
        kind: 'xi-command', label: id, insertText: id, detail: row.descriptor.help,
        commandName: undefined, commandId: row.descriptor.id, alias: undefined,
        available: inspection?.available ?? false, disabledReason: inspection?.disabledReason,
        exact: id === commandToken, replaceStart: argumentStart, replaceEnd: argumentStart + commandToken.length,
      }));
    }
  } else {
    for (const row of context.registry.snapshot.aliases) {
      if (!row.name.toLowerCase().startsWith(typed.toLowerCase())) continue;
      const inspection = context.registry.inspect({ kind: 'alias', name: row.name }, availability);
      output.push(Object.freeze({
        kind: 'alias', label: row.name, insertText: row.name, detail: inspection?.descriptor.help ?? 'Xi friendly alias',
        commandName: undefined, commandId: inspection?.descriptor.id, alias: row.name,
        available: inspection?.available ?? false, disabledReason: inspection?.disabledReason,
        exact: row.name === typed, replaceStart: commandStart, replaceEnd: commandEnd,
      }));
    }
  }
  return output.sort((left, right) => Number(right.exact) - Number(left.exact) || left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));
}

function inspectExPosition(source: string, cursorOffset: number): ExCommandPosition {
  const segmentStart = findSegmentStart(source, cursorOffset);
  const segmentEnd = findSegmentEnd(source, segmentStart);
  let index = segmentStart;
  if (source[index] === ':') index += 1;
  while (index < segmentEnd && isSpace(source[index])) index += 1;
  const rangeStart = index;
  index = skipExRange(source, index, segmentEnd);
  const rangeEnd = index;
  while (index < segmentEnd && isSpace(source[index])) index += 1;
  const commandNameStart = index;
  while (index < segmentEnd && /[A-Za-z&~_-]/u.test(source[index] ?? '')) index += 1;
  const commandNameEnd = index;
  const typedName = source.slice(commandNameStart, commandNameEnd);
  const typedBang = source[index] === '!';
  if (typedBang) index += 1;
  const argumentStart = index;
  return Object.freeze({
    source, segmentStart, segmentEnd, rangeStart, rangeEnd, commandNameStart, commandNameEnd, argumentStart, argumentEnd: segmentEnd,
    separatorStart: segmentEnd < source.length && source[segmentEnd] === '|' ? segmentEnd : null,
    typedName, typedBang,
  });
}

function buildNativeResolutionTable(commands: readonly NativeExCommandSpec[]): ReadonlyMap<string, NativeExCommandSpec[]> {
  const table = new Map<string, NativeExCommandSpec[]>();
  for (const command of commands) for (const spelling of command.abbreviations) {
    const key = spelling.toLowerCase();
    const values = table.get(key) ?? [];
    if (!values.some((candidate) => candidate.name === command.name)) values.push(command);
    table.set(key, values);
  }
  return table;
}

function resolveNativeCommand(typed: string, commands: readonly NativeExCommandSpec[]): { readonly kind: 'match'; readonly command: NativeExCommandSpec } | { readonly kind: 'ambiguous' } | { readonly kind: 'none' } {
  const table = buildNativeResolutionTable(commands);
  const matches = table.get(typed.toLowerCase()) ?? [];
  if (matches.length === 1 && matches[0] !== undefined) return { kind: 'match', command: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return { kind: 'none' };
}

function isExactCommandToken(position: ExCommandPosition, commands: readonly NativeExCommandSpec[], snapshot: CommandRegistrySnapshot): boolean {
  const native = resolveNativeCommand(position.typedName, commands);
  if (native.kind === 'match') return true;
  if (position.typedName.toLowerCase() === 'xi') return true;
  return snapshot.aliases.some((alias) => alias.name === position.typedName);
}

function nativeExecutionKind(name: string): Exclude<ExExecution['kind'], 'xi-command' | 'xi-alias'> {
  switch (name) {
    case 'quit': return 'native-close';
    case 'write': return 'native-write';
    case 'wq': return 'native-write-close';
    case 'x': return 'native-x';
    case 'qa': return 'native-quit-all';
    case 'wa': return 'native-write-all';
    default: return 'native-close';
  }
}

function nativeAvailability(command: NativeExCommandSpec, _context: CommandAvailabilityContext | undefined): { readonly available: true } {
  void command;
  return { available: true };
}

function resolveXiExecution(
  source: string,
  position: ExCommandPosition,
  parsed: VimExCommand | undefined,
  registry: CommandRegistry,
  availability: CommandAvailabilityContext | undefined,
): ExExecutionResult {
  const argument = source.slice(position.argumentStart, position.segmentEnd).trim();
  const commandToken = argument.split(/\s+/u)[0] ?? '';
  if (commandToken.length === 0) return { ok: false, error: { kind: 'incomplete-xi-command', message: ':Xi requires an exact namespaced command ID' } };
  const commandId = commandToken.startsWith('xi.') ? commandToken : `xi.${commandToken}`;
  const checked = registry.inspect({ kind: 'command', id: commandId as CommandId }, availability);
  if (checked === undefined) return { ok: false, error: { kind: 'unknown-command', typedName: commandToken } };
  if (!checked.available) return { ok: false, error: { kind: 'unavailable', reason: checked.disabledReason ?? 'Xi command is unavailable.' } };
  return { ok: true, value: Object.freeze({ kind: 'xi-command', commandId: commandId as CommandId, source, parsed }) };
}

function isVimNativeCommand(name: string): boolean {
  return name === 'quit' || name === 'write';
}

function findSegmentStart(source: string, cursorOffset: number): number {
  let start = 0;
  while (start < cursorOffset) {
    const end = findSegmentEnd(source, start);
    if (end >= cursorOffset) return start;
    start = end + 1;
  }
  return start;
}

function findSegmentEnd(source: string, segmentStart: number): number {
  const command = commandWordAt(source, segmentStart);
  const commandName = command?.name;
  let protectedUntil = segmentStart;
  if (commandName === 's' || commandName === 'substitute') {
    if (command === undefined) return source.length;
    let index = command.argumentStart;
    while (isSpace(source[index])) index += 1;
    const delimiter = source[index];
    if (delimiter !== undefined && !isSpace(delimiter)) {
      index = skipDelimited(source, index, delimiter);
      index = skipDelimited(source, index, delimiter);
    }
    protectedUntil = index;
  }
  let escaped = false;
  for (let index = protectedUntil; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '|') return index;
  }
  return source.length;
}

function commandWordAt(source: string, start: number): { readonly name: string; readonly argumentStart: number } | undefined {
  let index = start;
  if (source[index] === ':') index += 1;
  while (isSpace(source[index])) index += 1;
  index = skipExRange(source, index, source.length);
  while (isSpace(source[index])) index += 1;
  const begin = index;
  while (/[A-Za-z&~]/u.test(source[index] ?? '')) index += 1;
  return index === begin ? undefined : { name: source.slice(begin, index).toLowerCase(), argumentStart: index };
}

function skipDelimited(source: string, start: number, delimiter: string): number {
  let index = start;
  if (source[index] === delimiter) index += 1;
  let escaped = false;
  while (index < source.length) {
    const character = source[index];
    if (escaped) { escaped = false; index += 1; continue; }
    if (character === '\\') { escaped = true; index += 1; continue; }
    index += 1;
    if (character === delimiter) break;
  }
  return index;
}

function skipExRange(source: string, start: number, end: number): number {
  if (source[start] === '%') return start + 1;
  let index = start;
  const first = skipAddress(source, index, end);
  if (first === index) return index;
  index = first;
  if (source[index] === ',' || source[index] === ';') {
    const second = skipAddress(source, index + 1, end);
    if (second > index + 1) index = second;
  }
  return index;
}

function skipAddress(source: string, start: number, end: number): number {
  let index = start;
  const initial = source[index];
  if (initial === '.' || initial === '$') index += 1;
  else if (initial === '+' || initial === '-') {
    index += 1;
    while (index < end && /\d/u.test(source[index] ?? '')) index += 1;
  } else if (initial === "'") {
    if (index + 1 >= end) return start;
    index += 2;
  } else if (initial === '/' || initial === '?') {
    const delimiter = initial;
    index += 1;
    let escaped = false;
    while (index < end) {
      const character = source[index];
      if (escaped) { escaped = false; index += 1; continue; }
      if (character === '\\') { escaped = true; index += 1; continue; }
      index += 1;
      if (character === delimiter) break;
    }
  } else if (/\d/u.test(initial ?? '')) {
    while (index < end && /\d/u.test(source[index] ?? '')) index += 1;
  } else return start;
  while (index < end && (source[index] === '+' || source[index] === '-')) {
    index += 1;
    while (index < end && /\d/u.test(source[index] ?? '')) index += 1;
  }
  return index;
}

function normalizeAlias(value: string): string | undefined {
  return /^[a-z][a-z0-9_-]*$/u.test(value) ? value.toLowerCase() : undefined;
}

function isSpace(value: string | undefined): boolean {
  return value === ' ' || value === '\t';
}
