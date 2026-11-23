// Giftly's data lives in releases: /data/releases/<name>/ holds the database, the photos, the
// session secret and a manifest; /data/current is a symlink to the one in use. Switching data
// is one atomic rename of that symlink, done only while Giftly is stopped (or by Giftly itself
// before it opens anything). Restore, upgrade and rollback each create a NEW release and never
// modify the one they might need to go back to.
//
//   current -> releases/2026-11-23T15-00-00-000Z
//   releases/<name>/giftly.db, images/, .session-secret, manifest.json
//
// This module has no side effects on import: config.js calls ensureData() at startup, and the
// admin scripts (backup, restore, release) use the helpers directly.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { migrate, SCHEMA_VERSION } from './migrations.js';

export const IMAGE_FILE_RE = /^[a-z0-9]{8,40}\.(jpg|png|webp|gif|avif)$/;
// Tables whose image_file column names a photo in images/.
export const IMAGE_TABLES = ['items', 'gifts', 'wishlist_items'];
export const RELEASE_NAME_RE = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-[a-f0-9]{4})?$/;
export const KEEP_RELEASES = 3;
export const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export { SCHEMA_VERSION };

export const paths = (root) => ({
  root,
  releases: join(root, 'releases'),
  current: join(root, 'current'),
  legacyDb: join(root, 'giftly.db'),
  legacyImages: join(root, 'images'),
  legacySecret: join(root, '.session-secret'),
  legacyStamp: join(root, '.legacy-copied.json'),
});
export const releaseDir = (root, name) => join(root, 'releases', name);

// ---------- small helpers ----------

function fsyncDir(dir) {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort */ }
}

