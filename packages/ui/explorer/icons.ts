/**
 * Pure data map of file-type glyphs, mini.icons-style: one glyph plus a theme color token
 * per extension/basename. No OpenTUI import -- this is plain data the explorer row painter
 * (and any other consumer) resolves against a theme palette. Glyphs are plain Unicode (no
 * Nerd Font dependency, unlike real mini.icons) so they render in any terminal font. ASCII
 * mode ignores these entirely and keeps `formatNodeLine`'s existing plain markers
 * (`□`/`·`/`↪`).
 */

/** Theme color tokens an icon can resolve to; mapped onto existing `WorkbenchTheme`/
 * `ExplorerTheme` fields rather than inventing new color slots. */
export type IconColorToken = 'foreground' | 'muted' | 'accent' | 'gitAdded' | 'gitModified' | 'gitConflict' | 'error';

export interface FileIcon {
  readonly glyph: string;
  readonly color: IconColorToken;
}

const DIRECTORY_OPEN: FileIcon = Object.freeze({ glyph: '▽', color: 'accent' });
const DIRECTORY_CLOSED: FileIcon = Object.freeze({ glyph: '▷', color: 'accent' });
const DEFAULT_FILE: FileIcon = Object.freeze({ glyph: '·', color: 'muted' });

/** Exact basename matches, checked before the extension map (e.g. `Dockerfile`, dotfiles). */
const BASENAME_ICONS: Readonly<Record<string, FileIcon>> = Object.freeze({
  Dockerfile: Object.freeze({ glyph: '⚓', color: 'accent' }),
  '.gitignore': Object.freeze({ glyph: '±', color: 'gitModified' }),
  '.gitattributes': Object.freeze({ glyph: '±', color: 'gitModified' }),
  '.gitmodules': Object.freeze({ glyph: '±', color: 'gitModified' }),
  'bun.lock': Object.freeze({ glyph: '⛓', color: 'muted' }),
  'bun.lockb': Object.freeze({ glyph: '⛓', color: 'muted' }),
  'package-lock.json': Object.freeze({ glyph: '⛓', color: 'muted' }),
});

/** Extension (without the leading dot) to icon. */
const EXTENSION_ICONS: Readonly<Record<string, FileIcon>> = Object.freeze({
  ts: Object.freeze({ glyph: 'T', color: 'accent' }),
  tsx: Object.freeze({ glyph: 'X', color: 'accent' }),
  js: Object.freeze({ glyph: 'J', color: 'gitModified' }),
  jsx: Object.freeze({ glyph: 'X', color: 'gitModified' }),
  json: Object.freeze({ glyph: '{', color: 'muted' }),
  md: Object.freeze({ glyph: '≡', color: 'foreground' }),
  py: Object.freeze({ glyph: 'Y', color: 'gitAdded' }),
  rs: Object.freeze({ glyph: 'R', color: 'error' }),
  go: Object.freeze({ glyph: 'G', color: 'accent' }),
  toml: Object.freeze({ glyph: '=', color: 'muted' }),
  yaml: Object.freeze({ glyph: ':', color: 'gitModified' }),
  yml: Object.freeze({ glyph: ':', color: 'gitModified' }),
  lock: Object.freeze({ glyph: '⛓', color: 'muted' }),
  sh: Object.freeze({ glyph: '$', color: 'gitAdded' }),
  bash: Object.freeze({ glyph: '$', color: 'gitAdded' }),
  css: Object.freeze({ glyph: '#', color: 'accent' }),
  html: Object.freeze({ glyph: '<', color: 'gitModified' }),
  lua: Object.freeze({ glyph: 'L', color: 'accent' }),
  c: Object.freeze({ glyph: 'C', color: 'accent' }),
  h: Object.freeze({ glyph: 'h', color: 'muted' }),
  cpp: Object.freeze({ glyph: 'C', color: 'accent' }),
  cc: Object.freeze({ glyph: 'C', color: 'accent' }),
  hpp: Object.freeze({ glyph: 'h', color: 'muted' }),
  java: Object.freeze({ glyph: '☕', color: 'error' }),
  rb: Object.freeze({ glyph: '♦', color: 'error' }),
  zig: Object.freeze({ glyph: 'Z', color: 'gitModified' }),
  nix: Object.freeze({ glyph: '∇', color: 'accent' }),
  png: Object.freeze({ glyph: '▨', color: 'gitAdded' }),
  jpg: Object.freeze({ glyph: '▨', color: 'gitAdded' }),
  jpeg: Object.freeze({ glyph: '▨', color: 'gitAdded' }),
  gif: Object.freeze({ glyph: '▨', color: 'gitAdded' }),
  svg: Object.freeze({ glyph: '▨', color: 'gitModified' }),
});

/** ASCII fallbacks for the same glyph slots, used only when the caller's theme is ASCII;
 * kept distinct from `formatNodeLine`'s plain disclosure/kind markers so a caller that wants
 * an icon column in ASCII mode still gets a stable one-character marker per kind. */
const ASCII_DIRECTORY_OPEN = '\\';
const ASCII_DIRECTORY_CLOSED = '+';
const ASCII_DEFAULT_FILE = '-';

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/** Resolve the icon for a file/directory name. `ascii` returns a plain one-character
 * fallback instead of a Unicode glyph, matching `ASCII_WORKBENCH_THEME`'s policy elsewhere. */
export function resolveFileIcon(name: string, kind: 'directory' | 'file', expanded: boolean, ascii = false): FileIcon {
  if (kind === 'directory') {
    const base = expanded ? DIRECTORY_OPEN : DIRECTORY_CLOSED;
    return ascii ? Object.freeze({ glyph: expanded ? ASCII_DIRECTORY_OPEN : ASCII_DIRECTORY_CLOSED, color: base.color }) : base;
  }
  const byBasename = BASENAME_ICONS[name];
  const byExtension = byBasename ?? EXTENSION_ICONS[extensionOf(name) ?? ''];
  const resolved = byExtension ?? DEFAULT_FILE;
  return ascii ? Object.freeze({ glyph: ASCII_DEFAULT_FILE, color: resolved.color }) : resolved;
}
