import type { Disposable, CommandAvailabilityContext } from '../../contracts/src/index';
import type { PrefixHelpHint, PrefixHelpReadModel, PrefixHelpRequest } from '../../workbench/src/index';
export interface PrefixHelpClock { setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(handle: unknown): void; }
export interface PrefixHelpGenerations { readonly registryGeneration: number; readonly configGeneration: number; readonly focusGeneration: number; }
export interface PrefixHelpSource { readGenerations(): PrefixHelpGenerations; readPrefixHelp(request: PrefixHelpRequest): PrefixHelpReadModel; }
export interface PrefixHelpReadPort { readonly model: PrefixHelpReadModel | undefined; subscribe(listener: (model: PrefixHelpReadModel | undefined) => void): Disposable; }
export interface PrefixHelpControllerOptions { readonly delayMilliseconds?: number; readonly clock?: PrefixHelpClock; }
const systemClock: PrefixHelpClock = Object.freeze({ setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) });
export class PrefixHelpController implements PrefixHelpReadPort, Disposable {
  readonly #source: PrefixHelpSource; readonly #delayMilliseconds: number; readonly #clock: PrefixHelpClock; readonly #listeners = new Set<(model: PrefixHelpReadModel | undefined) => void>(); #timer: unknown; #serial = 0; #disposed = false; #model: PrefixHelpReadModel | undefined;
  constructor(source: PrefixHelpSource, options: PrefixHelpControllerOptions = {}) { this.#source = source; this.#delayMilliseconds = options.delayMilliseconds ?? 250; if (!Number.isSafeInteger(this.#delayMilliseconds) || this.#delayMilliseconds < 0) throw new TypeError('prefix-help-delay-must-be-nonnegative'); this.#clock = options.clock ?? systemClock; }
  get model(): PrefixHelpReadModel | undefined { return this.#model; }
  subscribe(listener: (model: PrefixHelpReadModel | undefined) => void): Disposable { if (this.#disposed) throw new Error('prefix-help-controller-disposed'); this.#listeners.add(listener); return { dispose: () => { this.#listeners.delete(listener); } }; }
  schedule(request: PrefixHelpRequest): void { if (this.#disposed) return; this.clearTimer(); this.clearModel(); if (request.pendingKeys.length === 0 && request.parserContinuations.length === 0) return; const serial = ++this.#serial; const captured = this.#source.readGenerations(); this.#timer = this.#clock.setTimeout(() => { this.#timer = undefined; if (this.#disposed || serial !== this.#serial) return; const current = this.#source.readGenerations(); if (!sameGenerations(captured, current) || current.configGeneration !== request.configGeneration) return; const model = this.#source.readPrefixHelp(Object.freeze({ ...request, ...(request.availability === undefined ? {} : { availability: Object.freeze({ contexts: Object.freeze([...request.availability.contexts]), capabilities: Object.freeze([...request.availability.capabilities]) } as CommandAvailabilityContext) }) })); if (!sameGenerations(captured, { registryGeneration: model.registryGeneration, focusGeneration: model.focusGeneration, configGeneration: model.configGeneration }) || model.hints.length === 0) return; this.#model = model; this.notify(); }, this.#delayMilliseconds); }
  cancel(): void { if (!this.#disposed) { this.#serial += 1; this.clearTimer(); this.clearModel(); } }
  completeCommand(): void { this.cancel(); }
  dispose(): void { if (!this.#disposed) { this.#disposed = true; this.#serial += 1; this.clearTimer(); this.#model = undefined; this.#listeners.clear(); } }
  private clearTimer(): void { if (this.#timer !== undefined) { this.#clock.clearTimeout(this.#timer); this.#timer = undefined; } }
  private clearModel(): void { if (this.#model !== undefined) { this.#model = undefined; this.notify(); } }
  private notify(): void { for (const listener of [...this.#listeners]) listener(this.#model); }
}
export interface PrefixHelpPanelTheme { readonly background: string; readonly foreground: string; readonly muted: string; readonly accent: string; readonly unavailable: string; }
export const DEFAULT_PREFIX_HELP_THEME: PrefixHelpPanelTheme = Object.freeze({ background: '#F1F0EC', foreground: '#24292E', muted: '#60666D', accent: '#245A88', unavailable: '#A52A36' });
const clip = (value: string, width: number): string => value.length <= width ? value : width <= 1 ? '…' : `${value.slice(0, width - 1)}…`;
export function formatPrefixHelpLines(model: PrefixHelpReadModel | undefined, width: number, maxRows: number): readonly string[] { if (model === undefined || maxRows <= 0 || width <= 0) return Object.freeze([]); const safeWidth = Math.max(1, Math.trunc(width)); const rows = Math.max(1, Math.trunc(maxRows)); const prefix = model.pendingKeys.length === 0 ? 'Prefix' : `Prefix ${model.pendingKeys.join(' ')}`; const compact = model.compactHint ?? `${prefix}: no legal continuation`; if (safeWidth < 48 || rows === 1) return Object.freeze([clip(compact, safeWidth)]); const output = [clip(`${prefix}  (${model.hints.length} hints)`, safeWidth)]; for (const hint of model.hints) { if (output.length >= rows) break; const state = hint.available ? '' : ` [${hint.disabledReason ?? 'unavailable'}]`; const alias = hint.aliases.length === 0 ? '' : ` (${hint.aliases.join(', ')})`; output.push(clip(`  ${hint.keyLabel}  ${hint.title}${alias} — ${hint.description}${state}`, safeWidth)); } return Object.freeze(output); }
function sameGenerations(left: PrefixHelpGenerations, right: PrefixHelpGenerations): boolean { return left.registryGeneration === right.registryGeneration && left.configGeneration === right.configGeneration && left.focusGeneration === right.focusGeneration; }
export type { PrefixHelpHint };

/** One Helix info-box line: a key (or key group) and its one-line doc. */
export interface PrefixHelpEntry { readonly key: string; readonly doc: string; readonly available: boolean; }

const PREFIX_TITLES: Readonly<Record<string, string>> = Object.freeze({ '<Space>': 'Space', g: 'Goto', z: 'View', Z: 'Quit', '<C-w>': 'Window' });

/** Helix names its info boxes after the keymap ("Space", "Goto", "Window"); nested prefixes show their keys. */
export function prefixHelpTitle(model: PrefixHelpReadModel): string {
  const keys = model.pendingKeys;
  return keys.length === 1 ? PREFIX_TITLES[keys[0] ?? ''] ?? keys[0] ?? '' : keys.map(key => PREFIX_TITLES[key] ?? key).join(' ');
}

/** Info-box rows in keymap order: Esc is implied (Helix omits it), and a deeper mapping collapses
 * into one row for its next key, labelled by its commands' shared namespace ("v  Panel…"). */
export function prefixHelpEntries(model: PrefixHelpReadModel): readonly PrefixHelpEntry[] {
  const entries: PrefixHelpEntry[] = [];
  const groups = new Map<string, string[]>();
  for (const hint of model.hints) {
    if (hint.kind === 'escape') continue;
    const first = hint.keys[0];
    if (hint.kind === 'mapping' && hint.keys.length > 1 && first !== undefined) {
      const ids = groups.get(first);
      if (ids !== undefined) { ids.push(hint.commandId ?? ''); continue; }
      groups.set(first, [hint.commandId ?? '']);
      entries.push({ key: first, doc: '', available: true });
      continue;
    }
    const doc = hint.description.replace(/\.$/u, '');
    entries.push({ key: hint.keyLabel, doc: hint.available || hint.disabledReason === undefined ? doc : `${doc} (${hint.disabledReason})`, available: hint.available });
  }
  return Object.freeze(entries.map(entry => {
    const ids = groups.get(entry.key);
    return ids === undefined || entry.doc.length > 0 ? entry : Object.freeze({ ...entry, doc: groupLabel(ids) });
  }));
}

function groupLabel(commandIds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const id of commandIds) { const head = id.split('.')[0] ?? ''; counts.set(head, (counts.get(head) ?? 0) + 1); }
  const head = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? '';
  return head.length === 0 ? 'More…' : `${head[0]?.toUpperCase() ?? ''}${head.slice(1)}…`;
}

/** Content size of the info box (without its border): Helix's `key  doc` columns plus one-cell side margins. */
export function measurePrefixHelp(entries: readonly PrefixHelpEntry[], title: string): { readonly keyWidth: number; readonly width: number; readonly height: number } {
  const keyWidth = entries.reduce((max, entry) => Math.max(max, [...entry.key].length), 0);
  const body = entries.reduce((max, entry) => Math.max(max, keyWidth + 2 + [...entry.doc].length), [...title].length);
  return { keyWidth, width: body + 2, height: entries.length };
}
