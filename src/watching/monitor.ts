import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export interface MonitorOptions {
  debounceMs?: number;
  stabilityMs?: number;
  pollMs?: number;
  run: (signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}

interface FileState { size: number; modified: number; stableSince: number }

/** Agrega eventos e executa no máximo uma reconciliação completa por vez. */
export class DirectoryMonitor {
  private readonly controller = new AbortController();
  private readonly watchers: FSWatcher[] = [];
  private readonly dirty = new Map<string, FileState | undefined>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rerun = false;
  private stopped = false;
  private current: Promise<void> | undefined;
  private readonly debounceMs: number;
  private readonly stabilityMs: number;
  private readonly pollMs: number;

  constructor(private readonly roots: readonly string[], private readonly options: MonitorOptions) {
    this.debounceMs = options.debounceMs ?? 750;
    this.stabilityMs = options.stabilityMs ?? 1_500;
    this.pollMs = options.pollMs ?? 250;
  }

  async start(): Promise<void> {
    for (const root of this.roots) {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        const candidate = filename ? path.resolve(root, filename.toString()) : root;
        // Eventos de diretórios também importam: renomear/remover uma subárvore
        // precisa gerar tombstones para todas as fotos que existiam nela.
        this.notify(candidate);
      });
      watcher.on('error', error => this.options.onError?.(error));
      this.watchers.push(watcher);
    }
    // Watchers entram antes do scan para fechar a janela entre reconciliação e observação.
    // Eventos durante o scan ficam na fila e provocam uma segunda passagem curta.
    await this.reconcile();
  }

  /** Eventos repetidos para o mesmo caminho são colapsados. */
  notify(file: string): void {
    if (this.stopped) return;
    this.dirty.set(file, undefined);
    if (this.running) this.rerun = true;
    this.schedule(this.debounceMs);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, delay);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.running || !this.dirty.size) return;
    const now = Date.now();
    let allStable = true;
    // Sequencial para uma rajada grande não abrir centenas de operações de I/O.
    for (const [file, previous] of this.dirty) {
      if (this.stopped) return;
      try {
        const info = await stat(file, { bigint: true });
        if (!info.isFile()) continue;
        const modified = Number(info.mtimeNs);
        if (!previous || previous.size !== Number(info.size) || previous.modified !== modified) {
          this.dirty.set(file, { size: Number(info.size), modified, stableSince: now });
          allStable = false;
        } else if (now - previous.stableSince < this.stabilityMs) allStable = false;
      } catch (error) {
        // ENOENT é remoção/rename e já está estável para reconciliação.
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) this.options.onError?.(error);
      }
    }
    if (!allStable) { this.schedule(this.pollMs); return; }
    this.dirty.clear();
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (this.running || this.stopped) { this.rerun = !this.stopped; return; }
    this.running = true;
    this.current = (async () => {
      try { await this.options.run(this.controller.signal); }
      catch (error) { if (!this.controller.signal.aborted) this.options.onError?.(error); }
      finally {
        this.running = false;
        this.current = undefined;
        if (!this.stopped && (this.rerun || this.dirty.size)) {
          this.rerun = false;
          this.schedule(this.debounceMs);
        }
      }
    })();
    await this.current;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    this.controller.abort();
    await this.current;
  }
}
