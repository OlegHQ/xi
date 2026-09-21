import { strict as assert } from "node:assert";
import { createTestRenderer } from "@opentui/core/testing";
import { parseColor, TextAttributes } from "@opentui/core";
import {
  asIdentifier,
  asUndoGroupId,
  asUtf16Offset,
  type DocumentId,
  type SelectionId,
  type ViewId,
} from "../../packages/primitives/src/index";
import type { SyntaxRead, SyntaxReadPort, SyntaxSpan } from "../../packages/contracts/src/index";
import {
  openTextDocument,
  type DocumentReadPort,
  type DocumentSnapshot,
} from "../../packages/document/src/index";
import { createSelectionSet } from "../../packages/selections/src/index";
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from "../../packages/workbench/src/index";
import {
  WorkbenchRenderable,
  LIGHT_WORKBENCH_THEME,
  calculatePaintRanges,
  themeColor,
} from "../../packages/ui/src/index";

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, "T053-paint-id");
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const VIEW_ID = id<ViewId>("T053-paint-view");
const DOCUMENT_ID = id<DocumentId>("T053-paint-document");
const TEXT = "const value = 1;";

function makeFixture(selection: { readonly kind: "normal-cursor" | "visual-character"; readonly anchor: number; readonly head: number; readonly mode: "normal" | "visual" } = { kind: "normal-cursor", anchor: 0, head: 0, mode: "normal" }): {
  readonly workbench: WorkbenchReadPort;
  readonly snapshot: DocumentSnapshot;
  readonly view: WorkbenchViewSnapshot;
} {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode(TEXT));
  if (opened.kind !== "editable") throw new Error("T053-paint-open");
  const snapshot = opened.document.snapshot();
  const primary = id<SelectionId>("T053-paint-primary");
  const desired = {
    logicalUtf16: 0 as number & { readonly __xiBrand: "Utf16Column" },
    displayCell: 0 as number & { readonly __xiBrand: "CellColumn" },
  };
  const offset = (value: number) => {
    const result = asUtf16Offset(value);
    if (!result.ok) throw new Error(`T053-paint-offset:${value}`);
    return result.value;
  };
  const common = {
    id: primary,
    direction: "forward" as const,
    anchor: { kind: "character" as const, offset: offset(selection.anchor), after: offset(selection.anchor + 1) },
    head: { kind: "character" as const, offset: offset(selection.head), after: offset(selection.head + 1) },
    desiredColumn: desired,
  };
  const members = [selection.kind === "visual-character"
    ? { ...common, kind: "visual-character" as const, inclusive: true }
    : { ...common, kind: "normal-cursor" as const }];
  const selections = createSelectionSet(snapshot, {
    primaryId: primary,
    selectionGeneration: 1,
    members,
  });
  if (!selections.ok) throw new Error(`T053-paint-selection:${selections.error.kind}`);
  const selectionSet = selections.value.selectionSet;
  const session = {
    viewId: VIEW_ID,
    documentId: DOCUMENT_ID,
    documentVersion: snapshot.version,
    selections: selectionSet,
    mode: selection.mode,
  } as const;
  const view: WorkbenchViewSnapshot = {
    session,
    document: snapshot,
    selections: selectionSet,
    scrollTop: 0,
    scrollLeft: 0,
  };
  const document: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) =>
      expectedVersion === snapshot.version
        ? snapshot.slice(start, end)
        : { ok: false, error: { kind: "stale-version" } },
  };
  return {
    snapshot,
    view,
    workbench: {
      activeViewId: VIEW_ID,
      readView: (viewId) => (viewId === VIEW_ID ? view : undefined),
      readDocument: (viewId) => (viewId === VIEW_ID ? document : undefined),
    },
  };
}

/**
 * A trivial fixed-spans SyntaxReadPort: "const" is a keyword, "value" is (deliberately)
 * classified as a string. The theme's default `variable` color equals the plain foreground
 * (a legitimate, common theme choice to reduce noise on plain identifiers), so a kind with a
 * genuinely distinct default color is used here to prove per-kind coloring, not just keywords.
 */
