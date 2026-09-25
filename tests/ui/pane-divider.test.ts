import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { WorkbenchSession } from '../../packages/workbench/session';
import { WorkbenchRenderable } from '../../packages/ui/src/workbench';

for (const ascii of [false, true]) for (const orientation of ['horizontal', 'vertical'] as const) {
  const session = new WorkbenchSession();
  const document = TextFileDocument.create('divider-doc' as DocumentId, 'body\n', ['lf'], 'lf');
  assert.ok(document.ok);
  const first = 'divider-first' as ViewId;
  assert.ok(session.openBuffer(document.value, { viewId: first }).ok);
  assert.ok(session.splitView(first, orientation).ok);
  const setup = await createTestRenderer({ width: 100, height: 24, bufferedOutput: 'memory' });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: session, fileLabel: 'divider.txt', ascii, bufferline: 'never' });
  setup.renderer.root.add(viewport);
  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame().split('\n');
    if (orientation === 'vertical') {
      const dividerX = viewport.layout.editorX + Math.floor((viewport.layout.editorWidth - 1) / 2);
      for (let row = 0; row < viewport.layout.statusRow; row++) assert.equal(frame[row]?.[dividerX], ascii ? '|' : '│', `vertical pane divider at row ${row}`);
    } else {
      const dividerY = viewport.layout.editorTop - 1 + Math.floor((viewport.layout.editorHeight + 1) / 2);
      assert.equal(frame[dividerY]?.slice(viewport.layout.editorX), (ascii ? '-' : '─').repeat(viewport.layout.editorWidth), 'horizontal pane divider spans the editor');
    }
  } finally { setup.renderer.destroy(); session.dispose(); }
}
console.log('Pane dividers render in both orientations and Unicode and ASCII modes');
