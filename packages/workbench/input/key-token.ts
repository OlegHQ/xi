import type { OwnedVimKeyEvent } from '../vim-session';

/**
 * Canonicalizes an OpenTUI key event into the same `<mod-key>` token vocabulary
 * `packages/services/config`'s binding compiler validates and stores (e.g. `<C-Up>`,
 * `<Space>`, `j`). Workbench cannot import `packages/vim`'s own private `canonicalKeyName`
 * (vim-owned, and mid-edit by another agent), so this is a small, independent equivalent
 * scoped to what config binding lookups need: named keys, Ctrl/Meta combinations and plain
 * single characters. Comparisons against config-supplied tokens are case-insensitive
 * (`normalizeCanonicalKey` in `packages/services/config` lowercases bracketed tokens too).
 */
export function canonicalKeyToken(event: OwnedVimKeyEvent): string {
  const lowerName = event.name.toLowerCase();
  const named: Record<string, string> = {
    escape: 'esc', esc: 'esc', enter: 'enter', return: 'enter', tab: 'tab', backspace: 'bs', delete: 'del',
    arrowup: 'up', up: 'up', arrowdown: 'down', down: 'down', arrowleft: 'left', left: 'left', arrowright: 'right', right: 'right',
    space: 'space',
  };
  const isSpace = event.raw === ' ' || lowerName === 'space';
  const namedKey = isSpace ? 'space' : named[lowerName];
  const isNamed = namedKey !== undefined;
  const bareKey = isNamed ? namedKey : (event.raw.length === 1 ? event.raw : lowerName);
  if (event.ctrl) return `<c-${bareKey.length === 1 ? bareKey.toLowerCase() : bareKey}>`;
  if (event.meta || event.option) return `<m-${bareKey.length === 1 ? bareKey.toLowerCase() : bareKey}>`;
  return isNamed ? `<${bareKey}>` : bareKey;
}
