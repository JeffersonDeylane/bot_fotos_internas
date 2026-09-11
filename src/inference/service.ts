import { Worker } from 'node:worker_threads';
import type { Settings } from '../config/settings.ts';
import { AppError } from '../core/errors.ts';

export function runInferenceTask(settings: Settings, task: { type: 'benchmark'; limit: number } | { type: 'text'; text: string }, signal: AbortSignal): Promise<unknown> {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL(`../workers/embedding.worker.${extension}`, import.meta.url), { workerData: { settings, task } });
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let result: unknown;
    let finished = false;
    const cancel = () => worker.postMessage('stop');
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    worker.on('message', message => {
      if (message.type === 'done') { result = message.result; finished = true; }
      if (message.type === 'failed') failure = new AppError(message.code, message.message);
    });
    worker.on('error', () => { failure = new AppError('INFERENCE_WORKER_FAILED', 'O worker de inferência falhou.'); });
    worker.on('exit', code => {
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0 || !finished) reject(new AppError('INFERENCE_WORKER_EXIT', 'Inferência interrompida.'));
      else resolve(result);
    });
  });
}
