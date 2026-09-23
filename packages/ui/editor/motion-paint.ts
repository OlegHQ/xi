import { TextAttributes, parseColor, type OptimizedBuffer, type RGBA } from "@opentui/core/renderer";
import type {
  CellPoint,
  ProjectedSelection,
  ScreenRow,
  ScreenCell,
  VisibleFrame,
} from "../../layout/src/index";
import type { MotionPaintTokens, EditorColorMode } from "../theme/motion-tokens";
import { resolvePaintColor, pickCursorForeground } from "../theme/motion-tokens";
import type { HelixThemeStyle, ThemeColor } from "../theme/workbench-themes";
import type { SyntaxRead, SyntaxSpan, SyntaxTokenKind } from "../../contracts/src/index";

/** Structural read of Vim's immutable presentation output. The UI never imports Vim. */
export interface MotionPreviewRead {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly selectionGeneration: number;
  readonly operatorKey?: string;
  readonly count?: number;
  readonly members: readonly MotionPreviewMemberRead[];
}

export interface MotionPreviewMemberRead {
  readonly memberId: string;
  readonly source: number;
  readonly destination: number;
  readonly moved: boolean;
  readonly extent: {
    readonly kind: "characterwise" | "linewise";
    readonly start: number;
    readonly end: number;
  };
}

/** A complete operator range supplied by an engine read model. It is never inferred by paint. */
export interface OperatorPreviewRead {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly selectionGeneration: number;
  readonly members: readonly OperatorPreviewMemberRead[];
}

export interface OperatorPreviewMemberRead {
  readonly memberId: string;
  readonly kind: "characterwise" | "linewise" | "blockwise";
  readonly start: number;
  readonly end: number;
}

/** Workspace-search matches for the painted document, as absolute UTF-16 offset ranges;
 * painted only while `documentId`/`documentVersion` match the frame (stale reads are skipped
 * like the other previews). */
export interface SearchHighlightRead {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly current?: { readonly start: number; readonly end: number };
}

export interface EditorPresentationRead {
  readonly motionPreview?: MotionPreviewRead | null;
  readonly operatorPreview?: OperatorPreviewRead | null;
  readonly searchHighlight?: SearchHighlightRead | null;
  readonly documentHighlight?: SearchHighlightRead | null;
  readonly motionTrail?: "off" | "last-motion";
  readonly reducedMotion?: boolean;
  readonly colorMode?: EditorColorMode;
}

export interface EditorPresentationReadPort {
  readPresentation(viewId: string): EditorPresentationRead | undefined;
}

export interface MotionPaintOptions {
  readonly frame: VisibleFrame;
  readonly presentation?: EditorPresentationRead;
  readonly mode: "normal" | "insert" | "visual" | string;
  /** Native terminal cursor shape for the primary cursor; omitted keeps the block paint. */
  readonly cursorShape?: "block" | "bar" | "underline" | "hidden";
  readonly cursorLine?: boolean;
  readonly cursorColumn?: boolean;
  readonly rulers?: readonly number[];
  readonly theme: MotionPaintTokens;
  readonly foreground: RGBA;
  readonly muted: RGBA;
  readonly background: RGBA;
  readonly accent: RGBA;
  readonly colorMode: EditorColorMode;
  /** Override a terminal undercurl false negative; false falls back curl styles to a line. */
  readonly undercurl?: boolean;
  readonly ascii: boolean;
  readonly x: number;
  readonly y: number;
  /** Painted when `syntax.documentVersion` matches `frame.identity.documentVersion`, or --
   * for a row whose `syntaxFallbackRows` entry proves its text hasn't changed -- reused
   * from a still-stale read (see `SyntaxFallbackRow`). */
  readonly syntax?: SyntaxRead;
  readonly syntaxColors?: Partial<Record<SyntaxTokenKind, ThemeColor>>;
  readonly syntaxStyles?: Readonly<Record<string, HelixThemeStyle>>;
  /** Per-row (indexed like `frame.rows`) last-known-current syntax snapshot; see `SyntaxFallbackRow`. */
  readonly syntaxFallbackRows?: readonly (SyntaxFallbackRow | undefined)[];
  /** Optional half-open visible row range for damage-limited repainting. */
  readonly rows?: { readonly start: number; readonly end: number };
}

export interface MotionPaintStats {
  readonly selectedCells: number;
  readonly secondarySelectedCells: number;
  readonly trailCells: number;
  readonly operatorPreviewCells: number;
  readonly primaryCursor: CellPoint | null;
  readonly secondaryCursors: number;
  readonly trailPainted: boolean;
  readonly rejectedStalePreview: boolean;
}

interface ResolvedSyntaxStyle {
  readonly foreground?: RGBA;
  readonly background?: RGBA;
  readonly underlineColor?: RGBA;
  readonly attributes: number;
}

const DEFAULT_RAINBOW_COLORS = Object.freeze([
  '#e06c75', '#d19a66', '#e5c07b', '#98c379',
  '#56b6c2', '#61afef', '#c678dd', '#be5046',
]);

function syntaxAttributes(style: HelixThemeStyle | undefined, undercurl = true): number {
  let attributes = 0;
  for (const modifier of style?.modifiers ?? []) {
    if (modifier === "bold") attributes |= TextAttributes.BOLD;
    else if (modifier === "dim") attributes |= TextAttributes.DIM;
    else if (modifier === "italic") attributes |= TextAttributes.ITALIC;
    else if (modifier === "underlined") attributes |= TextAttributes.UNDERLINE;
    else if (modifier === "slow_blink") attributes |= TextAttributes.BLINK;
    else if (modifier === "rapid_blink") attributes |= TextAttributes.RAPID_BLINK;
    else if (modifier === "reversed") attributes |= TextAttributes.INVERSE;
    else if (modifier === "hidden") attributes |= TextAttributes.HIDDEN;
    else if (modifier === "crossed_out") attributes |= TextAttributes.STRIKETHROUGH;
  }
  const underlineStyle = style?.underline?.style === 'curl' && !undercurl ? 'line' : style?.underline?.style;
  if (underlineStyle !== undefined) {
    attributes |=
      underlineStyle === "double_line"
        ? TextAttributes.UNDERLINE | TextAttributes.UNDERLINE_STYLE_DOUBLE
        : underlineStyle === "curl"
          ? TextAttributes.UNDERLINE | TextAttributes.UNDERLINE_STYLE_CURL
          : underlineStyle === "dotted"
            ? TextAttributes.UNDERLINE | TextAttributes.UNDERLINE_STYLE_DOTTED
            : underlineStyle === "dashed"
              ? TextAttributes.UNDERLINE | TextAttributes.UNDERLINE_STYLE_DASHED
              : TextAttributes.UNDERLINE;
  }
  return attributes;
}

