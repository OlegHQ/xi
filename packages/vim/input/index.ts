import type { CanonicalInputEvent, ClockPort, Result } from '../../contracts/src/index.ts';

/**
 * Vim consumes the UI's canonical event vocabulary. `key` is already a
 * decoded key identity; raw terminal bytes are deliberately not exposed here.
 */
export type NormalizedVimInput =
  | {
      readonly kind: 'key';
      readonly key: string;
      readonly phase: 'press' | 'repeat' | 'release';
      readonly modifiers: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean };
      readonly atMilliseconds: number;
    }
  | { readonly kind: 'paste'; readonly bytes: Uint8Array; readonly atMilliseconds: number }
  | { readonly kind: 'focus'; readonly focused: boolean; readonly atMilliseconds: number }
  | {
      readonly kind: 'pointer';
      readonly phase: 'down' | 'up' | 'move' | 'drag' | 'wheel';
      readonly cell: { readonly column0: number; readonly row0: number };
      readonly button: number | null;
      readonly modifiers: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean };
      readonly wheelDelta: number;
      readonly atMilliseconds: number;
    };

export type InputNormalizationFailure =
  | { readonly kind: 'invalid-key' }
  | { readonly kind: 'invalid-clock-value' }
  | { readonly kind: 'invalid-paste-bytes' }
  | { readonly kind: 'invalid-focus' }
  | { readonly kind: 'invalid-pointer' };

/** Only the monotonic clock is needed on the synchronous input path. */
export type VimInputClock = Pick<ClockPort, 'monotonicMilliseconds'>;

/**
 * Add a deterministic timestamp and defensive copies to one canonical event.
 * This layer does not decode terminal bytes or turn paste bytes into keys.
 */
export function normalizeVimInput(
  event: CanonicalInputEvent,
  clock: VimInputClock,
): Result<NormalizedVimInput, InputNormalizationFailure> {
  const atMilliseconds = clock.monotonicMilliseconds();
  if (!Number.isFinite(atMilliseconds) || atMilliseconds < 0) return failure('invalid-clock-value');

  switch (event.kind) {
    case 'key': {
      if (typeof event.key !== 'string' || event.key.length === 0) return failure('invalid-key');
      if (!isKeyPhase(event.phase) || !isModifiers(event.modifiers)) return failure('invalid-key');
      return success(Object.freeze({
        kind: 'key',
        key: event.key,
        phase: event.phase,
        modifiers: copyModifiers(event.modifiers),
        atMilliseconds,
      }));
    }
    case 'paste': {
      if (!(event.bytes instanceof Uint8Array)) return failure('invalid-paste-bytes');
      return success(Object.freeze({ kind: 'paste', bytes: new Uint8Array(event.bytes), atMilliseconds }));
    }
    case 'focus':
      if (typeof event.focused !== 'boolean') return failure('invalid-focus');
      return success(Object.freeze({ kind: 'focus', focused: event.focused, atMilliseconds }));
    case 'pointer': {
      if (!isPointerPhase(event.phase)
        || !Number.isSafeInteger(event.cell.column0) || event.cell.column0 < 0
        || !Number.isSafeInteger(event.cell.row0) || event.cell.row0 < 0
        || (event.button !== null && (!Number.isSafeInteger(event.button) || event.button < 0))
        || !isModifiers(event.modifiers) || !Number.isFinite(event.wheelDelta)) {
        return failure('invalid-pointer');
      }
      return success(Object.freeze({
        kind: 'pointer',
        phase: event.phase,
        cell: Object.freeze({ column0: event.cell.column0, row0: event.cell.row0 }),
        button: event.button,
        modifiers: copyModifiers(event.modifiers),
        wheelDelta: event.wheelDelta,
        atMilliseconds,
      }));
    }
    default:
      return failure('invalid-key');
  }
}

function isKeyPhase(value: unknown): value is 'press' | 'repeat' | 'release' {
  return value === 'press' || value === 'repeat' || value === 'release';
}

function isPointerPhase(value: unknown): value is 'down' | 'up' | 'move' | 'drag' | 'wheel' {
  return value === 'down' || value === 'up' || value === 'move' || value === 'drag' || value === 'wheel';
}

function isModifiers(value: unknown): value is { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const modifiers = value as Record<string, unknown>;
  return typeof modifiers.shift === 'boolean'
    && typeof modifiers.alt === 'boolean'
    && typeof modifiers.ctrl === 'boolean'
    && typeof modifiers.meta === 'boolean';
}

function copyModifiers(value: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean }) {
  return Object.freeze({ shift: value.shift, alt: value.alt, ctrl: value.ctrl, meta: value.meta });
}

function success<T>(value: T): Result<T, InputNormalizationFailure> { return { ok: true, value }; }
function failure(kind: InputNormalizationFailure['kind']): Result<never, InputNormalizationFailure> { return { ok: false, error: { kind } }; }
