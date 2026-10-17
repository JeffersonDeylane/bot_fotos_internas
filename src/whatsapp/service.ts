import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import type { Settings } from '../config/settings.ts';
import type { Logger } from '../logging/logger.ts';
import { CommandProcessor } from '../commands/processor.ts';
import { authorizePhotoFile } from '../security/allowed-paths.ts';
import { SendQueue } from './send-queue.ts';
import path from 'node:path';
import { rename } from 'node:fs/promises';
import { TrainingSender, loadTrainingConfig, normalizeTrainingGroup } from './training.ts';
import { AppError } from '../core/errors.ts';

export class WhatsAppService {
  private socket: WASocket | undefined;
  private stopped = false;
  private readonly commands: CommandProcessor;
  private readonly queue = new SendQueue();
  private readonly training: TrainingSender;
  private trainingTimer: ReturnType<typeof setInterval> | undefined;
  private recoveringSession = false;
  constructor(private readonly settings: Settings, private readonly logger: Logger) {
    this.commands = new CommandProcessor(settings);
    this.training = new TrainingSender(path.join(settings.storage.databaseDirectory, 'treinos-enviados.json'), async (group, name, values) => {
      const jid = await this.trainingGroup(group);
      await this.queue.enqueue(async () => {
        const socket = this.socket;
        if (!socket || this.stopped) throw new AppError('TRAINING_DISCONNECTED', 'WhatsApp desconectado. Aguarde a conexão e tente novamente.');
        try {
          await socket.sendMessage(jid, { poll: { name, values, selectableCount: values.length } });
        } catch (cause) {
          const status = (cause as { output?: { statusCode?: number } })?.output?.statusCode;
          throw new AppError('TRAINING_POLL_FAILED', `O WhatsApp falhou ao enviar a enquete${status ? ` (código ${status})` : ''}. Confira se o bot pode enviar mensagens no grupo e se a conexão está ativa.`, { cause });
        }
      });
    });
  }

  private async trainingGroup(name: string): Promise<string> {
    if (!this.socket) throw new AppError('TRAINING_DISCONNECTED', 'WhatsApp desconectado. Aguarde a conexão e tente novamente.');
    let participating;
    try {
      participating = await this.socket.groupFetchAllParticipating();
    } catch (cause) {
      throw new AppError('TRAINING_GROUP_FETCH', 'Não foi possível consultar os grupos no WhatsApp. Aguarde a conexão estabilizar e tente novamente.', { cause });
    }
    const groups = Object.values(participating).filter(group => normalizeTrainingGroup(group.subject) === normalizeTrainingGroup(name));
    if (!groups.length) throw new AppError('TRAINING_GROUP_MISSING', 'O grupo configurado em config/treinos.json não foi encontrado. Confira o nome do grupo e se o número do bot participa dele.');
    if (groups.length > 1) throw new AppError('TRAINING_GROUP_AMBIGUOUS', 'Existe mais de um grupo com o nome configurado. Use um nome único para o grupo de treinos.');
    return groups[0]!.id;
  }

  private scheduleTraining(): void {
    if (this.trainingTimer) clearInterval(this.trainingTimer);
    const tick = () => { void this.training.run(true).catch(error => this.logger.error('whatsapp.training_failed', error)); };
    tick();
    this.trainingTimer = setInterval(tick, 30_000);
    this.trainingTimer.unref();
  }

