import { AppError } from './errors.ts';

export class Lifecycle {
  readonly controller = new AbortController();
  private readonly cleanups: Array<() => Promise<void>> = [];
  private stopping: Promise<void> | undefined;

  register(cleanup: () => Promise<void>): void {
    if (this.stopping) throw new AppError('SHUTDOWN_STARTED', 'Encerramento já iniciado.');
    this.cleanups.push(cleanup);
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.controller.abort();
      this.stopping = Promise.resolve().then(async () => {
        let failed = false;
        for (const cleanup of this.cleanups.reverse()) {
          try { await cleanup(); } catch { failed = true; }
        }
        if (failed) throw new AppError('SHUTDOWN_FAILED', 'Uma ou mais operações de encerramento falharam.');
      });
    }
    return this.stopping;
  }
}