/** Write a file atomically (temporary file in the same folder, fsync, rename). */
export function writeFileAtomic(file, content, mode = 0o644) {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, { mode });
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** A new, unused release name: the UTC time with milliseconds (sorts by creation). */
export function newReleaseName(root, now = new Date()) {
  const base = now.toISOString().replace(/[:.]/g, '-');
  let name = base;
  while (existsSync(releaseDir(root, name)) || existsSync(join(root, 'releases', `.tmp-${name}`))) {
    name = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return name;
}

export function readManifest(root, name) {
  try {
    return JSON.parse(readFileSync(join(releaseDir(root, name), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function writeManifest(dir, manifest) {
  writeFileAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The release `current` points to, or null when there is none yet. Throws if it is broken. */
export function currentName(root) {
  const p = paths(root);
  let target;
  try {
    target = readlinkSync(p.current);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${p.current} is not a symlink to a data release (${err.code})`);
  }
  const m = /^releases\/([^/]+)$/.exec(target);
  if (!m || !RELEASE_NAME_RE.test(m[1])) throw new Error(`${p.current} points to ${target}, which is not a data release`);
  if (!existsSync(join(releaseDir(root, m[1]), 'manifest.json'))) {
    throw new Error(`${p.current} points to ${target}, which is missing or has no manifest.json`);
  }
  return m[1];
}

/** All releases, oldest first. */
export function listReleases(root) {
  try {
    return readdirSync(paths(root).releases).filter((n) => RELEASE_NAME_RE.test(n)).sort();
  } catch {
    return [];
  }
}

/** Point `current` at a release: one atomic rename of a symlink. Giftly must not be running. */
export function switchCurrent(root, name) {
  if (!RELEASE_NAME_RE.test(name) || !readManifest(root, name)) throw new Error(`no data release named ${name}`);
  const p = paths(root);
  const tmp = join(root, `.current.tmp-${randomBytes(4).toString('hex')}`);
  symlinkSync(`releases/${name}`, tmp);
  try {
    renameSync(tmp, p.current);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(root);
}

/** Hard-link (or, across file systems, copy) every photo from one images/ folder to another. */
export function linkImages(from, to, only = null) {
  mkdirSync(to, { recursive: true });
  let names;
  try { names = readdirSync(from); } catch { names = []; }
  const missing = [];
  for (const f of only ?? names) {
    if (!IMAGE_FILE_RE.test(f)) continue;
    const src = join(from, f);
    try {
      try { linkSync(src, join(to, f)); } catch (err) {
        if (err.code === 'ENOENT') throw err;
        copyFileSync(src, join(to, f));
      }
    } catch (err) {
      if (err.code === 'ENOENT' && only) { missing.push(f); continue; }
      throw err;
    }
  }
  return missing;
}

/** Photos a database uses. Throws on names that aren't photo file names. */
export function imageRefs(db) {
  const refs = new Set();
  for (const t of IMAGE_TABLES) {
    if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, 'image_file')) continue;
    for (const r of db.prepare(`SELECT DISTINCT image_file AS f FROM ${t} WHERE image_file IS NOT NULL AND image_file != ''`).all()) refs.add(r.f);
  }
  const bad = [...refs].filter((f) => !IMAGE_FILE_RE.test(f));
  if (bad.length) throw new Error(`the database names unexpected photo files: ${bad.join(' ')}`);
  return [...refs].sort();
}

// ---------- fingerprint ----------

const cell = (v) => (v instanceof Uint8Array ? `x'${Buffer.from(v).toString('hex')}'` : v);

/**
 * What a release holds: row count and a hash of every row of every table, the schema version,
 * and the photo files (names and sizes). Two releases with the same fingerprint hold the same
 * data. Computed only on data no process is writing (a new copy, before Giftly opens it).
 */
export function fingerprint(dir) {
  const dbFile = join(dir, 'giftly.db');
  if (!existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    const tables = {};
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    for (const t of names) {
      const h = createHash('sha256');
      let rows = 0;
      for (const r of db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}" ORDER BY rowid`).iterate()) {
        h.update(JSON.stringify(Object.values(r).map(cell)));
        h.update('\n');
        rows++;
      }
      tables[t] = { rows, sha256: h.digest('hex') };
    }
    const imgDir = join(dir, 'images');
    let files = [];
    try { files = readdirSync(imgDir).filter((f) => IMAGE_FILE_RE.test(f)).sort(); } catch { /* none */ }
    const ih = createHash('sha256');
    for (const f of files) ih.update(`${f} ${statSync(join(imgDir, f)).size}\n`);
    const body = { schema, tables, images: files.length, images_sha256: ih.digest('hex') };
    return { sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body };
  } finally {
    db.close();
  }
}

/** Integrity check of a release's database, and every photo it uses present. */
export function checkRelease(dir, { allowMissingImages = false } = {}) {
  const db = new DatabaseSync(join(dir, 'giftly.db'), { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    if (result.join() !== 'ok') throw new Error(`the database is damaged (${result.slice(0, 3).join('; ')})`);
    const missing = imageRefs(db).filter((f) => !existsSync(join(dir, 'images', f)));
    if (missing.length && !allowMissingImages) {
      throw new Error(`${missing.length} photo(s) the database uses are missing: ${missing.join(' ')}`);
    }
    return { schema: db.prepare('PRAGMA user_version').get().user_version, missing };
  } finally {
    db.close();
  }
}

// ---------- creating releases ----------

/** Start a release: an empty releases/.tmp-<name>/ folder to fill. */
export function startRelease(root) {
  const name = newReleaseName(root);
  const tmp = join(paths(root).releases, `.tmp-${name}`);
  mkdirSync(join(tmp, 'images'), { recursive: true });
  return { name, tmp };
}

/** Write the manifest of a filled release, then rename it into place (the only visible step). */
export function finishRelease(root, { name, tmp }, fields) {
  const manifest = {
    format: 1, name, giftly: APP_VERSION, created_at: new Date().toISOString(),
    parent: null, fingerprint: null, verified_at: null, ...fields, schema: schemaOf(tmp) ?? 0,
  };
  writeManifest(tmp, manifest);
  fsyncDir(tmp);
  renameSync(tmp, releaseDir(root, name));
  fsyncDir(paths(root).releases);
  return name;
}

export const abortRelease = ({ tmp }) => rmSync(tmp, { recursive: true, force: true });

/**
 * Build a release in releases/.tmp-<name>/ with `fill(dir)`, write its manifest (fingerprint
 * included) and only then rename it into place. On any failure the temporary folder is removed
 * and nothing else changed.
 */
export function buildRelease(root, fields, fill) {
  const r = startRelease(root);
  try {
    fill(r.tmp);
    return finishRelease(root, r, { fingerprint: fingerprint(r.tmp), ...fields });
  } catch (err) {
    abortRelease(r);
    throw err;
  }
}

/** Consistent copy of a database (safe while another process uses it). */
export function snapshotDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

function copySecret(from, toDir) {
  if (existsSync(from)) copyFileSync(from, join(toDir, '.session-secret'));
}

const legacyStamp = (p) => {
  const s = (f) => { try { const st = statSync(f); return [st.ino, st.size, st.mtimeMs]; } catch { return null; } };
  return { db: s(p.legacyDb), wal: s(`${p.legacyDb}-wal`) };
};

/** A release copied from the flat 3.x layout (/data/giftly.db, /data/images). The originals stay. */
function releaseFromLegacy(root, parent) {
  const p = paths(root);
  const name = buildRelease(root, { origin: parent ? 'legacy' : 'initial', parent, verified_at: new Date().toISOString() }, (dir) => {
    snapshotDb(p.legacyDb, join(dir, 'giftly.db'));
    linkImages(p.legacyImages, join(dir, 'images'));
    copySecret(p.legacySecret, dir);
  });
  writeFileAtomic(p.legacyStamp, JSON.stringify(legacyStamp(p)));
  return name;
}

/** A new, empty release (first start). The database is created by db.js. */
function emptyRelease(root) {
  return buildRelease(root, { origin: 'initial', verified_at: new Date().toISOString() }, () => {});
}

/** A copy of `from`, migrated to this version's schema. `from` itself is never written. */
function upgradeRelease(root, from) {
  const src = releaseDir(root, from);
  return buildRelease(root, { origin: 'upgrade', parent: from, verified_at: new Date().toISOString() }, (dir) => {
    snapshotDb(join(src, 'giftly.db'), join(dir, 'giftly.db'));
    linkImages(join(src, 'images'), join(dir, 'images'));
    copySecret(join(src, '.session-secret'), dir);
    const db = new DatabaseSync(join(dir, 'giftly.db'));
    try {
      db.exec('PRAGMA foreign_keys = ON');
      migrate(db);
    } finally {
      db.close();
    }
  });
}

const schemaOf = (dir) => {
  const file = join(dir, 'giftly.db');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); }
};

/**
 * Make sure `current` points to a release this version can serve, before anything opens it:
 *  - first start: an empty release; or a copy of the 3.x data in /data (left untouched, so an
 *    older Giftly still finds it), and a new copy if an older Giftly changed it since;
 *  - a release nobody has opened yet (a restore) must match its manifest's fingerprint;
 *  - an older schema: migrated in a NEW release; the previous one is left as it was.
 * Throws (and the app refuses to start) when any of that fails; `current` is then unchanged.
 */
export function ensureData(root, { log = console } = {}) {
  const p = paths(root);
  mkdirSync(p.releases, { recursive: true });
  let name = currentName(root);
  if (!name) {
    if (existsSync(p.legacyDb)) {
      name = releaseFromLegacy(root, null);
      log.log(`Data copied into ${releaseDir(root, name)} (the previous files in ${root} are left as they were; see the README).`);
    } else {
      name = emptyRelease(root);
    }
    switchCurrent(root, name);
  } else if (existsSync(p.legacyDb)) {
    let stamp = null;
    try { stamp = readFileSync(p.legacyStamp, 'utf8'); } catch { /* none */ }
    if (stamp !== JSON.stringify(legacyStamp(p))) {
      // An older Giftly ran on the flat files after they were copied (a rollback): they are newer.
      name = releaseFromLegacy(root, name);
      log.warn(`${p.legacyDb} changed since it was copied (an older Giftly used it): copied it again into ${releaseDir(root, name)}.`);
      switchCurrent(root, name);
    }
  }

  const manifest = readManifest(root, name);
  const dir = releaseDir(root, name);
  if (!manifest.verified_at) {
    // First open of a release made elsewhere (a restore): it must hold exactly what its manifest says.
    const fp = fingerprint(dir);
    if (!manifest.fingerprint || !fp || fp.sha256 !== manifest.fingerprint.sha256) {
      throw new Error(`the data in ${dir} doesn't match its manifest (fingerprint ${fp?.sha256 ?? 'none'}, expected ${manifest.fingerprint?.sha256 ?? 'none'}): refusing to serve it`);
    }
    writeManifest(dir, { ...manifest, verified_at: new Date().toISOString() });
  }

  const schema = schemaOf(dir);
  if (schema !== null && schema > SCHEMA_VERSION) {
    throw new Error(`the data in ${dir} has database schema ${schema}, newer than this Giftly ${APP_VERSION} supports (${SCHEMA_VERSION}). Run a newer Giftly, or switch back to an older release (see the README).`);
  }
  if (schema !== null && schema < SCHEMA_VERSION) {
    let next;
    try {
      next = upgradeRelease(root, name);
    } catch (err) {
      throw new Error(`upgrading the data in ${dir} from schema ${schema} to ${SCHEMA_VERSION} failed: ${err.message}. That release is unchanged.`);
    }
    switchCurrent(root, next);
    log.log(`Data upgraded into ${releaseDir(root, next)} (the previous data stays in ${dir}).`);
    name = next;
  }
  return { root, name, dir: releaseDir(root, name), manifest: readManifest(root, name) };
}

/**
 * Keep the newest KEEP_RELEASES releases, plus `current` and its parent; remove the rest, and
 * temporary folders left by an interrupted run (older than an hour).
 */
export function pruneReleases(root, { keep = KEEP_RELEASES, log = console } = {}) {
  const cur = currentName(root);
  if (!cur) return [];
  const all = listReleases(root);
  const keepSet = new Set(all.slice(-keep));
  keepSet.add(cur);
  const parent = readManifest(root, cur)?.parent;
  if (parent) keepSet.add(parent);
  const removed = [];
  for (const n of all) {
    if (keepSet.has(n)) continue;
    rmSync(releaseDir(root, n), { recursive: true, force: true });
    removed.push(n);
  }
  const hourAgo = Date.now() - 3600_000;
  for (const n of readdirSync(paths(root).releases)) {
    if (!n.startsWith('.tmp-')) continue;
    const f = join(paths(root).releases, n);
    if (lstatSync(f).mtimeMs < hourAgo) rmSync(f, { recursive: true, force: true });
  }
  if (removed.length) log.log(`Removed old data release(s): ${removed.join(', ')}`);
  return removed;
}
