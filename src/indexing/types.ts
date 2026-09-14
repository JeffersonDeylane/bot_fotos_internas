export const METADATA_VERSION = 'metadata-v2-exif-date';
export type IndexStatus = 'PENDING' | 'PROCESSING' | 'INDEXED' | 'FAILED';

export interface FileSnapshot {
  path: string;
  pathKey: string;
  size: number;
  modifiedAt: number;
  createdAt: number | null;
  fingerprint: string;
  extension: string;
}

export interface PhotoJob {
  id: number;
  path: string;
  fingerprint: string;
  root_path: string;
}

export interface JobResult {
  embedding?: Float32Array;
  modelVersion?: string;
  id: number;
  status: IndexStatus;
  width: number | null;
  height: number | null;
  takenAt?: number | null;
  takenAtSource?: 'EXIF' | 'FILE_MODIFIED' | null;
  error: string | null;
}

export interface IndexProgress {
  phase: 'scanning' | 'processing' | 'completed' | 'interrupted';
  found: number;
  alreadyIndexed: number;
  pending: number;
  processed: number;
  failed: number;
  scanErrors: number;
  removed: number;
  imagesPerSecond: number;
}
