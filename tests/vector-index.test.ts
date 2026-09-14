import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Catalog } from '../src/storage/catalog.ts';
import { snapshot } from '../src/indexing/scanner.ts';
import { VectorIndex } from '../src/search/vector-index.ts';
import Database from 'better-sqlite3';

test('índice persiste, reabre e atualiza vetor incrementalmente mantendo ID SQLite', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vector-index-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const photos = path.join(root, 'photos'); const indexDir = path.join(root, 'index');
  await mkdir(photos); await mkdir(indexDir);
  const file = path.join(photos, 'a.jpg'); await writeFile(file, 'x');
  const database = path.join(root, 'catalog.sqlite');
  const catalog = new Catalog(database, [photos]);
  const scan = catalog.startScan(photos); catalog.observe(scan.rootId, scan.id, [await snapshot(file)]); catalog.finishScan(scan.rootId, scan.id, 'COMPLETED');
  catalog.requireEmbeddings('test-model', 2);
  const job = catalog.claim(1, 0)[0]!;
  catalog.complete([{ id: job.id, status: 'INDEXED', width: 1, height: 1, error: null, modelVersion: 'test-model', embedding: new Float32Array([1, 0]) }]);
  catalog.close();
  const before = new Database(database, { readonly: true });
  try { assert.equal((before.prepare('SELECT status FROM photos WHERE id=?').get(job.id) as { status: string }).status, 'PROCESSING'); } finally { before.close(); }
  const first = await VectorIndex.synchronize(database, indexDir, 'test-model', 2);
  assert.equal(first.search(new Float32Array([1, 0]), 1)[0]!.id, job.id);
  const after = new Database(database, { readonly: true });
  try { assert.equal((after.prepare('SELECT status FROM photos WHERE id=?').get(job.id) as { status: string }).status, 'INDEXED'); } finally { after.close(); }
  const reopened = await VectorIndex.open(indexDir, 'test-model', 2);
  assert.equal(reopened.size, 1);
  await writeFile(path.join(indexDir, 'vector-index.json'), '{corrupt');
  const recovered = await VectorIndex.synchronize(database, indexDir, 'test-model', 2);
  assert.equal(recovered.search(new Float32Array([1, 0]), 1)[0]!.id, job.id);

  const update = new Catalog(database, [photos]);
  update.requireEmbeddings('other', 2); const changed = update.claim(1, 0)[0]!;
  update.complete([{ id: changed.id, status: 'INDEXED', width: 1, height: 1, error: null, modelVersion: 'test-model', embedding: new Float32Array([0, 1]) }]);
  update.close();
  const second = await VectorIndex.synchronize(database, indexDir, 'test-model', 2);
  assert.ok(second.search(new Float32Array([0, 1]), 1)[0]!.score > 0.99);
});
