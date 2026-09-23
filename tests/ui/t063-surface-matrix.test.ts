import { strict as assert } from 'node:assert';
import { TextAttributes } from '@opentui/core';
import { createComponent, testRender } from '@opentui/solid';
import { RowsSurface, type RowsSurfaceSpec } from '../../packages/ui/src/solid/panel';
import { formatGitLines, type GitPanelReadModel } from '../../packages/ui/git/index';
import { formatProblemsLines, type ProblemsReadModel } from '../../packages/ui/problems/index';
import { formatSearchLines, type SearchReadModel } from '../../packages/ui/search/index';
import { formatTaskOutputLines, type TaskOutputReadModel } from '../../packages/ui/output/index';
import { formatHoverLines, measureHover, type HoverReadModel } from '../../packages/ui/navigation/index';

class MutablePort<T> {
  constructor(readonly model: T) {}
  subscribe(): { dispose(): void } { return { dispose: () => {} }; }
}
async function capture<T>(port: MutablePort<T>, format: RowsSurfaceSpec<T>['format'], marker: string): Promise<void> {
  const setup = await testRender(() => createComponent((spec: RowsSurfaceSpec<T>) => RowsSurface(spec), {
    read: port, isOpen: () => true, format, maxRows: 8, background: '#FAF9F6', foreground: '#24292E', bounds: () => ({ width: 60, height: 8, left: 0, top: 0 }),
  }), { width: 60, height: 8, bufferedOutput: 'memory' });
  await setup.waitForFrame(frame => frame.includes(marker));
  assert.match(setup.captureCharFrame(), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  setup.renderer.destroy();
}
await capture(new MutablePort<ProblemsReadModel>({ contractVersion: 1, generation: 1, all: [] }), (model, width, rows, offset) => formatProblemsLines(model, width, rows, offset), 'Problems 0');
await capture(new MutablePort<TaskOutputReadModel>({ taskId: 'T063', state: 'idle', stdout: '', stderr: '', bytes: 0, truncated: false, exitCode: null }), formatTaskOutputLines, 'T063');
await capture(new MutablePort<SearchReadModel>({ contractVersion: 1, generation: 1, state: 'empty', query: { rootId: 'root', rootPath: '.', query: '' }, matches: [], totalMatches: 0, truncated: false, message: undefined }), (model, width, rows, offset) => formatSearchLines(model, width, rows, undefined, offset), 'Search');
const git: GitPanelReadModel = { contractVersion: 1, generation: 1, branch: 'main', state: 'ready', message: undefined, selectedId: undefined, sections: [] };
await capture(new MutablePort(git), formatGitLines, 'main');

const themedRows = new MutablePort({ selectedId: 'selected' });
const themedSetup = await testRender(() => createComponent((spec: RowsSurfaceSpec<typeof themedRows.model>) => RowsSurface(spec), {
  read: themedRows,
  isOpen: () => true,
  format: () => ['Picker', 'selected'],
  formatRows: () => [{ text: 'Picker' }, { text: 'selected', style: { fg: '#00ff00', modifiers: ['italic'] } }],
  maxRows: 2,
  background: '#000000',
  foreground: '#ffffff',
  bounds: () => ({ width: 20, height: 2, left: 0, top: 0 }),
  headerRows: 1,
  rowIds: () => [undefined, 'selected'],
  selectedId: model => model.selectedId,
  onTheme: setTheme => {
    setTheme('#000000', '#ffffff', undefined, undefined, '#000000', undefined, undefined, undefined, undefined,
      { modifiers: ['reversed'] }, { modifiers: ['rapid_blink'], underline: { color: '#123456', style: 'curl' } });
    return { dispose: () => {} };
  },
}), { width: 20, height: 2, bufferedOutput: 'memory' });
await themedSetup.renderOnce();
const themedFrame = themedSetup.captureSpans();
const headerAttributes = themedSetup.renderer.currentRenderBuffer.buffers.attributes[0] ?? 0;
const selectedAttributes = themedFrame.lines[1]?.spans[0]?.attributes ?? 0;
assert.equal(headerAttributes & TextAttributes.UNDERLINE_STYLE_CURL, TextAttributes.UNDERLINE_STYLE_CURL, 'T063-THEME-01 picker header keeps Helix curl underline');
assert.notEqual(headerAttributes & TextAttributes.RAPID_BLINK, 0, 'T063-THEME-01b picker header keeps Helix rapid blink distinct from slow blink');
assert.notEqual(selectedAttributes & TextAttributes.INVERSE, 0, 'T063-THEME-02 selected row keeps Helix reversed modifier');
assert.notEqual(selectedAttributes & TextAttributes.ITALIC, 0, 'T063-THEME-03 selected state composes with the row semantic style');
assert.equal(themedFrame.lines[1]?.spans[0]?.bg.g, 1, 'T063-THEME-04 selected reverse state displays the retained semantic foreground');
themedSetup.renderer.destroy();

const sparseSetup = await testRender(() => createComponent(RowsSurface, {
  read: new MutablePort({}), isOpen: () => true, format: () => [],
  formatRows: () => [{ text: 'Files >' }, { text: 'No matches', top: 5 }],
  maxRows: 6, background: '#123456', foreground: '#ffffff',
  bounds: () => ({ width: 20, height: 6, left: 0, top: 0 }),
}), { width: 20, height: 6, bufferedOutput: 'memory' });
await sparseSetup.renderOnce();
const sparseFrame = sparseSetup.captureCharFrame().split('\n');
assert.match(sparseFrame[0] ?? '', /Files >/u, 'T063-SPARSE-01 picker header stays at the top');
assert.match(sparseFrame[5] ?? '', /No matches/u, 'T063-SPARSE-02 picker footer stays at the bottom without blank row nodes');
assert.equal(sparseSetup.captureSpans().lines[3]?.spans[0]?.bg.r, 0x12 / 255, 'T063-SPARSE-03 empty rows inherit the panel background');
sparseSetup.renderer.destroy();

const hover: HoverReadModel = { state: 'ready', hover: 'const value: number\nA useful value.', message: undefined };
assert.deepEqual(formatHoverLines(hover, 40, 10), ['const value: number', 'A useful value.']);
assert.deepEqual(measureHover(hover, 80, 12), { width: 23, height: 4 }, 'hover bounds include two-cell side padding and top/bottom chrome');
console.log('T063 shared Solid surface matrix passed');
