import { PersistentTextModel, type ItemOps } from './model';

export interface PieceBuffer {
  readonly text: string;
  readonly lineBreaks: readonly number[];
}

export interface PieceDescriptor {
  readonly buffer: PieceBuffer;
  readonly start: number;
  readonly end: number;
}

export interface RopeChunk {
  readonly text: string;
  readonly lineBreaks: readonly number[];
}

export const ropeChunkSize = 1024;

const pieceOperations: ItemOps<PieceDescriptor> = {
  itemLength: (piece) => piece.end - piece.start,
  lineBreakCount: (piece) => lowerBound(piece.buffer.lineBreaks, piece.end) - lowerBound(piece.buffer.lineBreaks, piece.start),
  lineBreaksBefore: (piece, offset) => {
    const boundary = piece.start + offset;
    return lowerBound(piece.buffer.lineBreaks, boundary) - lowerBound(piece.buffer.lineBreaks, piece.start);
  },
  splitItem: (piece, offset) => [
    { buffer: piece.buffer, start: piece.start, end: piece.start + offset },
    { buffer: piece.buffer, start: piece.start + offset, end: piece.end },
  ],
  fromText: (text) => text.length === 0 ? [] : [{ buffer: createPieceBuffer(text), start: 0, end: text.length }],
  render: (piece) => piece.buffer.text.slice(piece.start, piece.end),
  codeUnitAt: (piece, offset) => piece.buffer.text.charCodeAt(piece.start + offset),
  canCoalesce: (left, right) => left.buffer === right.buffer && left.end === right.start,
  coalesce: (left, right) => ({ buffer: left.buffer, start: left.start, end: right.end }),
  storageIdentity: (piece) => piece.buffer,
  storageUnits: (piece) => piece.buffer.text.length,
};

const ropeOperations: ItemOps<RopeChunk> = {
  itemLength: (chunk) => chunk.text.length,
  lineBreakCount: (chunk) => chunk.lineBreaks.length,
  lineBreaksBefore: (chunk, offset) => lowerBound(chunk.lineBreaks, offset),
  splitItem: (chunk, offset) => [createRopeChunk(chunk.text.slice(0, offset)), createRopeChunk(chunk.text.slice(offset))],
  fromText: (text) => chunkText(text),
  render: (chunk) => chunk.text,
  codeUnitAt: (chunk, offset) => chunk.text.charCodeAt(offset),
  canCoalesce: (left, right) => left.text.length + right.text.length <= ropeChunkSize,
  coalesce: (left, right) => createRopeChunk(left.text + right.text),
  storageIdentity: (chunk) => chunk,
  storageUnits: (chunk) => chunk.text.length,
};

export function createPieceTree(text: string, seed = 41027): PersistentTextModel<PieceDescriptor> {
  return new PersistentTextModel(text, pieceOperations, seed);
}

export function createChunkedRope(text: string, seed = 41027): PersistentTextModel<RopeChunk> {
  return new PersistentTextModel(text, ropeOperations, seed);
}

export function pieceOperationsForTests(): ItemOps<PieceDescriptor> {
  return pieceOperations;
}

export function ropeOperationsForTests(): ItemOps<RopeChunk> {
  return ropeOperations;
}

function createPieceBuffer(text: string): PieceBuffer {
  return { text, lineBreaks: lineBreakOffsets(text) };
}

function createRopeChunk(text: string): RopeChunk {
  return { text, lineBreaks: lineBreakOffsets(text) };
}

function chunkText(text: string): RopeChunk[] {
  const chunks: RopeChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + ropeChunkSize);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    if (end <= start) throw new Error(`rope-chunker-made-no-progress: offset=${start}`);
    chunks.push(createRopeChunk(text.slice(start, end)));
    start = end;
  }
  return chunks;
}

function lineBreakOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) offsets.push(index);
  return offsets;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value !== undefined && value < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