function resolveSyntaxStyles(
  colors: Partial<Record<SyntaxTokenKind, ThemeColor>> | undefined,
  styles: Readonly<Record<string, HelixThemeStyle>> | undefined,
  colorMode: EditorColorMode,
  undercurl: boolean,
): Map<string, ResolvedSyntaxStyle> {
  const resolved = new Map<string, ResolvedSyntaxStyle>();
  for (const kind of new Set([...Object.keys(colors ?? {}), ...Object.keys(styles ?? {})])) {
    const style = styles?.[kind];
    const foreground = style?.fg ?? colors?.[kind as SyntaxTokenKind];
    const background = style?.bg;
    resolved.set(
      kind,
      Object.freeze({
        ...(foreground === undefined
          ? {}
          : { foreground: resolvePaintColor(foreground, colorMode) }),
        ...(background === undefined
          ? {}
          : { background: resolvePaintColor(background, colorMode) }),
        ...(style?.underline?.color === undefined
          ? {}
          : { underlineColor: resolvePaintColor(style.underline.color, colorMode) }),
        attributes: syntaxAttributes(style, undercurl),
      }),
    );
  }
  for (let index = 0; index < DEFAULT_RAINBOW_COLORS.length; index += 1) {
    const scope = `rainbow.${index}`;
    if (!resolved.has(scope)) resolved.set(scope, { foreground: resolvePaintColor(DEFAULT_RAINBOW_COLORS[index] as string, colorMode), attributes: 0 });
  }
  return resolved;
}

// `options.syntaxColors` is the same object reference for as long as the theme doesn't
// change (it comes straight from `theme.syntax`), so resolving it is memoized by
// (colors, colorMode) instead of rebuilt on every `drawFrame` call -- one call per paint
// range, several ranges per frame, every frame.
const syntaxStyleCache = new WeakMap<
  object,
  Map<string, Map<string, ResolvedSyntaxStyle>>
>();

function resolveSyntaxStylesCached(
  colors: Partial<Record<SyntaxTokenKind, ThemeColor>> | undefined,
  styles: Readonly<Record<string, HelixThemeStyle>> | undefined,
  colorMode: EditorColorMode,
  undercurl: boolean,
): Map<string, ResolvedSyntaxStyle> {
  const source = styles ?? colors;
  if (source === undefined) return resolveSyntaxStyles(colors, styles, colorMode, undercurl);
  let byMode = syntaxStyleCache.get(source);
  if (byMode === undefined) {
    byMode = new Map();
    syntaxStyleCache.set(source, byMode);
  }
  const cacheKey = `${colorMode}:${undercurl ? 'curl' : 'line'}`;
  let resolved = byMode.get(cacheKey);
  if (resolved === undefined) {
    resolved = resolveSyntaxStyles(colors, styles, colorMode, undercurl);
    byMode.set(cacheKey, resolved);
  }
  return resolved;
}

/** True when the active syntax read's version matches the painted frame's document version. */
function syntaxIsCurrent(frame: VisibleFrame, syntax: SyntaxRead | undefined): boolean {
  return (
    syntax !== undefined &&
    (frame.identity.documentVersion as unknown as number) ===
      (syntax.documentVersion as unknown as number)
  );
}

