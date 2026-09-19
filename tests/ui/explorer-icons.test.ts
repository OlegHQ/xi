import { strict as assert } from 'node:assert';
import { resolveFileIcon } from '../../packages/ui/explorer/icons';

// T-ICONS-01: directories resolve to the folder glyphs (closed/open), colored accent.
{
  const closed = resolveFileIcon('src', 'directory', false);
  const open = resolveFileIcon('src', 'directory', true);
  assert.equal(closed.glyph, '', 'T-ICONS-01a closed directory is nf-fa-folder');
  assert.equal(open.glyph, '', 'T-ICONS-01b open directory is nf-fa-folder_open');
  assert.equal(closed.color, 'accent', 'T-ICONS-01c directory color is accent');
  assert.equal(open.color, 'accent', 'T-ICONS-01d open directory color is accent');
}

// T-ICONS-02: known extensions resolve to their Nerd Font glyph, each exactly one code point.
{
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['index.ts', ''],
    ['app.tsx', ''],
    ['main.js', ''],
    ['comp.jsx', ''],
    ['mod.mjs', ''],
    ['mod.cjs', ''],
    ['data.json', ''],
    ['data.jsonc', ''],
    ['Cargo.toml', ''],
    ['ci.yaml', ''],
    ['ci.yml', ''],
    ['README.md', ''],
    ['notes.md', ''],
    ['main.py', ''],
    ['lib.rs', ''],
    ['main.go', ''],
    ['build.zig', ''],
    ['main.c', ''],
    ['main.h', ''],
    ['main.cpp', ''],
    ['main.cc', ''],
    ['main.hpp', ''],
    ['Main.java', ''],
    ['Main.kt', ''],
    ['app.rb', ''],
    ['run.sh', ''],
    ['run.bash', ''],
    ['run.zsh', ''],
    ['run.fish', ''],
    ['init.lua', ''],
    ['init.vim', ''],
    ['index.html', ''],
    ['style.css', ''],
    ['style.scss', ''],
    ['logo.svg', ''],
    ['photo.png', ''],
    ['photo.jpg', ''],
    ['photo.jpeg', ''],
    ['anim.gif', ''],
    ['photo.webp', ''],
    ['yarn.lock', ''],
    ['flake.nix', ''],
    ['notes.txt', ''],
    ['app.log', ''],
    ['doc.pdf', ''],
    ['archive.zip', ''],
    ['archive.tar', ''],
    ['archive.gz', ''],
  ];
  for (const [name, glyph] of cases) {
    const icon = resolveFileIcon(name, 'file', false);
    assert.equal(icon.glyph, glyph, `T-ICONS-02 ${name} resolves to ${JSON.stringify(glyph)}, got ${JSON.stringify(icon.glyph)}`);
    assert.equal([...icon.glyph].length, 1, `T-ICONS-02 ${name} glyph is exactly one code point`);
  }
}

// T-ICONS-03: exact basename matches win over extension matches (Dockerfile, dotfiles, lockfiles).
{
  assert.equal(resolveFileIcon('Dockerfile', 'file', false).glyph, '', 'T-ICONS-03a Dockerfile');
  assert.equal(resolveFileIcon('Makefile', 'file', false).glyph, '', 'T-ICONS-03b Makefile');
  assert.equal(resolveFileIcon('LICENSE', 'file', false).glyph, '', 'T-ICONS-03c LICENSE');
  assert.equal(resolveFileIcon('README', 'file', false).glyph, '', 'T-ICONS-03d README');
  assert.equal(resolveFileIcon('package.json', 'file', false).glyph, '', 'T-ICONS-03e package.json overrides the generic .json icon');
  assert.equal(resolveFileIcon('tsconfig.json', 'file', false).glyph, '', 'T-ICONS-03f tsconfig.json overrides the generic .json icon');
  assert.equal(resolveFileIcon('.env', 'file', false).glyph, '', 'T-ICONS-03g .env');
  assert.equal(resolveFileIcon('.gitignore', 'file', false).glyph, '', 'T-ICONS-03h .gitignore');
  assert.equal(resolveFileIcon('.gitattributes', 'file', false).glyph, '', 'T-ICONS-03i .gitattributes');
  assert.equal(resolveFileIcon('.gitmodules', 'file', false).glyph, '', 'T-ICONS-03j .gitmodules');
  assert.equal(resolveFileIcon('bun.lock', 'file', false).glyph, '', 'T-ICONS-03k bun.lock');
  assert.equal(resolveFileIcon('bun.lockb', 'file', false).glyph, '', 'T-ICONS-03l bun.lockb');
  assert.equal(resolveFileIcon('package-lock.json', 'file', false).glyph, '', 'T-ICONS-03m package-lock.json overrides .json');
}

// T-ICONS-04: unknown extensions and extensionless files fall back to the generic file glyph.
{
  const unknown = resolveFileIcon('mystery.xyz', 'file', false);
  assert.equal(unknown.glyph, '', 'T-ICONS-04a unknown extension falls back to nf-fa-file_text_o');
  assert.equal(unknown.color, 'muted', 'T-ICONS-04b default file color is muted');
  const noExt = resolveFileIcon('Justfile', 'file', false);
  assert.equal(noExt.glyph, '', 'T-ICONS-04c unmatched extensionless basename falls back too');
}

// T-ICONS-05: ASCII mode returns the stable plain-character fallbacks regardless of type,
// while preserving the resolved color.
{
  assert.equal(resolveFileIcon('src', 'directory', false, true).glyph, '+', 'T-ICONS-05a ascii closed directory');
  assert.equal(resolveFileIcon('src', 'directory', true, true).glyph, '\\', 'T-ICONS-05b ascii open directory');
  const tsAscii = resolveFileIcon('index.ts', 'file', false, true);
  assert.equal(tsAscii.glyph, '-', 'T-ICONS-05c ascii file glyph is the plain fallback');
  assert.equal(tsAscii.color, 'accent', 'T-ICONS-05d ascii mode still resolves the underlying color');
}

console.log('explorer-icons.test.ts passed');
