import { parentPort, workerData } from 'node:worker_threads';
import type { Settings } from '../config/settings.ts';
import { runIndex } from '../indexing/engine.ts';
import { AppError } from '../core/errors.ts';

const controller = new AbortController();
parentPort?.on('message', message => { if (message === 'stop') controller.abort(); });
const input = workerData as { settings: Settings; retryFailed: boolean };
try {
  const result = await runIndex(input.settings, controller.signal, {
    retryFailed: input.retryFailed,
    onProgress: progress => parentPort?.postMessage({ type: 'progress', progress }),
  });
  parentPort?.postMessage({ type: 'done', result });
} catch (error) {
  parentPort?.postMessage({ type: 'failed', code: error instanceof AppError ? error.code : 'INDEX_FAILED', message: error instanceof AppError ? error.message : 'Falha ao executar o indexador. O catálogo poderá ser retomado.' });
} finally { parentPort?.close(); }
