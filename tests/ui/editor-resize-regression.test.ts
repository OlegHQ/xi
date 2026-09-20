import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { WorkbenchSession } from '../../packages/workbench/session';
import { WorkbenchRenderable } from '../../packages/ui/src/workbench';
import { createChromeSurfaceNode, createThemeBridge, mountSolidRoot } from '../../packages/ui/src/solid/composition';

const session = new WorkbenchSession();
const text = Array.from({ length: 100 }, (_, i) => `row${String(i).padStart(3, '0')} ` + 'long source content '.repeat(30)).join('\n');
const document = TextFileDocument.create('resize-doc' as DocumentId, text, Array(99).fill('lf'), 'lf');
assert.ok(document.ok);
const first = 'resize-first' as ViewId;
assert.ok(session.openBuffer(document.value, { viewId: first, path: 'source.txt' }).ok);
const split = session.splitView(first, 'vertical');
assert.ok(split.ok);
const setup = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory' });
const tabs = (viewId?: string) => session.readTabs(viewId as ViewId | undefined);
const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: session, fileLabel: 'source.txt', tabs });
setup.renderer.root.add(viewport);
let notify = () => {};
await mountSolidRoot(setup.renderer, [createChromeSurfaceNode({ workbench: session, theme: viewport.theme, fileLabel: 'source.txt', tabs,
  tabStrips: (width, height) => viewport.getTabStrips(width, height), showBottomPanel: false,
  subscribe: listener => { notify = listener; return { dispose() {} }; },
}, createThemeBridge(viewport.theme))]);
try {
  for (const [width, height, ratio] of [[120, 40, .5], [120, 40, .3], [150, 45, .65], [90, 30, .5], [120, 40, .5]] as const) {
    setup.resize(width, height);
    await setup.waitFor(() => viewport.width === width && viewport.height === height);
    await setup.renderOnce();
    const root = session.readLayout().split.root;
    assert.equal(root?.kind, 'split');
    if (root?.kind !== 'split') throw new Error('missing split');
    assert.ok(session.resizeSplit(root.nodeId, ratio, viewport.layout.editorWidth - 1).ok);
    notify(); viewport.refresh(); await setup.renderOnce();
    const frame = setup.captureCharFrame().split('\n');
    const strips = viewport.tabStrips;
    for (const strip of strips) {
      assert.match(frame[strip.y]!.slice(strip.x, strip.x + strip.width), /source.txt/, `tab matches pane ${width}/${ratio}`);
      for (let row = 0; row < viewport.layout.editorHeight; row++) {
        assert.match(frame[strip.y + 1 + row]!.slice(strip.x, strip.x + strip.width), new RegExp(`row${String(row).padStart(3, '0')}`), `clipped long line must not hide later rows: ${width}/${ratio}/${row}`);
      }
    }
  }
} finally { setup.renderer.destroy(); session.dispose(); }
console.log('Long-line pane fill and tab alignment passed split dragging and terminal resizes');
