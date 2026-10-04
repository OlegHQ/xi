import {
  TextTableRenderable,
  TextAttributes,
  RGBA,
  parseColor,
  type RenderContext,
  type SyntaxStyle,
  type TextChunk,
} from '@opentui/core';
import type { ThemeColor, WorkbenchTheme } from '../workbench';
import { themeColor } from '../../theme/color-input';

export interface MarkdownTableCell {
  readonly text?: string;
  readonly tokens?: readonly unknown[];
}

export interface MarkdownTableTheme {
  readonly foreground: ThemeColor;
  readonly muted: ThemeColor;
  readonly accent: ThemeColor;
}

export interface MarkdownTableToken {
  readonly type: string;
  readonly header?: readonly MarkdownTableCell[];
  readonly align?: readonly ('center' | 'left' | 'right' | null | undefined)[];
  readonly rows?: readonly (readonly (MarkdownTableCell | undefined)[])[];
}

interface InlineToken {
  readonly type?: string;
  readonly text?: string;
  readonly tokens?: readonly unknown[];
}

const stringWidth = (typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function')
  ? Bun.stringWidth
  : (text: string): number => text.length;

function toRGBA(color: unknown): RGBA | undefined {
  if (color instanceof RGBA) return color;
  if (typeof color === 'string') return parseColor(color);
  return undefined;
}

function makeChunk(text: string, attributes?: number, fg?: RGBA): TextChunk {
  const chunk: TextChunk = {
    __isChunk: true,
    text,
  };
  if (attributes !== undefined && attributes !== 0) {
    chunk.attributes = attributes;
  }
  if (fg !== undefined) {
    chunk.fg = fg;
  }
  return chunk;
}

function processTokens(
  tokens: readonly unknown[] | undefined,
  isHeader: boolean,
  syntaxStyle: SyntaxStyle | undefined,
  defaultFg: RGBA | undefined,
  accentFg: RGBA | undefined,
  fallbackText?: string,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const headingStyle = syntaxStyle?.getStyle('markup.heading');
  const rawStyle = syntaxStyle?.getStyle('markup.raw');
  const linkStyle = syntaxStyle?.getStyle('markup.link.label');
  const baseAttrs = isHeader ? TextAttributes.BOLD : 0;
  const baseFg = isHeader ? (headingStyle?.fg ?? accentFg ?? defaultFg) : defaultFg;

  function walk(tok: unknown, currentAttrs: number, fg: RGBA | undefined): void {
    if (tok === null || typeof tok !== 'object') return;
    const inline = tok as InlineToken;
    const type = inline.type ?? '';
    const text = inline.text ?? '';
    const subTokens = inline.tokens;

    if (type === 'text' || type === 'escape') {
      chunks.push(makeChunk(text, currentAttrs, fg));
    } else if (type === 'strong') {
      const nextAttrs = currentAttrs | TextAttributes.BOLD;
      if (subTokens !== undefined && subTokens.length > 0) {
        for (const child of subTokens) walk(child, nextAttrs, fg);
      } else {
        chunks.push(makeChunk(text, nextAttrs, fg));
      }
    } else if (type === 'em') {
      const nextAttrs = currentAttrs | TextAttributes.ITALIC;
      if (subTokens !== undefined && subTokens.length > 0) {
        for (const child of subTokens) walk(child, nextAttrs, fg);
      } else {
        chunks.push(makeChunk(text, nextAttrs, fg));
      }
    } else if (type === 'codespan') {
      const codeFg = rawStyle?.fg ?? fg;
      chunks.push(makeChunk(text, currentAttrs, codeFg));
    } else if (type === 'link') {
      const nextAttrs = currentAttrs | TextAttributes.UNDERLINE;
      const targetFg = linkStyle?.fg ?? fg;
      if (subTokens !== undefined && subTokens.length > 0) {
        for (const child of subTokens) walk(child, nextAttrs, targetFg);
      } else {
        chunks.push(makeChunk(text, nextAttrs, targetFg));
      }
    } else if (type === 'del') {
      const nextAttrs = currentAttrs | TextAttributes.STRIKETHROUGH;
      if (subTokens !== undefined && subTokens.length > 0) {
        for (const child of subTokens) walk(child, nextAttrs, fg);
      } else {
        chunks.push(makeChunk(text, nextAttrs, fg));
      }
    } else if (type === 'html' && /<br\s*\/?>/iu.test(text)) {
      chunks.push(makeChunk('\n', currentAttrs, fg));
    } else if (subTokens !== undefined && subTokens.length > 0) {
      for (const child of subTokens) walk(child, currentAttrs, fg);
    } else if (text.length > 0) {
      chunks.push(makeChunk(text, currentAttrs, fg));
    }
  }

  if (tokens !== undefined && tokens.length > 0) {
    for (const t of tokens) walk(t, baseAttrs, baseFg);
  } else if (fallbackText !== undefined && fallbackText.length > 0) {
    chunks.push(makeChunk(fallbackText, baseAttrs, baseFg));
  }
  return chunks.length > 0 ? chunks : [makeChunk(' ', baseAttrs, baseFg)];
}

function splitLines(chunks: readonly TextChunk[]): TextChunk[][] {
  const lines: TextChunk[][] = [[]];
  for (const chunk of chunks) {
    const parts = chunk.text.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push([]);
      const part = parts[i];
      if (part !== undefined && part.length > 0) {
        const currentLine = lines[lines.length - 1];
        if (currentLine !== undefined) {
          currentLine.push(makeChunk(part, chunk.attributes, chunk.fg));
        }
      }
    }
  }
  return lines;
}

