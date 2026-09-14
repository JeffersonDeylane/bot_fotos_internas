import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { normalizeEmbedding, rgbToNchw, preprocessImage } from '../src/inference/preprocessing.ts';
import { Catalog } from '../src/storage/catalog.ts';
import { snapshot } from '../src/indexing/scanner.ts';

test('preprocessing RGB/NCHW e normalização correspondem ao contrato do modelo', async () => {
  const values = rgbToNchw(new Uint8Array([255, 0, 0, 0, 255, 255]), 2, 1);
  assert.deepEqual([...values], [1, -1, -1, 1, -1, 1]);
  assert.deepEqual([...normalizeEmbedding([3, 4])].map(n => Number(n.toFixed(2))), [0.6, 0.8]);
  assert.throws(() => normalizeEmbedding([NaN]));
  assert.throws(() => normalizeEmbedding([0, 0]));
});

test('Sharp gera tensor 1x3x256x256 de imagem não quadrada', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-embedding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'red.png');
  await sharp({ create: { width: 100, height: 17, channels: 3, background: '#ff0000' } }).png().toFile(file);
  const tensor = await preprocessImage(file);
  assert.equal(tensor.length, 3 * 256 * 256);
  assert.ok(tensor.subarray(0, 256 * 256).every(value => value === 1));
  assert.ok(tensor.subarray(256 * 256).every(value => value === -1));
});

test('catálogo persiste vetor binário e invalida somente quando modelo ou arquivo muda', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-embedding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const photos = path.join(root, 'photos');
  await mkdir(photos);
  const file = path.join(photos, 'sample.png');
  await writeFile(file, 'fixture');
  const database = path.join(root, 'catalog.sqlite');
  const catalog = new Catalog(database, [photos]);
  try {
    const scan = catalog.startScan(photos);
    catalog.observe(scan.rootId, scan.id, [await snapshot(file)]);
    catalog.finishScan(scan.rootId, scan.id, 'COMPLETED');
    catalog.requireEmbeddings('model-a', 2);
    const job = catalog.claim(1, 0)[0]!;
    catalog.complete([{ id: job.id, status: 'INDEXED', width: 1, height: 1, error: null, modelVersion: 'model-a', embedding: new Float32Array([0.6, 0.8]) }]);
    catalog.requireEmbeddings('model-a', 2);
    assert.equal(catalog.counts().pending, 1, 'vetor aguarda commit no índice antes de virar INDEXED');
    const reader = new Database(database, { readonly: true });
    try {
      const row = reader.prepare('SELECT embedding,embedding_dimension,model_version FROM photos').get() as { embedding: Buffer; embedding_dimension: number; model_version: string };
      assert.equal(row.embedding.length, 8);
      assert.equal(row.embedding_dimension, 2);
      assert.equal(row.model_version, 'model-a');
      assert.ok(Math.abs(row.embedding.readFloatLE(0) - 0.6) < 1e-6);
    } finally { reader.close(); }
    catalog.requireEmbeddings('model-b', 2);
    assert.equal(catalog.counts().pending, 1);
    const retry = catalog.claim(1, 0)[0]!;
    catalog.complete([{ id: retry.id, status: 'FAILED', width: 1, height: 1, error: 'inference error' }]);
    catalog.requireEmbeddings('model-b', 2);
    assert.equal(catalog.counts().failed, 1); // Não criar retry infinito.
    catalog.requireEmbeddings('model-c', 2);
    assert.equal(catalog.counts().pending, 1);
  } finally { catalog.close(); }
});

test('migração do esquema 1 preserva os registros de metadados existentes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const photos = path.join(root, 'photos');
  await mkdir(photos);
  const file = path.join(photos, 'sample.png');
  await writeFile(file, 'fixture');
  const database = path.join(root, 'catalog.sqlite');
  const initial = new Catalog(database, [photos]);
  const scan = initial.startScan(photos);
  initial.observe(scan.rootId, scan.id, [await snapshot(file)]);
  const job = initial.claim(1, 0)[0]!;
  initial.complete([{ id: job.id, status: 'INDEXED', width: 10, height: 20, error: null }]);
  initial.close();
  const legacy = new Database(database);
  legacy.exec(`DROP INDEX photos_model; ALTER TABLE photos DROP COLUMN embedding;
    ALTER TABLE photos DROP COLUMN embedding_dimension; ALTER TABLE photos DROP COLUMN embedding_target;
    ALTER TABLE photos DROP COLUMN vector_revision; DROP TABLE vector_state;
    PRAGMA user_version=1;`);
  legacy.close();
  const migrated = new Catalog(database, [photos]);
  try { assert.equal(migrated.counts().indexed, 1); } finally { migrated.close(); }
  const reader = new Database(database, { readonly: true });
  try {
    assert.equal(reader.pragma('user_version', { simple: true }), 4);
    const row = reader.prepare('SELECT id,width,height,embedding FROM photos').get();
    assert.deepEqual(row, { id: job.id, width: 10, height: 20, embedding: null });
  } finally { reader.close(); }
});
