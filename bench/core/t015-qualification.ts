#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asIdentifier,
  type DocumentId,
  type SelectionId,
  type UndoGroupId,
  type ViewId,
  type Utf16Offset,
} from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, mapSelectionSet, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import { ViewportLayout } from '../../packages/layout/src/index';
import { normalizeVimInput } from '../../packages/vim/input/index';
import { createVimParserState, parseVimInput } from '../../packages/vim/parser/index';
import {
  defineCommandRegistration,
  type CommandDescriptorCandidate,
  type CommandSchema,
} from '../../packages/contracts/src/index';
import { CommandRegistry } from '../../packages/workbench/src/index';

const warmups = 5;
const sampleCount = 30;
const initialText = 'x'.repeat(50_000);
const documentId = identifier<DocumentId>('t015-document');
const undoGroup = identifier<UndoGroupId>('t015-edit');
const viewId = identifier<ViewId>('t015-view');
const baseDocument = editable(documentId);
const baseSnapshot = baseDocument.snapshot();
const baseCommit = baseDocument.commit({
  documentId,
  expectedVersion: baseSnapshot.version,
  edits: [{ start: offset(25_000), end: offset(25_000), text: 'y' }],
  origin: 'vim',
  undoGroup,
});
if (!baseCommit.ok || baseCommit.value.kind !== 'committed') throw new Error('T015-selection-change');
const baseChange = baseCommit.value.change;
const selectionCosts: Record<string, unknown> = {};

for (const count of [1, 10, 100, 1_000, 10_000]) {
  const selection = makeSelectionSet(baseSnapshot, count);
  selectionCosts[String(count)] = await measureSync(() => {
    const mapped = mapSelectionSet(selection, baseChange.changeMap, baseChange.snapshot);
    if (!mapped.ok || mapped.value.selectionSet.members.length !== count) throw new Error(`T015-selection-map:${count}`);
  });
}

const parserDocument = editable(identifier<DocumentId>('t015-parser-document'));
const parserSelection = makeSelectionSet(parserDocument.snapshot(), 1, 'normal-cursor');
const parser = createVimParserState('normal', parserSelection);
if (!parser.ok) throw new Error(`T015-parser-state:${parser.error.kind}`);
const normalizedKey = normalizeVimInput({
  kind: 'key', key: 'h', phase: 'press',
  modifiers: { shift: false, alt: false, ctrl: false, meta: false },
}, { monotonicMilliseconds: () => 1 });
if (!normalizedKey.ok) throw new Error(`T015-normalize-key:${normalizedKey.error.kind}`);

const registry = makeRegistry();
const layout = new ViewportLayout();
const hitDocument = editable(identifier<DocumentId>('t015-hit-document'));
const hitSelection = makeSelectionSet(hitDocument.snapshot(), 1, 'normal-cursor');
const frame = layout.project({ viewId, snapshot: hitDocument.snapshot(), selection: hitSelection, widthCells: 120, heightCells: 40 });
if (!frame.ok) throw new Error(`T015-layout-frame:${frame.error.kind}`);

const measurements = {
  schemaVersion: 1,
  ticket: 'T015',
  fixture: 'T015-CORE-OPERATION-COSTS-01',
  environment: {
    platform: process.platform,
    architecture: process.arch,
    bun: Bun.version,
    cpuModel: cpus()[0]?.model.trim() || 'not exposed',
    logicalCpuCount: cpus().length,
  },
  method: {
    warmupSamples: warmups,
    measuredSamples: sampleCount,
    timer: 'performance.now; per-operation setup is excluded where noted',
    thresholds: null,
  },
  workload: {
    documentUtf16Units: initialText.length,
    selectionMappingCounts: [1, 10, 100, 1_000, 10_000],
    parserInput: 'normalize and parse one canonical h key in Normal mode',
    layoutViewport: '120x40 cells over one 50,000-unit line',
    registry: 'dispatch one registered typed command with numeric input/output',
  },
  microseconds: {
    documentCommitOneUnit: await measureSync(() => {
      const document = editable(identifier<DocumentId>('t015-commit-sample'));
      const before = document.snapshot();
      const committed = document.commit({
        documentId: before.id,
        expectedVersion: before.version,
        edits: [{ start: offset(25_000), end: offset(25_000), text: 'y' }],
        origin: 'vim', undoGroup,
      });
      if (!committed.ok || committed.value.kind !== 'committed') throw new Error('T015-document-commit');
    }),
    documentUndo: await measureSync(() => {
      const document = editable(identifier<DocumentId>('t015-undo-sample'));
      const before = document.snapshot();
      const committed = document.commit({
        documentId: before.id,
        expectedVersion: before.version,
        edits: [{ start: offset(25_000), end: offset(25_000), text: 'y' }],
        origin: 'vim', undoGroup,
      });
      if (!committed.ok || committed.value.kind !== 'committed') throw new Error('T015-undo-setup');
      const start = performance.now();
      const result = document.undo();
      const elapsed = performance.now() - start;
      if (!result.ok) throw new Error(`T015-document-undo:${result.error.kind}`);
      return elapsed;
    }),
    selectionMappingByCount: selectionCosts,
    normalizeAndParseOneKey: await measureSync(() => {
      const input = normalizeVimInput({
        kind: 'key', key: 'h', phase: 'press',
        modifiers: { shift: false, alt: false, ctrl: false, meta: false },
      }, { monotonicMilliseconds: () => 1 });
      if (!input.ok) throw new Error(`T015-normalize:${input.error.kind}`);
      const outcome = parseVimInput(parser.value, input.value);
      if (outcome.kind !== 'command') throw new Error(`T015-parse:${outcome.kind}`);
    }),
    commandRegistryDispatch: await measureAsync(async () => {
      const result = await registry.dispatch({ kind: 'command', id: identifier('xi.t015.benchmark') }, { value: 7 });
      if (!result.ok || result.value !== 8) throw new Error('T015-registry-dispatch');
    }),
    layoutHitTest: await measureSync(() => {
      const result = layout.hitTest(frame.value.identity.frameId, { row: 0, column: 0 });
      if (!result.ok || result.value.target.kind !== 'text') throw new Error('T015-layout-hit-test');
    }),
  },
};

