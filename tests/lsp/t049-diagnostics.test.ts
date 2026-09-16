import assert from 'node:assert/strict';
import { DiagnosticStore } from '../../packages/services/language/diagnostics';
import { formatProblemsLines } from '../../packages/ui/problems/index';

const diagnostic = (message: string, line = 0) => ({ range: { startLine: line, startUtf16: 0, endLine: line, endUtf16: 2 }, message, severity: 1 as const, source: 'ts', code: 'E', });

const store = new DiagnosticStore();
store.markDocumentGeneration('file:///a.ts', 3);
assert.equal(store.publish({ serverId: 'ts', uri: 'file:///a.ts', generation: 2, diagnostics: [diagnostic('old')] }), false, 'T049-STALE-01 old generation rejected');
assert.equal(store.publish({ serverId: 'ts', uri: 'file:///a.ts', generation: 3, documentVersion: 7, diagnostics: [diagnostic('current'), diagnostic('second', 1)] }), true);
assert.equal(store.publish({ serverId: 'eslint', uri: 'file:///a.ts', generation: 3, diagnostics: [diagnostic('other')] }), true);
assert.equal(store.model.all.length, 3, 'T049-AGGREGATE-01 diagnostics aggregate per server');
assert.equal(store.diagnosticsFor('file:///a.ts')[0]?.message, 'current');
const rows = formatProblemsLines({ contractVersion: 1, generation: store.model.generation, all: store.model.all }, 80, 2);
assert.equal(rows.length, 2, 'T049-BOUNDED-01 footer reports truncation without rendering 10k rows');
const tenThousand = Array.from({ length: 10_000 }, (_, index) => diagnostic(`bulk-${index}`, index));
assert.equal(store.publish({ serverId: 'ts', uri: 'file:///bulk.ts', generation: 1, diagnostics: tenThousand }), true, 'T049-BOUNDED-02 accepts a large diagnostic batch');
assert.equal(store.model.all.length, 10_003, 'T049-BOUNDED-02 retains diagnostics in the service model');
const boundedBulkRows = formatProblemsLines(store.model, 100, 12);
assert.ok(boundedBulkRows.length <= 12, 'T049-BOUNDED-02 Problems rendering remains row bounded for 10k diagnostics');
store.clearUri('file:///a.ts');
assert.equal(store.diagnosticsFor('file:///a.ts').length, 0, 'T049-CLOSE-01 closed URI diagnostics clear');
store.clearUri('file:///bulk.ts');
assert.equal(store.model.all.length, 0, 'T049-CLOSE-01 all closed URI diagnostics clear');
store.dispose();
console.log('T049 diagnostics passed generation ordering, per-server aggregation, bounded Problems rows and close cleanup');
