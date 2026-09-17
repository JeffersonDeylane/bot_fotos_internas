import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'node:path';
import type { Settings } from '../config/settings.ts';
import type { Logger } from '../logging/logger.ts';
import { CommandProcessor, isSendAllCommand } from '../commands/processor.ts';
import { NavigationService } from '../navigation/service.ts';
import { authorizePhotoFile } from '../security/allowed-paths.ts';
import { SendQueue } from './send-queue.ts';

export class WhatsAppService {
  private socket: WASocket | undefined;
  private stopped = false;
  private readonly bulkSending = new Set<string>();
  private readonly commands: CommandProcessor;
  private readonly queue = new SendQueue();
  constructor(private readonly settings: Settings, private readonly logger: Logger) { this.commands = new CommandProcessor(settings); }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.settings.storage.whatsAppSessionDirectory);
    const socket = makeWASocket({ auth: state, markOnlineOnConnect: false, syncFullHistory: false });
    this.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', update => {
      if (update.qr) qrcode.generate(update.qr, { small: true });
      if (update.connection === 'open') this.logger.log('info', 'whatsapp.connected');
      if (update.connection === 'close' && !this.stopped) {
        const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) this.logger.log('error', 'whatsapp.logged_out');
        else setTimeout(() => { void this.start(); }, 2_000).unref();
      }
    });
    socket.ev.on('messages.upsert', event => {
      if (event.type !== 'notify') return;
      for (const message of event.messages) {
        const jid = message.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
        const authorizedJid = message.key.remoteJidAlt ?? jid;
        if (!this.commands.authorized(authorizedJid)) continue;
        const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
        if (text && (text.startsWith('/') || isSendAllCommand(text))) void this.handle(jid, authorizedJid, text).catch(error => this.logger.error('whatsapp.command_failed', error));
      }
    });
  }

  private async handle(jid: string, authorizedJid: string, text: string): Promise<void> {
    if (this.stopped) return;
    if (isSendAllCommand(text)) {
      if (this.bulkSending.has(authorizedJid)) {
        await this.queue.enqueue(async () => { await this.socket?.sendMessage(jid, { text: 'Já existe um envio de arquivos em andamento.' }); });
        return;
      }
      this.bulkSending.add(authorizedJid);
      try {
        const reply = await this.commands.execute(authorizedJid, text);
        for (const value of reply.texts) await this.queue.enqueue(async () => { await this.socket?.sendMessage(jid, { text: value }); });
        if (reply.allFilesDirectory) await this.sendAllFiles(jid, reply.allFilesDirectory);
      } finally { this.bulkSending.delete(authorizedJid); }
      return;
    }
    const reply = await this.commands.execute(authorizedJid, text);
    for (const value of reply.texts) await this.queue.enqueue(async () => { await this.socket?.sendMessage(jid, { text: value }); });
    for (const file of reply.photos) await this.queue.enqueue(async () => {
      try {
        const safe = await authorizePhotoFile(file, this.settings.photos.directories);
        await this.socket?.sendMessage(jid, { image: { url: safe } });
      } catch { this.logger.log('warn', 'whatsapp.photo_skipped'); }
    });
    for (const file of reply.files ?? []) await this.queue.enqueue(async () => {
      try {
        const safe = await authorizePhotoFile(file, this.settings.photos.directories);
        await this.socket?.sendMessage(jid, { document: { url: safe }, fileName: path.basename(safe), mimetype: 'application/octet-stream' });
      } catch (error) {
        this.logger.error('whatsapp.file_failed', error);
        await this.socket?.sendMessage(jid, { text: 'Não foi possível enviar o arquivo. Ele pode ter sido removido ou estar indisponível.' });
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue.drain();
    this.socket?.end(undefined);
    this.socket = undefined;
  }

  private async sendAllFiles(jid: string, directory: string): Promise<void> {
    let sent = 0;
    let failed = 0;
    try {
      const navigation = new NavigationService(this.settings.photos.directories);
      for await (const file of navigation.files(directory)) {
        if (this.stopped) return;
        await this.queue.enqueue(async () => {
          if (this.stopped) return;
          try {
            const safe = await authorizePhotoFile(file, this.settings.photos.directories);
            if (!this.socket) throw new Error('WHATSAPP_DISCONNECTED');
            await this.socket.sendMessage(jid, { document: { url: safe }, fileName: path.basename(safe), mimetype: 'application/octet-stream' });
            sent++;
          } catch (error) {
            failed++;
            this.logger.error('whatsapp.file_failed', error);
          }
        });
      }
    } catch (error) {
      failed++;
      this.logger.error('whatsapp.directory_failed', error);
    }
    if (!this.stopped) await this.queue.enqueue(async () => {
      await this.socket?.sendMessage(jid, { text: `Envio finalizado. Arquivos enviados: ${sent}. Falhas: ${failed}.` });
    });
  }
}
