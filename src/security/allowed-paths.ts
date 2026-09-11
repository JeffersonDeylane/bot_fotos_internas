import { realpath, stat } from 'node:fs/promises';
import { containsPath } from '../config/settings.ts';
import { AppError } from '../core/errors.ts';

export async function authorizePhotoFile(file: string, roots: readonly string[]): Promise<string> {
  try {
    const resolved = await realpath(file);
    if (!roots.some(root => containsPath(root, resolved)) || !(await stat(resolved)).isFile()) {
      throw new Error('outside authorized roots');
    }
    return resolved;
  } catch (cause) {
    throw new AppError('PHOTO_ACCESS_DENIED', 'Arquivo indisponível ou fora das pastas autorizadas.', { cause });
  }
}
