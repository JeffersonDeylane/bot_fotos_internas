import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Settings } from '../config/settings.ts';
import { Catalog } from '../storage/catalog.ts';
import { scanDirectory } from './scanner.ts';
import { readPhotoMetadata } from './metadata.ts';
import type { FileSnapshot, IndexProgress } from './types.ts';
import { LocalEmbeddingModel } from '../inference/model.ts';
import { embedPhotoBatch } from './embeddings.ts';

export interface IndexOptions {
  retryFailed?: boolean;
  onProgress?: (progress: IndexProgress) => void;
}

export async function runIndex(settings: Settings, signal: AbortSignal, options: IndexOptions = {}): Promise<IndexProgress> {
  const catalog = new Catalog(path.join(settings.storage.databaseDirectory, 'catalog.sqlite'), settings.photos.directories);
  const progress: IndexProgress = { phase: 'scanning', found: 0, alreadyIndexed: 0, pending: 0, processed: 0, failed: 0, scanErrors: 0, removed: 0, imagesPerSecond: 0 };
  let lastReport = 0;
  let processingStarted = 0;
  let model: LocalEmbeddingModel | undefined;
  function report(force = false): void {
    if (!force && Date.now() - lastReport < 1000) return;
    const counts = catalog.counts();
    progress.pending = counts.pending;
    progress.failed = counts.failed;
    progress.imagesPerSecond = processingStarted ? Math.round(progress.processed / Math.max(0.001, (performance.now() - processingStarted) / 1000) * 100) / 100 : 0;
    options.onProgress?.({ ...progress });
    lastReport = Date.now();
  }
  try {
    if (settings.inference?.enabled) {
      model = await LocalEmbeddingModel.create(settings.inference);
      catalog.requireEmbeddings(model.version, model.dimension);
    }
    report(true);
    for (const root of settings.photos.directories) {
      if (signal.aborted) break;
      const scan = catalog.startScan(root);
      let files: FileSnapshot[] = [];
      let errors: { path: string; error: string }[] = [];
      let incomplete = false;
      const flush = () => {
        if (files.length) { progress.alreadyIndexed += catalog.observe(scan.rootId, scan.id, files); files = []; }
        if (errors.length) { catalog.recordScanErrors(scan.id, errors); errors = []; }
      };
      for await (const event of scanDirectory(root, signal)) {
        if (event.kind === 'file') { files.push(event.file); progress.found++; }
        else { errors.push(event); progress.scanErrors++; incomplete = true; }
        if (files.length + errors.length >= 256) { flush(); await setImmediate(); }
        report();
      }
      flush();
      progress.removed += catalog.finishScan(scan.rootId, scan.id, signal.aborted ? 'INTERRUPTED' : incomplete ? 'INCOMPLETE' : 'COMPLETED');
    }
    if (model) catalog.requireEmbeddings(model.version, model.dimension);
    if (options.retryFailed && !signal.aborted) catalog.retryFailed();
    progress.phase = 'processing';
    processingStarted = performance.now();
    report(true);
    let afterId = 0;
    while (!signal.aborted) {
      // Janela transacional limitada; concorrência e lote de leitura são limites separados.
      const jobs = catalog.claim(128, afterId);
      if (!jobs.length) break;
      afterId = jobs[jobs.length - 1]!.id;
      const results = [];
      const concurrency = model ? settings.inference!.batchSize : Math.min(settings.processing.maxWorkers, settings.processing.batchSize, 4);
      let lastCommit = performance.now();
      for (let start = 0; start < jobs.length && !signal.aborted; start += concurrency) {
        const chunk = jobs.slice(start, start + concurrency);
        const completed = model ? await embedPhotoBatch(chunk, model, signal) : await Promise.all(chunk.map(job => readPhotoMetadata(job, signal)));
        results.push(...completed);
        for (const result of completed) if (result.status === 'INDEXED') progress.processed++;
        if (results.length >= 32 || performance.now() - lastCommit > 1000) {
          catalog.complete(results.splice(0));
          lastCommit = performance.now();
        }
        report();
        await setImmediate();
      }
      if (results.length) catalog.complete(results);
    }
    progress.phase = signal.aborted ? 'interrupted' : 'completed';
    report(true);
    return { ...progress };
  } finally { try { await model?.close(); } finally { catalog.close(); } }
}
