import { Worker } from 'node:worker_threads';
import type { Settings } from '../config/settings.ts';
import type { Logger } from '../logging/logger.ts';
import type { IndexProgress } from './types.ts';
import { AppError } from '../core/errors.ts';

export function startIndexing(settings: Settings, logger: Logger, signal: AbortSignal, retryFailed: boolean): Promise<void> {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL(`../workers/indexing.worker.${extension}`, import.meta.url), { workerData: { settings, retryFailed } });
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let finished = false;
    const cancel = () => worker.postMessage('stop');
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    worker.on('message', (message: { type: string; progress: IndexProgress; code: string; message: string }) => {
      if (message.type === 'progress') {
        const p = message.progress;
        logger.log('info', 'index.progress', { ...p, message: `Encontradas: ${p.found} | Já indexadas: ${p.alreadyIndexed} | Pendentes: ${p.pending} | Processadas: ${p.processed} | Falharam: ${p.failed} | Erros de descoberta: ${p.scanErrors} | Velocidade: ${p.imagesPerSecond} imagens/s` });
      }
      if (message.type === 'done') finished = true;
      if (message.type === 'failed') failure = new AppError(message.code, message.message);
    });
    worker.on('error', () => { failure = new AppError('INDEX_WORKER_FAILED', 'O worker de indexação falhou.'); });
    worker.on('exit', code => {
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0 || !finished) reject(new AppError('INDEX_WORKER_EXIT', 'O worker encerrou antes de concluir a indexação.'));
      else resolve();
    });
  });
}
