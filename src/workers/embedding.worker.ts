import { parentPort, workerData } from 'node:worker_threads';
import type { Settings } from '../config/settings.ts';
import { LocalEmbeddingModel } from '../inference/model.ts';
import { benchmark } from '../inference/benchmark.ts';
import { AppError } from '../core/errors.ts';

const { settings, task } = workerData as { settings: Settings; task: { type: 'benchmark'; limit: number } | { type: 'text'; text: string } };
const controller = new AbortController();
parentPort?.on('message', message => { if (message === 'stop') controller.abort(); });
let model: LocalEmbeddingModel | undefined;
try {
  if (!settings.inference) throw new Error('INFERENCE_NOT_CONFIGURED');
  model = await LocalEmbeddingModel.create({ ...settings.inference, batchSize: task.type === 'benchmark' ? 2 : settings.inference.batchSize });
  const result = task.type === 'benchmark' ? await benchmark(settings, model, controller.signal, task.limit) : {
    modelVersion: model.version, dimension: model.dimension, embedding: Array.from((await model.embedTexts([task.text]))[0]!),
  };
  parentPort?.postMessage({ type: 'done', result });
} catch (error) {
  parentPort?.postMessage({ type: 'failed', code: error instanceof AppError ? error.code : 'INFERENCE_FAILED',
    message: error instanceof AppError ? error.message : 'Falha na inferência. Confira modelos locais e imagens autorizadas.' });
} finally { try { await model?.close(); } finally { parentPort?.close(); } }