/** Bounded, run-based per-row cursor over one row's sorted syntax spans (no per-cell allocation). */
class RowSyntaxCursor {
  readonly #spans: readonly SyntaxSpan[];
  #index = 0;
  constructor(spans: readonly SyntaxSpan[]) {
    this.#spans = spans;
  }
  spanAt(offset: number): SyntaxSpan | undefined {
    while (
      this.#index < this.#spans.length &&
      (this.#spans[this.#index] as SyntaxSpan).end <= offset
    )
      this.#index += 1;
    const span = this.#spans[this.#index];
    return span !== undefined && span.start <= offset && offset < span.end ? span : undefined;
  }
}

/**
 * A row's own offsets/text as they were the last time syntax was confirmed current
 * for it, kept by the caller (see `WorkbenchRenderable`'s `#lastCurrentSyntaxRows`)
 * so a still-stale read can keep coloring rows an edit elsewhere didn't touch.
 */
export interface SyntaxFallbackRow {
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly text: string;
}

function rowSyntaxCursor(
  frame: VisibleFrame,
  row: ScreenRow,
  syntax: SyntaxRead | undefined,
  fallback?: SyntaxFallbackRow,
): RowSyntaxCursor | undefined {
  if (syntax === undefined) return undefined;
  const start = row.startOffset as number | null;
  const end = row.endOffset as number | null;
  if (start === null || end === null || end <= start) return undefined;
  if (syntaxIsCurrent(frame, syntax)) return new RowSyntaxCursor(syntax.spansInRange(start, end));
  // The read is behind this frame's edit (e.g. the keystroke frame painted before the
  // background parse catches up). Rather than dropping color from every row, reuse the
  // stale read's spans for exactly the rows an edit elsewhere didn't touch: `fallback`
  // is this same read's own view of this row the last time it was current, so an exact
  // offset+text match proves the row's underlying text -- and therefore its spans --
  // has not changed since. A row whose offset shifted (later lines, after an edit) or
  // whose text changed (the edited row itself) fails the match and stays uncolored for
  // this one frame, exactly like today, until the next parse lands.
  if (
    fallback !== undefined &&
    fallback.startOffset === start &&
    fallback.endOffset === end &&
    fallback.text === row.text
  ) {
    return new RowSyntaxCursor(syntax.spansInRange(start, end));
  }
  return undefined;
}

function styleForScope(
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
  scope: string,
): ResolvedSyntaxStyle | undefined {
  if (styles === undefined) return undefined;
  let candidate = scope;
  while (candidate.length > 0) {
    const style = styles.get(candidate);
    if (style !== undefined) return style;
    candidate = candidate.slice(0, candidate.lastIndexOf("."));
  }
  return undefined;
}

function syntaxStyle(
  cell: ScreenRow["cells"][number],
  cursor: RowSyntaxCursor | undefined,
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
): ResolvedSyntaxStyle | undefined {
  if (
    cursor === undefined ||
    styles === undefined ||
    cell.role === "padding" ||
    cell.role === "gutter"
  )
    return undefined;
  const target = cell.target;
  if (target?.kind === "virtual-annotation" && target.annotationId.startsWith("wrap-indicator:")) {
    return styleForScope(styles, "ui.virtual.wrap");
  }
  if (target === null || target.kind !== "text") return undefined;
  const span = cursor.spanAt(target.offset as unknown as number);
  if (span === undefined) return undefined;
  return styleForScope(styles, span.scope ?? span.kind) ?? styles?.get(span.kind);
}

function cursorScope(primary: boolean, mode: string, selected: boolean): string {
  const modeScope =
    mode === "insert" ? "insert" : mode === "visual" || mode === "select" ? "select" : "normal";
  if (primary) return selected ? "ui.cursor.primary.select" : `ui.cursor.primary.${modeScope}`;
  return selected ? "ui.cursor.select" : `ui.cursor.${modeScope}`;
}

function cursorStyle(
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
  primary: boolean,
  mode: string,
  selected: boolean,
): ResolvedSyntaxStyle | undefined {
  if (primary) return styleForScope(styles, cursorScope(true, mode, selected));
  return (
    styleForScope(
      styles,
      selected
        ? "ui.cursor.secondary.select"
        : `ui.cursor.secondary.${mode === "insert" ? "insert" : mode === "visual" || mode === "select" ? "select" : "normal"}`,
    ) ?? styleForScope(styles, cursorScope(false, mode, selected))
  );
}

interface CursorPoints {
  readonly primary: CellPoint | undefined;
  readonly secondary: readonly CellPoint[];
}

function cursorPoints(frame: VisibleFrame): CursorPoints {
  let primary: CellPoint | undefined;
  const secondary: CellPoint[] = [];
  for (const selection of frame.selections) {
    if (selection.head.position === null) continue;
    if (selection.primary) primary = selection.head.position;
    else secondary.push(selection.head.position);
  }
  return { primary, secondary };
}

function lineNumberStyle(
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
  row: number,
  cursors: CursorPoints,
): ResolvedSyntaxStyle | undefined {
  if (cursors.primary?.row === row)
    return (
      styleForScope(styles, "ui.linenr.selected") ??
      styleForScope(styles, "ui.gutter.selected") ??
      styleForScope(styles, "ui.linenr") ??
      styleForScope(styles, "ui.gutter")
    );
  return styleForScope(styles, "ui.linenr") ?? styleForScope(styles, "ui.gutter");
}

function cursorGuideStyle(
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
  row: number,
  cursors: CursorPoints,
  enabled: boolean,
  fallbackBackground: RGBA | undefined,
): ResolvedSyntaxStyle | undefined {
  if (!enabled) return undefined;
  if (cursors.primary?.row === row)
    return styleForScope(styles, "ui.cursorline.primary") ?? styleForScope(styles, "ui.cursorline") ?? (fallbackBackground === undefined ? undefined : { background: fallbackBackground, attributes: 0 });
  if (cursors.secondary.some((cursor) => cursor.row === row))
    return (
      styleForScope(styles, "ui.cursorline.secondary") ?? styleForScope(styles, "ui.cursorline")
      ?? (fallbackBackground === undefined ? undefined : { background: fallbackBackground, attributes: 0 })
    );
  return undefined;
}

function cursorColumnStyle(
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
  column: number,
  cursors: CursorPoints,
  enabled: boolean,
  fallbackBackground: RGBA | undefined,
): ResolvedSyntaxStyle | undefined {
  if (!enabled) return undefined;
  if (cursors.primary?.column === column)
    return styleForScope(styles, "ui.cursorcolumn.primary") ?? styleForScope(styles, "ui.cursorcolumn") ?? (fallbackBackground === undefined ? undefined : { background: fallbackBackground, attributes: 0 });
  if (cursors.secondary.some((cursor) => cursor.column === column))
    return styleForScope(styles, "ui.cursorcolumn.secondary") ?? styleForScope(styles, "ui.cursorcolumn") ?? (fallbackBackground === undefined ? undefined : { background: fallbackBackground, attributes: 0 });
  return undefined;
}

function rulerStyle(
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
  displayColumn: number | undefined,
  rulers: readonly number[],
  fallbackBackground: RGBA | undefined,
): ResolvedSyntaxStyle | undefined {
  if (displayColumn === undefined || !rulers.includes(displayColumn)) return undefined;
  return styleForScope(styles, "ui.virtual.ruler") ?? (fallbackBackground === undefined ? undefined : { background: fallbackBackground, attributes: 0 });
}

function cursorGuideForCell(
  styles: Map<string, ResolvedSyntaxStyle> | undefined,
  row: number,
  column: number,
  cursors: CursorPoints,
  cursorLine: boolean,
  cursorColumn: boolean,
  lineBackground: RGBA | undefined,
  columnBackground: RGBA | undefined,
  displayColumn: number | undefined,
  rulers: readonly number[],
  rulerBackground: RGBA | undefined,
): ResolvedSyntaxStyle | undefined {
  return cursorGuideStyle(styles, row, cursors, cursorLine, lineBackground)
    ?? cursorColumnStyle(styles, column, cursors, cursorColumn, columnBackground)
    ?? rulerStyle(styles, displayColumn, rulers, rulerBackground);
}

function displayColumnForCell(cell: ScreenCell | undefined): number | undefined {
  const target = cell?.target;
  return target?.kind === "text" || target?.kind === "virtual-annotation" ? target.displayCellColumn as number : undefined;
}

function virtualAnnotationBackground(cell: ScreenCell, colorMode: EditorColorMode): RGBA | undefined {
  if (cell.background === undefined || colorMode === "no-color") return undefined;
  try {
    return parseColor(cell.background);
  } catch {
    return undefined;
  }
}

const PAINT_PRIMARY_SELECTION = 1;
const PAINT_SECONDARY_SELECTION = 2;
const PAINT_TRAIL = 4;
const PAINT_OPERATOR = 8;
const PAINT_SEARCH = 16;
const PAINT_DOCUMENT_HIGHLIGHT = 32;
const PAINT_CURRENT_SEARCH = 64;

/**
 * Paint one visible frame in strict layer order. All range work is bounded by
 * frame.rows/cells, so a long document or off-screen selection is never scanned.
 */
export function paintEditorFrame(
  buffer: OptimizedBuffer,
  options: MotionPaintOptions,
): MotionPaintStats {
  // @xi-perf H1 RENDER-120 -- Per-cell damage paint issuing native buffer writes; mask lookups are scalar, no retained per-cell object.
  const colorMode = options.presentation?.colorMode ?? options.colorMode;
  const softwarePrimaryCursor = options.cursorShape === undefined || options.cursorShape === "block";
  const cursorline = options.cursorLine === true ? resolvePaintColor(options.theme.cursorline, colorMode) : undefined;
  const cursorcolumn = options.cursorColumn === true ? resolvePaintColor(options.theme.cursorcolumn, colorMode) : undefined;
  const ruler = options.rulers === undefined ? undefined : resolvePaintColor(options.theme.ruler, colorMode);
  const rowRange = paintRowRange(options.frame, options.rows);
  if (canPaintPlainFrameCached(options.frame, options.presentation)) {
    return paintPlainFrame(buffer, options, rowRange);
  }
  const masks = buildPaintMasks(
    options.frame,
    options.presentation,
    options.mode,
    colorMode,
    rowRange,
  );
  const syntaxStyles =
    colorMode === "no-color"
      ? undefined
      : resolveSyntaxStylesCached(options.syntaxColors, options.syntaxStyles, colorMode, options.undercurl ?? true);
  const searchStyle = styleForScope(syntaxStyles, "ui.highlight");
  const currentSearchStyle = styleForScope(syntaxStyles, "ui.highlight.current");
  const primarySelectionStyle = styleForScope(syntaxStyles, "ui.selection.primary");
  const secondarySelectionStyle = styleForScope(syntaxStyles, "ui.selection");
  const colors = {
    trail: resolvePaintColor(options.theme.motionTrail, colorMode),
    operator: resolvePaintColor(options.theme.operatorPreview, colorMode),
    search: resolvePaintColor(options.theme.searchMatch, colorMode),
    primarySelection: resolvePaintColor(options.theme.selectionPrimary, colorMode),
    secondarySelection: resolvePaintColor(options.theme.selectionSecondary, colorMode),
    cursorPrimary: resolvePaintColor(options.theme.cursorPrimary, colorMode),
    cursorSecondary: resolvePaintColor(options.theme.cursorSecondary, colorMode),
    cursorOnSelection: resolvePaintColor(options.theme.cursorOnSelection, colorMode),
  };
  const cursors = cursorPoints(options.frame);
  // Cursor heads within the painted range, keyed like `masks.cells`, so the per-cell loop
  // below can paint the real glyph under the cursor (instead of a second pass stomping it
  // with a marker) while still seeing that cell's own selection/trail/operator state.
  const cursorCells = new Map<number, { readonly primary: boolean }>();
  for (const selection of options.frame.selections) {
    const point = selection.head.position;
    if (point === null || point.row < rowRange.start || point.row >= rowRange.end) continue;
    cursorCells.set(cellKey(point.row, point.column), { primary: selection.primary });
  }
  let selectedCells = 0;
  let secondarySelectedCells = 0;
  let trailCells = 0;
  let operatorPreviewCells = 0;
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = options.frame.rows[rowIndex];
    if (row === undefined) continue;
    const rowY = options.y + rowIndex;
    const syntaxCursor =
      syntaxStyles === undefined
        ? undefined
        : rowSyntaxCursor(
            options.frame,
            row,
            options.syntax,
            options.syntaxFallbackRows?.[rowIndex],
          );
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (cell === undefined) continue;
      const key = cellKey(rowIndex, column);
      const mask = masks.cells.get(key) ?? 0;
      const primarySelection = (mask & PAINT_PRIMARY_SELECTION) !== 0;
      const secondarySelection = (mask & PAINT_SECONDARY_SELECTION) !== 0;
      const trail = (mask & PAINT_TRAIL) !== 0;
      const operator = (mask & PAINT_OPERATOR) !== 0;
      const search = (mask & PAINT_SEARCH) !== 0;
      const currentSearch = (mask & PAINT_CURRENT_SEARCH) !== 0;
      const documentHighlight = (mask & PAINT_DOCUMENT_HIGHLIGHT) !== 0;
      if (primarySelection) selectedCells += 1;
      if (secondarySelection) secondarySelectedCells += 1;
      if (trail) trailCells += 1;
      if (operator) operatorPreviewCells += 1;
      const style = syntaxStyle(cell, syntaxCursor, syntaxStyles);
      const guide = cursorGuideForCell(syntaxStyles, rowIndex, column, cursors, options.cursorLine !== false, options.cursorColumn === true, cursorline, cursorcolumn, displayColumnForCell(cell), options.rulers ?? [], ruler);
      const gutter =
        cell.role === "gutter" ? lineNumberStyle(syntaxStyles, rowIndex, cursors) : undefined;
      let foreground = cell.role === "gutter"
        ? (gutter?.foreground ?? options.muted)
        : (guide?.foreground ?? style?.foreground ?? options.foreground);
      let background = gutter?.background ?? guide?.background ?? virtualAnnotationBackground(cell, colorMode) ?? style?.background ?? options.background;
      let attributes =
        (style?.attributes ?? 0) | (guide?.attributes ?? 0) | (gutter?.attributes ?? 0);
      let underlineColor = colorMode === "no-color"
        ? undefined
        : (gutter?.underlineColor ?? guide?.underlineColor ?? style?.underlineColor);
      if (trail) background = colors.trail;
      if (search) {
        foreground = searchStyle?.foreground ?? foreground;
        background = searchStyle?.background ?? colors.search;
        attributes |= searchStyle?.attributes ?? 0;
        underlineColor = searchStyle?.underlineColor ?? underlineColor;
      }
      if (documentHighlight) {
        foreground = searchStyle?.foreground ?? foreground;
        background = searchStyle?.background ?? colors.search;
        attributes |= searchStyle?.attributes ?? 0;
        underlineColor = searchStyle?.underlineColor ?? underlineColor;
      }
      if (currentSearch) {
        background = currentSearchStyle?.background ?? colors.cursorOnSelection;
        foreground = currentSearchStyle?.foreground ?? pickCursorForeground(foreground, background, options.foreground, options.background);
        attributes |= (currentSearchStyle?.attributes ?? 0) | TextAttributes.BOLD;
      }
      if (operator) {
        background = colors.operator;
        attributes |= TextAttributes.UNDERLINE;
      }
      if (secondarySelection) {
        foreground = secondarySelectionStyle?.foreground ?? foreground;
        background = secondarySelectionStyle?.background ?? colors.secondarySelection;
        attributes |= secondarySelectionStyle?.attributes ?? 0;
        underlineColor = secondarySelectionStyle?.underlineColor ?? underlineColor;
      }
      if (primarySelection) {
        foreground = primarySelectionStyle?.foreground ?? foreground;
        background = primarySelectionStyle?.background ?? colors.primarySelection;
        attributes |= primarySelectionStyle?.attributes ?? 0;
        underlineColor = primarySelectionStyle?.underlineColor ?? underlineColor;
      }
      if (colorMode === "no-color") {
        background = options.background;
        if (trail) attributes |= TextAttributes.DIM;
        if (search) attributes |= TextAttributes.BOLD | TextAttributes.UNDERLINE;
        if (currentSearch) attributes |= TextAttributes.INVERSE;
        if (operator) attributes |= TextAttributes.UNDERLINE;
        if (secondarySelection) attributes |= TextAttributes.UNDERLINE;
        if (primarySelection) attributes |= TextAttributes.INVERSE;
      }
      const cursorInfo = cursorCells.get(key);
      if (cursorInfo !== undefined && (softwarePrimaryCursor || !cursorInfo.primary)) {
        if (colorMode === "no-color") {
          attributes |= cursorInfo.primary ? TextAttributes.INVERSE : TextAttributes.UNDERLINE;
        } else {
          const onSelection = primarySelection || secondarySelection;
          const styleForCursor = cursorStyle(
            syntaxStyles,
            cursorInfo.primary,
            options.mode,
            onSelection,
          );
          if (styleForCursor !== undefined) {
            foreground = styleForCursor.foreground ?? foreground;
            background = styleForCursor.background ?? background;
            attributes |= styleForCursor.attributes;
            underlineColor = styleForCursor.underlineColor ?? underlineColor;
          } else if (options.mode === "insert") {
            attributes |= TextAttributes.UNDERLINE;
          } else {
            const cursorBackground = onSelection
              ? colors.cursorOnSelection
              : cursorInfo.primary ? colors.cursorPrimary : colors.cursorSecondary;
            foreground = pickCursorForeground(
              foreground,
              cursorBackground,
              options.foreground,
              options.background,
            );
            background = cursorBackground;
            attributes |= TextAttributes.BOLD;
          }
        }
      }
      buffer.fillRect(options.x + column, rowY, 1, 1, background);
      if (cell.text.length > 0 || cursorInfo !== undefined) {
        buffer.setCell(options.x + column, rowY, cell.text || " ", foreground, background, attributes);
        if (underlineColor !== undefined) buffer.setUnderlineColor(options.x + column, rowY, underlineColor);
      }
    }
  }
  let primaryCursor: CellPoint | null = null;
  let secondaryCursors = 0;
  for (const selection of options.frame.selections) {
    const point = selection.head.position;
    if (point === null || point.row < rowRange.start || point.row >= rowRange.end) continue;
    if (selection.primary) primaryCursor = Object.freeze({ row: point.row, column: point.column });
    else secondaryCursors += 1;
  }
  return Object.freeze({
    selectedCells,
    secondarySelectedCells,
    trailCells,
    operatorPreviewCells,
    primaryCursor,
    secondaryCursors,
    trailPainted: masks.trailPainted,
    rejectedStalePreview: masks.rejectedStalePreview,
  });
}

