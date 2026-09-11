import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { containsPath } from '../config/settings.ts';
import { photoExtension } from './formats.ts';
import type { FileSnapshot } from './types.ts';

export function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function snapshot(file: string): Promise<FileSnapshot> {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('NOT_REGULAR_FILE');
  const extension = photoExtension(file);
  if (!extension) throw new Error('UNSUPPORTED_EXTENSION');
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FILE_TOO_LARGE');
  return {
    path: path.normalize(file), pathKey: pathKey(file), size: Number(info.size),
    modifiedAt: Number(info.mtimeNs) / 1e6,
    createdAt: info.birthtimeNs > 0n ? Number(info.birthtimeNs) / 1e6 : null,
    fingerprint: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
    extension,
  };
}

export type ScanEvent = { kind: 'file'; file: FileSnapshot } | { kind: 'error'; path: string; error: string };

export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'SCAN_ACCESS_FAILED';
}

// DFS mantém somente um pequeno buffer por nível, nunca uma lista de todos os arquivos.
export async function* scanDirectory(root: string, signal: AbortSignal, directory = root, depth = 0): AsyncGenerator<ScanEvent> {
  if (signal.aborted) return;
  try {
    if (depth > 128) throw new Error('DEPTH_LIMIT');
    const info = await lstat(directory);
    const resolved = await realpath(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || !containsPath(root, resolved)) throw new Error('UNAUTHORIZED_DIRECTORY');
    const handle = await opendir(resolved, { bufferSize: 32 });
    for await (const entry of handle) {
      if (signal.aborted) return;
      if (entry.isSymbolicLink()) continue; // Inclusive junctions: não seguir para fora das raízes.
      const candidate = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        yield* scanDirectory(root, signal, candidate, depth + 1);
      } else if (entry.isFile() && photoExtension(candidate)) {
        try {
          const actual = await realpath(candidate);
          if (!containsPath(root, actual)) throw new Error('UNAUTHORIZED_FILE');
          yield { kind: 'file', file: await snapshot(actual) };
        } catch (error) {
          yield { kind: 'error', path: candidate, error: errorCode(error) };
        }
      }
    }
  } catch (error) {
    yield { kind: 'error', path: directory, error: errorCode(error) };
  }
}
