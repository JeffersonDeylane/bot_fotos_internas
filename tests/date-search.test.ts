import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExifDateTimeOriginal } from '../src/indexing/exif-date.ts';
import { parseDateSearch } from '../src/search/date-service.ts';

function exif(date: string): Buffer {
  const data = Buffer.alloc(82);
  data.write('Exif\0\0', 0, 'binary');
  data.write('II', 6, 'ascii'); data.writeUInt16LE(42, 8); data.writeUInt32LE(8, 10);
  data.writeUInt16LE(1, 14); data.writeUInt16LE(0x8769, 16); data.writeUInt16LE(4, 18);
  data.writeUInt32LE(1, 20); data.writeUInt32LE(26, 24); data.writeUInt32LE(0, 28);
  data.writeUInt16LE(1, 32); data.writeUInt16LE(0x9003, 34); data.writeUInt16LE(2, 36);
  data.writeUInt32LE(20, 38); data.writeUInt32LE(44, 42); data.writeUInt32LE(0, 46);
  data.write(`${date}\0`, 50, 'ascii');
  return data;
}

test('lê DateTimeOriginal do EXIF e rejeita datas inválidas', () => {
  const value = readExifDateTimeOriginal(exif('2024:07:18 14:35:09'));
  assert.notEqual(value, null);
  const date = new Date(value!);
  assert.deepEqual([date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()], [2024, 7, 18, 14]);
  assert.equal(readExifDateTimeOriginal(exif('2024:02:31 14:35:09')), null);
  assert.equal(readExifDateTimeOriginal(Buffer.from('not exif')), null);
});

test('interpreta dia, mês, ano e intervalo na busca por data', () => {
  const exact = parseDateSearch('10 13/09/2026'); assert.equal(exact.amount, 10);
  assert.equal(new Date(exact.start).getDate(), 13);
  const month = parseDateSearch('09/2026'); assert.equal(new Date(month.start).getMonth(), 8); assert.equal(new Date(month.end).getMonth(), 9);
  const year = parseDateSearch('2026'); assert.equal(new Date(year.end).getFullYear(), 2027);
  const interval = parseDateSearch('01/09/2026 a 13/09/2026'); assert.equal(new Date(interval.end - 1).getDate(), 13);
  assert.throws(() => parseDateSearch('31/02/2026'), /INVALID_DATE/);
  assert.throws(() => parseDateSearch('31 09/2026'), /INVALID_PHOTO_AMOUNT/);
});