/**
 * The common idle frame is already fully materialized by layout. Drawing its
 * contiguous ASCII runs avoids one native call per terminal cell. Decorated
 * frames and rows containing a multi-cell grapheme retain the precise path.
 */
// `paintEditorFrame` is called once per damage-limited paint range within the same
// render (see workbench.ts's per-range loop); `frame`/`presentation` are identical
// across those calls, so a full rows*cells scan per range is pure waste. Memoize
// by frame identity, one entry per rendered frame object.
const plainFrameCache = new WeakMap<
  VisibleFrame,
  { readonly presentation: EditorPresentationRead | undefined; readonly result: boolean }
>();

function canPaintPlainFrameCached(
  frame: VisibleFrame,
  presentation: EditorPresentationRead | undefined,
): boolean {
  const cached = plainFrameCache.get(frame);
  if (cached !== undefined && cached.presentation === presentation) return cached.result;
  const result = canPaintPlainFrame(frame, presentation);
  plainFrameCache.set(frame, { presentation, result });
  return result;
}

// `canPaintPlainFrame` is checked once per key, but `frame` (and therefore the WeakMap
// keyed on it, above) is a new object every render, so that memo never actually hits.
// A row's `contentKey` -- unlike the row object -- is stable across an edit that didn't
// touch that row (see its doc comment in packages/layout/src/index.ts), so per-row
// plain-ness is cached by contentKey instead: an edit only pays the per-cell scan for
// the rows it actually touched, not the whole ~4800-cell visible frame every keystroke.
const ROW_PLAIN_CACHE_CAP = 4096;
const rowPlainCache = new Map<string, boolean>();

