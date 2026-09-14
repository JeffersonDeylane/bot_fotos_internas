import Database from 'better-sqlite3';
import path from 'node:path';
import type { Settings } from '../config/settings.ts';
import { authorizePhotoFile } from '../security/allowed-paths.ts';

export interface DateSearch { start: number; end: number; amount: number; label: string }

function localDate(year: number, month: number, day: number): Date {
  const value = new Date(year, month - 1, day);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) throw new Error('INVALID_DATE');
  return value;
}

function day(value: string): { start: Date; end: Date } {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error('INVALID_DATE');
  const start = localDate(Number(match[3]), Number(match[2]), Number(match[1]));
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { start, end };
}

function period(value: string): { start: Date; end: Date } {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return day(value);
  const month = /^(\d{2})\/(\d{4})$/.exec(value);
  if (month) { const start = localDate(Number(month[2]), Number(month[1]), 1); return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) }; }
  const year = /^(\d{4})$/.exec(value);
  if (year) { const start = localDate(Number(year[1]), 1, 1); return { start, end: new Date(start.getFullYear() + 1, 0, 1) }; }
  throw new Error('INVALID_DATE');
}

export function parseDateSearch(input: string): DateSearch {
  let value = input.trim(); let amount = 5;
  const amountMatch = /^(\d{1,2})\s+(.+)$/.exec(value);
  if (amountMatch) { amount = Number(amountMatch[1]); if (amount < 1 || amount > 30) throw new Error('INVALID_PHOTO_AMOUNT'); value = amountMatch[2]!.trim(); }
  const interval = /^(\d{2}\/\d{2}\/\d{4})\s+(?:a|at[eé])\s+(\d{2}\/\d{2}\/\d{4})$/i.exec(value);
  if (interval) {
    const first = day(interval[1]!); const last = day(interval[2]!);
    if (first.start >= last.end) throw new Error('INVALID_DATE');
    return { start: first.start.getTime(), end: last.end.getTime(), amount, label: value };
  }
  const range = period(value);
  return { start: range.start.getTime(), end: range.end.getTime(), amount, label: value };
}

export async function searchPhotosByDate(settings: Settings, query: DateSearch, limit = 30): Promise<string[]> {
  const db = new Database(path.join(settings.storage.databaseDirectory, 'catalog.sqlite'), { readonly: true });
  try {
    const rows = db.prepare(`SELECT path FROM photos WHERE deleted_at IS NULL AND status='INDEXED'
      AND taken_at>=? AND taken_at<? ORDER BY taken_at DESC,id DESC LIMIT ?`).all(query.start, query.end, limit) as { path: string }[];
    const files: string[] = [];
    for (const row of rows) { try { files.push(await authorizePhotoFile(row.path, settings.photos.directories)); } catch { /* removido entre scan e envio */ } }
    return files;
  } finally { db.close(); }
}
