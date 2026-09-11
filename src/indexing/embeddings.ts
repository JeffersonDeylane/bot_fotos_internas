import type { LocalEmbeddingModel } from '../inference/model.ts';
import { authorizePhotoFile } from '../security/allowed-paths.ts';
import { snapshot } from './scanner.ts';
import { readPhotoMetadata } from './metadata.ts';
import type { JobResult, PhotoJob } from './types.ts';

export async function embedPhotoBatch(jobs: readonly PhotoJob[], model: LocalEmbeddingModel, signal: AbortSignal): Promise<JobResult[]> {
  const results: JobResult[] = [];
  const valid: { job: PhotoJob; result: JobResult; file: string }[] = [];
  for (const job of jobs) {
    const result = await readPhotoMetadata(job, signal);
    results.push(result);
    if (result.status === 'INDEXED' && !signal.aborted) {
      try {
        const file = await authorizePhotoFile(job.path, [job.root_path]);
        if ((await snapshot(file)).fingerprint !== job.fingerprint) {
          result.status = 'PENDING'; result.error = 'FILE_CHANGED_DURING_INDEX';
        } else valid.push({ job, result, file });
      } catch { result.status = 'FAILED'; result.error = 'PHOTO_ACCESS_DENIED'; }
    }
  }
  if (!valid.length) return results;
  let vectors: Float32Array[];
  try { vectors = await model.embedImages(valid.map(item => item.file)); }
  catch (error) {
    // Uma imagem ruim não deve fazer todas as imagens de um lote falharem.
    if (valid.length > 1 && !signal.aborted) {
      for (const item of valid) Object.assign(item.result, (await embedPhotoBatch([item.job], model, signal))[0]);
      return results;
    }
    for (const item of valid) {
      item.result.status = signal.aborted ? 'PENDING' : 'FAILED';
      item.result.error = `EMBEDDING_FAILED: ${error instanceof Error ? error.message.slice(0, 1024) : 'Erro de inferência'}`;
    }
    return results;
  }
  for (const [index, item] of valid.entries()) {
    try {
      const actual = await authorizePhotoFile(item.job.path, [item.job.root_path]);
      if (signal.aborted || actual !== item.file || (await snapshot(actual)).fingerprint !== item.job.fingerprint) {
        item.result.status = 'PENDING'; item.result.error = 'FILE_CHANGED_OR_INTERRUPTED';
      } else {
        item.result.embedding = vectors[index]!;
        item.result.modelVersion = model.version;
      }
    } catch { item.result.status = 'FAILED'; item.result.error = 'PHOTO_ACCESS_DENIED'; }
  }
  return results;
}