function isRowPlain(row: ScreenRow): boolean {
  const key = row.contentKey;
  if (key !== null) {
    const cached = rowPlainCache.get(key);
    if (cached !== undefined) return cached;
  }
  let plain = true;
  for (const cell of row.cells) {
    if (cell.text.length !== 1) {
      plain = false;
      break;
    }
  }
  if (key !== null) {
    if (rowPlainCache.size >= ROW_PLAIN_CACHE_CAP) {
      const oldest = rowPlainCache.keys().next().value;
      if (oldest !== undefined) rowPlainCache.delete(oldest);
    }
    rowPlainCache.set(key, plain);
  }
  return plain;
}

/** Exported for direct unit testing of the plain-paint fast path (see tests/ui). */
export function canPaintPlainFrame(
  frame: VisibleFrame,
  presentation: EditorPresentationRead | undefined,
): boolean {
  if (
    presentation?.motionPreview != null ||
    presentation?.operatorPreview != null ||
    presentation?.searchHighlight != null ||
    presentation?.documentHighlight != null
  )
    return false;
  for (const selection of frame.selections) {
    // Only a visual-* selection ever populates `buildPaintMasks`' cell map (see
    // `markSelectionCells`); a plain cursor -- normal mode's block or insert mode's
    // caret, drawn afterward by `paintPlainFrame` itself -- never does, so both are
    // safe to run through the plain per-row path with an empty mask set.
    if (selection.kind !== "normal-cursor" && selection.kind !== "insert-caret") return false;
  }
  for (const row of frame.rows) {
    if (!isRowPlain(row)) return false;
  }
  return true;
}

