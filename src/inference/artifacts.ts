import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.ts';
import { MODEL } from './definition.ts';

export async function verifyArtifact(directory: string, file: (typeof MODEL.files)[number]): Promise<void> {
  try {
    const target = path.join(directory, file.name);
    if ((await stat(target)).size !== file.size) throw new Error('size');
    const hash = createHash(file.sha256 ? 'sha256' : 'sha1');
    if (file.gitSha) hash.update(`blob ${file.size}\0`);
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== (file.sha256 ?? file.gitSha)) throw new Error('hash');
  } catch (cause) {
    throw new AppError('MODEL_ARTIFACT_INVALID', `Arquivo do modelo ausente ou inválido: ${file.name}. Execute npm run model:prepare.`, { cause });
  }
}

export async function verifyModel(directory: string): Promise<void> {
  // Streaming: não ler os ~400 MB em um único Buffer.
  for (const file of MODEL.files) await verifyArtifact(directory, file);
}
