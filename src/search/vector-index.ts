import Database from 'better-sqlite3';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Index, MetricKind, ScalarKind } from 'usearch';

interface Manifest { format: 1; model: string; dimension: number; revision: number; generation: string; keys: number[] }
interface VectorRow { id: number; embedding: Buffer; vector_revision: number }

export interface VectorMatch { id: number; distance: number; score: number }

export class VectorIndex {
  private constructor(private index: Index, private manifest: Manifest, private readonly directory: string) {}

  static async synchronize(databaseFile: string, directory: string, model: string, dimension: number): Promise<VectorIndex> {
    await mkdir(directory, { recursive: true });
    const manifestFile = path.join(directory, 'vector-index.json');
    let manifest: Manifest | undefined;
    let index: Index | undefined;
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Manifest;
      if (manifest.format !== 1 || manifest.model !== model || manifest.dimension !== dimension) manifest = undefined;
      if (manifest) {
        index = new Index({ dimensions: dimension, metric: MetricKind.Cos, quantization: ScalarKind.F32,
          connectivity: 16, expansion_add: 128, expansion_search: 64, multi: false });
        index.load(path.join(directory, manifest.generation));
        if (index.dimensions() !== dimension || index.size() !== manifest.keys.length) { index = undefined; manifest = undefined; }
      }
    } catch { index = undefined; manifest = undefined; }

    const db = new Database(databaseFile, { timeout: 3000 });
    try {
      const revision = (db.prepare('SELECT revision FROM vector_state WHERE id=1').get() as { revision: number }).revision;
      const activeIds = (db.prepare(`SELECT id FROM photos WHERE deleted_at IS NULL AND status IN ('INDEXED','PROCESSING')
        AND model_version=? AND embedding_dimension=? AND embedding IS NOT NULL ORDER BY id`).all(model, dimension) as { id: number }[]).map(row => row.id);
      const active = new Set(activeIds);
      const oldKeys = manifest?.keys ?? [];
      const rebuild = !index || !manifest;
      if (!rebuild && manifest!.revision === revision && oldKeys.length === activeIds.length && oldKeys.every((id, i) => id === activeIds[i])) {
        db.prepare(`UPDATE photos SET status='INDEXED',last_indexed_at=COALESCE(last_indexed_at,?)
          WHERE status='PROCESSING' AND deleted_at IS NULL AND model_version=? AND embedding_dimension=? AND vector_revision<=?`).run(new Date().toISOString(), model, dimension, revision);
        return new VectorIndex(index!, manifest!, directory);
      }
      if (rebuild) {
        index = new Index({ dimensions: dimension, metric: MetricKind.Cos, quantization: ScalarKind.F32,
          connectivity: 16, expansion_add: 128, expansion_search: 64, multi: false });
      } else {
        for (const id of oldKeys) if (!active.has(id) && index!.contains(BigInt(id))) index!.remove(BigInt(id));
      }
      if (!index) throw new Error('VECTOR_INDEX_INITIALIZATION_FAILED');
      const activeIndex = index;
      const rows = db.prepare(rebuild ? `SELECT id,embedding,vector_revision FROM photos WHERE deleted_at IS NULL AND status IN ('INDEXED','PROCESSING')
        AND model_version=? AND embedding_dimension=? AND embedding IS NOT NULL ORDER BY id` : `SELECT id,embedding,vector_revision FROM photos
        WHERE deleted_at IS NULL AND status IN ('INDEXED','PROCESSING') AND model_version=? AND embedding_dimension=? AND embedding IS NOT NULL
        AND vector_revision>? ORDER BY id`).all(...(rebuild ? [model, dimension] : [model, dimension, manifest!.revision])) as VectorRow[];
      for (const row of rows) {
        const key = BigInt(row.id);
        if (activeIndex.contains(key)) activeIndex.remove(key);
        const vector = new Float32Array(row.embedding.length / 4);
        for (let i = 0; i < vector.length; i++) vector[i] = row.embedding.readFloatLE(i * 4);
        activeIndex.add(key, vector, 1);
      }
      const next: Manifest = { format: 1, model, dimension, revision, generation: `vectors-${randomUUID()}.usearch`, keys: activeIds };
      const tempIndex = path.join(directory, `${next.generation}.tmp`);
      activeIndex.save(tempIndex);
      await rename(tempIndex, path.join(directory, next.generation));
      const tempManifest = `${manifestFile}.${randomUUID()}.tmp`;
      await writeFile(tempManifest, JSON.stringify(next));
      await rename(tempManifest, manifestFile);
      db.prepare(`UPDATE photos SET status='INDEXED',last_indexed_at=COALESCE(last_indexed_at,?)
        WHERE status='PROCESSING' AND deleted_at IS NULL AND model_version=? AND embedding_dimension=? AND vector_revision<=?`).run(new Date().toISOString(), model, dimension, revision);
      // A geração anterior é mantida: uma pesquisa que leu o manifesto antigo
      // imediatamente antes do rename ainda consegue abri-la sem corrida com o worker.
      return new VectorIndex(activeIndex, next, directory);
    } finally { db.close(); }
  }

  static async open(directory: string, model: string, dimension: number): Promise<VectorIndex> {
    const manifest = JSON.parse(await readFile(path.join(directory, 'vector-index.json'), 'utf8')) as Manifest;
    if (manifest.format !== 1 || manifest.model !== model || manifest.dimension !== dimension) throw new Error('VECTOR_INDEX_INCOMPATIBLE');
    const index = new Index({ dimensions: dimension, metric: MetricKind.Cos, quantization: ScalarKind.F32,
      connectivity: 16, expansion_add: 128, expansion_search: 64, multi: false });
    index.load(path.join(directory, manifest.generation));
    if (index.size() !== manifest.keys.length) throw new Error('VECTOR_INDEX_CORRUPT');
    return new VectorIndex(index, manifest, directory);
  }

  search(vector: Float32Array, limit: number): VectorMatch[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_SEARCH_LIMIT');
    if (vector.length !== this.manifest.dimension || !this.index.size()) return [];
    const result = this.index.search(vector, Math.min(limit, this.index.size()), 1);
    return Array.from(result.keys, (key, i) => ({ id: Number(key), distance: result.distances[i]!, score: 1 - result.distances[i]! }));
  }

  async diskBytes(): Promise<number> { return (await stat(path.join(this.directory, this.manifest.generation))).size; }
  get size(): number { return this.index.size(); }
  get model(): string { return this.manifest.model; }
  get ids(): readonly number[] { return this.manifest.keys; }
}