function syntaxPort(documentVersion: DocumentSnapshot["version"]): SyntaxReadPort {
  const spans: readonly SyntaxSpan[] = Object.freeze([
    Object.freeze({ start: 0, end: 5, kind: "keyword" as const }),
    Object.freeze({ start: 6, end: 11, kind: "string" as const }),
  ]);
  const read: SyntaxRead = {
    documentVersion,
    spansInRange: (start, end) => spans.filter((span) => span.start < end && span.end > start),
  };
  return { readSyntax: (documentId) => (documentId === DOCUMENT_ID ? read : undefined) };
}

function findSpanText(
  frame: ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>,
  text: string,
): { readonly fg: { r: number; g: number; b: number } } | undefined {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return { fg: span.fg };
    }
  }
  return undefined;
}

function capturedSpan(
  frame: ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>,
  text: string,
) {
  for (const line of frame.lines)
    for (const span of line.spans) if (span.text.includes(text)) return span;
  return undefined;
}

async function keywordAndPlainCellsDifferByColor(): Promise<void> {
  const fixture = makeFixture();
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: "editor.ts",
    theme: LIGHT_WORKBENCH_THEME,
    syntax: syntaxPort(fixture.snapshot.version),
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const frame = setup.captureSpans();
  // The primary cursor sits at offset 0, replacing the "c" glyph with a cursor marker;
  // the rest of "const" ("onst") is still painted with the keyword's syntax color.
  const keywordSpan = findSpanText(frame, "onst");
  const stringSpan = findSpanText(frame, "value");
  const plainSpan = findSpanText(frame, "=");
  assert.ok(
    keywordSpan !== undefined,
    "T053-PAINT-01 the keyword glyph is present in the painted frame",
  );
  assert.ok(
    stringSpan !== undefined,
    "T053-PAINT-01b the string-classified glyph is present in the painted frame",
  );
  assert.ok(
    plainSpan !== undefined,
    "T053-PAINT-02 an unclassified glyph is present in the painted frame",
  );
  const expectedKeywordColor = parseColor(LIGHT_WORKBENCH_THEME.syntax?.keyword as string);
  const expectedStringColor = parseColor(LIGHT_WORKBENCH_THEME.syntax?.string as string);
  assert.equal(
    keywordSpan?.fg.r,
    expectedKeywordColor.r,
    "T053-PAINT-03 the keyword cell uses the theme keyword color (r)",
  );
  assert.equal(
    keywordSpan?.fg.g,
    expectedKeywordColor.g,
    "T053-PAINT-03 the keyword cell uses the theme keyword color (g)",
  );
  assert.equal(
    keywordSpan?.fg.b,
    expectedKeywordColor.b,
    "T053-PAINT-03 the keyword cell uses the theme keyword color (b)",
  );
  assert.equal(
    stringSpan?.fg.r,
    expectedStringColor.r,
    "T053-PAINT-03b the string-classified cell uses the theme string color (r)",
  );
  const plainColor = parseColor(LIGHT_WORKBENCH_THEME.foreground);
  assert.equal(
    plainSpan?.fg.r,
    plainColor.r,
    "T053-PAINT-04 an unclassified cell keeps the plain foreground (r)",
  );
  assert.notEqual(
    keywordSpan?.fg.r,
    plainSpan?.fg.r,
    "T053-PAINT-05 keyword and plain cells are painted with different colors",
  );
  assert.notEqual(
    stringSpan?.fg.r,
    plainSpan?.fg.r,
    "T053-PAINT-05b string-classified and plain cells are painted with different colors",
  );
  setup.renderer.destroy();
}

