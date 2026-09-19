import { strict as assert } from 'node:assert';
import { createTestRenderer } from '@opentui/core/testing';
import { WorkbenchRenderable, LIGHT_WORKBENCH_THEME } from '../../packages/ui/src/index';
import { DiffViewController } from '../../packages/workbench/git/diff';
import { BufferHost } from '../../packages/workbench/host';
import { WorkbenchSession } from '../../packages/workbench/session';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import { computeLineDiff } from '../../packages/services/git/diff';
import { prepareComparison } from '../../packages/services/git/alignment';
import type { DocumentId, ViewId, Utf16Offset, SyntaxReadPort } from '../../packages/contracts/src/index';

const lines = Array.from({ length: 60 }, (_, n) => `const line${n} = ${n};\n`);
const original = lines.join('');
lines[30] = 'const changed = "你好 😀";\n';
const working = lines.join('');
const opened = openTextDocument('diff-file' as DocumentId, new TextEncoder().encode(working));
if (opened.kind !== 'editable') throw new Error('fixture');
const document = opened.document;
const workbench = new WorkbenchSession();
const viewId = 'file-view' as ViewId;
assert.ok(workbench.openBuffer(document, { path: '/workspace/file.ts', viewId }).ok);
const host = new BufferHost(workbench, document, { launchViewId: viewId, marker: () => {}, workspaceRelativePath: path => path, openDocument: async () => document });
host.createSession(document, viewId);
const snapshots = new Map<DocumentId, DocumentSnapshot>([[document.id, document.snapshot()]]);
const controller = new DiffViewController({
  host, workbench, workspaceRoot: '/workspace', marker: () => {}, onError: message => { throw new Error(message); },
  openSyntax: snapshot => { snapshots.set(snapshot.id, snapshot); }, closeSyntax: id => { snapshots.delete(id); },
  service: {
    align: async lines => ({ unified: await prepareComparison(lines, false), split: await prepareComparison(lines, true) }),
    load: async () => ({ ok: true, value: { kind: 'ready', leftLabel: 'INDEX', rightLabel: 'WORKTREE', leftText: original, rightText: working, diff: computeLineDiff(original.match(/[^\n]*\n/g)!, lines, true) } }),
    compare: async (left, right) => computeLineDiff(left.match(/[^\n]*\n|[^\n]+$/g) ?? [], right.match(/[^\n]*\n|[^\n]+$/g) ?? [], true),
  },
});
await controller.open('file.ts', 'worktree');
const model = controller.readComparison()!;
assert.notEqual(model.viewId, viewId, 'comparison has an independent view/tab identity');
assert.equal(workbench.readTabs().length, 2);
assert.equal(host.documents.size, 1, 'both editors share one writable document');
assert.ok(workbench.activateBuffer(document.id).ok);
assert.equal(workbench.activeViewId, viewId, 'the ordinary file tab does not reactivate its comparison');
assert.equal(controller.readComparison(), undefined);
assert.ok(workbench.activateBuffer(model.viewId as unknown as DocumentId).ok);
assert.equal(workbench.activeViewId, model.viewId);
const cursor = workbench.readView(model.viewId)!.selections.members[0]!.head.at.offset;
assert.deepEqual(document.snapshot().lineIndexAt(cursor), { ok: true, value: 30 }, 'opening focuses the first changed line, not its context');

const syntax: SyntaxReadPort = { readSyntax: id => {
  const snapshot = id === document.id ? document.snapshot() : snapshots.get(id);
  if (snapshot === undefined) return undefined;
  return { documentVersion: snapshot.version, spansInRange: (start, end) => [{ start, end: Math.min(start + 5, end), kind: 'keyword' }] };
} };
for (const width of [160, 80]) {
  const setup = await createTestRenderer({ width, height: 24, bufferedOutput: 'memory' });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench, comparison: controller, syntax, theme: LIGHT_WORKBENCH_THEME });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const text = setup.captureSpans().lines.map(line => line.spans.map(span => span.text).join('')).join('\n');
  assert.match(text, /line30/, `${width}: original deleted text is visible`);
  assert.match(text, /changed/, `${width}: modified text is visible`);
  assert.match(text, /−/, `${width}: removed rows carry a minus sign`);
  assert.match(text, /\+/, `${width}: added rows carry a plus sign`);
  assert.match(text, /line29/, `${width}: unchanged context remains visible`);
  assert.ok(setup.captureSpans().lines.flatMap(line => line.spans).some(span => span.text.includes('const') && span.fg.r !== 30 / 255), 'syntax spans still color comparison text');
  setup.renderer.destroy();
}

const key = (raw: string) => ({ name: raw === '\x1b' ? 'escape' : raw, raw, shift: false, ctrl: false, option: false, meta: false });
const session = host.sessions.get(model.viewId)!;
for (const raw of ['i', 'X', '\x1b']) await session.handleKey(key(raw));
assert.ok(document.isDirty);
assert.equal(document.snapshot().slice(cursor, (Number(cursor) + 1) as Utf16Offset).ok, true);
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(controller.readComparison()?.rightLabel, 'BUFFER (unsaved)');
controller.close();
assert.equal(workbench.activeViewId, viewId);
assert.equal(workbench.readTabs().length, 1);
assert.ok(document.isDirty, 'closing comparison preserves unsaved file edits');
await host.sessions.get(viewId)!.handleKey(key('u'));
const restored = document.snapshot().slice(0 as Utf16Offset, document.snapshot().lengthUtf16 as Utf16Offset);
assert.ok(restored.ok);
assert.equal(restored.value, working, 'ordinary file view can undo an edit made in its comparison');
await controller.open('file.ts', 'index');
assert.equal(controller.readComparison()?.editable, false);
assert.equal(controller.handleKeypress(key('i')), true, 'index side never enters Insert');
assert.equal(workbench.readView(workbench.activeViewId!)?.session.mode, 'normal');
controller.close();
assert.equal(snapshots.size, 1, 'closing comparisons releases original/index syntax snapshots');
controller.dispose(); host.dispose();
console.log('Git comparison passed separate tabs/shared document, first-change focus, split/unified +/- syntax frames and edit/close preservation');
