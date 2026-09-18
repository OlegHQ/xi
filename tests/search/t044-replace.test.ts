import assert from 'node:assert/strict';
import { WorkspaceReplaceService, applyReplacementEdits, type ReplaceApplyPort, type ReplaceTarget } from '../../packages/services/search/replace';
import type { SearchMatch, SearchQuery } from '../../packages/services/search/index';

const target: ReplaceTarget = { rootId: 'root', path: 'a.ts', text: 'one\ntwo one', source: 'disk', diskHash: 'h' };
const match = (line: number, start: number, end: number): SearchMatch => ({ id: `${line}`, rootId: 'root', path: 'a.ts', line, range: { startUtf16: start, endUtf16: end }, lineText: line === 0 ? 'one' : 'two one', snippet: '', source: 'disk', diskHash: 'h', generation: 1 });
const query: SearchQuery = { rootId: 'root', rootPath: '/repo', query: '(one)', regex: true };
let applied = false;
const port: ReplaceApplyPort = { async readTarget() { return { ok: true, value: target }; }, async apply(plan) { applied = plan.edits.every((edit) => edit.replacement === 'ONE'); return { ok: true, value: { journal: { schemaVersion: 1, operationId: 'test', generation: plan.generation, entries: [], status: 'applied' }, restored: false } }; }, async restore() { return { ok: true, value: undefined }; } };
const service = new WorkspaceReplaceService(port);
const preview = service.preview(query, 'ONE', [target], [match(0, 0, 3), match(1, 4, 7)], 1);
assert.equal(preview.ok, true, 'T044-PREVIEW-01 replacement preview builds from search ranges');
if (preview.ok) { assert.equal(preview.value.edits.length, 2); assert.equal((await service.apply(preview.value)).ok, true); }
assert.equal(applied, true, 'T044-APPLY-01 preview replacement equals applied plan');
if (preview.ok) {
  const rendered = applyReplacementEdits(target.text, preview.value.edits);
  assert.equal(rendered.ok, true, 'T044-E06-01 applying preview produces text');
  if (rendered.ok) assert.equal(rendered.value, 'ONE\ntwo ONE', 'T044-E06-02 preview text equals applied text');
}
const changed = new WorkspaceReplaceService({ ...port, async readTarget() { return { ok: true, value: { ...target, text: 'changed' } }; } });
if (preview.ok) assert.equal((await changed.apply(preview.value)).ok, false, 'T044-STALE-01 changed target refuses blind apply');
const invalid = service.preview({ ...query, query: '[' }, 'x', [target], [], 1); assert.equal(invalid.ok, false, 'T044-REGEX-FAIL-01 invalid regex is explicit');
const multiline: ReplaceTarget = { rootId: 'root', path: 'multi.ts', text: 'a\nb', source: 'buffer', version: 4 };
const multilineMatch: SearchMatch = { id: 'multi', rootId: 'root', path: 'multi.ts', line: 0, endLine: 1, range: { startUtf16: 0, endUtf16: 1 }, lineText: 'a', snippet: 'a\nb', source: 'buffer', documentVersion: 4, generation: 2 };
const multilinePlan = service.preview({ ...query, query: 'a\\nb' }, 'X', [multiline], [multilineMatch], 2);
assert.equal(multilinePlan.ok, true, 'T044-MULTILINE-01 multiline match keeps exact UTF-16 range');
if (multilinePlan.ok) {
  const rendered = applyReplacementEdits(multiline.text, multilinePlan.value.edits);
  assert.equal(rendered.ok && rendered.value, 'X', 'T044-MULTILINE-02 preview applies across lines');
}
const namedTarget: ReplaceTarget = { rootId: 'root', path: 'named.ts', text: 'ONE', source: 'disk', diskHash: 'named' };
const namedMatch: SearchMatch = { id: 'named', rootId: 'root', path: 'named.ts', line: 0, range: { startUtf16: 0, endUtf16: 3 }, lineText: 'ONE', snippet: 'ONE', source: 'disk', diskHash: 'named', generation: 3 };
const namedPlan = service.preview({ ...query, query: '(?<word>ONE)' }, '\\L$<word>-$1\\E', [namedTarget], [namedMatch], 3);
assert.equal(namedPlan.ok, true, 'T044-CAPTURE-01 named and numeric captures parse');
if (namedPlan.ok) assert.equal(namedPlan.value.edits[0]?.replacement, 'one-one', 'T044-CAPTURE-02 explicit preserve-case grammar is deterministic');
const zeroTarget: ReplaceTarget = { rootId: 'root', path: 'zero.ts', text: 'a\nb', source: 'disk', diskHash: 'zero' };
const zeroMatches: SearchMatch[] = [0, 1].map((line) => ({ id: `zero-${line}`, rootId: 'root', path: 'zero.ts', line, range: { startUtf16: 0, endUtf16: 0 }, lineText: line === 0 ? 'a' : 'b', snippet: '', source: 'disk', diskHash: 'zero', generation: 4 }));
const zeroPlan = service.preview({ ...query, query: '^' }, 'X', [zeroTarget], zeroMatches, 4);
assert.equal(zeroPlan.ok, true, 'T044-ZERO-01 zero-width matches terminate and remain selectable');
if (zeroPlan.ok) { const rendered = applyReplacementEdits(zeroTarget.text, zeroPlan.value.edits); assert.equal(rendered.ok && rendered.value, 'Xa\nXb', 'T044-ZERO-02 zero-width preview applies once per line'); }
const overlapMatches = [0, 0].map((start, index) => ({ ...match(0, start, start + 1), id: `overlap-${index}`, generation: 5 }));
const overlap = service.preview({ ...query, query: '.' }, 'X', [target], overlapMatches, 5);
assert.equal(overlap.ok, false, 'T044-OVERLAP-01 overlapping edits refuse preview');
// A lookahead/lookbehind depends on context outside the matched range itself; re-verifying the
// match by exec-ing only the isolated matched slice always reports "match changed" even though
// nothing changed. The preview must re-run against the full text instead.
const lookaroundTarget: ReplaceTarget = { rootId: 'root', path: 'lookaround.ts', text: 'foo(bar)', source: 'disk', diskHash: 'la' };
const lookaroundMatch: SearchMatch = { id: 'lookaround', rootId: 'root', path: 'lookaround.ts', line: 0, range: { startUtf16: 4, endUtf16: 7 }, lineText: 'foo(bar)', snippet: 'foo(bar)', source: 'disk', diskHash: 'la', generation: 6 };
const lookaroundPlan = service.preview({ ...query, query: '(?<=\\()\\w+(?=\\))' }, 'BAZ', [lookaroundTarget], [lookaroundMatch], 6);
assert.equal(lookaroundPlan.ok, true, 'T044-LOOKAROUND-01 a lookaround match is not reported as changed');
if (lookaroundPlan.ok) {
  const rendered = applyReplacementEdits(lookaroundTarget.text, lookaroundPlan.value.edits);
  assert.equal(rendered.ok && rendered.value, 'foo(BAZ)', 'T044-LOOKAROUND-02 lookaround preview applies correctly');
}
// F2-1: `$&` must expand to the whole match text, not the literal character `&`.
const ampersandTarget: ReplaceTarget = { rootId: 'root', path: 'amp.ts', text: 'foo', source: 'disk', diskHash: 'amp' };
const ampersandMatch: SearchMatch = { id: 'amp', rootId: 'root', path: 'amp.ts', line: 0, range: { startUtf16: 0, endUtf16: 3 }, lineText: 'foo', snippet: 'foo', source: 'disk', diskHash: 'amp', generation: 7 };
const ampersandPlan = service.preview({ ...query, query: 'foo' }, '[$&]', [ampersandTarget], [ampersandMatch], 7);
assert.equal(ampersandPlan.ok, true, 'T044-AMPERSAND-01 $& replacement parses');
if (ampersandPlan.ok) assert.equal(ampersandPlan.value.edits[0]?.replacement, '[foo]', 'F2-1: $& expands to the whole match (match[0]), not the literal character &');
// `$$` must still expand to a literal `$`, unaffected by the $& fix.
const dollarPlan = service.preview({ ...query, query: 'foo' }, '$$$&', [ampersandTarget], [ampersandMatch], 7);
if (dollarPlan.ok) assert.equal(dollarPlan.value.edits[0]?.replacement, '$foo', 'T044-DOLLAR-01 $$ still expands to a literal dollar sign');

