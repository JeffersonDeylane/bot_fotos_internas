export type PendingResults =
  | { kind: 'photos'; files: string[]; offset: number; pageSize: number }
  | { kind: 'folders'; folders: string[]; offset: number };

export interface UserSession {
  root: string | undefined;
  directory: string | undefined;
  pending?: PendingResults;
  lastFolders: string[];
}

export class UserSessions {
  private readonly values = new Map<string, UserSession>();
  get(user: string): UserSession {
    let session = this.values.get(user);
    if (!session) { session = { root: undefined, directory: undefined, lastFolders: [] }; this.values.set(user, session); }
    return session;
  }
}
