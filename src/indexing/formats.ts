import path from 'node:path';

// Adicionar extensões somente depois de validar o leitor de metadados correspondente.
export const PHOTO_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function photoExtension(file: string): string | undefined {
  const extension = path.extname(file).toLowerCase();
  return PHOTO_EXTENSIONS.has(extension) ? extension : undefined;
}
