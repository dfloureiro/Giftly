// Backup archives: a plain ustar tar, gzipped, holding regular files only. Written and read
// here (no `tar` binary) so a restore accepts exactly the files a backup may contain: no links,
// no devices, no paths outside the folder it is unpacked into.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';

const BLOCK = 512;

function header(name, size, mode = 0o600, mtime = Math.floor(Date.now() / 1000)) {
  if (Buffer.byteLength(name) > 100) throw new Error(`name too long for the archive: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const field = (off, len, value) => h.write(value, off, len, 'ascii');
  h.write(name, 0, 100, 'utf8');
  field(100, 8, `${mode.toString(8).padStart(7, '0')}\0`);
  field(108, 8, '0000000\0');
  field(116, 8, '0000000\0');
  field(124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  field(136, 12, `${mtime.toString(8).padStart(11, '0')}\0`);
  field(148, 8, '        ');
  field(156, 1, '0');
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  let sum = 0;
  for (const b of h) sum += b;
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/**
 * Write a .tar.gz of `entries` ({ name, file } or { name, data }) to the writable stream `out`.
 */
export async function writeTarGz(entries, out) {
  const gz = createGzip();
  const done = pipeline(gz, out);
  const write = async (buf) => { if (!gz.write(buf)) await once(gz, 'drain'); };
  for (const e of entries) {
    if (e.data !== undefined) {
      const data = Buffer.from(e.data);
      await write(header(e.name, data.length, e.mode));
      await write(data);
      if (data.length % BLOCK) await write(Buffer.alloc(BLOCK - (data.length % BLOCK)));
    } else {
      const { size } = statSync(e.file);
      await write(header(e.name, size, e.mode));
      let n = 0;
      for await (const chunk of createReadStream(e.file)) { n += chunk.length; await write(chunk); }
      if (n !== size) throw new Error(`${e.name} changed while it was archived`);
      if (size % BLOCK) await write(Buffer.alloc(BLOCK - (size % BLOCK)));
    }
  }
  await write(Buffer.alloc(BLOCK * 2));
  gz.end();
  await done;
}

const str = (buf, off, len) => {
  const s = buf.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString('utf8');
};
const octal = (buf, off, len) => {
  const s = str(buf, off, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error('not a valid archive (bad number in a header)');
  return s ? parseInt(s, 8) : 0;
};

/**
 * Unpack a .tar.gz stream into `dir`. Only regular files whose name passes `allowed(name)` are
 * accepted (and directory entries for their folders); anything else rejects the whole archive.
 * Returns { name: sha256 } for every file written.
 */
export async function readTarGz(input, dir, allowed, { maxBytes = 64 * 1024 ** 3 } = {}) {
  const files = {};
  let pending = Buffer.alloc(0);
  let cur = null; // { name, left, pad, out, hash }
  let ended = false;
  let total = 0;

  const startEntry = async (h) => {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new Error('not a valid archive (header checksum)');
    const prefix = str(h, 345, 155);
    const name = (prefix ? `${prefix}/` : '') + str(h, 0, 100);
    const clean = name.replace(/^\.\//, '');
    const type = String.fromCharCode(h[156] || 48);
    const size = octal(h, 124, 12);
    if (type === '5') {
      if (clean === '' || clean === '.' || clean === './' || allowed(`${clean.replace(/\/$/, '')}/`)) return;
      throw new Error(`unexpected folder in the backup: ${name}`);
    }
    if (type !== '0') throw new Error(`unexpected entry in the backup (type ${type}): ${name}`);
    if (!allowed(clean) || clean.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`unexpected file in the backup: ${name}`);
    if (files[clean]) throw new Error(`file twice in the backup: ${name}`);
    total += size;
    if (total > maxBytes) throw new Error('the backup is larger than allowed');
    const path = join(dir, clean);
    mkdirSync(dirname(path), { recursive: true });
    const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    cur = { name: clean, left: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, out, hash: createHash('sha256') };
    files[clean] = null;
    if (size === 0) await finishEntry();
  };
  const finishEntry = async () => {
    const { out, name, hash } = cur;
    out.end();
    await once(out, 'finish');
    files[name] = hash.digest('hex');
    cur = { pad: cur.pad, left: 0, skipPad: true };
  };

  const gunzip = createGunzip();
  input.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (ended) { pending = Buffer.alloc(0); break; }
        if (cur && cur.left > 0) {
          const n = Math.min(cur.left, pending.length);
          const part = pending.subarray(0, n);
          cur.hash.update(part);
          if (!cur.out.write(part)) await once(cur.out, 'drain');
          cur.left -= n;
          pending = pending.subarray(n);
          if (cur.left === 0) await finishEntry();
          continue;
        }
        if (cur && cur.skipPad) {
          if (pending.length < cur.pad) break;
          pending = pending.subarray(cur.pad);
          cur = null;
          continue;
        }
        if (pending.length < BLOCK) break;
        const h = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (h.every((b) => b === 0)) { ended = true; continue; }
        await startEntry(Buffer.from(h));
      }
    }
  } catch (err) {
    if (cur?.out) cur.out.destroy();
    if (/incorrect header check|unexpected end/i.test(err.message)) throw new Error('not a readable backup (gzip)');
    throw err;
  }
  // The end-of-archive block is only read between entries, so it proves every file is complete.
  if (!ended) throw new Error('the backup is truncated');
  return files;
}
