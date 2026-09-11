import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from './config/settings.ts';
import { AppError } from './core/errors.ts';
import { Application } from './core/application.ts';
import { Lifecycle } from './core/lifecycle.ts';
import { startIndexing } from './indexing/service.ts';
import { Logger, parseLogLevel } from './logging/logger.ts';
import { downloadModel } from './inference/download.ts';
import { runInferenceTask } from './inference/service.ts';
import { prepareFixtures } from './inference/fixtures.ts';

// Resolve tanto src/main.ts quanto dist/src/main.js sem depender do cwd.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, import.meta.url.endsWith('.ts') ? '..' : '../..');
let logger = new Logger();
const lifecycle = new Lifecycle();
let shutdown: Promise<void> | undefined;

function stop(reason: string, failed = false): Promise<void> {
  if (failed) process.exitCode = 1;
  if (!shutdown) {
    shutdown = (async () => {
      logger.log('info', 'shutdown.started', { reason });
      const deadline = setTimeout(() => {
        logger.log('error', 'shutdown.timeout');
        process.exit(1);
      }, 10_000);
      deadline.unref();
      try { await lifecycle.stop(); }
      catch (error) { process.exitCode = 1; logger.error('shutdown.failed', error); }
      finally { clearTimeout(deadline); }
    })();
  }
  return shutdown;
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });
process.once('uncaughtException', error => { logger.error('process.uncaught_exception', error); void stop('fatal', true); });
process.once('unhandledRejection', error => { logger.error('process.unhandled_rejection', error); void stop('fatal', true); });

try {
  const envPath = path.join(projectRoot, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  logger = new Logger(parseLogLevel(process.env.LOG_LEVEL));
  const command = process.argv[2] ?? 'start';
  const retryFailed = command === 'index' && process.argv[3] === '--retry-failed';
  const benchmarkLimit = process.argv[3] === '--limit' ? Number(process.argv[4]) : 8;
  const extra = command === 'benchmark' && process.argv[3] === '--limit' ? 5 : command === 'text' || retryFailed ? 4 : 3;
  if (!['start', 'index', 'model:prepare', 'fixtures:prepare', 'benchmark', 'text'].includes(command) || process.argv.length > extra ||
      (command === 'benchmark' && (!Number.isInteger(benchmarkLimit) || benchmarkLimit < 1 || benchmarkLimit > 128)) ||
      (command === 'text' && !process.argv[3]?.trim())) {
    throw new AppError('INVALID_COMMAND', 'Use start, index [--retry-failed], model:prepare, benchmark [--limit N] ou text "consulta".');
  }
  const settings = await loadSettings(projectRoot, process.env.PHOTO_CONFIG ?? 'config/settings.json');
  if (!lifecycle.controller.signal.aborted) {
    if (command === 'fixtures:prepare') {
      const download = prepareFixtures(settings.storage.cacheDirectory, lifecycle.controller.signal);
      lifecycle.register(async () => { await download; });
      await download;
      await stop('fixtures.prepared');
    } else if (command === 'model:prepare') {
      const download = downloadModel(settings.inference!.modelDirectory, logger, lifecycle.controller.signal);
      lifecycle.register(async () => { await download; });
      await download;
      await stop('model.prepared');
    } else if (command === 'benchmark' || command === 'text') {
      const inference = runInferenceTask(settings, command === 'benchmark' ? { type: 'benchmark', limit: benchmarkLimit } : { type: 'text', text: process.argv[3]! }, lifecycle.controller.signal);
      lifecycle.register(async () => { await inference; });
      const result = await inference;
      process.stdout.write(`${JSON.stringify(result)}\n`);
      await stop('inference.completed');
    } else if (command === 'index') {
      const indexing = startIndexing(settings, logger, lifecycle.controller.signal, retryFailed);
      lifecycle.register(async () => { await indexing; });
      await indexing;
      await stop('index.completed');
    } else {
      const app = new Application(settings, logger);
      lifecycle.register(() => app.stop());
      // Mantém o esqueleto ativo até SIGINT/SIGTERM, sem varreduras ou polling de fotos.
      const keepAlive = setInterval(() => {}, 60_000);
      lifecycle.register(async () => { clearInterval(keepAlive); });
      await app.start();
    }
  }
} catch (error) {
  logger.error('startup.failed', error);
  await stop('startup.failed', true);
}
