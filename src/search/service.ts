import Database from 'better-sqlite3';
import path from 'node:path';
import type { Settings } from '../config/settings.ts';
import { runInferenceTask } from '../inference/service.ts';
import { authorizePhotoFile } from '../security/allowed-paths.ts';
import { VectorIndex } from './vector-index.ts';

export interface SearchResult { id: number; path: string; score: number; width: number | null; height: number | null; modifiedAt: number }

export class SearchService {
  constructor(private readonly settings: Settings) {}
  async search(text: string, limit = 30, signal = new AbortController().signal): Promise<SearchResult[]> {
    if (!text.trim() || text.length > 4096) throw new Error('INVALID_QUERY');
    if (!this.settings.inference?.enabled) throw new Error('INFERENCE_DISABLED');
    const output = await runInferenceTask(this.settings, { type: 'text', text }, signal) as { modelVersion: string; dimension: number; embedding: number[] };
    const index = await VectorIndex.open(this.settings.storage.indexDirectory, output.modelVersion, output.dimension);
    const found = index.search(new Float32Array(output.embedding), limit);
    const db = new Database(path.join(this.settings.storage.databaseDirectory, 'catalog.sqlite'), { readonly: true });
    try {
      if (!found.length) return [];
      const get = db.prepare(`SELECT id,path,width,height,modified_at FROM photos WHERE id=? AND deleted_at IS NULL AND status='INDEXED'`);
      const results: SearchResult[] = [];
      for (const match of found) {
        const row = get.get(match.id) as { id: number; path: string; width: number | null; height: number | null; modified_at: number } | undefined;
        if (!row) continue;
        try {
          results.push({ id: row.id, path: await authorizePhotoFile(row.path, this.settings.photos.directories), score: match.score,
            width: row.width, height: row.height, modifiedAt: row.modified_at });
        } catch { /* Arquivo removido entre busca e resolução. */ }
      }
      return results;
    } finally { db.close(); }
  }
}