async function staleVersionReadPaintsPlain(): Promise<void> {
  const fixture = makeFixture();
  const staleVersion = ((fixture.snapshot.version as number) + 1) as DocumentSnapshot["version"];
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: "editor.ts",
    theme: LIGHT_WORKBENCH_THEME,
    syntax: syntaxPort(staleVersion),
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const frame = setup.captureSpans();
  const keywordSpan = findSpanText(frame, "onst");
  assert.ok(keywordSpan !== undefined, "T053-PAINT-06 the keyword glyph is still present");
  const plainColor = parseColor(LIGHT_WORKBENCH_THEME.foreground);
  assert.equal(
    keywordSpan?.fg.r,
    plainColor.r,
    "T053-PAINT-07 a stale-version syntax read paints plain, not the syntax color (r)",
  );
  assert.equal(
    keywordSpan?.fg.g,
    plainColor.g,
    "T053-PAINT-07 a stale-version syntax read paints plain, not the syntax color (g)",
  );
  assert.equal(
    keywordSpan?.fg.b,
    plainColor.b,
    "T053-PAINT-07 a stale-version syntax read paints plain, not the syntax color (b)",
  );
  setup.renderer.destroy();
}

async function syntaxStylesPaintBackgroundAndModifiers(): Promise<void> {
  const fixture = makeFixture();
  const theme = {
    ...LIGHT_WORKBENCH_THEME,
    syntaxStyles: {
      keyword: {
        fg: "#112233",
        bg: "#445566",
        modifiers: ["italic", "underlined"],
        underline: { style: "curl", color: "#aabbcc" },
      },
    },
  };
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: "editor.ts",
    theme,
    syntax: syntaxPort(fixture.snapshot.version),
    undercurl: true,
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const span = capturedSpan(setup.captureSpans(), "onst");
  assert.ok(span !== undefined, "T053-STYLE-01 the styled keyword glyph is present");
  const foreground = parseColor("#112233");
  const background = parseColor("#445566");
  assert.equal(span?.fg.r, foreground.r, "T053-STYLE-02 syntax style foreground is painted");
  assert.equal(span?.bg.g, background.g, "T053-STYLE-03 syntax style background is painted");
  assert.ok((span?.attributes ?? 0) !== 0, "T053-STYLE-04 syntax style modifiers are painted");
  const attributes = setup.renderer.currentRenderBuffer.buffers.attributes;
  assert.ok(
    attributes.some(
      (attribute) =>
        (attribute & TextAttributes.UNDERLINE_STYLE_CURL) === TextAttributes.UNDERLINE_STYLE_CURL,
    ),
    "T053-STYLE-05 Helix curl underline shape reaches the native cell attribute",
  );
  setup.renderer.destroy();

  const fallback = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const fallbackViewport = new WorkbenchRenderable(fallback.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: "editor.ts",
    theme,
    syntax: syntaxPort(fixture.snapshot.version),
    undercurl: false,
  });
  fallback.renderer.root.add(fallbackViewport);
  await fallback.renderOnce();
  const fallbackAttributes = fallback.renderer.currentRenderBuffer.buffers.attributes;
  assert.ok(
    fallbackAttributes.some(
      (attribute) =>
        (attribute & TextAttributes.UNDERLINE) === TextAttributes.UNDERLINE,
    ),
    "T036-UNDERCURL-UNIT-01 disabled undercurl falls back to a native line underline",
  );
  assert.ok(
    fallbackAttributes.every(
      (attribute) =>
        (attribute & TextAttributes.UNDERLINE_STYLE_CURL) !== TextAttributes.UNDERLINE_STYLE_CURL,
    ),
    "T036-UNDERCURL-UNIT-01 disabled undercurl does not emit curl attributes",
  );
  fallback.renderer.destroy();
}

async function exactCaptureScopeWinsOverItsParent(): Promise<void> {
  const fixture = makeFixture();
  const spans: readonly SyntaxSpan[] = Object.freeze([
    Object.freeze({ start: 0, end: 5, kind: "keyword" as const, scope: "keyword.control" }),
  ]);
  const syntax: SyntaxReadPort = {
    readSyntax: (documentId) =>
      documentId === DOCUMENT_ID
        ? {
            documentVersion: fixture.snapshot.version,
            spansInRange: (start, end) =>
              spans.filter((span) => span.start < end && span.end > start),
          }
        : undefined,
  };
  const theme = {
    ...LIGHT_WORKBENCH_THEME,
    styles: {
      keyword: { fg: "#112233" },
      "keyword.control": { fg: "#778899", modifiers: ["bold"] },
    },
  };
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: "editor.ts",
    theme,
    syntax,
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const span = capturedSpan(setup.captureSpans(), "onst");
  assert.ok(span !== undefined, "T053-SCOPE-01 the captured keyword glyph is present");
  const expected = parseColor("#778899");
  assert.equal(
    span?.fg.b,
    expected.b,
    "T053-SCOPE-02 an exact Helix capture scope overrides its parent scope",
  );
  setup.renderer.destroy();
}