/** The non-cursor style at a cursor's cell, so the overlay patches the real glyph/style. */
function cursorCellStyle(
  frame: VisibleFrame,
  rowIndex: number,
  column: number,
  row: ScreenRow | undefined,
  syntax: SyntaxRead | undefined,
  fallback: SyntaxFallbackRow | undefined,
  syntaxStyles: Map<string, ResolvedSyntaxStyle> | undefined,
  cursors: CursorPoints,
  muted: RGBA,
  foreground: RGBA,
  background: RGBA,
  cursorLine: boolean,
  cursorlineBackground: RGBA | undefined,
  cursorColumn: boolean,
  cursorcolumnBackground: RGBA | undefined,
): { readonly glyph: string; readonly foreground: RGBA; readonly background: RGBA; readonly attributes: number; readonly underlineColor?: RGBA } {
  const cell = row?.cells[column];
  if (row === undefined || cell === undefined) return { glyph: " ", foreground, background, attributes: 0 };
  const cursor =
    syntaxStyles === undefined ? undefined : rowSyntaxCursor(frame, row, syntax, fallback);
  const style = syntaxStyle(cell, cursor, syntaxStyles);
  const guide = cursorGuideForCell(syntaxStyles, rowIndex, column, cursors, cursorLine, cursorColumn, cursorlineBackground, cursorcolumnBackground, undefined, [], undefined);
  const underlineColor = guide?.underlineColor ?? style?.underlineColor;
  return {
    glyph: cell.text || " ",
    foreground: cell.role === "gutter" ? muted : (guide?.foreground ?? style?.foreground ?? foreground),
    background: guide?.background ?? style?.background ?? background,
    attributes: (style?.attributes ?? 0) | (guide?.attributes ?? 0),
    ...(underlineColor === undefined ? {} : { underlineColor }),
  };
}

function paintPlainFrame(
  buffer: OptimizedBuffer,
  options: MotionPaintOptions,
  rowRange: PaintRowRange,
): MotionPaintStats {
  // @xi-perf H1 RENDER-120 -- Per-cell run-coalesced plain paint; run buffers are bounded per row, not per cell.
  const softwarePrimaryCursor = options.cursorShape === undefined || options.cursorShape === "block";
  const colors = {
    cursorPrimary: resolvePaintColor(options.theme.cursorPrimary, options.colorMode),
    cursorSecondary: resolvePaintColor(options.theme.cursorSecondary, options.colorMode),
    cursorline: options.cursorLine === true ? resolvePaintColor(options.theme.cursorline, options.colorMode) : undefined,
    cursorcolumn: options.cursorColumn === true ? resolvePaintColor(options.theme.cursorcolumn, options.colorMode) : undefined,
    ruler: options.rulers === undefined ? undefined : resolvePaintColor(options.theme.ruler, options.colorMode),
  };
  const syntaxStyles =
    options.colorMode === "no-color"
      ? undefined
      : resolveSyntaxStylesCached(options.syntaxColors, options.syntaxStyles, options.colorMode, options.undercurl ?? true);
  const cursors = cursorPoints(options.frame);
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = options.frame.rows[rowIndex];
    if (row === undefined || row.cells.length === 0) continue;
    const syntaxCursor =
      syntaxStyles === undefined
        ? undefined
        : rowSyntaxCursor(
            options.frame,
            row,
            options.syntax,
            options.syntaxFallbackRows?.[rowIndex],
          );
    let runStart = 0;
    let runForeground = options.foreground;
    let runBackground = options.background;
    let runAttributes = 0;
    let runUnderlineColor: RGBA | undefined;
    const runText: string[] = [];
    const flush = (column: number): void => {
      if (runText.length > 0) {
        buffer.drawText(
          runText.join(""),
          options.x + runStart,
          options.y + rowIndex,
          runForeground,
          runBackground,
          runAttributes,
        );
        if (runUnderlineColor !== undefined) {
          for (let cursor = runStart; cursor < column; cursor += 1) {
            buffer.setUnderlineColor(options.x + cursor, options.y + rowIndex, runUnderlineColor);
          }
        }
      }
      runStart = column;
      runText.length = 0;
    };
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (cell === undefined) continue;
      const style = syntaxStyle(cell, syntaxCursor, syntaxStyles);
      const guide = cursorGuideForCell(syntaxStyles, rowIndex, column, cursors, options.cursorLine !== false, options.cursorColumn === true, colors.cursorline, colors.cursorcolumn, displayColumnForCell(cell), options.rulers ?? [], colors.ruler);
      const gutter =
        cell.role === "gutter" ? lineNumberStyle(syntaxStyles, rowIndex, cursors) : undefined;
      const foreground =
        cell.role === "gutter"
          ? (gutter?.foreground ?? options.muted)
          : (guide?.foreground ?? style?.foreground ?? options.foreground);
      const background =
        gutter?.background ?? guide?.background ?? virtualAnnotationBackground(cell, options.colorMode) ?? style?.background ?? options.background;
      const attributes =
        (style?.attributes ?? 0) | (guide?.attributes ?? 0) | (gutter?.attributes ?? 0);
      const underlineColor = gutter?.underlineColor ?? guide?.underlineColor ?? style?.underlineColor;
      if (
        foreground !== runForeground ||
        background !== runBackground ||
        attributes !== runAttributes ||
        underlineColor !== runUnderlineColor
      ) {
        flush(column);
        runForeground = foreground;
        runBackground = background;
        runAttributes = attributes;
        runUnderlineColor = underlineColor;
      }
      runText.push(cell.text);
    }
    flush(row.cells.length);
  }
  let primaryCursor: CellPoint | null = null;
  let secondaryCursors = 0;
  for (const selection of options.frame.selections) {
    const point = selection.head.position;
    if (point === null || point.row < rowRange.start || point.row >= rowRange.end) continue;
    const row = options.frame.rows[point.row];
    const base = cursorCellStyle(
      options.frame,
      point.row,
      point.column,
      row,
      options.syntax,
      options.syntaxFallbackRows?.[point.row],
      syntaxStyles,
      cursors,
      options.muted,
      options.foreground,
      options.background,
      options.cursorLine !== false,
      colors.cursorline,
      options.cursorColumn === true,
      colors.cursorcolumn,
    );
    if (options.colorMode === "no-color" && (softwarePrimaryCursor || !selection.primary)) {
      const attributes = base.attributes | (selection.primary ? TextAttributes.INVERSE : TextAttributes.UNDERLINE);
      buffer.setCell(
        options.x + point.column,
        options.y + point.row,
        base.glyph,
        base.foreground,
        base.background,
        attributes,
      );
    } else if (softwarePrimaryCursor || !selection.primary) {
      const styleForCursor = cursorStyle(syntaxStyles, selection.primary, options.mode, false);
      if (styleForCursor !== undefined) {
        buffer.setCell(
          options.x + point.column,
          options.y + point.row,
          base.glyph,
          styleForCursor.foreground ?? base.foreground,
          styleForCursor.background ?? base.background,
          base.attributes | styleForCursor.attributes,
        );
        const underlineColor = styleForCursor.underlineColor ?? base.underlineColor;
        if (underlineColor !== undefined) buffer.setUnderlineColor(options.x + point.column, options.y + point.row, underlineColor);
      } else if (options.mode === "insert") {
        buffer.setCell(options.x + point.column, options.y + point.row, base.glyph, base.foreground, base.background, base.attributes | TextAttributes.UNDERLINE);
        if (base.underlineColor !== undefined) buffer.setUnderlineColor(options.x + point.column, options.y + point.row, base.underlineColor);
      } else {
        const cursorBackground = selection.primary ? colors.cursorPrimary : colors.cursorSecondary;
        const foreground = pickCursorForeground(
          base.foreground,
          cursorBackground,
          options.foreground,
          options.background,
        );
        buffer.setCell(options.x + point.column, options.y + point.row, base.glyph, foreground, cursorBackground, base.attributes | TextAttributes.BOLD);
        if (base.underlineColor !== undefined) buffer.setUnderlineColor(options.x + point.column, options.y + point.row, base.underlineColor);
      }
    }
    if (selection.primary) primaryCursor = Object.freeze({ row: point.row, column: point.column });
    else secondaryCursors += 1;
  }
  return Object.freeze({
    selectedCells: 0,
    secondarySelectedCells: 0,
    trailCells: 0,
    operatorPreviewCells: 0,
    primaryCursor,
    secondaryCursors,
    trailPainted: false,
    rejectedStalePreview: false,
  });
}

