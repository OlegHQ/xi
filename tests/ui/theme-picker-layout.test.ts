import { strict as assert } from 'node:assert';
import { createComponent, testRender } from '@opentui/solid';
import { RowsSurface } from '../../packages/ui/src/solid/panel';
import { getPickerBounds } from '../../packages/ui/src/solid/layout';
import { formatPickerLines, pickerRowIds, type PickerReadModel } from '../../packages/ui/picker/index';

let model: PickerReadModel = {
  contractVersion: 1, mode: 'theme', query: '', generation: 1, state: 'ready',
  entries: Array.from({ length: 60 }, (_, index) => ({
    id: `theme-${index}`, mode: 'theme', kind: 'theme', label: `Theme ${index}`, detail: '', value: `theme-${index}`,
    rootId: undefined, relativePath: undefined, hidden: false, score: 0,
  })),
  selectedId: 'theme-59', totalMatches: 60, truncated: false, message: undefined,
};
let notify: (model: PickerReadModel) => void = () => {};
let visibleRows = 0;
let isOpen = true;
const previews: string[] = [];
const setup = await testRender(() => createComponent(RowsSurface<PickerReadModel>, {
  read: { get model() { return model; }, subscribe: listener => { notify = listener; return { dispose() {} }; } },
  isOpen: () => isOpen, format: formatPickerLines, maxRows: Number.POSITIVE_INFINITY,
  background: '#181825', foreground: '#cdd6f4', bounds: getPickerBounds, border: true,
  panel: 'picker', generation: current => current.generation, rowIds: pickerRowIds,
  headerRows: 1, footerRows: 1, totalRows: current => current.entries.length,
  selectedId: current => current.selectedId,
  selectedIndex: current => current.entries.findIndex(entry => entry.id === current.selectedId),
  previewOnHover: () => true, onViewportRows: count => { visibleRows = count; },
  onPointer: event => {
    previews.push(event.itemId);
    model = { ...model, selectedId: event.itemId };
    notify(model);
    return true;
  },
}), { width: 120, height: 40, bufferedOutput: 'memory' });
try {
  await setup.renderOnce();
  let frame = setup.captureCharFrame().split('\n');
  assert.equal(visibleRows, 26, 'all 26 result rows inside the border/header/footer are available');
  assert.match(frame[32] ?? '', /▸ Theme 59/u, 'the current theme at the end is visible above the footer');
  assert.match(frame[5] ?? '', /╭.*╮/u, 'top border stays intact');
  assert.match(frame[33] ?? '', /60 matches/u, 'footer uses the last interior row');
  assert.match(frame[34] ?? '', /╰.*╯/u, 'bottom border stays intact');
  assert.equal(frame[32]?.[112], '█', 'the scrollbar thumb is painted above the row backgrounds');
  await setup.mockMouse.moveTo(12, 7);
  await setup.renderOnce();
  assert.deepEqual(previews, ['theme-34'], 'hover resolves exactly the painted row inside the border');
  await setup.mockMouse.moveTo(15, 7);
  assert.equal(previews.length, 1, 'moving across the same selected row does not reapply the theme');
  await setup.mockMouse.click(6, 7);
  assert.equal(previews.length, 1, 'clicking the frame does not activate a row');
  for (let step = 0; step < 40; step += 1) await setup.mockMouse.scroll(20, 15, 'up');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Theme 0\s/u, 'wheel reaches the first result without selection snapping it back');
  for (let step = 0; step < 60; step += 1) await setup.mockMouse.scroll(20, 15, 'down');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Theme 59/u, 'wheel reaches the final result');
  isOpen = false;
  model = { ...model };
  notify(model);
  await setup.renderOnce();
  isOpen = true;
  model = { ...model };
  notify(model);
  await setup.renderOnce();
  assert.ok(setup.captureCharFrame().includes(`▸ Theme ${model.selectedId?.slice(6)}`), `reopening reveals ${model.selectedId} after scrolling away`);
  model = { ...model, selectedId: 'theme-59' };
  notify(model);
  setup.resize(60, 18);
  await setup.renderOnce();
  frame = setup.captureCharFrame().split('\n');
  assert.equal(visibleRows, 9);
  assert.match(frame.join('\n'), /▸ Theme 59/u, 'resize keeps the selected theme visible');
  for (const [width, height] of [[15, 8], [1, 1]]) {
    const bounds = getPickerBounds(width!, height!);
    assert.ok(bounds.width <= width! && bounds.height <= height!, 'small terminals never get an oversized picker');
  }
} finally { setup.renderer.destroy(); }
console.log('theme-picker-layout passed full-height rows, borders, hover, resize and narrow bounds');
