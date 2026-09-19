/**
 * Pure data map of file-type glyphs, mini.icons/nvim-web-devicons-style: one glyph plus a
 * theme color token per extension/basename. No OpenTUI import -- this is plain data the
 * explorer row painter (and any other consumer) resolves against a theme palette. Glyphs are
 * Nerd Font v3 codepoints (single code point each, no variation selectors), verified against
 * the upstream nerd-fonts `glyphnames.json`; a Nerd Font is required in the terminal for these
 * to render as icons rather than tofu/replacement boxes. ASCII mode ignores these entirely and
 * keeps `formatNodeLine`'s existing plain markers (`□`/`·`/`↪`).
 */

/** Theme color tokens an icon can resolve to; mapped onto existing `WorkbenchTheme`/
 * `ExplorerTheme` fields rather than inventing new color slots. */
export type IconColorToken = 'foreground' | 'muted' | 'accent' | 'gitAdded' | 'gitModified' | 'gitConflict' | 'error';

export interface FileIcon {
  readonly glyph: string;
  readonly color: IconColorToken;
}

/** nf-fa-folder / nf-fa-folder_open. */
const DIRECTORY_OPEN: FileIcon = Object.freeze({ glyph: '', color: 'accent' });
const DIRECTORY_CLOSED: FileIcon = Object.freeze({ glyph: '', color: 'accent' });
/** nf-fa-file_text_o, the generic-file fallback. */
const DEFAULT_FILE: FileIcon = Object.freeze({ glyph: '', color: 'muted' });

/** Exact basename matches, checked before the extension map (e.g. `Dockerfile`, dotfiles). */
const BASENAME_ICONS: Readonly<Record<string, FileIcon>> = Object.freeze({
  Dockerfile: Object.freeze({ glyph: '', color: 'accent' }), // nf-dev-docker
  Makefile: Object.freeze({ glyph: '', color: 'muted' }), // nf-seti-makefile
  LICENSE: Object.freeze({ glyph: '', color: 'muted' }), // nf-seti-license
  README: Object.freeze({ glyph: '', color: 'foreground' }), // nf-fa-readme
  'README.md': Object.freeze({ glyph: '', color: 'foreground' }),
  'package.json': Object.freeze({ glyph: '', color: 'accent' }), // nf-dev-npm
  'tsconfig.json': Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-typescript
  '.env': Object.freeze({ glyph: '', color: 'muted' }), // nf-seti-config
  '.gitignore': Object.freeze({ glyph: '', color: 'gitModified' }), // nf-dev-git
  '.gitattributes': Object.freeze({ glyph: '', color: 'gitModified' }),
  '.gitmodules': Object.freeze({ glyph: '', color: 'gitModified' }),
  'bun.lock': Object.freeze({ glyph: '', color: 'muted' }), // nf-seti-lock
  'bun.lockb': Object.freeze({ glyph: '', color: 'muted' }),
  'package-lock.json': Object.freeze({ glyph: '', color: 'muted' }),
});

/** Extension (without the leading dot) to icon. Codepoints double-checked against upstream
 * nerd-fonts `glyphnames.json` (ryanoasis/nerd-fonts). */
const EXTENSION_ICONS: Readonly<Record<string, FileIcon>> = Object.freeze({
  ts: Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-typescript
  tsx: Object.freeze({ glyph: '', color: 'accent' }), // nf-dev-react
  js: Object.freeze({ glyph: '', color: 'gitModified' }), // nf-dev-javascript_alt
  jsx: Object.freeze({ glyph: '', color: 'gitModified' }), // nf-dev-react
  mjs: Object.freeze({ glyph: '', color: 'gitModified' }),
  cjs: Object.freeze({ glyph: '', color: 'gitModified' }),
  json: Object.freeze({ glyph: '', color: 'muted' }), // nf-seti-json
  jsonc: Object.freeze({ glyph: '', color: 'muted' }),
  toml: Object.freeze({ glyph: '', color: 'muted' }), // nf-custom-toml
  yaml: Object.freeze({ glyph: '', color: 'gitModified' }), // nf-seti-yml
  yml: Object.freeze({ glyph: '', color: 'gitModified' }),
  md: Object.freeze({ glyph: '', color: 'muted' }), // nf-dev-markdown
  py: Object.freeze({ glyph: '', color: 'gitAdded' }), // nf-dev-python
  rs: Object.freeze({ glyph: '', color: 'error' }), // nf-dev-rust
  go: Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-go
  zig: Object.freeze({ glyph: '', color: 'gitModified' }), // nf-seti-zig
  c: Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-c
  h: Object.freeze({ glyph: '', color: 'muted' }),
  cpp: Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-cpp
  cc: Object.freeze({ glyph: '', color: 'accent' }),
  hpp: Object.freeze({ glyph: '', color: 'muted' }),
  java: Object.freeze({ glyph: '', color: 'error' }), // nf-seti-java
  kt: Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-kotlin
  rb: Object.freeze({ glyph: '', color: 'error' }), // nf-seti-ruby
  sh: Object.freeze({ glyph: '', color: 'gitAdded' }), // nf-seti-shell
  bash: Object.freeze({ glyph: '', color: 'gitAdded' }),
  zsh: Object.freeze({ glyph: '', color: 'gitAdded' }),
  fish: Object.freeze({ glyph: '', color: 'gitAdded' }),
  lua: Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-lua
  vim: Object.freeze({ glyph: '', color: 'accent' }), // nf-dev-vim
  html: Object.freeze({ glyph: '', color: 'gitModified' }), // nf-dev-html5
  css: Object.freeze({ glyph: '', color: 'accent' }), // nf-dev-css3
  scss: Object.freeze({ glyph: '', color: 'accent' }), // nf-seti-sass
  svg: Object.freeze({ glyph: '', color: 'gitModified' }), // nf-fa-file_image_o
  png: Object.freeze({ glyph: '', color: 'gitAdded' }),
  jpg: Object.freeze({ glyph: '', color: 'gitAdded' }),
  jpeg: Object.freeze({ glyph: '', color: 'gitAdded' }),
  gif: Object.freeze({ glyph: '', color: 'gitAdded' }),
  webp: Object.freeze({ glyph: '', color: 'gitAdded' }),
  lock: Object.freeze({ glyph: '', color: 'muted' }), // nf-seti-lock
  nix: Object.freeze({ glyph: '', color: 'accent' }), // nf-dev-nixos
  txt: Object.freeze({ glyph: '', color: 'muted' }), // nf-fa-file_text_o
  log: Object.freeze({ glyph: '', color: 'muted' }), // nf-oct-log
  pdf: Object.freeze({ glyph: '', color: 'error' }), // nf-fa-file_pdf_o
  zip: Object.freeze({ glyph: '', color: 'muted' }), // nf-fa-file_archive_o
  tar: Object.freeze({ glyph: '', color: 'muted' }),
  gz: Object.freeze({ glyph: '', color: 'muted' }),
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
