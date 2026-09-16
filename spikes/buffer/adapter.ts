import { createChunkedRope, createPieceTree } from './candidates';
import type { PersistentTextModel, ModelMetrics, TextEdit } from './model';

export interface CapturedBuffer {
  readonly version: number;
  text(): string;
}

export interface BufferAdapter {
  readonly version: number;
  readonly length: number;
  text(): string;
  lineIndexAt(offset: number): number;
  capture(): CapturedBuffer;
  fork(): BufferAdapter;
  replace(start: number, end: number, text: string, retainUndo?: boolean): void;
  replaceBatch(edits: readonly TextEdit[], expectedVersion: number, retainUndo?: boolean, shouldCancel?: () => boolean): void;
  undo(): boolean;
  metrics(): ModelMetrics;
}

export interface CandidateDefinition {
  readonly id: 'augmented-piece-tree' | 'chunked-rope';
  readonly open: (text: string, seed?: number) => BufferAdapter;
}

export const candidates: readonly CandidateDefinition[] = [
  {
    id: 'augmented-piece-tree',
    open: (text, seed) => adapt(createPieceTree(text, seed)),
  },
  {
    id: 'chunked-rope',
    open: (text, seed) => adapt(createChunkedRope(text, seed)),
  },
];

function adapt<Item>(model: PersistentTextModel<Item>): BufferAdapter {
  return {
    get version() {
      return model.version;
    },
    get length() {
      return model.length;
    },
    text: () => model.text(),
    lineIndexAt: (offset) => model.lineIndexAt(offset),
    capture: () => {
      const snapshot = model.snapshot();
      return { version: snapshot.version, text: () => model.snapshotText(snapshot) };
    },
    fork: () => adapt(model.fork()),
    replace: (start, end, text, retainUndo) => model.replace(start, end, text, retainUndo),
    replaceBatch: (edits, expectedVersion, retainUndo, shouldCancel) =>
      model.replaceBatch(edits, expectedVersion, retainUndo, shouldCancel),
    undo: () => model.undo(),
    metrics: () => model.metrics(),
  };
}
