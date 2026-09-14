import type { Settings } from '../config/settings.ts';
import type { Logger } from '../logging/logger.ts';
import { startIndexing } from '../indexing/service.ts';
import { DirectoryMonitor } from '../watching/monitor.ts';
import { WhatsAppService } from '../whatsapp/service.ts';

export class Application {
  private readonly settings: Settings;
  private readonly logger: Logger;
  private monitor?: DirectoryMonitor;
  private whatsapp?: WhatsAppService;

  constructor(settings: Settings, logger: Logger) {
    this.settings = settings;
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.monitor = new DirectoryMonitor(this.settings.photos.directories, {
      run: signal => startIndexing(this.settings, this.logger, signal, false),
      onError: error => this.logger.error('watcher.failed', error),
    });
    await this.monitor.start();
    if (this.settings.whatsapp.allowedNumbers.length) {
      this.whatsapp = new WhatsAppService(this.settings, this.logger);
      await this.whatsapp.start();
    }
    this.logger.log('info', 'application.ready', {
      photoDirectoryCount: this.settings.photos.directories.length,
      maxWorkers: this.settings.processing.maxWorkers,
      batchSize: this.settings.processing.batchSize,
      aiEnabled: this.settings.inference?.enabled ?? false,
      whatsappEnabled: Boolean(this.whatsapp),
      watcherEnabled: true,
    });
  }

  async stop(): Promise<void> {
    await this.whatsapp?.stop();
    await this.monitor?.stop();
    this.logger.log('info', 'application.stopped');
  }
}
