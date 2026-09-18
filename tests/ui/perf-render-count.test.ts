import { strict as assert } from 'node:assert';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { runOpenTuiWorkbench } from '../../packages/ui/src/index';
import type { CliRenderer } from '@opentui/core/renderer';
import type { Disposable } from '../../packages/contracts/src/index';
import { dispatchKeyFromOnKeypress } from './router-test-helpers';

// H1-1: `subscribeSurfaceChanges` notifications (~7/edit from the syntax capture window,
// per the audit finding) used to each unconditionally run `installOptionalSurfacesNow`'s
// own `renderer.intermediateRender()` synchronously, on top of the normal one-frame-per-key
// flush -- roughly 20 real render passes per keystroke. This counts actual renderer 'frame'
// events (not just `onFrame`, which only fires from the normal flush path and would have
// missed the bug entirely) to prove a keystroke, and a same-tick burst of surface-change
// notifications, each still produce exactly one render pass.

const VIEW_ID = id<ViewId>('PERF-view');
const DOCUMENT_ID = id<DocumentId>('PERF-document');

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'PERF-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function makeCursorView(snapshot: DocumentSnapshot, primary: SelectionId, offset: number, generation: number): WorkbenchViewSnapshot {
  const head = asUtf16Offset(offset);
  const after = asUtf16Offset(offset + 1);
  if (!head.ok || !after.ok) throw new Error(`PERF-offset:${offset}`);
  const selections = createSelectionSet(snapshot, {
    primaryId: primary,
    selectionGeneration: generation,
    members: [{ id: primary, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: head.value, after: after.value }, head: { kind: 'character', offset: head.value, after: after.value } }],
  });
  if (!selections.ok) throw new Error(`PERF-selection:${selections.error.kind}`);
  return {
    session: { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selections.value.selectionSet, mode: 'normal' },
    document: snapshot,
    selections: selections.value.selectionSet,
    scrollTop: 0,
    scrollLeft: 0,
  };
}

function makeMutableWorkbench(text: string): { readonly workbench: WorkbenchReadPort; readonly moveCursor: (offset: number) => void } {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('PERF-document-open');
  const snapshot = opened.document.snapshot();
  const primary = id<SelectionId>('PERF-primary');
  let offset = 0;
  let generation = 0;
  let view = makeCursorView(snapshot, primary, offset, generation);
  const document: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) => expectedVersion === snapshot.version
      ? snapshot.slice(start, end)
      : { ok: false, error: { kind: 'stale-version' } },
  };
  const workbench: WorkbenchReadPort = {
    activeViewId: VIEW_ID,
    readView: (viewId) => viewId === VIEW_ID ? view : undefined,
    readDocument: (viewId) => viewId === VIEW_ID ? document : undefined,
  };
  return {
    workbench,
    moveCursor: (nextOffset) => { offset = nextOffset; generation += 1; view = makeCursorView(snapshot, primary, offset, generation); },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
}

async function testKeystrokeRendersOnce(): Promise<void> {
  const { workbench, moveCursor } = makeMutableWorkbench('alpha\nbeta\ngamma\n');
  const setup = await createTestRenderer({ width: 80, height: 24, bufferedOutput: 'memory', gatherStats: true });
  let renderPasses = 0;
  setup.renderer.on('frame', () => { renderPasses += 1; });
  let nextOffset = 0;
  const run = runOpenTuiWorkbench(workbench, 'editor.ts', {
    renderer: Promise.resolve(setup.renderer as unknown as CliRenderer),
    dispatchKey: dispatchKeyFromOnKeypress(() => { nextOffset += 1; moveCursor(nextOffset); return true; }),
  });
  await tick();
  renderPasses = 0;

  setup.mockInput.pressKey('a');
  await tick();
  assert.equal(renderPasses, 1, 'PERF-KEY-01 a single keystroke produces exactly one render pass');

  setup.renderer.destroy();
  await run;
}

async function testSurfaceChangeBurstRendersOnce(): Promise<void> {
  const { workbench } = makeMutableWorkbench('alpha\nbeta\ngamma\n');
  const setup = await createTestRenderer({ width: 80, height: 24, bufferedOutput: 'memory', gatherStats: true });
  let renderPasses = 0;
  setup.renderer.on('frame', () => { renderPasses += 1; });
  let notify: (() => void) | undefined;
  const run = runOpenTuiWorkbench(workbench, 'editor.ts', {
    renderer: Promise.resolve(setup.renderer as unknown as CliRenderer),
    dispatchKey: dispatchKeyFromOnKeypress(() => false),
    subscribeSurfaceChanges: (listener: () => void): Disposable => {
      notify = listener;
      return { dispose: () => { notify = undefined; } };
    },
  });
  await tick();
  assert.ok(notify !== undefined, 'PERF-SURFACE-00 subscribeSurfaceChanges registered a listener');
  renderPasses = 0;

  // Same-tick burst: mirrors ~7 `notifySurfaceChange` calls from one keystroke's syntax
  // capture window (H1-1 finding), all firing synchronously within one macrotask.
  for (let i = 0; i < 7; i += 1) notify?.();
  await tick();
  assert.equal(renderPasses, 1, 'PERF-SURFACE-01 a same-tick burst of 7 surface-change notifications coalesces to one render pass');

  setup.renderer.destroy();
  await run;
}

await testKeystrokeRendersOnce();
await testSurfaceChangeBurstRendersOnce();
console.log('perf-render-count passed: one render pass per keystroke and per same-tick surface-change burst');
