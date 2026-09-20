import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createTestRenderer } from '@opentui/core/testing';
import { CancellationSource, type DocumentId, type ViewId } from '../../packages/primitives/src/entrypoints/launch';
import { discoverCustomThemeConfigs, decodeHelixWorkbenchTheme } from '../../packages/services/config';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session';
import { WorkbenchRenderable } from '../../packages/ui/src/workbench';
import { createWorkbenchAppNode } from '../../packages/ui/src/solid/workbench';
import { createThemeBridge, mountSolidRoot } from '../../packages/ui/src/solid/composition';
import { BUILTIN_WORKBENCH_THEMES } from '../../packages/ui/theme/workbench-themes';
import { contrastRatio } from '../../packages/ui/theme/motion-tokens';
import { computeLineDiff } from '../../packages/services/git/diff';
import { prepareComparison } from '../../packages/services/git/alignment';
import type { DiffViewReadModel } from '../../packages/workbench/git/diff';
import { themeScenes } from './workbench-theme-scenes';

const themes = new Map(Object.entries(BUILTIN_WORKBENCH_THEMES));
const directory = process.argv[2];
const diagnostics: unknown[] = [];
if (directory !== undefined) {
  const cancellation = new CancellationSource();
  const loaded = await discoverCustomThemeConfigs({
    enumerateDirectory: async path => ({ ok: true, value: (await readdir(path)).map(name => ({ name, kind: 'file' })) }),
    readFile: async path => ({ ok: true, value: await readFile(path) }),
  }, directory, cancellation.token);
  cancellation.dispose();
  diagnostics.push(...loaded.diagnostics);
  for (const [id, value] of loaded.themes) themes.set(id, decodeHelixWorkbenchTheme(value.theme));
}
interface ContrastSpan { readonly row: number; readonly text: string; readonly attributes: number; readonly fg: readonly number[]; readonly bg: readonly number[]; readonly ratio: number; }
const results: { theme: string; scene: string; state: string; spans: number; minimum: number; below45: ContrastSpan[] }[] = [];
const unresolved: string[] = [];
const artifacts = '.artifacts/ui/workbench-theme-audit';
await mkdir(artifacts, { recursive: true });
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
for (const [themeId, theme] of themes) {
  if (process.env.XI_AUDIT_THEME !== undefined && themeId !== process.env.XI_AUDIT_THEME) continue;
  if (JSON.stringify(theme).includes('\\u0000xi-terminal-')) unresolved.push(themeId);
  const frames: string[] = [];
  for (const [scene, fixture] of Object.entries(themeScenes)) {
    const workbench = new WorkbenchSession();
    const document = TextFileDocument.create('audit-document' as DocumentId, 'const auditEditor = "text";\n', ['lf'], 'lf');
    assert.ok(document.ok);
    assert.ok(workbench.openBuffer(document.value, { viewId: 'audit-view' as ViewId, path: 'audit.ts' }).ok);
    const left = TextFileDocument.create('audit-original' as DocumentId, 'auditRemoved\n', ['lf'], 'lf');
    assert.ok(left.ok);
    const diff = computeLineDiff(['auditRemoved\n'], ['const auditEditor = "text";\n'], true);
    const comparisonModel: DiffViewReadModel = { ...diff, viewId: 'audit-view' as ViewId, path: 'audit.ts', target: 'worktree', leftLabel: 'INDEX', rightLabel: 'WORKTREE', layout: 'side-by-side', selectedHunk: 0, scrollTop: 0, state: 'ready', message: undefined, generation: 1, left: left.value.snapshot(), right: document.value.snapshot(), editable: true, unified: await prepareComparison(diff.lines, false), split: await prepareComparison(diff.lines, true) };
    const comparison = scene.startsWith('comparison') ? { readComparison: () => comparisonModel, onPointer: () => {} } : undefined;
    const setup = await createTestRenderer({ width: scene === 'comparison-wide' ? 160 : 120, height: 40, bufferedOutput: 'memory' });
    const options = { ...fixture.options, ...(comparison === undefined ? {} : { comparison }), tabs: (viewId?: string) => workbench.readTabs(viewId as ViewId | undefined), dispatchKey: () => 'unhandled' as const,
      sidebar: () => ({ width: 32, visible: true, panel: scene === 'search' ? 'search' as const : scene === 'git' ? 'git' as const : 'files' as const, activeSection: 'files' as const,
        sections: [{ id: 'files' as const, label: 'Files', expanded: scene !== 'outline' }, { id: 'outline' as const, label: 'Outline', expanded: scene === 'outline' }] }),
    };
    const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench, theme, fileLabel: 'audit.ts', sidebar: options.sidebar, ...(comparison === undefined ? {} : { comparison }) });
    setup.renderer.root.add(viewport);
    await mountSolidRoot(setup.renderer, [createWorkbenchAppNode({ workbench, theme, viewport, fileLabel: 'audit.ts', options, themeBridge: createThemeBridge(theme), requestFrame: () => {} })]);
    try {
      await setup.renderOnce();
      const text = setup.captureCharFrame();
      assert.ok(text.includes(fixture.marker), `${themeId}/${scene}: populated production surface was not rendered (${fixture.marker})`);
      const capture = (state: string) => {
      const lines = setup.captureSpans().lines;
      const spans = lines.flatMap((line, row) => line.spans.filter(span => span.text.trim().length > 0).map(span => ({ row, text: span.text, attributes: span.attributes, fg: span.fg.toInts(), bg: span.bg.toInts(), ratio: contrastRatio(span.fg, span.bg) })));
      results.push({ theme: themeId, scene, state, spans: spans.length, minimum: Math.min(...spans.map(span => span.ratio)), below45: spans.filter(span => span.ratio < 4.5) });
      frames.push(`<h2 id="${scene}-${state}">${escapeHtml(`${scene} (${state})`)}</h2><pre>${lines.map(line => line.spans.map(span => `<span style="color:rgb(${span.fg.toInts().slice(0, 3).join(',')});background:rgb(${span.bg.toInts().slice(0, 3).join(',')})">${escapeHtml(span.text)}</span>`).join('')).join('\n')}</pre>`);
      };
      capture('normal-selected');
      const textRows = text.split('\n');
      const hoverRow = textRows.findIndex(row => row.includes('normal'));
      if (hoverRow >= 0) {
        await setup.mockMouse.moveTo(textRows[hoverRow]!.indexOf('normal'), hoverRow, { delayMs: 0 });
        await setup.renderOnce();
        capture('hover-normal-row');
      }
    } finally { setup.renderer.destroy(); workbench.dispose(); }
  }
  await writeFile(`${artifacts}/${themeId}.html`, `<!doctype html><meta charset="utf-8"><title>${escapeHtml(themeId)} rendered Xi panels</title><style>body{background:#777;color:white}pre{font:14px/1.1 monospace;display:inline-block;white-space:pre}</style><h1>${escapeHtml(themeId)}</h1>${frames.join('\n')}`);
  console.log(`${themeId}: ${Object.keys(themeScenes).length} populated WorkbenchApp scenes rendered`);
}
await writeFile(`${artifacts}/report${process.env.XI_AUDIT_THEME === undefined ? '' : `-${process.env.XI_AUDIT_THEME}`}.json`, JSON.stringify({ scope: 'Production WorkbenchApp scenes, including editor/chrome; normal and selected sample content. Numeric contrast excludes whitespace, includes disabled text. Numeric RGB excludes terminal dim/blink behavior. Hover sampled by moving the pointer over populated normal rows. No physical-display certification.', themes: themes.size, scenes: Object.keys(themeScenes), terminalPaletteAssumptions: { themes: unresolved, basis: 'OpenTUI fallback ANSI palette and default foreground/background snapshots; actual user palettes are not measured' }, diagnostics, results }, null, 2));
console.log(`Audit retained in ${artifacts}; ${results.length} rendered scenes, ${unresolved.length} unresolved terminal-palette themes`);
