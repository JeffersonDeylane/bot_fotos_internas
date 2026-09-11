import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { loadSettings } from '../../src/config/settings.ts';
import { LocalEmbeddingModel } from '../../src/inference/model.ts';
import { cosine } from '../../src/inference/preprocessing.ts';
import { MODEL } from '../../src/inference/definition.ts';
import { runIndex } from '../../src/indexing/engine.ts';

test('inferência real offline: português, imagem/texto, lotes e SQLite incremental', { timeout: 180_000 }, async t => {
  // Teste explícito: requer npm run model:prepare e npm run test:fixtures previamente.
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const settings = await loadSettings(projectRoot, process.env.PHOTO_CONFIG ?? 'config/settings.json');
  assert.ok(settings.inference);
  const model = await LocalEmbeddingModel.create({ ...settings.inference, batchSize: 2 });
  const files = ['cats.png', 'dog.jpg', 'bus.jpg'].map(name => path.join(settings.storage.cacheDirectory, 'embedding-fixtures', name));
  try {
    const images: Float32Array[] = [];
    for (const file of files) images.push((await model.embedImages([file]))[0]!);
    const texts = await model.embedTexts(['dois gatos em um sofá', 'um cachorro branco', 'um ônibus na rua']);
    for (const [index, query] of texts.entries()) {
      assert.equal(query.length, 768);
      assert.ok(Math.abs(cosine(query, query) - 1) < 1e-5);
      const scores: number[] = images.map(image => cosine(query, image));
      assert.equal(scores.indexOf(Math.max(...scores)), index, JSON.stringify(scores));
    }
    const batch = await model.embedImages(files.slice(0, 2));
    for (let i = 0; i < 2; i++) assert.ok(cosine(batch[i]!, images[i]!) > 0.98);
    const tokens = await model.tokenize(['gato preto', 'pessoas pescando '.repeat(100)]);
    assert.equal(tokens.length, 128);
    assert.ok(tokens.slice(0, 64).includes(1n));
    assert.equal(tokens[63], 0n);
    assert.equal(tokens[127], 1n);
    await assert.rejects(model.embedTexts(['']), { code: 'INVALID_QUERY' });
  } finally { await model.close(); }

  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-real-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const photos = path.join(root, 'photos');
  const databaseDirectory = path.join(root, 'database');
  await mkdir(photos); await mkdir(databaseDirectory);
  for (const file of files) await copyFile(file, path.join(photos, path.basename(file)));
  const local = { ...settings, photos: { directories: [photos] }, storage: { ...settings.storage, databaseDirectory }, inference: { ...settings.inference, enabled: true } };
  assert.equal((await runIndex(local, new AbortController().signal)).processed, 3);
  const reader = new Database(path.join(databaseDirectory, 'catalog.sqlite'), { readonly: true });
  try {
    const rows = reader.prepare('SELECT model_version,embedding_dimension,length(embedding) AS bytes FROM photos').all() as { model_version: string; embedding_dimension: number; bytes: number }[];
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.model_version === MODEL.version && row.embedding_dimension === 768 && row.bytes === 3072));
  } finally { reader.close(); }
  const second = await runIndex(local, new AbortController().signal);
  assert.equal(second.processed, 0);
  assert.equal(second.alreadyIndexed, 3);
});
