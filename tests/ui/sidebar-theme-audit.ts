import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createComponent, testRender } from '@opentui/solid';
import { CancellationSource } from '../../packages/primitives/src/entrypoints/launch';
import { discoverCustomThemeConfigs, decodeHelixWorkbenchTheme } from '../../packages/services/config/index';
import { BUILTIN_WORKBENCH_THEMES, type WorkbenchTheme } from '../../packages/ui/theme/workbench-themes';
import { sidebarTheme } from '../../packages/ui/theme/sidebar';
import { helixThemeColor } from '../../packages/ui/theme/color-input';
import { contrastRatio } from '../../packages/ui/theme/motion-tokens';
import { gitRows } from '../../packages/ui/src/solid/workbench';
import { RowsSurface } from '../../packages/ui/src/solid/panel';
import type { GitPanelReadModel } from '../../packages/ui/git';

const directory = process.argv[2];
const themes = new Map(Object.entries(BUILTIN_WORKBENCH_THEMES));
const diagnostics: unknown[] = [];
if (directory !== undefined) {
  const source = new CancellationSource();
  const loaded = await discoverCustomThemeConfigs({
    enumerateDirectory: async path => ({ ok: true, value: (await readdir(path)).map(name => ({ name, kind: 'file' })) }),
    readFile: async path => ({ ok: true, value: await readFile(path) }),
  }, directory, source.token);
  source.dispose();
  diagnostics.push(...loaded.diagnostics);
  for (const [id, value] of loaded.themes) themes.set(id, decodeHelixWorkbenchTheme(value.theme));
}
const model: GitPanelReadModel = {
  contractVersion: 1, generation: 1, branch: 'main', state: 'ready', message: undefined, selectedId: 'selected',
  sections: [{ id: 'changes', label: 'Changes', count: 3, collapsed: false, entries: [
    { id: 'selected', path: 'src/selected.ts', state: 'modified', letter: 'M' },
    { id: 'normal', path: 'src/normal.ts', state: 'added', letter: 'A' },
    { id: 'hovered', path: 'src/hovered.ts', state: 'deleted', letter: 'D' },
  ] }],
};
async function capture(theme: WorkbenchTheme) {
  const setup = await testRender(() => createComponent(RowsSurface<GitPanelReadModel>, {
    read: { model, subscribe: () => ({ dispose() {} }) }, isOpen: () => true,
    format: () => [], formatRows: (value, width, rows, offset) => gitRows(value, width, rows, offset, 'hovered', theme),
    maxRows: 9, background: theme.surface, foreground: theme.foreground,
    bounds: () => ({ left: 0, top: 0, width: 40, height: 9 }),
  }), { width: 40, height: 9, bufferedOutput: 'memory' });
  try {
    await setup.renderOnce();
    const cells = setup.captureSpans().lines.flatMap((line, row) => line.spans.filter(span => span.text.trim().length > 0).map(span => ({
      row, text: span.text, fg: span.fg.toInts(), bg: span.bg.toInts(), ratio: contrastRatio(span.fg, span.bg),
    })));
    assert.ok(cells.some(cell => cell.text.includes('normal.ts')), 'audit must render populated production rows');
    return { text: setup.captureCharFrame(), cells, below45: cells.filter(cell => cell.ratio < 4.5).length };
  } finally { setup.renderer.destroy(); }
}
const results = [];
const unresolved: string[] = [];
for (const [id, theme] of themes) {
  if (JSON.stringify([theme.background, theme.foreground, theme.surface, theme.surfaceActive, theme.muted, theme.accent, theme.error, theme.selectionPrimary, theme.selectionSecondary, ...Object.entries(theme.styles ?? {}).filter(([scope]) => scope.startsWith('ui.') || scope.startsWith('diff.') || scope === 'error')]).includes('\\u0000xi-terminal-')) { unresolved.push(id); continue; }
  const previous = { ...theme,
    surface: helixThemeColor(theme, 'ui.menu', 'bg', theme.surface),
    foreground: helixThemeColor(theme, 'ui.menu', 'fg', theme.foreground),
    surfaceActive: helixThemeColor(theme, 'ui.menu.selected', 'bg', theme.surfaceActive),
  };
  const before = await capture(previous);
  const after = await capture(sidebarTheme(theme));
  results.push({ theme: id, before, after });
}
const out = '.artifacts/ui/sidebar-theme-audit.json';
await mkdir('.artifacts/ui', { recursive: true });
await writeFile(out, JSON.stringify({ scope: 'Git sidebar populated rows: normal, selected, hovered, metadata and status glyphs', themes: themes.size, rendered: results.length, unresolvedTerminalPalette: unresolved, diagnostics, results }, null, 2));
console.log(`Rendered ${results.length}/${themes.size} themes, before/after: ${out}; diagnostics=${diagnostics.length}`);