interface PaintMaskResult {
  readonly cells: Map<number, number>;
  readonly trailPainted: boolean;
  readonly rejectedStalePreview: boolean;
}

function buildPaintMasks(
  frame: VisibleFrame,
  presentation: EditorPresentationRead | undefined,
  mode: string,
  colorMode: EditorColorMode,
  rowRange: PaintRowRange,
): PaintMaskResult {
  const cells = new Map<number, number>();
  const setMask = (row: number, column: number, bit: number): void => {
    const key = cellKey(row, column);
    cells.set(key, (cells.get(key) ?? 0) | bit);
  };
  for (const selection of frame.selections) {
    const isVisual =
      selection.kind === "visual-character" ||
      selection.kind === "visual-line" ||
      selection.kind === "visual-block";
    if (!isVisual) continue;
    markSelectionCells(
      frame,
      selection,
      selection.primary ? PAINT_PRIMARY_SELECTION : PAINT_SECONDARY_SELECTION,
      setMask,
      rowRange,
    );
  }
  const identity = frame.identity;
  let rejectedStalePreview = false;
  const motion = presentation?.motionPreview;
  const trailMode = presentation?.motionTrail ?? "off";
  const trailAllowed =
    trailMode === "last-motion" &&
    mode === "normal" &&
    presentation?.reducedMotion !== false &&
    colorMode !== "no-color";
  if (motion !== undefined && motion !== null) {
    const valid =
      motion.documentId === identity.documentId &&
      motion.documentVersion === identity.documentVersion &&
      motion.selectionGeneration === identity.selectionGeneration;
    if (!valid) rejectedStalePreview = true;
    if (valid && trailAllowed) {
      for (const member of motion.members) {
        paintOffsetRange(
          frame,
          member.extent.start,
          member.extent.end,
          (row, column) => setMask(row, column, PAINT_TRAIL),
          rowRange,
        );
      }
    }
  }
  const operator = presentation?.operatorPreview;
  if (operator !== undefined && operator !== null) {
    const valid =
      operator.documentId === identity.documentId &&
      operator.documentVersion === identity.documentVersion &&
      operator.selectionGeneration === identity.selectionGeneration;
    if (!valid) rejectedStalePreview = true;
    if (valid) {
      for (const member of operator.members) {
        paintOffsetRange(
          frame,
          member.start,
          member.end,
          (row, column) => setMask(row, column, PAINT_OPERATOR),
          rowRange,
        );
      }
    }
  }
  const search = presentation?.searchHighlight;
  if (
    search !== undefined &&
    search !== null &&
    search.documentId === identity.documentId &&
    search.documentVersion === identity.documentVersion
  ) {
    // Ranges are sorted by start; only the ones overlapping the painted rows cost anything.
    const firstRow = frame.rows[rowRange.start];
    const lastRow = frame.rows[rowRange.end - 1];
    const lowest = (firstRow?.startOffset as number | null | undefined) ?? 0;
    const highest = (lastRow?.endOffset as number | null | undefined) ?? Number.MAX_SAFE_INTEGER;
    for (const range of search.ranges) {
      if (range.start > highest) break;
      if (range.end < lowest) continue;
      paintOffsetRange(
        frame,
        range.start,
        range.end,
        (row, column) => setMask(row, column, PAINT_SEARCH),
        rowRange,
      );
    }
    if (search.current !== undefined) paintOffsetRange(frame, search.current.start, search.current.end,
      (row, column) => setMask(row, column, PAINT_CURRENT_SEARCH), rowRange);
  }
  const documentHighlight = presentation?.documentHighlight;
  if (
    documentHighlight !== undefined &&
    documentHighlight !== null &&
    documentHighlight.documentId === identity.documentId &&
    documentHighlight.documentVersion === identity.documentVersion
  ) {
    const firstRow = frame.rows[rowRange.start];
    const lastRow = frame.rows[rowRange.end - 1];
    const lowest = (firstRow?.startOffset as number | null | undefined) ?? 0;
    const highest = (lastRow?.endOffset as number | null | undefined) ?? Number.MAX_SAFE_INTEGER;
    for (const range of documentHighlight.ranges) {
      if (range.start > highest) continue;
      if (range.end < lowest) continue;
      paintOffsetRange(frame, range.start, range.end, (row, column) => setMask(row, column, PAINT_DOCUMENT_HIGHLIGHT), rowRange);
    }
  }
  return Object.freeze({
    cells,
    trailPainted: trailAllowed && motion !== undefined && motion !== null && !rejectedStalePreview,
    rejectedStalePreview,
  });
}

