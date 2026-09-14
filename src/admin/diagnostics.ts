import Database from 'better-sqlite3';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Settings } from '../config/settings.ts';
import { MODEL } from '../inference/definition.ts';
import { verifyModel } from '../inference/artifacts.ts';
import { VectorIndex } from '../search/vector-index.ts';

export interface SystemStatus { total: number; indexed: number; pending: number; failed: number; removed: number; vectorIndexed: number; model: string }
export interface DoctorReport { ok: boolean; checks: Record<string, { ok: boolean; detail: string }> }

const databaseFile = (settings: Settings) => path.join(settings.storage.databaseDirectory, 'catalog.sqlite');

export function systemStatus(settings: Settings): SystemStatus {
  const db = new Database(databaseFile(settings), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS total_count,
      SUM(deleted_at IS NULL AND status='INDEXED') AS indexed_count,
      SUM(deleted_at IS NULL AND status IN ('PENDING','PROCESSING')) AS pending_count,
      SUM(deleted_at IS NULL AND status='FAILED') AS failed_count,
      SUM(deleted_at IS NOT NULL) AS removed_count FROM photos`).get() as Record<string, number | null>;
    const vectorIndexed = (db.prepare(`SELECT COUNT(*) count FROM photos WHERE deleted_at IS NULL AND status='INDEXED'
      AND model_version=? AND embedding_dimension=? AND embedding IS NOT NULL`).get(MODEL.version, MODEL.dimension) as { count: number }).count;
    return { total: row.total_count ?? 0, indexed: row.indexed_count ?? 0, pending: row.pending_count ?? 0, failed: row.failed_count ?? 0, removed: row.removed_count ?? 0,
      vectorIndexed, model: settings.inference?.enabled ? MODEL.version : 'disabled' };
  } finally { db.close(); }
}

export async function doctor(settings: Settings): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = {};
  const record = (name: string, ok: boolean, detail: string) => { checks[name] = { ok, detail }; };
  const directories = Object.entries({ database: settings.storage.databaseDirectory, index: settings.storage.indexDirectory,
    cache: settings.storage.cacheDirectory, auth: settings.storage.whatsAppSessionDirectory });
  settings.photos.directories.forEach((directory, index) => directories.push([`photos.${index}`, directory]));
  for (const [name, directory] of directories) {
    try { await access(directory); record(`directory.${name}`, true, 'accessible'); } catch { record(`directory.${name}`, false, 'unavailable'); }
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(databaseFile(settings), { readonly: true, fileMustExist: true, timeout: 3000 });
    const integrity = db.pragma('integrity_check', { simple: true }) as string;
    const foreign = db.pragma('foreign_key_check') as unknown[];
    record('sqlite', integrity === 'ok' && foreign.length === 0, integrity === 'ok' && !foreign.length ? 'ok' : `${integrity}; foreign_keys=${foreign.length}`);
    const invalid = (db.prepare(`SELECT COUNT(*) count FROM photos WHERE embedding IS NOT NULL AND
      (embedding_dimension IS NULL OR length(embedding)<>embedding_dimension*4 OR embedding_dimension<>?)`).get(MODEL.dimension) as { count: number }).count;
    record('embeddings', invalid === 0, `${invalid} invalid`);
    const files = db.prepare('SELECT path FROM photos WHERE deleted_at IS NULL') .iterate() as Iterable<{ path: string }>;
    let missing = 0; for (const row of files) try { await access(row.path); } catch { missing++; }
    record('files', missing === 0, `${missing} missing`);
    const expected = (db.prepare(`SELECT id FROM photos WHERE deleted_at IS NULL AND status='INDEXED' AND model_version=?
      AND embedding_dimension=? AND embedding IS NOT NULL ORDER BY id`).all(MODEL.version, MODEL.dimension) as { id: number }[]).map(row => row.id);
    try {
      const index = await VectorIndex.open(settings.storage.indexDirectory, MODEL.version, MODEL.dimension);
      const same = expected.length === index.ids.length && expected.every((id, i) => id === index.ids[i]);
      record('vectorIndex', same, same ? `${index.size} vectors` : `SQLite=${expected.length}; index=${index.size}`);
    } catch (error) {
      const absentAndEmpty = expected.length === 0 && !existsSync(path.join(settings.storage.indexDirectory, 'vector-index.json'));
      record('vectorIndex', absentAndEmpty, absentAndEmpty ? 'empty' : error instanceof Error ? error.message : 'unreadable');
    }
  } catch (error) { record('sqlite', false, error instanceof Error ? error.message : 'unreadable'); }
  finally { db?.close(); }
  if (settings.inference?.enabled) {
    try { await verifyModel(settings.inference.modelDirectory); record('model', true, MODEL.version); }
    catch { record('model', false, 'missing or corrupt'); }
  } else record('model', true, 'disabled');
  return { ok: Object.values(checks).every(check => check.ok), checks };
}
