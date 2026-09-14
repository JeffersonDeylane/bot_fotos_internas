import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Settings } from '../src/config/settings.ts';
import { Catalog } from '../src/storage/catalog.ts';
import { doctor, systemStatus } from '../src/admin/diagnostics.ts';

test('status e doctor diagnosticam sem apagar ou reconstruir dados', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'doctor-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const photos = path.join(root, 'photos'); const database = path.join(root, 'database');
  const index = path.join(root, 'index'); const cache = path.join(root, 'cache'); const auth = path.join(root, 'auth');
  for (const dir of [photos, database, index, cache, auth]) await mkdir(dir);
  const settings: Settings = { photos: { directories: [photos] }, storage: { databaseDirectory: database, indexDirectory: index,
    cacheDirectory: cache, whatsAppSessionDirectory: auth }, processing: { maxWorkers: 1, batchSize: 1 }, whatsapp: { allowedNumbers: [] } };
  const catalog = new Catalog(path.join(database, 'catalog.sqlite'), [photos]); catalog.close();
  assert.equal(systemStatus(settings).total, 0);
  const report = await doctor(settings);
  assert.equal(report.checks.sqlite?.ok, true);
  assert.equal(report.checks.files?.ok, true);
  assert.equal(report.checks.vectorIndex?.ok, true);
  assert.equal(report.ok, true);
  assert.equal(systemStatus(settings).total, 0, 'doctor deve ser somente leitura');
  await writeFile(path.join(index, 'vector-index.json'), '{corrupt');
  const corrupt = await doctor(settings);
  assert.equal(corrupt.checks.vectorIndex?.ok, false);
  assert.equal(corrupt.ok, false);
});
