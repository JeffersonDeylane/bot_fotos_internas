export type PendingPage =
  | { kind: 'folders'; folders: string[]; offset: number }
  | { kind: 'photos'; files: string[]; offset: number; pageSize: number };

export interface UserSession {
  directory: string | undefined;
  root: string | undefined;
  lastFolders: string[];
  pending: PendingPage | undefined;
  filePage?: { directory: string; offset: number };
}

/** Estado temporário de navegação, separado das credenciais do WhatsApp. */
export class UserSessions {
  private readonly entries = new Map<string, { session: UserSession; accessedAt: number }>();

  constructor(private readonly ttlMs = 30 * 60_000, private readonly capacity = 100) {
    if (ttlMs <= 0 || !Number.isInteger(capacity) || capacity < 1) throw new Error('INVALID_SESSION_LIMIT');
  }

  get(user: string): UserSession {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.accessedAt >= this.ttlMs) this.entries.delete(key);
    }
    const existing = this.entries.get(user);
    if (existing) {
      this.entries.delete(user);
      this.entries.set(user, { session: existing.session, accessedAt: now });
      return existing.session;
    }
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const session: UserSession = { directory: undefined, root: undefined, lastFolders: [], pending: undefined };
    this.entries.set(user, { session, accessedAt: now });
    return session;
  }
}
