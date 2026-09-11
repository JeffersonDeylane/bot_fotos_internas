import type { Settings } from '../config/settings.ts';
import type { Logger } from '../logging/logger.ts';

export class Application {
  private readonly settings: Settings;
  private readonly logger: Logger;

  constructor(settings: Settings, logger: Logger) {
    this.settings = settings;
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.logger.log('info', 'application.ready', {
      photoDirectoryCount: this.settings.photos.directories.length,
      maxWorkers: this.settings.processing.maxWorkers,
      batchSize: this.settings.processing.batchSize,
      aiEnabled: this.settings.inference?.enabled ?? false,
      whatsappEnabled: false,
    });
  }

  async stop(): Promise<void> {
    this.logger.log('info', 'application.stopped');
  }
}
