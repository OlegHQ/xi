import { FilePathIndex } from '../packages/services/navigation/index';

const index = new FilePathIndex({ maxEntries: 120_000 });
const root = index.addRoot({ id: 'bench-root', label: 'bench', path: '/bench' });
if (!root.ok) throw new Error(root.error.kind);
const paths = Array.from({ length: 100_000 }, (_, index) => ({
  rootId: 'bench-root', relativePath: `src/module-${String(index).padStart(6, '0')}/file.ts`,
}));
const added = index.addPaths('bench-root', paths);
if (!added.ok) throw new Error(added.error.kind);
index.markReady();
const emptyIndex = new FilePathIndex({ maxEntries: 5_000 });
if (!emptyIndex.addRoot({ id: 'bench-root', label: 'bench', path: '/bench' }).ok) throw new Error('empty picker root');
if (!emptyIndex.addPaths('bench-root', paths.slice(0, 5_000)).ok) throw new Error('empty picker paths');
const emptySamples: number[] = [];
for (let sample = 0; sample < 20; sample += 1) {
  const start = performance.now();
  const result = await emptyIndex.queryAsync('', { limit: 10_000 });
  if (!result.ok || result.value.entries.length !== 5_000) throw new Error('empty picker result');
  emptySamples.push(performance.now() - start);
}
emptySamples.sort((left, right) => left - right);
const emptyP95 = emptySamples[Math.min(emptySamples.length - 1, Math.floor(emptySamples.length * 0.95))] ?? 0;
if (emptyP95 > 50) throw new Error(`T039-FILE-PICKER-EMPTY-5K p95 ${emptyP95.toFixed(2)}ms exceeds 50ms`);
emptyIndex.dispose();
const samples: number[] = [];
for (let sample = 0; sample < 20; sample += 1) {
  const start = performance.now();
  const result = await index.queryAsync('module-050', { limit: 100 });
  if (!result.ok) throw new Error(result.error.kind);
  samples.push(performance.now() - start);
}
samples.sort((left, right) => left - right);
const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
console.log(JSON.stringify({ fixture: 'T039-FILE-PICKER-100K', entries: index.snapshot.entries, firstUsefulMilliseconds: samples[0], p95Milliseconds: p95, empty5kP95Milliseconds: emptyP95 }));
if (p95 > 100) throw new Error(`T039-FILE-PICKER-100K p95 ${p95.toFixed(2)}ms exceeds 100ms`);
index.dispose();
