import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadSettings } from '../src/config/settings.ts';
import { authorizePhotoFile } from '../src/security/allowed-paths.ts';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-settings-'));
  for (const dir of ['photos', 'database', 'index', 'cache', 'auth']) await mkdir(path.join(root, dir));
  const config = {
    photos: { directories: ['./photos'] },
    storage: { databaseDirectory: './database', indexDirectory: './index', cacheDirectory: './cache', whatsAppSessionDirectory: './auth' },
    processing: { maxWorkers: 1, batchSize: 1 },
    whatsapp: { allowedNumbers: [] as string[] },
  };
  const save = async () => { await writeFile(path.join(root, 'settings.json'), JSON.stringify(config)); };
  return { root, config, save };
}

test('resolve caminhos relativos, congela configuração e mantém acesso restrito', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.save();
  const settings = await loadSettings(f.root, 'settings.json');
  assert.equal(settings.photos.directories[0], path.join(f.root, 'photos'));
  assert.ok(Object.isFrozen(settings.processing));
  assert.deepEqual(settings.whatsapp.allowedNumbers, []);
  const photo = path.join(f.root, 'photos', 'sample.txt');
  await writeFile(photo, 'fixture');
  assert.equal(await authorizePhotoFile(photo, settings.photos.directories), photo);
  await assert.rejects(authorizePhotoFile(path.join(f.root, 'settings.json'), settings.photos.directories), { code: 'PHOTO_ACCESS_DENIED' });
});

test('rejeita diretórios inexistentes sem criá-los automaticamente', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.photos.directories = ['./missing'];
  await f.save();
  await assert.rejects(loadSettings(f.root, 'settings.json'), { code: 'DIRECTORY_UNAVAILABLE' });
});

test('rejeita armazenamento dentro de fotos', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(path.join(f.root, 'photos', 'cache'));
  f.config.storage.cacheDirectory = './photos/cache';
  await f.save();
  await assert.rejects(loadSettings(f.root, 'settings.json'), { code: 'OVERLAPPING_DIRECTORIES' });
});

test('rejeita concorrência inválida e número fora do formato internacional', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.config.processing.maxWorkers = 0;
  await f.save();
  await assert.rejects(loadSettings(f.root, 'settings.json'), { code: 'INVALID_CONFIG' });
  f.config.processing.maxWorkers = 1;
  f.config.whatsapp.allowedNumbers = ['123'];
  await f.save();
  await assert.rejects(loadSettings(f.root, 'settings.json'), { code: 'INVALID_CONFIG' });
});

test('rejeita JSON inválido e arquivo de configuração ausente', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(loadSettings(f.root, 'missing.json'), { code: 'CONFIG_READ_FAILED' });
  await writeFile(path.join(f.root, 'settings.json'), '{');
  await assert.rejects(loadSettings(f.root, 'settings.json'), { code: 'CONFIG_READ_FAILED' });
});