// F2-2: two different roots with the SAME relative path must not have their edits grouped
// together and applied with each other's offsets.
const rootATarget: ReplaceTarget = { rootId: 'root-a', path: 'shared.ts', text: 'aaa', source: 'disk', diskHash: 'a' };
const rootBTarget: ReplaceTarget = { rootId: 'root-b', path: 'shared.ts', text: 'bbbbbbbb', source: 'disk', diskHash: 'b' };
const rootAMatch: SearchMatch = { id: 'root-a-match', rootId: 'root-a', path: 'shared.ts', line: 0, range: { startUtf16: 0, endUtf16: 3 }, lineText: 'aaa', snippet: 'aaa', source: 'disk', diskHash: 'a', generation: 8 };
const rootBMatch: SearchMatch = { id: 'root-b-match', rootId: 'root-b', path: 'shared.ts', line: 0, range: { startUtf16: 4, endUtf16: 8 }, lineText: 'bbbbbbbb', snippet: 'bbbbbbbb', source: 'disk', diskHash: 'b', generation: 8 };
const multiRootPlan = service.preview({ ...query, query: '\\w+', regex: true }, 'X', [rootATarget, rootBTarget], [rootAMatch, rootBMatch], 8);
assert.equal(multiRootPlan.ok, true, 'T044-MULTIROOT-01 same-relative-path matches across two roots preview together');
if (multiRootPlan.ok) {
  assert.equal(multiRootPlan.value.edits.every((edit) => edit.rootId !== undefined), true, 'F2-2: every edit carries its rootId');
  const rootAEdits = multiRootPlan.value.edits.filter((edit) => edit.rootId === 'root-a');
  const rootBEdits = multiRootPlan.value.edits.filter((edit) => edit.rootId === 'root-b');
  assert.equal(rootAEdits.length, 1, 'F2-2: root-a keeps only its own edit');
  assert.equal(rootBEdits.length, 1, 'F2-2: root-b keeps only its own edit');
  assert.equal(rootAEdits[0]?.endUtf16, 3, "F2-2: root-a's edit keeps root-a's own offsets, not root-b's");
  const renderedA = applyReplacementEdits(rootATarget.text, rootAEdits);
  assert.equal(renderedA.ok && renderedA.value, 'X', "F2-2: applying root-a's edits against root-a's text must not use root-b's offsets");
}

service.dispose(); changed.dispose();
console.log('T044 workspace replace passed E06 preview/apply equality, stale and overlap refusal, multiline/zero-width matches, captures, preserve-case grammar, lookaround match verification, $& expansion (F2-1) and multi-root path keying (F2-2)');