function markSelectionCells(
  frame: VisibleFrame,
  selection: ProjectedSelection,
  bit: number,
  setMask: (row: number, column: number, bit: number) => void,
  rowRange: PaintRowRange,
): void {
  const anchor = selection.anchor.position;
  const head = selection.head.position;
  if (selection.kind === "visual-line") {
    const firstLine = Math.min(
      selection.anchor.lineIndex as number,
      selection.head.lineIndex as number,
    );
    const lastLine = Math.max(
      selection.anchor.lineIndex as number,
      selection.head.lineIndex as number,
    );
    for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
      const row = frame.rows[rowIndex];
      if (
        row === undefined ||
        row.lineIndex === null ||
        (row.lineIndex as number) < firstLine ||
        (row.lineIndex as number) > lastLine
      )
        continue;
      for (let column = 0; column < row.cells.length; column += 1) {
        if (row.cells[column]?.role !== "gutter") setMask(rowIndex, column, bit);
      }
    }
    return;
  }
  if (anchor === null || head === null) return;
  if (selection.kind === "visual-block") {
    const firstRow = Math.min(anchor.row, head.row);
    const lastRow = Math.max(anchor.row, head.row);
    const firstColumn = Math.min(anchor.column, head.column);
    const lastColumn = Math.max(anchor.column, head.column);
    for (
      let row = Math.max(firstRow, rowRange.start);
      row <= Math.min(lastRow, rowRange.end - 1);
      row += 1
    ) {
      const frameRow = frame.rows[row];
      if (frameRow === undefined) continue;
      for (
        let column = firstColumn;
        column <= lastColumn && column < frameRow.cells.length;
        column += 1
      ) {
        if (column >= 0 && frameRow.cells[column]?.role !== "gutter") setMask(row, column, bit);
      }
    }
    return;
  }
  const start = Math.min(
    selection.anchor.requestedOffset as number,
    selection.head.requestedOffset as number,
  );
  const end = Math.max(
    selection.anchor.requestedOffset as number,
    selection.head.requestedOffset as number,
  );
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = frame.rows[rowIndex];
    if (row === undefined) continue;
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      const target = cell?.target;
      if (
        cell?.role !== "gutter" &&
        cell?.role !== "padding" &&
        target?.kind === "text" &&
        (target.offset as number) >= start &&
        (target.offset as number) <= end
      ) {
        setMask(rowIndex, column, bit);
      }
    }
    // Keep the explicit EOL cell selected when the endpoint names the line end.
    if (
      (row.endOffset as number | null) !== null &&
      end >= (row.endOffset as number) &&
      start <= (row.endOffset as number)
    ) {
      const eolColumn = eolColumnForRow(row);
      if (eolColumn >= 0) setMask(rowIndex, eolColumn, bit);
    }
  }
}

function paintOffsetRange(
  frame: VisibleFrame,
  start: number,
  end: number,
  paint: (row: number, column: number) => void,
  rowRange: PaintRowRange,
): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return;
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = frame.rows[rowIndex];
    if (row === undefined || row.kind !== "text") continue;
    const rowStart = row.startOffset as number | null;
    const rowEnd = row.endOffset as number | null;
    if (rowStart === null || rowEnd === null || end <= rowStart || start >= rowEnd) continue;
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (cell === undefined) continue;
      const target = cell.target;
      if (
        cell.role !== "gutter" &&
        cell.role !== "padding" &&
        target?.kind === "text" &&
        (target.offset as number) >= start &&
        (target.offset as number) < end
      )
        paint(rowIndex, column);
    }
    if (start <= rowEnd && end >= rowEnd && rowEnd > rowStart) {
      const eolColumn = eolColumnForRow(row);
      if (eolColumn >= 0) paint(rowIndex, eolColumn);
    }
  }
}

function eolColumnForRow(row: ScreenRow): number {
  let contentStart = 0;
  while (contentStart < row.cells.length && row.cells[contentStart]?.role === "gutter")
    contentStart += 1;
  return Math.min(
    row.cells.length - 1,
    Math.max(contentStart, contentStart + Math.floor(row.displayEndCell)),
  );
}

interface PaintRowRange {
  readonly start: number;
  readonly end: number;
}

function paintRowRange(frame: VisibleFrame, requested: MotionPaintOptions["rows"]): PaintRowRange {
  if (requested === undefined) return { start: 0, end: frame.rows.length };
  return {
    start: Math.max(0, Math.min(frame.rows.length, Math.trunc(requested.start))),
    end: Math.max(0, Math.min(frame.rows.length, Math.trunc(requested.end))),
  };
}

function cellKey(row: number, column: number): number {
  return row * 2_048 + column;
}
