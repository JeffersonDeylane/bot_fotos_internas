import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Logger } from '../logging/logger.ts';
import { MODEL } from './definition.ts';
import { verifyArtifact } from './artifacts.ts';

// Único módulo de inferência com acesso à rede; só é chamado por model:prepare.
export async function downloadModel(directory: string, logger: Logger, signal: AbortSignal): Promise<void> {
  for (const file of MODEL.files) {
    signal.throwIfAborted();
    try { await verifyArtifact(directory, file); continue; } catch { /* Baixar/reparar somente este arquivo. */ }
    const target = path.join(directory, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.part`;
    logger.log('info', 'model.download', { file: file.name, bytes: file.size });
    try {
      const response = await fetch(`https://huggingface.co/${MODEL.id}/resolve/${MODEL.revision}/${file.name}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
      });
      if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary), { signal });
      // Verificar antes de publicar; a pasta temporária mantém a mesma estrutura relativa.
      await verifyArtifact(directory, { ...file, name: `${file.name}.part` });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  logger.log('info', 'model.ready', { model: MODEL.version, dimension: MODEL.dimension });
}
