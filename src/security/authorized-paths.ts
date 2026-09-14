import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { containsPath } from '../config/settings.ts';

export function rejectUnsafeName(value: string): void {
  if (!value.trim() || value.includes('\0') || path.isAbsolute(value) || value === '..' || value === '.' || /(^|[\\/])\.\.([\\/]|$)/.test(value) || /^[a-z]:/i.test(value) || value.startsWith('\\\\')) {
    throw new Error('UNSAFE_PATH');
  }
}

export async function authorizeDirectory(candidate: string, roots: readonly string[]): Promise<string> {
  const resolved = await realpath(candidate);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || !roots.some(root => containsPath(root, resolved))) throw new Error('UNAUTHORIZED_DIRECTORY');
  return resolved;
}

