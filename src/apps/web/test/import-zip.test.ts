/**
 * import-zip.test.ts — the zip reader on node:zlib (F4): Actual's export opens,
 * anything else is refused in plain words, sizes are bounded before inflating.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeZip } from './fixtures/make-zip';
import { listZip, readZipExactly, ZipError } from '../src/lib/server/import/zip';

const SAMPLE = path.resolve(__dirname, 'fixtures/Sample-budget-export.zip');

const LIMITS = { 'db.sqlite': 1_000_000, 'metadata.json': 65_536 };
const WHAT = "Actual Budget's export";

describe('zip reader (F4)', () => {
  it("opens Actual's export: exactly db.sqlite and metadata.json, sizes and CRCs checked", () => {
    const buf = fs.readFileSync(SAMPLE);
    expect(listZip(buf).map((e) => e.name).sort()).toEqual(['db.sqlite', 'metadata.json']);
    const files = readZipExactly(buf, LIMITS, WHAT);
    expect(files.get('db.sqlite')!.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(JSON.parse(files.get('metadata.json')!.toString()).budgetName).toBe('Sample budget (Bengaluru)');
  });

  it('reads stored and deflated entries alike', () => {
    const zip = makeZip([
      { name: 'db.sqlite', data: Buffer.from('a'.repeat(5000)) },
      { name: 'metadata.json', data: Buffer.from('{"id":"x"}'), store: true },
    ]);
    const files = readZipExactly(zip, LIMITS, WHAT);
    expect(files.get('db.sqlite')!.length).toBe(5000);
    expect(files.get('metadata.json')!.toString()).toBe('{"id":"x"}');
  });

  it('refuses a file that is not a zip, a zip with other files or a file missing', () => {
    expect(() => readZipExactly(Buffer.from('not a zip at all, just text here....'), LIMITS, WHAT)).toThrow("This file isn't a zip.");
    const extra = makeZip([
      { name: 'db.sqlite', data: Buffer.from('x') },
      { name: 'metadata.json', data: Buffer.from('{}') },
      { name: 'run.exe', data: Buffer.from('MZ') },
    ]);
    expect(() => readZipExactly(extra, LIMITS, WHAT)).toThrow("This zip isn't Actual Budget's export.");
    const missing = makeZip([{ name: 'db.sqlite', data: Buffer.from('x') }]);
    expect(() => readZipExactly(missing, LIMITS, WHAT)).toThrow(ZipError);
  });

  it('refuses an entry past its size limit before inflating it, a damaged one and a password-protected one', () => {
    const big = makeZip([
      { name: 'db.sqlite', data: Buffer.alloc(2_000_000) },
      { name: 'metadata.json', data: Buffer.from('{}') },
    ]);
    expect(() => readZipExactly(big, LIMITS, WHAT)).toThrow('db.sqlite is too large to import.');
    const badCrc = makeZip([
      { name: 'db.sqlite', data: Buffer.from('hello'), crc: 1 },
      { name: 'metadata.json', data: Buffer.from('{}') },
    ]);
    expect(() => readZipExactly(badCrc, LIMITS, WHAT)).toThrow('This zip is damaged.');
    const locked = makeZip([
      { name: 'db.sqlite', data: Buffer.from('hello'), flags: 1 },
      { name: 'metadata.json', data: Buffer.from('{}') },
    ]);
    expect(() => readZipExactly(locked, LIMITS, WHAT)).toThrow('This zip is password-protected.');
  });

  it('refuses an entry whose stated size lies (a zip bomb inflates past the limit)', () => {
    const zip = makeZip([
      { name: 'db.sqlite', data: Buffer.alloc(2_000_000) },
      { name: 'metadata.json', data: Buffer.from('{}') },
    ]);
    // Rewrite the stated sizes of db.sqlite (local + central) to 10 bytes: the inflate must stop at the limit.
    const entries = listZip(zip);
    const e = entries.find((x) => x.name === 'db.sqlite')!;
    zip.writeUInt32LE(10, e.localOffset + 22);
    const centralAt = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, centralAt + 24);
    expect(() => readZipExactly(zip, LIMITS, WHAT)).toThrow(/damaged or too large|damaged/);
  });
});
