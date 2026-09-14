import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Settings } from '../config/settings.ts';
import { NavigationService, type FolderListing } from '../navigation/service.ts';
import { authorizeDirectory, rejectUnsafeName } from '../security/authorized-paths.ts';
import { UserSessions } from '../sessions/user-sessions.ts';
import { SearchService } from '../search/service.ts';
import { parseDateSearch, searchPhotosByDate } from '../search/date-service.ts';

export interface CommandReply { texts: string[]; photos: string[] }
const EMPTY = (): CommandReply => ({ texts: [], photos: [] });

export class CommandProcessor {
  private readonly sessions = new UserSessions();
  private readonly navigation: NavigationService;
  private readonly search: SearchService;
  private readonly allowed: Set<string>;

  constructor(private readonly settings: Settings) {
    this.navigation = new NavigationService(settings.photos.directories);
    this.search = new SearchService(settings);
    this.allowed = new Set(settings.whatsapp.allowedNumbers.map(number => number.replace(/\D/g, '')));
  }

  authorized(jid: string): boolean { return this.allowed.has(jid.split('@')[0]!.split(':')[0]!.replace(/\D/g, '')); }

  async execute(jid: string, raw: string, signal?: AbortSignal): Promise<CommandReply> {
    if (!this.authorized(jid)) return EMPTY();
    const text = raw.trim();
    const lower = text.toLocaleLowerCase('pt-BR');
    const session = this.sessions.get(jid);
    try {
      if (lower === '/ajuda') return { texts: [HELP.replace('/mais', '/data [quantidade] DD/MM/AAAA, MM/AAAA ou AAAA\n/data [quantidade] DD/MM/AAAA a DD/MM/AAAA\n/mais')], photos: [] };
      if (lower === '/mostrar-pastas') return this.folderPage(session, this.navigation.rootsListing());
      if (lower === '/pastas') return this.folderPage(session, session.directory ? await this.navigation.list(session.directory) : this.navigation.rootsListing());
      if (lower === '/mais-pastas') return this.nextFolders(session);
      if (lower === '/voltar') return this.folderPage(session, await this.navigation.back(session));
      if (lower === '/onde') {
        const listing = session.directory ? await this.navigation.list(session.directory) : this.navigation.rootsListing();
        return { texts: [`📍 Local atual: ${session.directory ? this.navigation.display(session.directory) : 'Raiz'}\nSubpastas: ${listing.folders.length}\nFotos: ${listing.photos}`], photos: [] };
      }
      if (lower === '/status') return { texts: [await this.status(session.directory)], photos: [] };
      if (lower === '/mais') return this.nextPhotos(session);
      const showAmount = /^\/mostrar(?:\s+(\d+))?$/i.exec(text);
      if (showAmount) {
        if (!session.directory) throw new Error('NO_CURRENT_FOLDER');
        return this.photoPage(session, await this.navigation.photos(session.directory), `📷 ${this.navigation.display(session.directory)}`, parsePhotoAmount(showAmount[1]));
      }
      if (lower.startsWith('/abrir-')) return this.folderPage(session, await this.navigation.open(session, text.slice('/abrir-'.length)));
      if (lower.startsWith('/abrir ')) return this.folderPage(session, await this.navigation.open(session, text.slice('/abrir '.length).trim()));
      if (lower.startsWith('/mostrar-')) {
        const name = text.slice('/mostrar-'.length).trim(); rejectUnsafeName(name);
        const base = session.directory;
        if (!base) throw new Error('NO_CURRENT_FOLDER');
        let matches = path.basename(base).localeCompare(name, 'pt-BR', { sensitivity: 'base' }) === 0 ? [base] :
          (await this.navigation.list(base)).folders.filter(folder => path.basename(folder).localeCompare(name, 'pt-BR', { sensitivity: 'base' }) === 0);
        if (!matches.length) matches = await this.navigation.findFolders(name);
        if (matches.length > 1) return this.folderPage(session, { title: `Foram encontradas ${matches.length} pastas chamadas "${name}"`, folders: matches, photos: 0 });
        if (!matches.length) throw new Error('FOLDER_NOT_FOUND');
        const safe = await authorizeDirectory(matches[0]!, this.settings.photos.directories);
        return this.photoPage(session, await this.navigation.photos(safe), `📷 ${this.navigation.display(safe)}`);
      }
      if (lower.startsWith('/fotos ')) {
        const { query, amount } = parsePhotoSearch(text.slice('/fotos '.length).trim());
        const results = await this.search.search(query, Math.max(30, amount), signal);
        return this.photoPage(session, results.map(result => result.path), `🔎 ${results.length} resultados para "${query}"`, amount);
      }
      if (lower.startsWith('/data ')) {
        const query = parseDateSearch(text.slice('/data '.length));
        const results = await searchPhotosByDate(this.settings, query, Math.max(30, query.amount));
        return this.photoPage(session, results, `Fotos de ${query.label}`, query.amount);
      }
      return { texts: ['Comando desconhecido. Use /ajuda.'], photos: [] };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ERROR';
      const messages: Record<string, string> = {
        UNSAFE_PATH: 'Caminho recusado por segurança.', UNAUTHORIZED_DIRECTORY: 'Pasta fora das raízes autorizadas.',
        FOLDER_NOT_FOUND: 'Pasta não encontrada neste local.', AMBIGUOUS_FOLDER: 'Existem pastas com esse nome; use a listagem e /abrir <número>.',
        INVALID_FOLDER_SELECTION: 'Seleção inválida ou listagem expirada.', NO_CURRENT_FOLDER: 'Abra uma pasta primeiro.',
        INVALID_PHOTO_AMOUNT: 'Informe uma quantidade entre 1 e 30.',
        INVALID_DATE: 'Data inválida. Use DD/MM/AAAA, MM/AAAA, AAAA ou DD/MM/AAAA a DD/MM/AAAA.',
        INFERENCE_DISABLED: 'A pesquisa por IA está desativada.', VECTOR_INDEX_INCOMPATIBLE: 'Índice vetorial indisponível ou incompatível.',
      };
      return { texts: [messages[code] ?? 'Não foi possível executar o comando.'], photos: [] };
    }
  }

