import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lifecycle } from '../src/core/lifecycle.ts';

test('encerramento é idempotente, cancela tarefas e libera recursos em ordem inversa', async () => {
  const lifecycle = new Lifecycle();
  const order: number[] = [];
  lifecycle.register(async () => { order.push(1); });
  lifecycle.register(async () => { order.push(2); });
  await Promise.all([lifecycle.stop(), lifecycle.stop()]);
  assert.deepEqual(order, [2, 1]);
  assert.ok(lifecycle.controller.signal.aborted);
});

test('falha de uma limpeza não impede as outras', async () => {
  const lifecycle = new Lifecycle();
  let cleaned = false;
  lifecycle.register(async () => { cleaned = true; });
  lifecycle.register(async () => { throw new Error('fixture'); });
  await assert.rejects(lifecycle.stop(), { code: 'SHUTDOWN_FAILED' });
  assert.ok(cleaned);
});