function getLineWidth(line: readonly TextChunk[]): number {
  return line.reduce((sum, c) => sum + stringWidth(c.text), 0);
}

function getCellMaxWidth(lines: readonly (readonly TextChunk[])[]): number {
  return lines.reduce((max, line) => Math.max(max, getLineWidth(line)), 0);
}

function alignCell(
  lines: readonly (readonly TextChunk[])[],
  targetWidth: number,
  align: 'center' | 'left' | 'right' | null | undefined,
): TextChunk[] {
  const result: TextChunk[] = [];
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    if (line === undefined) continue;
    if (li > 0) result.push(makeChunk('\n'));
    const currentW = getLineWidth(line);
    const diff = targetWidth - currentW;
    if (diff <= 0 || align === undefined || align === null || align === 'left') {
      result.push(...line);
      continue;
    }
    const left = align === 'right' ? diff : Math.floor(diff / 2);
    const right = align === 'right' ? 0 : diff - left;
    if (left > 0) result.push(makeChunk(' '.repeat(left)));
    result.push(...line);
    if (right > 0) result.push(makeChunk(' '.repeat(right)));
  }
  return result.length > 0 ? result : [makeChunk(' '.repeat(Math.max(1, targetWidth)))];
}

export function createMarkdownTable(
  tableToken: MarkdownTableToken,
  renderer: RenderContext,
  syntaxStyle: SyntaxStyle | undefined,
  theme: MarkdownTableTheme,
): TextTableRenderable | null {
  const header = tableToken.header;
  if (header === undefined || header.length === 0) return null;
  const colCount = header.length;

  const defaultFg = toRGBA(themeColor(theme.foreground, 'fg'));
  const accentFg = toRGBA(themeColor(theme.accent, 'fg'));
  const borderColor = toRGBA(themeColor(theme.muted, 'fg'));
  const aligns = tableToken.align ?? [];

  const headerLines = header.map(cell =>
    splitLines(processTokens(cell.tokens, true, syntaxStyle, defaultFg, accentFg, cell.text)),
  );
  const rowLines = (tableToken.rows ?? []).map(row =>
    Array.from({ length: colCount }, (_, i) => {
      const cell = row[i];
      return splitLines(processTokens(cell?.tokens, false, syntaxStyle, defaultFg, accentFg, cell?.text));
    }),
  );

  const colWidths = new Array<number>(colCount).fill(1);
  for (let c = 0; c < colCount; c += 1) {
    const headerCol = headerLines[c];
    if (headerCol !== undefined) {
      colWidths[c] = Math.max(colWidths[c] ?? 1, getCellMaxWidth(headerCol));
    }
    for (const r of rowLines) {
      const cellCol = r[c];
      if (cellCol !== undefined) {
        colWidths[c] = Math.max(colWidths[c] ?? 1, getCellMaxWidth(cellCol));
      }
    }
  }

  const alignedHeader = headerLines.map((lines, c) => alignCell(lines, colWidths[c] ?? 1, aligns[c]));
  const alignedRows = rowLines.map(row =>
    row.map((lines, c) => alignCell(lines, colWidths[c] ?? 1, aligns[c])),
  );

  return new TextTableRenderable(renderer, {
    content: [alignedHeader, ...alignedRows],
    cellPaddingX: 1,
    columnWidthMode: 'content',
    showBorders: true,
    border: true,
    outerBorder: true,
    borderStyle: 'single',
    ...(borderColor !== undefined ? { borderColor } : {}),
  });
}