  private folderPage(session: ReturnType<UserSessions['get']>, listing: FolderListing): CommandReply {
    session.lastFolders = listing.folders;
    session.pending = { kind: 'folders', folders: listing.folders, offset: 20 };
    return { texts: [this.formatFolders(listing.title, listing.folders, 0)], photos: [] };
  }
  private nextFolders(session: ReturnType<UserSessions['get']>): CommandReply {
    if (session.pending?.kind !== 'folders') return { texts: ['Não há listagem de pastas para continuar.'], photos: [] };
    const { folders, offset } = session.pending; session.pending.offset += 20;
    return { texts: [this.formatFolders('Mais pastas', folders, offset)], photos: [] };
  }
  private formatFolders(title: string, folders: string[], offset: number): string {
    const page = folders.slice(offset, offset + 20);
    return `📁 ${title}\nPastas ${page.length ? offset + 1 : 0}-${offset + page.length} de ${folders.length}\n\n${page.map((folder, i) => `${offset + i + 1}. ${path.basename(folder)}`).join('\n')}${offset + page.length < folders.length ? '\n\nUse /mais-pastas.' : ''}`;
  }
  private photoPage(session: ReturnType<UserSessions['get']>, files: string[], title: string, pageSize = 5): CommandReply {
    session.pending = { kind: 'photos', files, offset: pageSize, pageSize };
    return { texts: [`${title}\n${files.length} fotos encontradas. Enviando 1-${Math.min(pageSize, files.length)}.${files.length > pageSize ? '\nUse /mais para continuar.' : ''}`], photos: files.slice(0, pageSize) };
  }
  private nextPhotos(session: ReturnType<UserSessions['get']>): CommandReply {
    if (session.pending?.kind !== 'photos') return { texts: ['Não há fotos para continuar.'], photos: [] };
    const { files, offset, pageSize } = session.pending; const page = files.slice(offset, offset + pageSize); session.pending.offset += pageSize;
    return { texts: [page.length ? `Enviando ${offset + 1}-${offset + page.length} de ${files.length}.` : 'Não há mais fotos.'], photos: page };
  }
  private async status(directory?: string): Promise<string> {
    const db = new Database(path.join(this.settings.storage.databaseDirectory, 'catalog.sqlite'), { readonly: true });
    try {
      const row = db.prepare(`SELECT COUNT(*) total, SUM(status='INDEXED') indexed, SUM(status='PENDING' OR status='PROCESSING') pending, SUM(status='FAILED') failed FROM photos WHERE deleted_at IS NULL`).get() as Record<string, number>;
      const folders = await this.navigation.directoryCount();
      const vectorReady = existsSync(path.join(this.settings.storage.indexDirectory, 'vector-index.json'));
      return `📊 Sistema\nFotos encontradas: ${row.total}\nIndexadas: ${row.indexed}\nPendentes: ${row.pending}\nFalhas: ${row.failed}\nPastas: ${folders}\nIndexador: monitorando\nModelo: ${this.settings.inference?.enabled ? 'ativo' : 'desativado'}\nÍndice vetorial: ${vectorReady ? 'pronto' : 'pendente'}\n📍 Pasta atual: ${directory ? this.navigation.display(directory) : 'Raiz'}`;
    } finally { db.close(); }
  }
}

const HELP = `🔎 PESQUISA\n/fotos [quantidade] <descrição>\n/mais\n\n📁 NAVEGAÇÃO\n/mostrar-pastas\n/abrir-<pasta>\n/abrir <número>\n/pastas\n/mostrar [quantidade]\n/mostrar-<pasta>\n/mais-pastas\n/voltar\n/onde\n/status\n/ajuda`;

export function parsePhotoAmount(value?: string): number {
  if (value === undefined) return 5;
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 1 || amount > 30) throw new Error('INVALID_PHOTO_AMOUNT');
  return amount;
}

export function parsePhotoSearch(value: string): { query: string; amount: number } {
  const match = /^(\d+)\s+(?:fotos?\s+(?:de\s+)?)?(.+)$/i.exec(value.trim());
  if (!match) return { query: value.trim(), amount: 5 };
  return { query: match[2]!.trim(), amount: parsePhotoAmount(match[1]) };
}
