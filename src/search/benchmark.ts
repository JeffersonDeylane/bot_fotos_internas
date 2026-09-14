import { writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Index, MetricKind, ScalarKind } from 'usearch';

export async function benchmarkVectorIndex(directory: string, count: number, dimension = 768) {
  if (![10_000, 50_000, 100_000].includes(count)) throw new Error('VECTOR_BENCHMARK_COUNT');
  const index = new Index({ dimensions: dimension, metric: MetricKind.Cos, quantization: ScalarKind.F32,
    connectivity: 16, expansion_add: 128, expansion_search: 64, multi: false });
  const baseline = process.memoryUsage().rss;
  let seed = 0x12345678;
  const vector = new Float32Array(dimension);
  const fill = () => {
    let norm = 0;
    for (let i = 0; i < dimension; i++) { seed = (1664525 * seed + 1013904223) >>> 0; const value = seed / 0xffffffff - 0.5; vector[i] = value; norm += value * value; }
    norm = Math.sqrt(norm); for (let i = 0; i < dimension; i++) vector[i] = vector[i]! / norm;
  };
  const buildStart = performance.now();
  for (let id = 1; id <= count; id++) { fill(); index.add(BigInt(id), vector, 1); }
  const buildMs = performance.now() - buildStart;
  const query = new Float32Array(vector);
  const queryStart = performance.now();
  for (let i = 0; i < 100; i++) index.search(query, 10, 1);
  const searchMeanMs = (performance.now() - queryStart) / 100;
  const file = path.join(directory, `benchmark-${count}.usearch`);
  index.save(file);
  const report = { vectors: count, dimension, buildMs, searchMeanMs, rssDeltaMiB: (process.memoryUsage().rss - baseline) / 2 ** 20,
    indexBytes: (await stat(file)).size, createdAt: new Date().toISOString() };
  await writeFile(path.join(directory, `vector-benchmark-${count}.json`), JSON.stringify(report, null, 2));
  return report;
}
