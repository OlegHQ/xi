import { strict as assert } from 'node:assert';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import type { SyntaxRead, SyntaxReadPort, SyntaxSpan } from '../../packages/contracts/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { WorkbenchRenderable } from '../../packages/ui/src/index';

// H1-3: `snapshotSyntaxRowsIfCurrent` used to re-slice every visible row's syntax spans
// (`syntaxRead.spansInRange`) on every single render, even when neither the document nor
// the syntax read had changed since the last one. This proves a second render with nothing
// changed does not re-query spans for rows whose content didn't change.

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'PERF-syntax-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const VIEW_ID = id<ViewId>('PERF-syntax-view');
const DOCUMENT_ID = id<DocumentId>('PERF-syntax-document');
const LINES = Array.from({ length: 20 }, (_unused, index) => `const line${index} = ${index};`);
const TEXT = LINES.join('\n');

function makeFixture(): { readonly workbench: WorkbenchReadPort; readonly snapshot: DocumentSnapshot } {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode(TEXT));
  if (opened.kind !== 'editable') throw new Error('PERF-syntax-open');
  const snapshot = opened.document.snapshot();
  const primary = id<SelectionId>('PERF-syntax-primary');
  const offset = (value: number) => {
    const result = asUtf16Offset(value);
    if (!result.ok) throw new Error(`PERF-syntax-offset:${value}`);
    return result.value;
  };
  const members = [{ id: primary, kind: 'normal-cursor' as const, direction: 'forward' as const, anchor: { kind: 'character' as const, offset: offset(0), after: offset(1) }, head: { kind: 'character' as const, offset: offset(0), after: offset(1) } }];
  const selections = createSelectionSet(snapshot, { primaryId: primary, selectionGeneration: 1, members });
  if (!selections.ok) throw new Error(`PERF-syntax-selection:${selections.error.kind}`);
  const selectionSet = selections.value.selectionSet;
  const session = { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selectionSet, mode: 'normal' } as const;
  const view: WorkbenchViewSnapshot = { session, document: snapshot, selections: selectionSet, scrollTop: 0, scrollLeft: 0 };
  const document: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) => expectedVersion === snapshot.version ? snapshot.slice(start, end) : { ok: false, error: { kind: 'stale-version' } },
  };
  return { snapshot, workbench: { activeViewId: VIEW_ID, readView: (viewId) => viewId === VIEW_ID ? view : undefined, readDocument: (viewId) => viewId === VIEW_ID ? document : undefined } };
}

function countingSyntaxPort(documentVersion: DocumentSnapshot['version'], counter: { calls: number }): SyntaxReadPort {
  const spans: readonly SyntaxSpan[] = Object.freeze([Object.freeze({ start: 0, end: 5, kind: 'keyword' as const })]);
  const read: SyntaxRead = {
    documentVersion,
    spansInRange: (start, end) => { counter.calls += 1; return spans.filter((span) => span.start < end && span.end > start); },
  };
  return { readSyntax: (documentId) => documentId === DOCUMENT_ID ? read : undefined };
}

async function unchangedRenderDoesNotRequerySpans(): Promise<void> {
  const fixture = makeFixture();
  const counter = { calls: 0 };
  const setup = await createTestRenderer({ width: 80, height: 24, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: 'editor.ts',
    syntax: countingSyntaxPort(fixture.snapshot.version, counter),
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const firstPassCalls = counter.calls;
  assert.ok(firstPassCalls >= LINES.length, 'PERF-SYNTAX-00 the first paint queries spans for the visible rows');

  counter.calls = 0;
  viewport.refresh();
  await setup.renderOnce();
  assert.equal(counter.calls, 0, 'PERF-SYNTAX-01 a second render with nothing changed reuses every row\'s cached spans instead of re-querying spansInRange');

  setup.renderer.destroy();
}

await unchangedRenderDoesNotRequerySpans();
console.log('perf-syntax-snapshot-reuse passed: an unchanged render reuses cached per-row syntax spans instead of re-querying them');
