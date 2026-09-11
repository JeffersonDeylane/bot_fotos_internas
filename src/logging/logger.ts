import { AppError } from '../core/errors.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return 'info';
  if (Object.hasOwn(priorities, value)) return value as LogLevel;
  throw new AppError('INVALID_LOG_LEVEL', 'LOG_LEVEL deve ser debug, info, warn ou error.');
}

export class Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel = 'info') { this.level = level; }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (priorities[level] < priorities[this.level]) return;
    const line = JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level, event });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  }

  error(event: string, error: unknown): void {
    // Não registrar stacks, conteúdo de arquivos, números ou caminhos privados.
    this.log('error', event, {
      code: error instanceof AppError ? error.code : 'UNEXPECTED_ERROR',
      message: error instanceof AppError ? error.message : 'Falha inesperada na operação.',
    });
  }
}
