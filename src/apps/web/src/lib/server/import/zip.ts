/**
 * zip.ts — a small zip reader on `node:zlib` (F4; no new dependency).
 * ============================================================================
 * Reads the entries of a zip held in memory: the end-of-central-directory record, the central
 * directory, then each wanted entry's local header and data, stored (method 0) or deflated
 * (method 8), checked against its CRC-32. Only what Actual's Export data writes is supported: no
 * encryption, no zip64, no multi-disk. Every size is bounded before anything is inflated, so a
 * small file that would inflate to gigabytes is refused, not unpacked.
 * ============================================================================
 */
import zlib from 'node:zlib';

/** A zip this reader won't open; the message says why in plain words. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc: number;
  readonly localOffset: number;
  readonly encrypted: boolean;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries listed in the zip's central directory. */
export function listZip(buf: Buffer): ZipEntry[] {
  // The end record sits in the last 22 bytes plus at most a 65,535-byte comment.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("This file isn't a zip.");
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirStart = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirStart === 0xffffffff) throw new ZipError('This zip is too large to open here.');
  if (dirStart + dirSize > eocd) throw new ZipError('This zip is damaged.');

  const entries: ZipEntry[] = [];
  let p = dirStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('This zip is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      encrypted: (flags & 1) === 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's bytes, refused past `maxSize` (checked before and while inflating). */
export function readZipEntry(buf: Buffer, entry: ZipEntry, maxSize: number): Buffer {
  if (entry.encrypted) throw new ZipError('This zip is password-protected.');
  if (entry.size > maxSize) throw new ZipError(`${entry.name} is too large to import.`);
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL) throw new ZipError('This zip is damaged.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new ZipError('This zip is damaged.');
  const raw = buf.subarray(start, end);

  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: maxSize });
    } catch {
      throw new ZipError(`${entry.name} is damaged or too large to import.`);
    }
  } else throw new ZipError(`${entry.name} is packed in a way this reader doesn't know.`);

  if (data.length !== entry.size || zlib.crc32(data) !== entry.crc) throw new ZipError('This zip is damaged.');
  return data;
}

/**
 * The named entries of a zip that must hold exactly those names (directories aside), each within
 * its size limit. Anything else in the zip, or a name missing, is refused: it isn't the file asked for.
 */
export function readZipExactly(buf: Buffer, limits: Readonly<Record<string, number>>, what: string): Map<string, Buffer> {
  const entries = listZip(buf).filter((e) => !e.name.endsWith('/'));
  const names = Object.keys(limits);
  const seen = new Set(entries.map((e) => e.name));
  if (entries.length !== names.length || names.some((n) => !seen.has(n))) {
    throw new ZipError(`This zip isn't ${what}.`);
  }
  return new Map(entries.map((e) => [e.name, readZipEntry(buf, e, limits[e.name]!)]));
}
