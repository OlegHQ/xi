import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { WorkbenchSession } from '../../packages/workbench/session';
import { WorkbenchRenderable } from '../../packages/ui/src/workbench';
import { createChromeSurfaceNode, createThemeBridge, mountSolidRoot } from '../../packages/ui/src/solid/composition';

for (const orientation of ['horizontal', 'vertical'] as const) {
  const session = new WorkbenchSession();
  const doc = TextFileDocument.create('pane-doc' as DocumentId, 'body\n', ['lf'], 'lf');
  assert.ok(doc.ok);
  const first = 'pane-first' as ViewId;
  assert.ok(session.openBuffer(doc.value, { viewId: first, path: 'first.txt' }).ok);
  const split = session.splitView(first, orientation);
  assert.ok(split.ok);
  const second = TextFileDocument.create('pane-other' as DocumentId, 'second body\n', ['lf'], 'lf');
  assert.ok(second.ok);
  assert.ok(session.openBuffer(second.value, { path: 'second.txt' }).ok);
  const secondView = session.activeViewId!;
  const tabs = (viewId?: string) => session.readTabs(viewId as ViewId | undefined);
  const setup = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory' });
  const controls: string[] = [];
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: session, fileLabel: 'first.txt', tabs, onPointer: event => { if (event.phase === 'down' && event.control !== undefined) controls.push(event.control.kind); return true; } });
  setup.renderer.root.add(viewport);
  let notify = () => {};
  await mountSolidRoot(setup.renderer, [createChromeSurfaceNode({
    workbench: session, theme: viewport.theme, fileLabel: 'first.txt', tabs,
    tabStrips: (width, height) => viewport.getTabStrips(width, height), showBottomPanel: false,
    onPointer: viewport.forwardPointerEvent.bind(viewport),
    subscribe: listener => { notify = listener; return { dispose() {} }; },
  }, createThemeBridge(viewport.theme))]);
  try {
    await setup.renderOnce();
    const strips = viewport.tabStrips;
    assert.equal(strips.length, 2);
    if (orientation === 'horizontal') {
      assert.equal(strips[1]!.y, 19, 'the lower buffer strip occupies the split boundary with no extra separator row');
      await setup.mockMouse.click(strips[1]!.x + 2, strips[1]!.y);
      assert.equal(controls.at(-1), 'tab', 'the shared boundary keeps tab clicks');
      await setup.mockMouse.click(strips[1]!.x + strips[1]!.width - 2, strips[1]!.y);
      assert.equal(controls.at(-1), 'splitter', 'unused tab-strip space still resizes the split');
    }
    const frame = setup.captureCharFrame().split('\n');
    for (const strip of strips) {
      assert.match(frame[strip.y]!.slice(strip.x, strip.x + strip.width), /first.txt/);
      assert.match(frame[strip.y]!.slice(strip.x, strip.x + strip.width), /second.txt/);
    }
    assert.ok(orientation === 'horizontal' ? strips[1]!.y > strips[0]!.y : strips[1]!.x > strips[0]!.x);
    assert.equal(tabs(first).find(tab => tab.active)?.id, doc.value.id);
    assert.equal(tabs(secondView).find(tab => tab.active)?.id, second.value.id);
    const nested = session.splitView(secondView, orientation === 'horizontal' ? 'vertical' : 'horizontal');
    assert.ok(nested.ok);
    notify();
    await setup.renderOnce();
    const changedFrame = setup.captureCharFrame().split('\n');
    assert.equal(viewport.tabStrips.length, 3);
    for (const strip of viewport.tabStrips) assert.match(changedFrame[strip.y]!.slice(strip.x, strip.x + strip.width), /second.txt/);
    assert.ok(session.closeView(nested.value.viewId, 'discard').ok);
    notify();
    // The file already visible in the first pane can also open in the second without moving the first.
    assert.ok(session.activateBuffer(doc.value.id, secondView).ok);
    assert.equal(session.readView(first)?.document.id, doc.value.id);
    assert.notEqual(session.activeViewId, first);
    assert.equal(session.readView(session.activeViewId!)?.document.id, doc.value.id);
    assert.equal(viewport.tabStrips.length, 2);
  } finally { setup.renderer.destroy(); session.dispose(); }
}
console.log('Per-pane buffer strips render both orientations and preserve independent buffer activation');
