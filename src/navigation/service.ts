import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { photoExtension } from '../indexing/formats.ts';
import { authorizeDirectory, rejectUnsafeName } from '../security/authorized-paths.ts';
import type { UserSession } from '../sessions/user-sessions.ts';

export interface FolderListing { title: string; folders: string[]; photos: number }

export class NavigationService {
  private directoryCache: Promise<string[]> | undefined;
  constructor(private readonly roots: readonly string[]) {}

  rootsListing(): FolderListing {
    return { title: 'Pastas disponíveis', folders: [...this.roots], photos: 0 };
  }

  async list(directory: string): Promise<FolderListing> {
    const safe = await authorizeDirectory(directory, this.roots);
    const folders: string[] = [];
    let photos = 0;
    const handle = await opendir(safe);
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) folders.push(path.join(safe, entry.name));
      else if (entry.isFile() && photoExtension(entry.name)) photos++;
    }
    folders.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'pt-BR', { sensitivity: 'base' }));
    return { title: this.display(safe), folders, photos };
  }

  async open(session: UserSession, value: string): Promise<FolderListing> {
    rejectUnsafeName(value);
    if (/^\d+$/.test(value)) {
      const chosen = session.lastFolders[Number(value) - 1];
      if (!chosen) throw new Error('INVALID_FOLDER_SELECTION');
      return this.enter(session, chosen);
    }
    const base = session.directory;
    const candidates = base ? (await this.list(base)).folders : [...this.roots];
    const matches = candidates.filter(item => path.basename(item).localeCompare(value.trim(), 'pt-BR', { sensitivity: 'base' }) === 0);
    if (!matches.length) throw new Error('FOLDER_NOT_FOUND');
    if (matches.length > 1) throw new Error('AMBIGUOUS_FOLDER');
    return this.enter(session, matches[0]!);
  }

  private async enter(session: UserSession, candidate: string): Promise<FolderListing> {
    const safe = await authorizeDirectory(candidate, this.roots);
    session.root = this.roots.find(root => safe === root || safe.startsWith(`${root}${path.sep}`));
    session.directory = safe;
    const listing = await this.list(safe);
    session.lastFolders = listing.folders;
    return listing;
  }

  async back(session: UserSession): Promise<FolderListing> {
    if (!session.directory || !session.root) return this.rootsListing();
    if (session.directory === session.root) {
      session.directory = undefined; session.root = undefined; session.lastFolders = [...this.roots];
      return this.rootsListing();
    }
    return this.enter(session, path.dirname(session.directory));
  }

  async photos(directory: string): Promise<string[]> {
    const safe = await authorizeDirectory(directory, this.roots);
    const files: string[] = [];
    const handle = await opendir(safe);
    for await (const entry of handle) if (entry.isFile() && !entry.isSymbolicLink() && photoExtension(entry.name)) files.push(await realpath(path.join(safe, entry.name)));
    return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'pt-BR', { sensitivity: 'base' }));
  }

  async findFolders(name: string): Promise<string[]> {
    rejectUnsafeName(name);
    this.directoryCache ??= this.collectDirectories();
    return (await this.directoryCache).filter(folder => path.basename(folder).localeCompare(name.trim(), 'pt-BR', { sensitivity: 'base' }) === 0);
  }
  async directoryCount(): Promise<number> { this.directoryCache ??= this.collectDirectories(); return (await this.directoryCache).length; }

  private async collectDirectories(): Promise<string[]> {
    const found: string[] = [];
    const pending = [...this.roots];
    while (pending.length) {
      const current = pending.pop()!;
      found.push(current);
      const handle = await opendir(await authorizeDirectory(current, this.roots));
      for await (const entry of handle) if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
    }
    return found;
  }

  display(directory: string): string {
    const root = this.roots.find(item => directory === item || directory.startsWith(`${item}${path.sep}`));
    return root ? path.join(path.basename(root), path.relative(root, directory)).replaceAll('\\', '/') : 'Raiz';
  }
}
