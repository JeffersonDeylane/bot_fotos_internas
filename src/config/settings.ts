import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.ts';
import type { InferenceSettings } from '../inference/definition.ts';

export interface Settings {
  readonly inference?: InferenceSettings;
  readonly photos: { readonly directories: readonly string[] };
  readonly storage: {
    readonly databaseDirectory: string;
    readonly indexDirectory: string;
    readonly cacheDirectory: string;
    readonly whatsAppSessionDirectory: string;
  };
  readonly processing: { readonly maxWorkers: number; readonly batchSize: number };
  readonly whatsapp: { readonly allowedNumbers: readonly string[] };
}

function object(value: unknown, name: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_CONFIG', `${name} deve ser um objeto.`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) {
    throw new AppError('INVALID_CONFIG', `${name} contém campos desconhecidos.`);
  }
  return result;
}

function strings(value: unknown, name: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new AppError('INVALID_CONFIG', `${name} deve ser uma lista de textos válidos.`);
  }
  return value as string[];
}

function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError('INVALID_CONFIG', `${name} deve ser inteiro entre 1 e ${max}.`);
  }
  return value;
}

export function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function loadSettings(projectRoot: string, configFile: string): Promise<Settings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.resolve(projectRoot, configFile), 'utf8'));
  } catch (cause) {
    throw new AppError('CONFIG_READ_FAILED', 'Não foi possível ler a configuração. Crie config/settings.json a partir do exemplo e confira o JSON.', { cause });
  }
  const root = object(parsed, 'config', ['photos', 'storage', 'processing', 'whatsapp', 'inference']);
  const photos = object(root.photos, 'photos', ['directories']);
  const storageKeys = ['databaseDirectory', 'indexDirectory', 'cacheDirectory', 'whatsAppSessionDirectory'];
  const storage = object(root.storage, 'storage', storageKeys);
  const processing = object(root.processing, 'processing', ['maxWorkers', 'batchSize']);
  const whatsapp = object(root.whatsapp, 'whatsapp', ['allowedNumbers']);
  const inference = root.inference === undefined ? {} : object(root.inference, 'inference', ['enabled', 'modelDirectory', 'intraOpThreads', 'batchSize']);
  if (inference.enabled !== undefined && typeof inference.enabled !== 'boolean') throw new AppError('INVALID_CONFIG', 'inference.enabled deve ser booleano.');
  const modelPath = inference.modelDirectory ?? './models/siglip2-base-int8';
  if (typeof modelPath !== 'string' || !modelPath.trim()) throw new AppError('INVALID_CONFIG', 'inference.modelDirectory deve ser um caminho.');

  async function directory(value: unknown, name: string, writable: boolean): Promise<string> {
    if (typeof value !== 'string' || !value.trim()) throw new AppError('INVALID_CONFIG', `${name} deve ser um caminho não vazio.`);
    try {
      const resolved = await realpath(path.resolve(projectRoot, value));
      if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
      await access(resolved, writable ? constants.R_OK | constants.W_OK : constants.R_OK);
      return resolved;
    } catch (cause) {
      throw new AppError('DIRECTORY_UNAVAILABLE', `Diretório de ${name} inexistente ou sem acesso necessário.`, { cause });
    }
  }

  const photoDirectories: string[] = [];
  for (const [index, value] of strings(photos.directories, 'photos.directories').entries()) {
    photoDirectories.push(await directory(value, `photos.directories[${index}]`, false));
  }
  const resolvedStorage: string[] = [];
  for (const key of storageKeys) resolvedStorage.push(await directory(storage[key], `storage.${key}`, true));
  const resolvedModelDirectory = inference.enabled === true ? await directory(modelPath, 'inference.modelDirectory', false) : path.resolve(projectRoot, modelPath);
  const allDirectories = [...photoDirectories, ...resolvedStorage, ...(inference.enabled === true ? [resolvedModelDirectory] : [])];
  for (let i = 0; i < allDirectories.length; i++) {
    for (let j = i + 1; j < allDirectories.length; j++) {
      if (containsPath(allDirectories[i]!, allDirectories[j]!) || containsPath(allDirectories[j]!, allDirectories[i]!)) {
        throw new AppError('OVERLAPPING_DIRECTORIES', 'Diretórios configurados não podem coincidir ou conter uns aos outros.');
      }
    }
  }
  const allowedNumbers = strings(whatsapp.allowedNumbers, 'whatsapp.allowedNumbers', true);
  if (allowedNumbers.some(number => !/^\+[1-9]\d{7,14}$/.test(number))) {
    throw new AppError('INVALID_CONFIG', 'whatsapp.allowedNumbers deve usar formato internacional: + seguido de 8 a 15 dígitos.');
  }
  return Object.freeze({
    inference: Object.freeze({ enabled: inference.enabled === true, modelDirectory: resolvedModelDirectory,
      intraOpThreads: integer(inference.intraOpThreads ?? 2, 'inference.intraOpThreads', 4),
      batchSize: integer(inference.batchSize ?? 1, 'inference.batchSize', 4) }),
    photos: Object.freeze({ directories: Object.freeze(photoDirectories) }),
    storage: Object.freeze({ databaseDirectory: resolvedStorage[0]!, indexDirectory: resolvedStorage[1]!, cacheDirectory: resolvedStorage[2]!, whatsAppSessionDirectory: resolvedStorage[3]! }),
    processing: Object.freeze({ maxWorkers: integer(processing.maxWorkers, 'processing.maxWorkers', 16), batchSize: integer(processing.batchSize, 'processing.batchSize', 32) }),
    whatsapp: Object.freeze({ allowedNumbers: Object.freeze([...new Set(allowedNumbers)]) }),
  });
}
