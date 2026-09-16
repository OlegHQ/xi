import assert from 'node:assert/strict';
import { MultiCursorLanguageEditCoordinator, type MultiCursorEditPort } from '../../packages/workbench/editing/language-edits';

let applied = 0; let additional = 0; const port: MultiCursorEditPort = { apply(edits, extra) { applied += edits.length; additional = extra.length; return { ok: true, value: undefined }; } };
const coordinator = new MultiCursorLanguageEditCoordinator(port, 4, 9);
const response = { documentVersion: 4, selectionGeneration: 9, primary: { memberId: 'one', start: 0, end: 1, text: 'x' }, additional: [{ start: 5, end: 6, text: 'import' }, { start: 5, end: 6, text: 'import' }] };
assert.equal(coordinator.apply(response).ok, true, 'T088-MC11-01 primary and additional edits apply once'); assert.equal(applied, 1); assert.equal(additional, 1, 'T088-MC11-02 duplicate additional edit deduplicated');
coordinator.updateVersion(5, 10); assert.equal(coordinator.apply(response).ok, false, 'T088-STALE-01 moved selection invalidates pending acceptance');
coordinator.updateVersion(4, 9); assert.equal(coordinator.apply({ ...response, additional: [{ start: 0, end: 2, text: 'overlap' }] }).ok, false, 'T088-OVERLAP-01 incompatible ranges fail before editing'); coordinator.dispose();
console.log('T088 language edits passed primary/additional deduplication, move-only staleness and overlap preflight');
