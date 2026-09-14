import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DirectoryMonitor } from '../src/watching/monitor.ts';

async function eventually(predicate: () => boolean, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timeout esperando reconciliação do watcher');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('watcher reconcilia ao iniciar e agrega criação, alteração, rename, remoção e duplicatas', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-watch-'));
  let runs = 0;
  const monitor = new DirectoryMonitor([root], {
    debounceMs: 30, stabilityMs: 80, pollMs: 20,
    run: async () => { runs++; await new Promise(resolve => setTimeout(resolve, 15)); },
    onError: error => { throw error; },
  });
  await monitor.start();
  t.after(async () => { await monitor.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  assert.equal(runs, 1);

  const first = path.join(root, 'one.png');
  await writeFile(first, 'part');
  await writeFile(first, 'complete');
  await eventually(() => runs >= 2);
  await writeFile(first, 'changed');
  await eventually(() => runs >= 3);
  const renamed = path.join(root, 'renamed.png');
  await rename(first, renamed);
  await eventually(() => runs >= 4);
  await rm(renamed);
  await eventually(() => runs >= 5);

  const before = runs;
  for (let i = 0; i < 20; i++) monitor.notify(path.join(root, 'duplicate.png'));
  await eventually(() => runs > before);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(runs, before + 1);
});

test('rajada de 500 fotos mantém concorrência de reconciliação em um', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-watch-bulk-'));
  let runs = 0; let active = 0; let peak = 0;
  const monitor = new DirectoryMonitor([root], {
    debounceMs: 40, stabilityMs: 60, pollMs: 20,
    run: async () => { runs++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 25)); active--; },
    onError: error => { throw error; },
  });
  await monitor.start();
  t.after(async () => { await monitor.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await mkdir(path.join(root, 'bulk'));
  await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(path.join(root, 'bulk', `${i}.jpg`), 'photo')));
  await eventually(() => runs >= 2, 15_000);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(peak, 1);
  assert.ok(runs <= 3, `rajada gerou ${runs - 1} reconciliações`);
});
