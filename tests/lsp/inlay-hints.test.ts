#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { decodeDocumentColors, decodeDocumentHighlights, decodeInlayHints, LanguagePresentationFeatures } from '../../packages/services/language/folding';

const decoded = decodeInlayHints([
  { position: { line: 1, character: 4 }, label: [{ value: ': ' }, { value: 'number' }] },
  { position: { line: 2, character: 0 }, label: 'abcde' },
], 'doc', 3, 1, 4);
assert.equal(decoded.ok, true, 'T036-LSP-INLAY-HINTS-UNIT-01 decoder accepts LSP string and label-part labels');
if (decoded.ok) {
  assert.deepEqual(decoded.value.hints.map((hint) => hint.label), [': nu', 'abcd'], 'T036-LSP-INLAY-HINTS-LIMIT-UNIT-01 decoder applies the configured UTF-16 label limit');
  const presentation = new LanguagePresentationFeatures();
  assert.equal(presentation.applyHints(decoded.value).ok, true, 'T036-LSP-INLAY-HINTS-UNIT-01 presentation accepts the versioned result');
  assert.equal(presentation.visibleHints('doc', 1, 2)?.hints.length, 1, 'T036-LSP-INLAY-HINTS-UNIT-01 presentation filters by visible line');
  presentation.dispose();
}

const highlights = decodeDocumentHighlights([
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
  { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, kind: 2 },
], 'doc', 3, 5);
assert.equal(highlights.ok, true, 'T036-LSP-DOCUMENT-HIGHLIGHT-UNIT-01 decoder accepts valid LSP highlight ranges');
if (highlights.ok) {
  const presentation = new LanguagePresentationFeatures();
  assert.equal(presentation.applyDocumentHighlights(highlights.value).ok, true, 'T036-LSP-DOCUMENT-HIGHLIGHT-UNIT-02 presentation accepts the versioned result');
  assert.equal(presentation.documentHighlights('doc')?.ranges.length, 2, 'T036-LSP-DOCUMENT-HIGHLIGHT-UNIT-03 presentation retains highlight ranges');
  presentation.dispose();
}
assert.equal(decodeDocumentHighlights([{ range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } } }], 'doc', 3, 6).ok, false, 'T036-LSP-DOCUMENT-HIGHLIGHT-INVALID-UNIT-01 rejects reversed ranges');

assert.equal(decodeInlayHints([{ position: { line: -1, character: 0 }, label: 'bad' }], 'doc', 3, 2).ok, false, 'T036-LSP-INLAY-HINTS-INVALID-UNIT-01 rejects invalid positions');
assert.equal(decodeInlayHints(null, 'doc', 3, 2).ok, true, 'T036-LSP-INLAY-HINTS-UNIT-01 accepts a null LSP result');
const colors = decodeDocumentColors([{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } }, color: { red: 1, green: 0.5, blue: 0, alpha: 1 } }], 'doc', 3, 4);
assert.equal(colors.ok, true, 'T036-LSP-COLOR-SWATCHES-UNIT-01 decoder accepts a valid LSP document color');
if (colors.ok) {
  assert.equal(colors.value.colors[0]?.color, '#ff8000', 'T036-LSP-COLOR-SWATCHES-UNIT-02 document color becomes a terminal-safe RGB swatch');
  const presentation = new LanguagePresentationFeatures();
  assert.equal(presentation.applyColors(colors.value).ok, true, 'T036-LSP-COLOR-SWATCHES-UNIT-03 presentation accepts the versioned color result');
  assert.equal(presentation.colors('doc')?.colors.length, 1, 'T036-LSP-COLOR-SWATCHES-UNIT-04 color read model retains one swatch');
  assert.equal(decodeDocumentColors([{ range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } }, color: { red: 0, green: 0, blue: 0, alpha: 1 } }], 'doc', 3, 5).ok, false, 'T036-LSP-COLOR-SWATCHES-INVALID-UNIT-01 rejects reversed ranges');
  assert.equal(decodeDocumentColors([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, color: { red: 2, green: 0, blue: 0, alpha: 1 } }], 'doc', 3, 6).ok, false, 'T036-LSP-COLOR-SWATCHES-INVALID-UNIT-02 rejects out-of-range channels');
  presentation.dispose();
}
console.log('LSP inlay-hints unit checks passed.');