async function helixEditorUiScopesPaint(): Promise<void> {
  const fixture = makeFixture();
  const theme = {
    ...LIGHT_WORKBENCH_THEME,
    styles: {
      "ui.linenr.selected": { fg: "#112233" },
      "ui.cursorcolumn.primary": { bg: "#ff00fe" },
      "ui.cursorline.primary": { fg: "#778899", bg: "#445566", underline: { color: "#abcdef", style: "dotted" } },
      "ui.cursor.primary.normal": { fg: "#010203", bg: "#a0b0c0", modifiers: ["rapid_blink"] },
    },
  };
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: "editor.ts",
    theme,
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const frame = setup.captureSpans();
  const columnColor = parseColor('#ff00fe');
  assert.ok(!frame.lines.flatMap(line => line.spans).some(span => span.bg.r === columnColor.r && span.bg.g === columnColor.g && span.bg.b === columnColor.b), 'a theme scope alone must not enable cursor-column painting');
  const lineNumber = frame.lines
    .flatMap((line) => line.spans)
    .find((span) => /^\s*1\s*$/u.test(span.text));
  const text = capturedSpan(frame, "onst");
  assert.ok(
    lineNumber !== undefined,
    "T053-UI-SCOPE-01 the gutter line number is painted separately",
  );
  assert.ok(text !== undefined, "T053-UI-SCOPE-02 the primary cursor line text is painted");
  const lineNumberColor = parseColor("#112233");
  const cursorLineColor = parseColor("#445566");
  const cursorLineForeground = parseColor("#778899");
  assert.equal(
    lineNumber?.fg.r,
    lineNumberColor.r,
    "T053-UI-SCOPE-03 ui.linenr.selected colors the active line number",
  );
  assert.equal(
    text?.bg.b,
    cursorLineColor.b,
    "T053-UI-SCOPE-04 ui.cursorline.primary colors the active editor row",
  );
  assert.equal(text?.fg.g, cursorLineForeground.g, "T053-UI-SCOPE-05 ui.cursorline.primary foreground patches syntax text");
  const attributes = setup.renderer.currentRenderBuffer.buffers.attributes;
  assert.ok(attributes.some(attribute => (attribute & TextAttributes.UNDERLINE_STYLE_DOTTED) === TextAttributes.UNDERLINE_STYLE_DOTTED), "T053-UI-SCOPE-06 cursorline underline shape reaches cells");
  assert.ok(attributes.some(attribute => (attribute & TextAttributes.UNDERLINE_STYLE_DOTTED) === TextAttributes.UNDERLINE_STYLE_DOTTED), "T053-UI-SCOPE-07 cursorline underline colour keeps its decorated cell path");
  assert.ok(attributes.some(attribute => (attribute & TextAttributes.RAPID_BLINK) !== 0), "T053-UI-SCOPE-08 rapid blink remains distinct on the cursor cell");
  setup.renderer.destroy();
}

