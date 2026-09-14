import sharp from 'sharp';
import { authorizePhotoFile } from '../security/allowed-paths.ts';
import { snapshot } from './scanner.ts';
import type { JobResult, PhotoJob } from './types.ts';
import { readExifDateTimeOriginal } from './exif-date.ts';

sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });

export async function readPhotoMetadata(job: PhotoJob, signal: AbortSignal): Promise<JobResult> {
  const result: JobResult = { id: job.id, status: 'PENDING', width: null, height: null, error: null };
  if (signal.aborted) return result;
  try {
    const file = await authorizePhotoFile(job.path, [job.root_path]);
    const before = await snapshot(file);
    if (before.fingerprint !== job.fingerprint) return { ...result, error: 'FILE_CHANGED_DURING_INDEX' };
    const metadata = await sharp(file, { limitInputPixels: 100_000_000, sequentialRead: true }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('DIMENSIONS_UNAVAILABLE');
    const actual = await authorizePhotoFile(job.path, [job.root_path]);
    const after = await snapshot(actual);
    if (signal.aborted || before.fingerprint !== after.fingerprint || actual !== file) {
      return { ...result, error: signal.aborted ? null : 'FILE_CHANGED_DURING_INDEX' };
    }
    // Dimensões do arquivo, antes de aplicar orientação EXIF.
    const exifDate = readExifDateTimeOriginal(metadata.exif);
    return { ...result, status: 'INDEXED', width: metadata.width, height: metadata.height,
      takenAt: exifDate ?? before.modifiedAt, takenAtSource: exifDate === null ? 'FILE_MODIFIED' : 'EXIF' };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'METADATA_READ_FAILED';
    // O diagnóstico fica apenas no catálogo privado, nunca nos logs públicos.
    const detail = error instanceof Error ? error.message.slice(0, 1024) : 'Erro sem mensagem';
    return { ...result, status: 'FAILED', error: `${code}: ${detail}` };
  }
}