const artifactPath = resolve(fileURLToPath(new URL('../../.artifacts/core/T015-qualification.json', import.meta.url)));
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(measurements, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(measurements, null, 2));
console.log(`artifact=${artifactPath}`);
await registry.dispose();

async function measureSync(operation: () => void | number): Promise<Stats> {
  for (let index = 0; index < warmups; index += 1) operation();
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    const reported = operation();
    samples.push(reported ?? performance.now() - start);
  }
  return summarize(samples);
}

async function measureAsync(operation: () => Promise<void>): Promise<Stats> {
  for (let index = 0; index < warmups; index += 1) await operation();
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

function summarize(milliseconds: number[]): Stats {
  const sorted = [...milliseconds].sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    samples: sorted.length,
    p50: at(0.5) * 1_000,
    p95: at(0.95) * 1_000,
    p99: at(0.99) * 1_000,
    max: (sorted.at(-1) ?? 0) * 1_000,
  };
}

function editable(id: DocumentId): TextFileDocument {
  const result = TextFileDocument.create(id, initialText, [], 'lf');
  if (!result.ok) throw new Error(`T015-document-open:${result.error.kind}`);
  return result.value;
}

function makeSelectionSet(
  snapshot: ReturnType<TextFileDocument['snapshot']>,
  count: number,
  kind: 'insert-caret' | 'normal-cursor' = 'insert-caret',
): SelectionSetSnapshot {
  const primaryId = selectionId('t015-selection-0');
  const members = Array.from({ length: count }, (_, index) => {
    const id = selectionId(`t015-selection-${index}`);
    const endpoint = kind === 'normal-cursor'
      ? { kind: 'character' as const, offset: offset(index * 4), after: offset(index * 4 + 1) }
      : { kind: 'gap' as const, offset: offset(index * 4), affinity: 'right' as const };
    return { id, kind, direction: 'forward' as const, anchor: endpoint, head: endpoint };
  });
  const result = createSelectionSet(snapshot, { primaryId, members });
  if (!result.ok) throw new Error(`T015-selection-create:${result.error.kind}:${count}`);
  return result.value.selectionSet;
}

function makeRegistry(): CommandRegistry {
  interface Args { readonly value: number }
  const argsSchema: CommandSchema<Args> = {
    decode(input: unknown) {
      if (typeof input !== 'object' || input === null || !('value' in input) || typeof input.value !== 'number') {
        return { ok: false, error: [{ path: '$.value', code: 'invalid-type', message: 'value must be numeric' }] };
      }
      return { ok: true, value: { value: input.value } };
    },
  };
  const outputSchema: CommandSchema<number> = {
    decode(input: unknown) {
      return typeof input === 'number'
        ? { ok: true, value: input }
        : { ok: false, error: [{ path: '$', code: 'invalid-type', message: 'output must be numeric' }] };
    },
  };
  const candidate: CommandDescriptorCandidate<Args, number> = {
    id: identifier('xi.t015.benchmark'),
    contractVersion: 1,
    owner: 'benchmark.t015',
    title: 'Benchmark command',
    help: 'Measures registered command dispatch.',
    category: 'benchmark',
    arguments: argsSchema,
    output: outputSchema,
    selectionPolicy: 'document-once',
    effect: 'read',
    undoPolicy: 'none',
    replayPolicy: 'never',
    cancellationPolicy: 'cancellable',
    availability: { contexts: [], requiredCapabilities: [], unavailableReason: 'Unavailable.' },
  };
  const registration = defineCommandRegistration({ descriptor: candidate, handler: ({ value }) => value + 1 });
  const registry = new CommandRegistry({ nativeExNames: ['quit'] });
  const result = registry.register({ commands: [registration] });
  if (!result.ok) throw new Error(`T015-register:${result.error.kind}`);
  return registry;
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 't015-benchmark-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function selectionId(value: string): SelectionId { return identifier<SelectionId>(value); }
function offset(value: number): Utf16Offset { return value as Utf16Offset; }

interface Stats {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}
