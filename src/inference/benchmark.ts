import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '../config/settings.ts';
import { scanDirectory } from '../indexing/scanner.ts';
import { authorizePhotoFile } from '../security/allowed-paths.ts';
import { LocalEmbeddingModel } from './model.ts';
import { cosine } from './preprocessing.ts';

export async function benchmark(settings: Settings, model: LocalEmbeddingModel, signal: AbortSignal, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('BENCHMARK_LIMIT');
  const files: string[] = [];
  for (const root of settings.photos.directories) {
    for await (const event of scanDirectory(root, signal)) {
      if (event.kind === 'file') files.push(await authorizePhotoFile(event.file.path, settings.photos.directories));
      if (files.length >= limit) break;
    }
    if (files.length >= limit) break;
  }
  if (!files.length) throw new Error('BENCHMARK_NO_IMAGES');
  let peakRss = process.memoryUsage().rss;
  const baseline = peakRss;
  const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  const timer = setInterval(sample, 50);
  try {
    const cold = performance.now();
    await model.embedImages([files[0]!]);
    const warmupMs = performance.now() - cold;
    const measurements = [];
    let imageVectors: Float32Array[] = [];
    for (const batchSize of [1, 2]) {
      signal.throwIfAborted();
      if (batchSize === 2) await model.embedImages(files.slice(0, 2));
      const start = performance.now();
      const vectors: Float32Array[] = [];
      for (let offset = 0; offset < files.length; offset += batchSize) {
        signal.throwIfAborted();
        const selected = files.slice(offset, offset + batchSize);
        for (const file of selected) await authorizePhotoFile(file, settings.photos.directories);
        vectors.push(...await model.embedImages(selected));
        sample();
      }
      const elapsedMs = performance.now() - start;
      measurements.push({ batchSize, images: files.length, elapsedMs, imagesPerSecond: files.length * 1000 / elapsedMs, meanMs: elapsedMs / files.length });
      if (batchSize === 1) imageVectors = vectors;
    }
    const prompts = ['gato preto', 'pessoas pescando', 'carro vermelho', 'cachorro brincando na praia', 'dois gatos em um sofá', 'um cachorro branco', 'um ônibus na rua'];
    const textStart = performance.now();
    const queries = await model.embedTexts(prompts);
    const textElapsedMs = performance.now() - textStart;
    sample();
    const finalRss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, finalRss);
    const report = {
      model: model.version, dimension: model.dimension, provider: 'cpu', createdAt: new Date().toISOString(),
      warmupMs, measurements, textElapsedMs,
      baselineRssMiB: baseline / 2 ** 20, peakRssMiB: peakRss / 2 ** 20, finalRssMiB: finalRss / 2 ** 20,
      memoryScope: 'RSS do processo inteiro, incluindo memória nativa; pico amostrado a cada 50 ms',
      rankings: prompts.map((query, index) => ({ query, matches: imageVectors.map((vector, imageIndex) => ({ imageIndex, score: cosine(queries[index]!, vector) })).sort((a, b) => b.score - a.score) })),
    };
    await writeFile(path.join(settings.storage.cacheDirectory, 'embedding-benchmark.json'), JSON.stringify(report, null, 2));
    return report;
  } finally { clearInterval(timer); }
}
