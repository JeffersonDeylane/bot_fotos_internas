import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const entry = fileURLToPath(new URL('../src/main.js', import.meta.url));

test('CLI index executa worker de outro cwd e conclui catálogo vazio', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['photos', 'database', 'index', 'cache', 'auth']) await mkdir(path.join(root, dir));
  const configPath = path.join(root, 'settings.json');
  await writeFile(configPath, JSON.stringify({
    photos: { directories: [path.join(root, 'photos')] },
    storage: {
      databaseDirectory: path.join(root, 'database'), indexDirectory: path.join(root, 'index'),
      cacheDirectory: path.join(root, 'cache'), whatsAppSessionDirectory: path.join(root, 'auth'),
    },
    processing: { maxWorkers: 1, batchSize: 1 }, whatsapp: { allowedNumbers: [] },
  }));
  const result = spawnSync(process.execPath, [entry, 'index'], {
    cwd: root, env: { ...process.env, PHOTO_CONFIG: configPath, LOG_LEVEL: 'info' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const logs = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { event: string });
  assert.equal(logs[0]?.event, 'index.progress');
  assert.ok(logs.some(log => log.event === 'shutdown.started'));
  assert.ok(!result.stdout.includes(root), 'Logs não devem expor caminhos privados');
});

test('CLI falha com código não zero e erro JSON para comando inválido', () => {
  const result = spawnSync(process.execPath, [entry, 'invalid'], {
    env: { ...process.env, LOG_LEVEL: 'info' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1);
  const log = JSON.parse(result.stderr.trim()) as { code: string };
  assert.equal(log.code, 'INVALID_COMMAND');
});
