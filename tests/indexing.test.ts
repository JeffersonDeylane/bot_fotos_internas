import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import type { Settings } from '../src/config/settings.ts';
import { runIndex } from '../src/indexing/engine.ts';
import { Catalog } from '../src/storage/catalog.ts';
import { scanDirectory } from '../src/indexing/scanner.ts';
import { readPhotoMetadata } from '../src/indexing/metadata.ts';
import { photoExtension } from '../src/indexing/formats.ts';

interface Row {
  id: number; path: string; width: number | null; height: number | null; status: string;
  attempts: number; last_indexed_at: string | null; model_version: string | null;
  deleted_at: string | null; error: string | null;
}

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'photo-index-'));
  const root = await realpath(temporary);
  t.after(async () => {
    // Todos os arquivos de teste ficam dentro da raiz temporária verificada.
    assert.ok(path.basename(root).startsWith('photo-index-'));
    assert.equal(path.dirname(root).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const photos = path.join(root, 'photos');
  const databaseDirectory = path.join(root, 'database');
  for (const dir of [photos, databaseDirectory]) await mkdir(dir);
  const settings: Settings = {
    photos: { directories: [photos] },
    storage: { databaseDirectory, indexDirectory: path.join(root, 'index'), cacheDirectory: path.join(root, 'cache'), whatsAppSessionDirectory: path.join(root, 'auth') },
    processing: { maxWorkers: 1, batchSize: 1 }, whatsapp: { allowedNumbers: [] },
  };
  const file = path.join(databaseDirectory, 'catalog.sqlite');
  const rows = (): Row[] => {
    const db = new Database(file, { readonly: true });
    try { return db.prepare('SELECT * FROM photos ORDER BY id').all() as Row[]; } finally { db.close(); }
  };
  const image = async (name: string, width = 12, height = 8) => {
    const target = path.join(photos, name);
    await sharp({ create: { width, height, channels: 3, background: '#aaff00' } }).png().toFile(target);
    return target;
  };
  const run = (signal = new AbortController().signal, retryFailed = false) => runIndex(settings, signal, { retryFailed });
  return { root, photos, settings, file, rows, image, run };
}

test('novo e existente: dimensões persistidas e segunda execução não relê imagem', async t => {
  const f = await fixture(t);
  await f.image('first.PNG');
  const first = await f.run();
  assert.equal(first.processed, 1);
  const row = f.rows()[0]!;
  assert.equal(row.status, 'INDEXED');
  assert.equal(row.width, 12);
  assert.equal(row.height, 8);
  assert.equal(row.model_version, null);
  assert.ok(row.last_indexed_at);
  const second = await f.run();
  assert.equal(second.alreadyIndexed, 1);
  assert.equal(second.processed, 0);
  assert.equal(f.rows()[0]!.attempts, 1);
  assert.equal(f.rows()[0]!.last_indexed_at, row.last_indexed_at);
});

test('arquivo alterado: tamanho/dimensões, mtime e rename são detectados', async t => {
  const f = await fixture(t);
  const file = await f.image('changed.png');
  await f.run();
  const id = f.rows()[0]!.id;
  await f.image('changed.png', 40, 30);
  assert.equal((await f.run()).processed, 1);
  assert.equal(f.rows()[0]!.id, id);
  assert.equal(f.rows()[0]!.width, 40);
  await utimes(file, new Date(), new Date(Date.now() + 10_000));
  assert.equal((await f.run()).processed, 1);
  await rename(file, path.join(f.photos, 'renamed.png'));
  const renamed = await f.run();
  assert.equal(renamed.processed, 1);
  assert.equal(renamed.removed, 1);
});

test('arquivo removido recebe tombstone e reaparecimento reativa o mesmo ID', async t => {
  const f = await fixture(t);
  const file = await f.image('removed.png');
  await f.run();
  const bytes = await readFile(file);
  const id = f.rows()[0]!.id;
  await rm(file);
  assert.equal((await f.run()).removed, 1);
  assert.ok(f.rows()[0]!.deleted_at);
  await writeFile(file, bytes);
  assert.equal((await f.run()).processed, 1);
  assert.equal(f.rows()[0]!.id, id);
  assert.equal(f.rows()[0]!.deleted_at, null);
});

test('imagem inválida não interrompe as demais; retry é explícito e persistente', async t => {
  const f = await fixture(t);
  await f.image('valid.png');
  await writeFile(path.join(f.photos, 'broken.jpg'), 'not an image');
  const first = await f.run();
  assert.equal(first.processed, 1);
  assert.equal(first.failed, 1);
  const bad = () => f.rows().find(row => row.status === 'FAILED')!;
  assert.ok(bad().error);
  assert.equal(bad().attempts, 1);
  await f.run();
  assert.equal(bad().attempts, 1);
  await f.run(undefined, true);
  assert.equal(bad().attempts, 2);
  await f.image('broken.jpg');
  assert.equal((await f.run()).failed, 0);
});

test('interrupção após descoberta preserva pendentes e retoma sem repetir concluídas', async t => {
  const f = await fixture(t);
  await f.image('indexed.png');
  await f.run();
  await f.image('pending.png');
  const controller = new AbortController();
  const interrupted = await runIndex(f.settings, controller.signal, {
    onProgress: p => { if (p.phase === 'processing') controller.abort(); },
  });
  assert.equal(interrupted.phase, 'interrupted');
  assert.equal(interrupted.pending, 1);
  assert.equal(f.rows().filter(row => row.status === 'PENDING').length, 1);
  const resumed = await f.run();
  assert.equal(resumed.processed, 1);
  assert.ok(f.rows().every(row => row.attempts === 1));
});

test('crash real com PROCESSING recupera lock abandonado e retoma fila', async t => {
  const f = await fixture(t);
  await f.image('crash-a.png');
  await f.image('crash-b.png');
  const controller = new AbortController();
  await runIndex(f.settings, controller.signal, { onProgress: p => { if (p.phase === 'processing') controller.abort(); } });
  const moduleUrl = new URL('../src/storage/catalog.js', import.meta.url).href;
  const metadataUrl = new URL('../src/indexing/metadata.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { Catalog } from ${JSON.stringify(moduleUrl)}; import { readPhotoMetadata } from ${JSON.stringify(metadataUrl)};
     const catalog = new Catalog(process.argv[1], [process.argv[2]]); const jobs = catalog.claim(2, 0);
     catalog.complete([await readPhotoMetadata(jobs[0], new AbortController().signal)]); process.exit(17);`, f.file, f.photos],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 17, child.stderr);
  assert.equal(f.rows()[0]!.status, 'INDEXED');
  assert.equal(f.rows()[1]!.status, 'PROCESSING');
  assert.equal((await f.run()).processed, 1);
  assert.equal(f.rows()[0]!.status, 'INDEXED');
  assert.equal(f.rows()[0]!.attempts, 1);
  assert.equal(f.rows()[1]!.attempts, 2);
});

test('scan incompleto ou interrompido nunca confirma remoções', async t => {
  const f = await fixture(t);
  await f.image('keep.png');
  await f.run();
  const catalog = new Catalog(f.file, f.settings.photos.directories);
  try {
    for (const status of ['INCOMPLETE', 'INTERRUPTED'] as const) {
      const scan = catalog.startScan(f.photos);
      assert.equal(catalog.finishScan(scan.rootId, scan.id, status), 0);
    }
  } finally { catalog.close(); }
  assert.equal(f.rows()[0]!.deleted_at, null);
});

test('scanner recursivo ignora junction externa e formatos não autorizados', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'outside');
  await mkdir(external);
  await writeFile(path.join(external, 'secret.png'), 'outside');
  await symlink(external, path.join(f.photos, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(path.join(f.photos, 'nested'));
  await f.image('nested/inside.png');
  await writeFile(path.join(f.photos, 'ignored.txt'), 'fixture');
  const files: string[] = [];
  for await (const event of scanDirectory(f.photos, new AbortController().signal)) if (event.kind === 'file') files.push(event.file.path);
  assert.equal(files.length, 1);
  assert.ok(files[0]!.endsWith('inside.png'));
  assert.equal(photoExtension('PHOTO.JPEG'), '.jpeg');
  assert.equal(photoExtension('PHOTO.webp'), '.webp');
  assert.equal(photoExtension('PHOTO.exe'), undefined);
});

test('mudança entre descoberta e leitura fica pendente; catálogo rejeita outro escritor', async t => {
  const f = await fixture(t);
  await f.image('racing.png');
  const controller = new AbortController();
  await runIndex(f.settings, controller.signal, { onProgress: p => { if (p.phase === 'processing') controller.abort(); } });
  const catalog = new Catalog(f.file, f.settings.photos.directories);
  try {
    assert.throws(() => new Catalog(f.file, f.settings.photos.directories), { code: 'INDEX_ALREADY_RUNNING' });
    const job = catalog.claim(1, 0)[0]!;
    await f.image('racing.png', 33, 22);
    const result = await readPhotoMetadata(job, new AbortController().signal);
    assert.equal(result.status, 'PENDING');
    assert.equal(result.error, 'FILE_CHANGED_DURING_INDEX');
    catalog.complete([result]);
  } finally { catalog.close(); }
  assert.equal((await f.run()).processed, 1);
});

test('270 arquivos atravessam lotes de descoberta e processamento sem perdas', async t => {
  const f = await fixture(t);
  const first = await f.image('000.png');
  const bytes = await readFile(first);
  for (let i = 1; i < 270; i++) await writeFile(path.join(f.photos, `${i}.png`), bytes);
  const initial = await f.run();
  assert.equal(initial.found, 270);
  assert.equal(initial.processed, 270);
  assert.equal(initial.pending, 0);
  assert.equal(f.rows().length, 270);
  assert.equal((await f.run()).alreadyIndexed, 270);
});

test('leitores nativos suportam JPEG, JPG, PNG e WebP reais', async t => {
  const f = await fixture(t);
  for (const extension of ['jpeg', 'jpg', 'png', 'webp']) {
    await sharp({ create: { width: 15, height: 11, channels: 3, background: '#ff0000' } })
      .toFile(path.join(f.photos, `photo.${extension}`));
  }
  assert.equal((await f.run()).processed, 4);
  assert.ok(f.rows().every(row => row.width === 15 && row.height === 11));
});

test('raiz indisponível durante execução preserva registros e registra erro', async t => {
  const f = await fixture(t);
  await f.image('keep.png');
  await f.run();
  await rename(f.photos, path.join(f.root, 'unavailable'));
  const result = await f.run();
  assert.equal(result.removed, 0);
  assert.equal(result.scanErrors, 1);
  assert.equal(f.rows()[0]!.deleted_at, null);
});