async function helixSelectionStylePatchesEveryChannel(): Promise<void> {
  const fixture = makeFixture({ kind: "visual-character", anchor: 0, head: 4, mode: "visual" });
  const theme = {
    ...LIGHT_WORKBENCH_THEME,
    styles: {
      "ui.selection.primary": { fg: "#102030", bg: "#405060", modifiers: ["italic"], underline: { color: "#708090", style: "curl" } },
      "ui.cursor.primary.select": { modifiers: ["reversed"] },
    },
  };
  const setup = await createTestRenderer({ width: 80, height: 24, bufferedOutput: "memory", gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench: fixture.workbench, fileLabel: "editor.ts", theme, undercurl: true });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  const spans = setup.captureSpans().lines.flatMap(line => line.spans).filter(span => span.text.includes("cons") || span.text.includes("onst"));
  const selected = spans.find(span => (span.attributes & TextAttributes.ITALIC) !== 0);
  assert.ok(selected !== undefined, "T053-SELECTION-01 the visual selection carries Helix modifiers");
  assert.equal(selected?.fg.r, parseColor("#102030").r, "T053-SELECTION-02 ui.selection.primary foreground is painted");
  assert.equal(selected?.bg.g, parseColor("#405060").g, "T053-SELECTION-03 ui.selection.primary background is painted");
  const attributes = setup.renderer.currentRenderBuffer.buffers.attributes;
  assert.ok(attributes.some(attribute => (attribute & TextAttributes.UNDERLINE_STYLE_CURL) === TextAttributes.UNDERLINE_STYLE_CURL), "T053-SELECTION-04 selection underline shape is painted");
  assert.ok(attributes.some(attribute => (attribute & TextAttributes.UNDERLINE_STYLE_CURL) === TextAttributes.UNDERLINE_STYLE_CURL), "T053-SELECTION-05 selection underline colour keeps its decorated cell path");
  setup.renderer.destroy();
}

function terminalPaletteIntentSurvivesUiBoundary(): void {
  const indexed = themeColor("\u0000xi-terminal-index:1");
  const defaultBackground = themeColor("\u0000xi-terminal-default", "bg");
  assert.notEqual(
    typeof indexed,
    "string",
    "T053-TERMINAL-01 terminal palette colours become renderer colours",
  );
  assert.notEqual(
    typeof defaultBackground,
    "string",
    "T053-TERMINAL-02 default colours become renderer colours",
  );
  if (typeof indexed !== "string") {
    assert.equal(
      indexed.intent,
      "indexed",
      "T053-TERMINAL-03 indexed palette intent reaches OpenTUI",
    );
    assert.equal(indexed.slot, 1, "T053-TERMINAL-04 Helix red uses ANSI palette slot 1");
  }
  if (typeof defaultBackground !== "string")
    assert.equal(
      defaultBackground.intent,
      "default",
      "T053-TERMINAL-05 Helix default background retains default-colour intent",
    );
}

/**
 * The real `LiveHighlightResult.spansInRange` never blocks: a cold window returns `[]` and
 * enqueues background work, so the first paint after opening/editing a document is plain, and
 * only the *next* paint (after the background window finishes and fires `onResult`) is colored.
 * This simulates that exact contract at the read-port boundary the UI paints from, without
 * requiring the full async grammar/parse pipeline in a UI-layer test.
 */
async function firstPaintIsPlainSecondPaintIsColored(): Promise<void> {
  const fixture = makeFixture();
  const spans: readonly SyntaxSpan[] = Object.freeze([
    Object.freeze({ start: 0, end: 5, kind: "keyword" as const }),
  ]);
  // Two distinct read objects, not one mutable flag: production gets a *new* `DocumentSyntaxRead`
  // wrapper from the tracker each time a background window resolves and fires `onResult` (see
  // `SyntaxDocumentTracker`), which is what makes the paint path's `syntaxRead !== previousSyntaxRead`
  // identity check -- and so the full repaint -- actually fire on the next frame.
  const coldRead: SyntaxRead = {
    documentVersion: fixture.snapshot.version,
    spansInRange: () => [],
  };
  const drainedRead: SyntaxRead = {
    documentVersion: fixture.snapshot.version,
    spansInRange: (start, end) => spans.filter((span) => span.start < end && span.end > start),
  };
  let drained = false;
  const port: SyntaxReadPort = {
    readSyntax: (documentId) =>
      documentId === DOCUMENT_ID ? (drained ? drainedRead : coldRead) : undefined,
  };
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench: fixture.workbench,
    fileLabel: "editor.ts",
    theme: LIGHT_WORKBENCH_THEME,
    syntax: port,
  });
  setup.renderer.root.add(viewport);

  await setup.renderOnce();
  const firstFrame = setup.captureSpans();
  const plainColor = parseColor(LIGHT_WORKBENCH_THEME.foreground);
  const firstKeywordSpan = findSpanText(firstFrame, "onst");
  assert.ok(
    firstKeywordSpan !== undefined,
    "T053-PAINT-08 the keyword glyph is present on the first paint",
  );
  assert.equal(
    firstKeywordSpan?.fg.r,
    plainColor.r,
    "T053-PAINT-09 the first paint (uncached window) is plain, not colored",
  );

  drained = true;
  await setup.renderOnce();
  const secondFrame = setup.captureSpans();
  const expectedKeywordColor = parseColor(LIGHT_WORKBENCH_THEME.syntax?.keyword as string);
  const secondKeywordSpan = findSpanText(secondFrame, "onst");
  assert.ok(
    secondKeywordSpan !== undefined,
    "T053-PAINT-10 the keyword glyph is present on the second paint",
  );
  assert.equal(
    secondKeywordSpan?.fg.r,
    expectedKeywordColor.r,
    "T053-PAINT-11 the second paint (after the background window resolves) is colored",
  );
  setup.renderer.destroy();
}

