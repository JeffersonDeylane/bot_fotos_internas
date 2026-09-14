import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AppError } from '../core/errors.ts';
import { pathKey } from '../indexing/scanner.ts';
import { METADATA_VERSION } from '../indexing/types.ts';
import type { FileSnapshot, JobResult, PhotoJob } from '../indexing/types.ts';

export class Catalog {
  private readonly db: Database.Database;
  private readonly token = randomUUID();

  constructor(file: string, roots: readonly string[]) {
    this.db = new Database(file, { timeout: 3000 });
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('cache_size = -8192');
      this.db.pragma('temp_store = FILE');
      const schema = this.db.pragma('user_version', { simple: true });
      if (schema !== 0 && schema !== 1 && schema !== 2 && schema !== 3 && schema !== 4) throw new AppError('SCHEMA_VERSION', 'Versão do catálogo não suportada.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS writer_lock (
          id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, host TEXT NOT NULL, token TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS roots (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS scans (
          id TEXT PRIMARY KEY, root_id INTEGER NOT NULL REFERENCES roots(id), started_at TEXT NOT NULL,
          finished_at TEXT, status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','INCOMPLETE','INTERRUPTED'))
        );
        CREATE TABLE IF NOT EXISTS scan_errors (
          id INTEGER PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id), path TEXT NOT NULL,
          error TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS photos (
          id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL REFERENCES roots(id),
          path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL,
          modified_at REAL NOT NULL, created_at REAL, extension TEXT NOT NULL,
          fingerprint TEXT NOT NULL, width INTEGER, height INTEGER,
          status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','INDEXED','FAILED')),
          model_version TEXT, metadata_version TEXT NOT NULL, last_indexed_at TEXT,
          last_attempt_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
          seen_scan TEXT NOT NULL, deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS photos_queue ON photos(root_id,status,id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS photos_scan ON photos(root_id,seen_scan) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS photos_modified ON photos(modified_at);
        CREATE INDEX IF NOT EXISTS photos_created ON photos(created_at);
        CREATE INDEX IF NOT EXISTS scans_root ON scans(root_id,started_at);
        CREATE INDEX IF NOT EXISTS errors_scan ON scan_errors(scan_id);
      `);
      this.db.transaction(() => {
        const lock = this.db.prepare('SELECT * FROM writer_lock WHERE id=1').get() as { pid: number; host: string } | undefined;
        if (lock) {
          let alive = true;
          try { process.kill(lock.pid, 0); } catch (error) {
            alive = !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
          }
          if (lock.host !== hostname() || alive) throw new AppError('INDEX_ALREADY_RUNNING', 'Já existe um indexador ativo ou um bloqueio que não pode ser recuperado com segurança.');
        }
        this.db.prepare('INSERT OR REPLACE INTO writer_lock VALUES (1,?,?,?)').run(process.pid, hostname(), this.token);
        if (schema < 2) {
          this.db.exec(`ALTER TABLE photos ADD COLUMN embedding BLOB;
            ALTER TABLE photos ADD COLUMN embedding_dimension INTEGER;
            ALTER TABLE photos ADD COLUMN embedding_target TEXT;
            CREATE INDEX photos_model ON photos(model_version,embedding_dimension) WHERE deleted_at IS NULL;
            PRAGMA user_version = 2;`);
        }
        if (schema < 3) {
          this.db.exec(`ALTER TABLE photos ADD COLUMN vector_revision INTEGER NOT NULL DEFAULT 0;
            CREATE TABLE IF NOT EXISTS vector_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
            INSERT OR IGNORE INTO vector_state VALUES (1,0);
            UPDATE vector_state SET revision=revision+1;
            UPDATE photos SET vector_revision=(SELECT revision FROM vector_state);
            PRAGMA user_version = 3;`);
        }
        if (schema < 4) {
          const columns = new Set((this.db.pragma('table_info(photos)') as { name: string }[]).map(column => column.name));
          if (!columns.has('taken_at')) this.db.exec('ALTER TABLE photos ADD COLUMN taken_at REAL');
          if (!columns.has('taken_at_source')) this.db.exec("ALTER TABLE photos ADD COLUMN taken_at_source TEXT CHECK(taken_at_source IN ('EXIF','FILE_MODIFIED'))");
          this.db.exec(`CREATE INDEX IF NOT EXISTS photos_taken ON photos(taken_at) WHERE deleted_at IS NULL;
            PRAGMA user_version = 4;`);
        }
        this.db.prepare("UPDATE photos SET status='PENDING' WHERE status='PROCESSING' AND embedding IS NULL").run();
        this.db.prepare("UPDATE scans SET status='INTERRUPTED', finished_at=? WHERE status='RUNNING'").run(new Date().toISOString());
        this.db.prepare('UPDATE roots SET active=0').run();
        const add = this.db.prepare('INSERT INTO roots(path,path_key,active) VALUES (?,?,1) ON CONFLICT(path_key) DO UPDATE SET active=1,path=excluded.path');
        for (const root of roots) add.run(root, pathKey(root));
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }

  startScan(root: string): { id: string; rootId: number } {
    const row = this.db.prepare('SELECT id FROM roots WHERE path_key=? AND active=1').get(pathKey(root)) as { id: number };
    const id = randomUUID();
    this.db.prepare("INSERT INTO scans(id,root_id,started_at,status) VALUES (?,?,?,'RUNNING')").run(id, row.id, new Date().toISOString());
    return { id, rootId: row.id };
  }

  observe(rootId: number, scanId: string, files: readonly FileSnapshot[]): number {
    const existing = this.db.prepare('SELECT status,fingerprint,metadata_version,deleted_at FROM photos WHERE path_key=?');
    const upsert = this.db.prepare(`
      INSERT INTO photos(root_id,path,path_key,size,modified_at,created_at,extension,fingerprint,status,metadata_version,seen_scan)
      VALUES (@rootId,@path,@pathKey,@size,@modifiedAt,@createdAt,@extension,@fingerprint,'PENDING',@version,@scanId)
      ON CONFLICT(path_key) DO UPDATE SET root_id=excluded.root_id,path=excluded.path,size=excluded.size,
        modified_at=excluded.modified_at,created_at=excluded.created_at,extension=excluded.extension,
        fingerprint=excluded.fingerprint,metadata_version=excluded.metadata_version,seen_scan=excluded.seen_scan,
        deleted_at=NULL,status=CASE WHEN @changed THEN 'PENDING' ELSE photos.status END,
        width=CASE WHEN @changed THEN NULL ELSE photos.width END,
        height=CASE WHEN @changed THEN NULL ELSE photos.height END,
        taken_at=CASE WHEN @changed THEN NULL ELSE photos.taken_at END,
        taken_at_source=CASE WHEN @changed THEN NULL ELSE photos.taken_at_source END,
        model_version=CASE WHEN @changed THEN NULL ELSE photos.model_version END,
        embedding=CASE WHEN @changed THEN NULL ELSE photos.embedding END,
        embedding_dimension=CASE WHEN @changed THEN NULL ELSE photos.embedding_dimension END,
        vector_revision=CASE WHEN @changed THEN (SELECT revision+1 FROM vector_state WHERE id=1) ELSE photos.vector_revision END,
        error=CASE WHEN @changed THEN NULL ELSE photos.error END
    `);
    return this.db.transaction(() => {
      let unchanged = 0;
      let changedAny = false;
      for (const file of files) {
        const old = existing.get(file.pathKey) as { status: string; fingerprint: string; metadata_version: string; deleted_at: string | null } | undefined;
        const changed = !old || old.fingerprint !== file.fingerprint || old.metadata_version !== METADATA_VERSION || old.deleted_at !== null;
        changedAny ||= changed;
        if (!changed && old.status === 'INDEXED') unchanged++;
        upsert.run({ ...file, rootId, scanId, version: METADATA_VERSION, changed: Number(changed) });
      }
      if (changedAny) this.db.prepare('UPDATE vector_state SET revision=revision+1 WHERE id=1').run();
      return unchanged;
    })();
  }

  recordScanErrors(scanId: string, errors: readonly { path: string; error: string }[]): void {
    const insert = this.db.prepare('INSERT INTO scan_errors(scan_id,path,error,created_at) VALUES (?,?,?,?)');
    this.db.transaction(() => {
      for (const error of errors) insert.run(scanId, error.path, error.error, new Date().toISOString());
    })();
  }

  finishScan(rootId: number, scanId: string, status: 'COMPLETED' | 'INCOMPLETE' | 'INTERRUPTED'): number {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const removedRows = status === 'COMPLETED' ? this.db.prepare('SELECT id FROM photos WHERE root_id=? AND seen_scan<>? AND deleted_at IS NULL').all(rootId, scanId) as { id: number }[] : [];
      let removed = 0;
      if (removedRows.length) {
        this.db.prepare('UPDATE vector_state SET revision=revision+1 WHERE id=1').run();
        const revision = (this.db.prepare('SELECT revision FROM vector_state WHERE id=1').get() as { revision: number }).revision;
        removed = this.db.prepare('UPDATE photos SET deleted_at=?,vector_revision=? WHERE root_id=? AND seen_scan<>? AND deleted_at IS NULL').run(now, revision, rootId, scanId).changes;
      }
      this.db.prepare('UPDATE scans SET status=?,finished_at=? WHERE id=?').run(status, now, scanId);
      return removed;
    })();
  }

  retryFailed(): void {
    this.db.prepare("UPDATE photos SET status='PENDING' WHERE status='FAILED' AND deleted_at IS NULL AND root_id IN (SELECT id FROM roots WHERE active=1)").run();
  }

  reindexAll(): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE vector_state SET revision=revision+1 WHERE id=1').run();
      const revision = (this.db.prepare('SELECT revision FROM vector_state WHERE id=1').get() as { revision: number }).revision;
      this.db.prepare(`UPDATE photos SET status='PENDING',width=NULL,height=NULL,taken_at=NULL,taken_at_source=NULL,embedding=NULL,
        embedding_dimension=NULL,model_version=NULL,embedding_target=NULL,error=NULL,vector_revision=?
        WHERE deleted_at IS NULL AND root_id IN (SELECT id FROM roots WHERE active=1)`).run(revision);
    })();
  }

  requireEmbeddings(version: string, dimension: number): void {
    this.db.prepare(`UPDATE photos SET status='PENDING',embedding=NULL,embedding_dimension=NULL,
      model_version=NULL,embedding_target=@version,error=NULL
      WHERE deleted_at IS NULL AND root_id IN (SELECT id FROM roots WHERE active=1)
      AND (embedding_target IS NOT @version OR (status='INDEXED' AND
        (model_version IS NOT @version OR embedding_dimension IS NOT @dimension OR embedding IS NULL)))`).run({ version, dimension });
  }

  claim(limit: number, afterId: number): PhotoJob[] {
    return this.db.transaction(() => {
      const jobs = this.db.prepare(`SELECT p.id,p.path,p.fingerprint,r.path AS root_path FROM roots r
        JOIN photos p ON p.root_id=r.id WHERE r.active=1 AND p.deleted_at IS NULL
        AND p.status='PENDING' AND p.id>? ORDER BY p.id LIMIT ?`).all(afterId, limit) as PhotoJob[];
      const claim = this.db.prepare("UPDATE photos SET status='PROCESSING',attempts=attempts+1,last_attempt_at=? WHERE id=?");
      const now = new Date().toISOString();
      for (const job of jobs) claim.run(now, job.id);
      return jobs;
    })();
  }

  complete(results: readonly JobResult[]): void {
    const update = this.db.prepare(`UPDATE photos SET status=@status,width=@width,height=@height,taken_at=@takenAt,taken_at_source=@takenAtSource,error=@error,
      embedding=@embedding,embedding_dimension=@dimension,model_version=@modelVersion,vector_revision=@revision,
      last_indexed_at=CASE WHEN @status='INDEXED' THEN @now ELSE last_indexed_at END WHERE id=@id`);
    this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const result of results) {
        this.db.prepare('UPDATE vector_state SET revision=revision+1 WHERE id=1').run();
        const revision = (this.db.prepare('SELECT revision FROM vector_state WHERE id=1').get() as { revision: number }).revision;
        const vector = result.status === 'INDEXED' ? result.embedding : undefined;
        if (vector && (!result.modelVersion || vector.length === 0 || !vector.every(Number.isFinite))) throw new Error('INVALID_EMBEDDING');
        // Serialização explícita little-endian: formato estável, 4 bytes por dimensão.
        const bytes = vector ? Buffer.allocUnsafe(vector.length * 4) : null;
        if (bytes && vector) for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i]!, i * 4);
        // Com vetor, PROCESSING significa "SQLite pronto, aguardando commit atômico do HNSW".
        const storedStatus = vector ? 'PROCESSING' : result.status;
        update.run({ id: result.id, status: storedStatus, width: result.width, height: result.height,
          takenAt: result.takenAt ?? null, takenAtSource: result.takenAtSource ?? null, error: result.error,
          now, revision, embedding: bytes, dimension: vector?.length ?? null, modelVersion: vector ? result.modelVersion! : null });
      }
    })();
  }

  counts(): { pending: number; failed: number; indexed: number } {
    const rows = this.db.prepare(`SELECT p.status,COUNT(*) AS count FROM roots r JOIN photos p ON p.root_id=r.id
      WHERE r.active=1 AND p.deleted_at IS NULL GROUP BY p.status`).all() as { status: string; count: number }[];
    const counts = { pending: 0, failed: 0, indexed: 0 };
    for (const row of rows) {
      if (row.status === 'PENDING' || row.status === 'PROCESSING') counts.pending += row.count;
      if (row.status === 'FAILED') counts.failed += row.count;
      if (row.status === 'INDEXED') counts.indexed += row.count;
    }
    return counts;
  }

  close(): void {
    if (!this.db.open) return;
    try {
      this.db.transaction(() => {
        this.db.prepare("UPDATE photos SET status='PENDING' WHERE status='PROCESSING' AND embedding IS NULL").run();
        this.db.prepare('DELETE FROM writer_lock WHERE token=?').run(this.token);
      })();
    } finally { this.db.close(); }
  }
}
