import { strict as assert } from 'node:assert';
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
const hover: HoverReadModel = { state: 'ready', hover: 'const value: number\nA useful value.', message: undefined };
assert.deepEqual(formatHoverLines(hover, 40, 10), ['const value: number', 'A useful value.']);
assert.deepEqual(measureHover(hover, 80, 12), { width: 23, height: 4 }, 'hover bounds include two-cell side padding and top/bottom chrome');
console.log('T063 shared Solid surface matrix passed');
