import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTestRenderer } from '@opentui/core/testing';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { WorkbenchSession } from '../../packages/workbench/session';
import { WorkbenchRenderable } from '../../packages/ui/src/workbench';
import { createWorkbenchAppNode } from '../../packages/ui/src/solid/workbench';
import { createThemeBridge, mountSolidRoot } from '../../packages/ui/src/solid/composition';
import type { Disposable } from '../../packages/contracts/src/index';

const workbench = new WorkbenchSession();
const source = '# Preview title\n\nA **bold** word and [link](https://example.com).\n\n| Name | Status |\n| --- | --- |\n| api | ready |\n\n```ts\nconst value = 1;\n```\n';
const document = TextFileDocument.create('preview-document' as DocumentId, source, Array(source.split('\n').length - 1).fill('lf'), 'lf');
assert.ok(document.ok);
const initialVersion = document.value.snapshot().version;
const viewId = 'preview-view' as ViewId;
assert.ok(workbench.openBuffer(document.value, { viewId, path: 'preview.md' }).ok);
const setup = await createTestRenderer({ width: 100, height: 30, bufferedOutput: 'memory' });
let preview = false;
let failPreview = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): Disposable => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; };
const options = {
  isMarkdownPreview: (id: string) => preview && id === viewId,
  scheduleMarkdownPreview: (task: () => void) => { if (failPreview) throw new Error('Deliberate preview failure'); const timer = setTimeout(task, 0); return { dispose: () => clearTimeout(timer) }; },
  subscribeSurfaceChanges: subscribe,
  dispatchKey: () => 'unhandled' as const,
};
const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench, fileLabel: 'preview.md', ...options });
setup.renderer.root.add(viewport);
await mountSolidRoot(setup.renderer, [createWorkbenchAppNode({ workbench, fileLabel: 'preview.md', viewport, options, theme: viewport.theme, themeBridge: createThemeBridge(viewport.theme), requestFrame: () => setup.renderer.requestRender(), subscribeFrame: subscribe })]);
const refresh = () => { for (const listener of listeners) listener(); viewport.refresh(); };
try {
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /\*\*bold\*\*/);
  for (let toggle = 0; toggle < 3; toggle += 1) {
    preview = true; refresh();
    await new Promise(resolve => setTimeout(resolve, 500));
    await setup.waitForFrame(frame => frame.includes('Markdown preview') && frame.includes('ready') && frame.includes('Preview title') && !frame.includes('Loading'));
    const rendered = setup.captureCharFrame();
    assert.ok(!rendered.includes('**bold**'), 'preview clears raw markup');
    assert.ok(!rendered.includes('[link]('), 'native viewer conceals link markup');
    assert.match(rendered, /Preview title/);
    assert.match(rendered, /const value = 1/);
    assert.equal(viewport.cursorCell, undefined, 'source cursor hidden');
    await mkdir('.artifacts/markdown-preview', { recursive: true });
    await writeFile('.artifacts/markdown-preview/frame.txt', rendered);
    preview = false; refresh();
    await setup.waitForFrame(frame => frame.includes('**bold**') && !frame.includes('Markdown preview'));
    assert.ok(!setup.captureCharFrame().includes('│ api'), 'source clears table cells');
  }
  preview = true; refresh();
  await new Promise(resolve => setTimeout(resolve, 500));
  setup.resize(70, 20); refresh();
  await new Promise(resolve => setTimeout(resolve, 500));
  await setup.waitForFrame(frame => frame.includes('Preview title') && frame.includes('ready'));
  setup.resize(120, 30);
  assert.ok(workbench.splitView(viewId, 'vertical').ok);
  refresh();
  await new Promise(resolve => setTimeout(resolve, 500));
  await setup.waitForFrame(frame => frame.includes('Markdown preview') && frame.includes('**bold**'));
  preview = false; refresh();
  await setup.waitForFrame(frame => !frame.includes('Markdown preview'));
  failPreview = true; preview = true; refresh();
  await setup.waitForFrame(frame => frame.includes('Markdown preview failed') && frame.includes('Deliberate preview failure'));
  preview = false; refresh();
  await setup.waitForFrame(frame => frame.includes('**bold**') && !frame.includes('Deliberate preview failure'));
  assert.equal(document.value.snapshot().version, initialVersion, 'view toggle does not edit source');
} finally { setup.renderer.destroy(); workbench.dispose(); }
console.log('Native Markdown preview renders and clears both directions across repeated toggles');