  private async handleTraining(jid: string, group: boolean): Promise<void> {
    try {
      if (group && jid !== await this.trainingGroup((await loadTrainingConfig()).grupo)) return;
      await this.training.run(false);
    } catch (error) {
      this.logger.error('whatsapp.training_command_failed', error);
      const detail = error instanceof AppError ? error.message : 'Falha inesperada ao enviar os treinos. Confira a conexão do WhatsApp.';
      await this.queue.enqueue(async () => { await this.socket?.sendMessage(jid, { text: detail }); });
    }
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    const { state, saveCreds } = await useMultiFileAuthState(this.settings.storage.whatsAppSessionDirectory);
    this.logger.log('info', 'whatsapp.connecting', {
      message: state.creds.me
        ? 'Reconectando com a sessão salva; o QR Code só aparece quando é necessário vincular novamente.'
        : 'Aguardando o QR Code para vincular o WhatsApp.',
    });
    const socket = makeWASocket({ auth: state, markOnlineOnConnect: false, syncFullHistory: false });
    this.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', update => {
      if (update.qr) {
        this.logger.log('info', 'whatsapp.qr_ready', { message: 'Escaneie o QR Code em WhatsApp > Aparelhos conectados > Conectar aparelho.' });
        qrcode.generate(update.qr, { small: true });
      }
      if (update.connection === 'open') {
        this.logger.log('info', 'whatsapp.connected', { message: 'WhatsApp conectado. O comando /treinos está disponível.' });
        this.scheduleTraining();
      }
      if (update.connection === 'close' && this.trainingTimer) {
        clearInterval(this.trainingTimer);
        this.trainingTimer = undefined;
      }
      if (update.connection === 'close' && !this.stopped) {
        const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          this.logger.log('warn', 'whatsapp.logged_out', { message: 'Sessão recusada pelo WhatsApp. Guardando backup para solicitar um novo QR Code.' });
          if (!this.recoveringSession) {
            this.recoveringSession = true;
            void (async () => {
              // O evento de fechamento já encerrou esta conexão. Preserve a sessão
              // recusada e deixe o Baileys criar uma nova pasta de autenticação.
              await saveCreds();
              if (this.stopped) return;
              const directory = this.settings.storage.whatsAppSessionDirectory;
              await rename(directory, `${directory}.invalid-${Date.now()}`);
              this.logger.log('info', 'whatsapp.session_reset', { message: 'Sessão anterior preservada em backup. Gerando novo vínculo.' });
              await this.start();
            })().catch(error => this.logger.error('whatsapp.session_reset_failed', error))
              .finally(() => { this.recoveringSession = false; });
          }
        }
        else {
          this.logger.log('warn', 'whatsapp.disconnected', { status: status ?? 'unknown', message: 'Conexão interrompida; tentando reconectar em 2 segundos.' });
          setTimeout(() => { void this.start().catch(error => this.logger.error('whatsapp.reconnect_failed', error)); }, 2_000).unref();
        }
      }
    });
    socket.ev.on('messages.upsert', event => {
      if (event.type !== 'notify') return;
      for (const message of event.messages) {
        const jid = message.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
        if (text?.trim().toLowerCase() === '/treinos') {
          const group = jid.endsWith('@g.us');
          if (group || this.commands.authorized(message.key.remoteJidAlt ?? jid)) {
            void this.handleTraining(jid, group).catch(error => this.logger.error('whatsapp.training_command_failed', error));
          }
          continue;
        }
        if (jid.endsWith('@g.us')) continue;
        const authorizedJid = message.key.remoteJidAlt ?? jid;
        if (!this.commands.authorized(authorizedJid)) continue;
        if (text?.startsWith('/')) void this.handle(jid, authorizedJid, text).catch(error => this.logger.error('whatsapp.command_failed', error));
      }
    });
  }

  private async handle(jid: string, authorizedJid: string, text: string): Promise<void> {
    const reply = await this.commands.execute(authorizedJid, text);
    for (const value of reply.texts) await this.queue.enqueue(async () => { await this.socket?.sendMessage(jid, { text: value }); });
    for (const file of reply.photos) await this.queue.enqueue(async () => {
      try {
        const safe = await authorizePhotoFile(file, this.settings.photos.directories);
        await this.socket?.sendMessage(jid, { image: { url: safe } });
      } catch { this.logger.log('warn', 'whatsapp.photo_skipped'); }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.trainingTimer) clearInterval(this.trainingTimer);
    await this.queue.drain();
    this.socket?.end(undefined);
    this.socket = undefined;
  }
}
