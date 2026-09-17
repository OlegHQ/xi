import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId } from '../../packages/primitives/src/index';
import { openTextDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/src/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T123-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// T123: the UI adapter needs the read model to expose a view's scroll position so a
// wheel scroll written through `WorkbenchSession.setViewScroll` (apps/xi/src/main.ts's
// wheel handler) is visible to `WorkbenchRenderable` through `readView()`, instead of
// only living in the renderable's own private last-anchor map.

const session = new WorkbenchSession({ workspaceId: 'T123-scroll' });
const opened = openTextDocument(id<DocumentId>('T123-doc'), new TextEncoder().encode('alpha\nbeta\ngamma\n'));
if (opened.kind !== 'editable') throw new Error('T123-document-open');
const buffer = session.openBuffer(opened.document);
if (!buffer.ok) throw new Error(`T123-open:${buffer.error.kind}`);
const viewId = buffer.value.viewIds[0];
if (viewId === undefined) throw new Error('T123-no-view');

const initial = session.readView(viewId);
assert.ok(initial !== undefined, 'T123-01 a freshly opened view has a read model');
assert.equal(initial?.scrollTop, 0, 'T123-02 scrollTop starts at 0 (document line index)');
assert.equal(initial?.scrollLeft, 0, 'T123-03 scrollLeft starts at 0 (terminal cell column)');

const scrolled = session.setViewScroll(viewId, 2, 4);
assert.ok(scrolled.ok, 'T123-04 setViewScroll succeeds for an open view');

const afterScroll = session.readView(viewId);
assert.ok(afterScroll !== undefined, 'T123-05 the view is still readable after a scroll write');
assert.equal(afterScroll?.scrollTop, 2, 'T123-06 setViewScroll is visible through readView (scrollTop)');
assert.equal(afterScroll?.scrollLeft, 4, 'T123-07 setViewScroll is visible through readView (scrollLeft)');
assert.notEqual(afterScroll, initial, 'T123-08 the read-view cache invalidates when only scroll changes');

// A second read without any further scroll change must be a cache hit (same reference),
// not a silent recompute that could mask a broken cache-invalidation key.
const afterScrollAgain = session.readView(viewId);
assert.equal(afterScrollAgain, afterScroll, 'T123-09 an unchanged scroll position reuses the cached read view');

session.dispose();
console.log('T123 scroll read model passed setViewScroll visibility and cache-invalidation fixtures');