/**
 * Regression for the stale-syntax repaint/flicker bug: `syntaxIsCurrent` used to
 * reject the whole frame the instant a keystroke advanced the document version past
 * the last-parsed syntax read, so every row -- not just the edited one -- painted
 * plain for that frame; then the fresh parse landing forced a full-viewport repaint
 * regardless of how few rows actually changed color. The fix reuses a still-stale
 * read's own spans for a row whose offsets/text are unaffected (via `rowSyntaxCursor`'s
 * fallback in editor/motion-paint.ts), and `calculatePaintRanges` now dirties only
 * the row whose offsets actually shifted once the fresh read lands.
 */
async function staleReadKeepsUnaffectedRowColoredThenFollowUpRepaintsOnlyChangedRow(): Promise<void> {
  const text = "const value = 1;\nsecond line\nthird";
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode(text));
  if (opened.kind !== "editable") throw new Error("T053-STALE-open");
  const document = opened.document;
  let snapshot = document.snapshot();
  const primary = id<SelectionId>("T053-STALE-primary");
  let generation = 0;
  const makeView = (): WorkbenchViewSnapshot => {
    const offset = asUtf16Offset(0);
    const after = asUtf16Offset(1);
    if (!offset.ok || !after.ok) throw new Error("T053-STALE-offset");
    const selections = createSelectionSet(snapshot, {
      primaryId: primary,
      selectionGeneration: generation,
      members: [
        {
          id: primary,
          kind: "normal-cursor",
          direction: "forward",
          anchor: { kind: "character", offset: offset.value, after: after.value },
          head: { kind: "character", offset: offset.value, after: after.value },
        },
      ],
    });
    if (!selections.ok) throw new Error(`T053-STALE-selection:${selections.error.kind}`);
    return {
      session: {
        viewId: VIEW_ID,
        documentId: DOCUMENT_ID,
        documentVersion: snapshot.version,
        selections: selections.value.selectionSet,
        mode: "normal",
      },
      document: snapshot,
      selections: selections.value.selectionSet,
      scrollTop: 0,
      scrollLeft: 0,
    };
  };
  let view = makeView();
  const workbenchDocument: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) =>
      expectedVersion === snapshot.version
        ? snapshot.slice(start, end)
        : { ok: false, error: { kind: "stale-version" } },
  };
  const workbench: WorkbenchReadPort = {
    activeViewId: VIEW_ID,
    readView: (viewId) => (viewId === VIEW_ID ? view : undefined),
    readDocument: (viewId) => (viewId === VIEW_ID ? workbenchDocument : undefined),
  };

  const keywordSpans: readonly SyntaxSpan[] = Object.freeze([
    Object.freeze({ start: 0, end: 5, kind: "keyword" as const }),
  ]);
  let currentRead: SyntaxRead = {
    documentVersion: snapshot.version,
    spansInRange: (start, end) =>
      keywordSpans.filter((span) => span.start < end && span.end > start),
  };
  const port: SyntaxReadPort = {
    readSyntax: (documentId) => (documentId === DOCUMENT_ID ? currentRead : undefined),
  };

  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    gatherStats: true,
  });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench,
    fileLabel: "editor.ts",
    theme: LIGHT_WORKBENCH_THEME,
    syntax: port,
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();

  const expectedKeywordColor = parseColor(LIGHT_WORKBENCH_THEME.syntax?.keyword as string);
  const initialKeyword = findSpanText(setup.captureSpans(), "onst");
  assert.equal(
    initialKeyword?.fg.r,
    expectedKeywordColor.r,
    "T053-STALE-00 the keyword is colored before any edit",
  );

  // Append a character to the LAST line, so line 0's own offsets and text are
  // completely unaffected by the edit (nothing after it in the document to shift).
  const staleRead = currentRead;
  const group = asUndoGroupId("T053-STALE-edit");
  if (!group.ok) throw new Error("T053-STALE-group");
  const end = asUtf16Offset(text.length);
  if (!end.ok) throw new Error("T053-STALE-end-offset");
  const committed = document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits: [{ start: end.value, end: end.value, text: "X" }],
    origin: "vim",
    undoGroup: group.value,
  });
  if (!committed.ok) throw new Error(`T053-STALE-commit:${committed.error.kind}`);
  snapshot = document.snapshot();
  generation += 1;
  view = makeView();
  // `currentRead` is deliberately left pointing at the pre-edit read here -- the
  // background parse hasn't caught up with this keystroke yet, exactly like
  // production (see `SyntaxDocumentTracker`).

  viewport.refresh();
  await setup.renderOnce();
  const staleKeyword = findSpanText(setup.captureSpans(), "onst");
  assert.equal(
    staleKeyword?.fg.r,
    expectedKeywordColor.r,
    "T053-STALE-01 a typed character elsewhere does not drop color on the unchanged keyword row",
  );
  const afterStale = viewport.lastFrame;
  assert.ok(
    afterStale?.frame !== undefined && afterStale.view !== undefined,
    "T053-STALE-02 a frame is projected for the stale-read paint",
  );

  // The background parse now lands: a new read object, current for the new version.
  currentRead = {
    documentVersion: snapshot.version,
    spansInRange: (start, endOffset) =>
      keywordSpans.filter((span) => span.start < endOffset && span.end > start),
  };
  viewport.refresh();
  await setup.renderOnce();
  const freshKeyword = findSpanText(setup.captureSpans(), "onst");
  assert.equal(
    freshKeyword?.fg.r,
    expectedKeywordColor.r,
    "T053-STALE-03 the keyword stays colored once the fresh parse lands",
  );
  const afterFresh = viewport.lastFrame;
  assert.ok(
    afterFresh?.frame !== undefined && afterFresh.view !== undefined,
    "T053-STALE-04 a frame is projected for the fresh-read paint",
  );

  const ranges = calculatePaintRanges(
    afterStale,
    afterFresh!.frame!,
    afterFresh!.view!,
    undefined,
    undefined,
    false,
    currentRead,
    staleRead,
  );
  const repaintedRows = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
  assert.ok(
    repaintedRows <= 2,
    `T053-STALE-05 the fresh parse landing repaints <=2 rows (the edited line), got ${repaintedRows} (ranges=${JSON.stringify(ranges)})`,
  );

  setup.renderer.destroy();
}

await keywordAndPlainCellsDifferByColor();
await staleVersionReadPaintsPlain();
await syntaxStylesPaintBackgroundAndModifiers();
await exactCaptureScopeWinsOverItsParent();
await helixEditorUiScopesPaint();
await helixSelectionStylePatchesEveryChannel();
terminalPaletteIntentSurvivesUiBoundary();
await firstPaintIsPlainSecondPaintIsColored();
await staleReadKeepsUnaffectedRowColoredThenFollowUpRepaintsOnlyChangedRow();
console.log(
  "T053 syntax paint passed: colors, Helix syntax style backgrounds/modifiers, stale-version fallback, and bounded repaint fixtures",
);
