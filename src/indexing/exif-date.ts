const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const EXIF_OFFSET = /^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/;

/** Reads DateTimeOriginal (0x9003) from the TIFF payload returned by Sharp. */
export function readExifDateTimeOriginal(data?: Buffer): number | null {
  if (!data || data.length < 8) return null;
  const start = data.subarray(0, 6).equals(Buffer.from('Exif\0\0', 'binary')) ? 6 : 0;
  if (start + 8 > data.length) return null;
  const marker = data.toString('ascii', start, start + 2);
  if (marker !== 'II' && marker !== 'MM') return null;
  const little = marker === 'II';
  const u16 = (at: number) => at >= 0 && at + 2 <= data.length ? (little ? data.readUInt16LE(at) : data.readUInt16BE(at)) : undefined;
  const u32 = (at: number) => at >= 0 && at + 4 <= data.length ? (little ? data.readUInt32LE(at) : data.readUInt32BE(at)) : undefined;
  if (u16(start + 2) !== 42) return null;
  const find = (ifdOffset: number, tag: number): { type: number; count: number; valueAt: number } | undefined => {
    const base = start + ifdOffset; const count = u16(base);
    if (count === undefined || count > 4096 || base + 2 + count * 12 > data.length) return undefined;
    for (let index = 0; index < count; index++) {
      const entry = base + 2 + index * 12;
      if (u16(entry) !== tag) continue;
      const type = u16(entry + 2); const length = u32(entry + 4);
      if (type === undefined || length === undefined) return undefined;
      const offset = length <= 4 ? entry + 8 : start + (u32(entry + 8) ?? data.length);
      return offset >= start && offset + length <= data.length ? { type, count: length, valueAt: offset } : undefined;
    }
    return undefined;
  };
  const ascii = (entry?: { type: number; count: number; valueAt: number }) => {
    if (!entry || entry.type !== 2 || entry.count < 2 || entry.count > 128) return undefined;
    return data.toString('ascii', entry.valueAt, entry.valueAt + entry.count).replace(/\0.*$/s, '').trim();
  };
  const ifd0 = u32(start + 4); if (ifd0 === undefined) return null;
  const pointer = find(ifd0, 0x8769);
  if (!pointer || pointer.type !== 4 || pointer.count !== 1) return null;
  const exifIfd = u32(pointer.valueAt); if (exifIfd === undefined) return null;
  const dateText = ascii(find(exifIfd, 0x9003)); const match = dateText ? EXIF_DATE.exec(dateText) : null;
  if (!match) return null;
  const [, yy, mo, dd, hh, mi, ss] = match; const [year, month, day, hour, minute, second] = [yy, mo, dd, hh, mi, ss].map(Number);
  const offset = ascii(find(exifIfd, 0x9011));
  const calendar = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day ||
      calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) return null;
  const value = offset && EXIF_OFFSET.test(offset) ? Date.parse(`${yy}-${mo}-${dd}T${hh}:${mi}:${ss}${offset}`) : new Date(year!, month! - 1, day!, hour!, minute!, second!).getTime();
  return Number.isFinite(value) ? value : null;
}
