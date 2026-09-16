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
const samples: number[] = [];
for (let sample = 0; sample < 20; sample += 1) {
  const start = performance.now();
  const result = index.query('module-050', { limit: 100 });
  if ('kind' in result) throw new Error(result.kind);
  samples.push(performance.now() - start);
}
samples.sort((left, right) => left - right);
const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
console.log(JSON.stringify({ fixture: 'T039-FILE-PICKER-100K', entries: index.snapshot.entries, firstUsefulMilliseconds: samples[0], p95Milliseconds: p95 }));
index.dispose();
