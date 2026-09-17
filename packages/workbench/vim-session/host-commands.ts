import { asLineIndex, asUtf16Offset } from '../../contracts/src/index';
import type { DocumentSnapshot } from '../../document/src/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { VimHostCommand } from '../../vim/src/index';
import { tokenBoundsAt } from '../../vim/src/index';

export interface HostTarget {
  readonly target: string;
  readonly line?: number;
}

/** Extract only the bounded current line needed by gf/gF and tag commands. */
export function hostTarget(snapshot: DocumentSnapshot, member: SelectionSetSnapshot['members'][number] | undefined, lineAware = false): HostTarget | undefined {
  if (member === undefined) return undefined;
  const line = snapshot.lineIndexAt(member.anchor.at.offset);
  if (!line.ok) return undefined;
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return undefined;
  const nextLine = (line.value as number) + 1;
  const nextLineIndex = asLineIndex(nextLine);
  const end = nextLine < snapshot.lineCount && nextLineIndex.ok
    ? snapshot.lineStartOffset(nextLineIndex.value)
    : asUtf16Offset(snapshot.lengthUtf16);
  if (!end.ok) return undefined;
  const text = snapshot.slice(start.value, end.value);
  if (!text.ok) return undefined;
  const cursor = Math.min(Math.max(0, (member.anchor.at.offset as number) - (start.value as number)), text.value.length);
  const bounds = tokenBoundsAt(text.value, cursor, isHostTokenCharacter);
  if (bounds === undefined) return undefined;
  const raw = text.value.slice(bounds.start, bounds.end);
  if (raw.length === 0 || raw.length > 4096) return undefined;
  const numbered = /^(.*):([1-9][0-9]*)$/u.exec(raw);
  if (numbered?.[1] === undefined || numbered[1].length === 0) return { target: raw };
  const parsedLine = Number(numbered[2]);
  if (!Number.isSafeInteger(parsedLine) || parsedLine < 1) return { target: raw };
  return { target: numbered[1], ...(lineAware ? { line: parsedLine - 1 } : {}) };
}

export function isHostTokenCharacter(value: string): boolean {
  return value.length === 1 && !/\s/u.test(value) && !"'\"`<>()[]{};,".includes(value);
}

export function hostWindowAction(
  prefix: 'ctrl-w' | 'ctrl-w-g',
  key: string,
): Extract<VimHostCommand, { readonly kind: 'window' }>['action'] | undefined {
  if (prefix === 'ctrl-w-g') {
    switch (key) {
      case 't': return 'move-tab';
      case 'T': return 'move-tab';
      case 'g': return 'focus-first';
      case 'G': return 'focus-last';
      case '+': return 'resize-increase';
      case '-': return 'resize-decrease';
      case '<': return 'resize-left';
      case '>': return 'resize-right';
      case '_': return 'resize-top';
      case '|': return 'resize-right';
      default: return undefined;
    }
  }
  switch (key) {
    case 'h': return 'focus-left';
    case 'j': return 'focus-down';
    case 'k': return 'focus-up';
    case 'l': return 'focus-right';
    case 'w': return 'focus-next';
    case 'W': return 'focus-previous';
    case 'p': return 'focus-previous';
    case 't': return 'focus-first';
    case 'b': return 'focus-last';
    case 'c':
    case 'q': return 'close';
    case 'o':
    case 'O': return 'only';
    case 's': return 'split-horizontal';
    case 'S': return 'split-vertical';
    case 'v': return 'split-vertical';
    case '=': return 'equalize';
    case '+': return 'resize-increase';
    case '-': return 'resize-decrease';
    case '<': return 'resize-left';
    case '>': return 'resize-right';
    case '_': return 'resize-top';
    case '|': return 'resize-right';
    case 'x': return 'exchange-next';
    case 'X': return 'exchange-previous';
    case 'r': return 'rotate';
    case 'R': return 'rotate-reverse';
    case 'B': return 'move-bottom';
    case 'P': return 'move-top';
    case 'T': return 'move-tab';
    case 'n': return 'focus-next';
    case 'C': return 'new-window';
    default: return undefined;
  }
}
