/** Terminal bytes ESC + one printable character that arrive in a single read.
 *
 * OpenTUI's parser (pinned 0.5.11) turns ESC + [a-zA-Z0-9] into a meta chord and leaves
 * every other ESC-prefixed pair as a nameless key, so a stalled read that merged the user's
 * Escape with the next keystroke (`iX<Esc>:q`) silently dropped both. Per Neovim's `i_ALT`
 * rule an unmapped Alt chord is Escape followed by the key, which is also exactly what was
 * typed here; the UI adapter owns event normalization, so the split happens before dispatch.
 */
export interface CoalescedKeyLike {
  readonly name: string;
  readonly sequence: string;
  readonly raw: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly shift: boolean;
}

const ESC = String.fromCharCode(0x1b);

/** Returns the two events to dispatch instead of `event`, or undefined to keep it as-is. */
export function splitCoalescedEscape<T extends CoalescedKeyLike>(event: T): readonly [T, T] | undefined {
  const sequence = event.sequence.length > 0 ? event.sequence : event.raw;
  if (!sequence.startsWith(ESC)) return undefined;
  const rest = [...sequence.slice(1)];
  if (rest.length !== 1) return undefined;
  const character = rest[0] ?? '';
  const code = character.codePointAt(0) ?? 0;
  if (character === ESC) {
    const escape = { ...event, name: 'escape', sequence: ESC, raw: ESC, ctrl: false, meta: false, option: false, shift: false };
    return [escape, escape];
  }
  // A real escape sequence introducer (CSI '[', SS3 'O', DCS/OSC) is never split.
  if (character === '[' || character === 'O' || code < 0x20 || code === 0x7f) return undefined;
  const escape = { ...event, name: 'escape', sequence: ESC, raw: ESC, ctrl: false, meta: false, option: false, shift: false };
  const upper = code >= 0x41 && code <= 0x5a;
  const plain = { ...event, name: upper ? character.toLowerCase() : character, sequence: character, raw: character, ctrl: false, meta: false, option: false, shift: upper };
  return [escape, plain];
}
