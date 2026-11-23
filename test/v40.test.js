// 4.0: data in releases behind /data/current. Restore, upgrade and rollback create a new release
// and never modify the one they may need to go back to; Giftly refuses data that doesn't match
// its manifest, and reports which release it serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { startServer, loginAdmin, Client } from './helpers.js';
import {
  buildRelease, currentName, fingerprint, listReleases, pruneReleases, readManifest, releaseDir, switchCurrent, SCHEMA_VERSION,
} from '../src/release.js';
import { migrations } from '../src/migrations.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const quiet = { log() {}, warn() {} };
const tmp = (p) => mkdtemp(join(tmpdir(), `giftly-v40-${p}-`));

/** Run one of the admin scripts against a data folder. */
function script(name, args, { data, input, output, env = {} } = {}) {
  const stdin = input ? openSync(input, 'r') : 'ignore';
  const stdout = output ? openSync(output, 'w') : 'pipe';
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', name), ...args], {
      env: { ...process.env, DATA_DIR: data, ...env }, stdio: [stdin, stdout, 'pipe'], encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr };
  } finally {
    if (typeof stdin === 'number') closeSync(stdin);
    if (typeof stdout === 'number') closeSync(stdout);
  }
}

/** A Giftly with a list whose gift has a photo; returns what to check later. */
async function seeded(server) {
  const admin = await loginAdmin(server.base);
  const r = await admin.post('/admin/lists', { title: 'Release list', visibility: 'shared' }, { from: '/admin' });
  const listId = Number(/\/admin\/lists\/(\d+)/.exec(r.location)?.[1]);
  await admin.post(`/admin/lists/${listId}/items`, { title: 'Photo gift', image_data: PNG }, { from: `/admin/lists/${listId}` });
  const page = (await admin.get(`/admin/lists/${listId}`)).text;
  const photo = /\/img\/([a-z0-9]+\.png)/.exec(page)?.[1];
  assert.ok(photo, 'the gift has a photo');
  return { admin, listId, photo };
}
async function servesSeed(base, { listId, photo }) {
  const admin = await loginAdmin(base);
  assert.match((await admin.get(`/admin/lists/${listId}`)).text, /Photo gift/);
  assert.equal((await admin.request(`/img/${photo}`)).status, 200);
}
/** The same browser (cookies), talking to a restarted server. */
const moved = (c, base) => Object.assign(new Client(base), { jar: new Map(c.jar) });
const served = async (server) => {
  const token = readFileSync(join(server.dataDir, '.healthz-token'), 'utf8').trim();
  const r = await new Client(server.base).request('/healthz/data', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  return JSON.parse(r.text);
};
const tree = (dir) => {
  const out = {};
  for (const f of readdirSync(dir, { recursive: true })) {
    const p = join(dir, f);
    if (statSync(p).isFile()) out[f] = readFileSync(p).toString('base64');
  }
  return out;
};
const startFails = async (env, opts) => {
  let srv;
  try { srv = await startServer(env, opts); } catch (err) { return err.message; }
  await srv.stop();
  assert.fail('the server should have refused to start');
};

test('first start: the data lives in a release behind the current symlink, secret included', async () => {
  const s = await startServer();
  try {
    const name = readlinkSync(join(s.dataDir, 'current'));
    assert.match(name, /^releases\/\d{4}-.*Z$/);
    const dir = join(s.dataDir, name);
    assert.ok(existsSync(join(dir, 'giftly.db')) && existsSync(join(dir, 'images')) && existsSync(join(dir, '.session-secret')));
    assert.ok(!existsSync(join(s.dataDir, 'giftly.db')) && !existsSync(join(s.dataDir, '.session-secret')));
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(m.origin, 'initial');
    const info = await served(s);
    assert.equal(info.release, name.slice('releases/'.length));
    assert.equal(info.schema, SCHEMA_VERSION);
  } finally {
    await s.stop();
  }
});

test('/healthz/data needs the token from the data folder', async () => {
  const s = await startServer();
  try {
    const c = new Client(s.base);
    assert.equal((await c.request('/healthz/data')).status, 404);
    assert.equal((await c.request('/healthz/data', { headers: { authorization: 'Bearer nope' } })).status, 404);
    assert.equal((statSync(join(s.dataDir, '.healthz-token')).mode & 0o077), 0, 'token file is private');
    const r = script('served.js', [], { data: s.dataDir, env: { PORT: new URL(s.base).port } });
    assert.equal(r.status, 0, r.err);
    assert.equal(JSON.parse(r.out).release, currentName(s.dataDir));
    const wrong = script('served.js', ['--expect', '2000-01-01T00-00-00-000Z'], { data: s.dataDir, env: { PORT: new URL(s.base).port } });
    assert.notEqual(wrong.status, 0);
  } finally {
    await s.stop();
  }
});

test('one-time migration from 3.x: data copied into a release, the flat files left untouched', async () => {
  // Build a 3.x-style data folder (flat giftly.db, images/, .session-secret) from a seeded Giftly.
  const first = await startServer();
  const seed = await seeded(first);
  await first.stop({ keepData: true });
  const data = first.dataDir;
  const rel = join(data, readlinkSync(join(data, 'current')));
  const flat = await tmp('flat');
  cpSync(join(rel, 'giftly.db'), join(flat, 'giftly.db'));
  cpSync(join(rel, 'images'), join(flat, 'images'), { recursive: true });
  cpSync(join(rel, '.session-secret'), join(flat, '.session-secret'));
  rmSync(data, { recursive: true, force: true });
  const before = tree(flat);
  const fpBefore = fingerprint(flat);

  const s = await startServer({}, { dataDir: flat });
  try {
    await servesSeed(s.base, seed);
    // The session made before still works: the secret came along.
    assert.equal((await moved(seed.admin, s.base).get('/admin')).status, 200);
    const name = currentName(flat);
    assert.equal(readManifest(flat, name).origin, 'initial');
  } finally {
    await s.stop();
  }
  const after = tree(flat);
  for (const [f, content] of Object.entries(before)) assert.equal(after[f], content, `${f} untouched`);
  // The copy holds exactly what the flat files held (before the app wrote its own sessions).
  const initial = listReleases(flat)[0];
  assert.equal(readManifest(flat, initial).fingerprint.sha256, fpBefore.sha256);

  // An older Giftly (a rollback) then writes to the flat files: the next start copies them again.
  const db = new DatabaseSync(join(flat, 'giftly.db'));
  db.prepare("UPDATE lists SET title = 'Changed by 3.x' WHERE id = ?").run(seed.listId);
  db.close();
  const again = await startServer({}, { dataDir: flat });
  try {
    const admin = await loginAdmin(again.base);
    assert.match((await admin.get(`/admin/lists/${seed.listId}`)).text, /Changed by 3\.x/);
    const m = readManifest(flat, currentName(flat));
    assert.equal(m.origin, 'legacy');
    assert.equal(m.parent, initial);
  } finally {
    await again.stop();
    rmSync(flat, { recursive: true, force: true });
  }
});

/** A data folder whose current release has an older schema (all migrations but the last). */
async function olderRelease({ broken = false } = {}) {
  const data = await tmp('old');
  const name = buildRelease(data, { origin: 'initial', verified_at: new Date().toISOString() }, (dir) => {
    const db = new DatabaseSync(join(dir, 'giftly.db'));
    const all = broken ? migrations.length : migrations.length - 1;
    for (let v = 0; v < all; v++) {
      const m = typeof migrations[v] === 'string' ? { sql: migrations[v] } : migrations[v];
      db.exec(m.sql);
    }
    // broken: the full schema labelled one version older, so the last migration fails.
    db.exec(`PRAGMA user_version = ${migrations.length - 1}`);
    db.exec("INSERT INTO lists (title, token, created_at) VALUES ('Old list', 'tok-old-list-00000000', 1)");
    db.close();
  });
  switchCurrent(data, name);
  return { data, name };
}

test('upgrade: migrations run on a new release; the previous one is left exactly as it was', async () => {
  const { data, name } = await olderRelease();
  const before = tree(releaseDir(data, name));
  const s = await startServer({}, { dataDir: data });
  try {
    const info = await served(s);
    assert.notEqual(info.release, name);
    assert.equal(info.origin, 'upgrade');
    assert.equal(info.parent, name);
    assert.equal(info.schema, SCHEMA_VERSION);
    assert.ok(info.verified_at);
  } finally {
    await s.stop();
  }
  assert.deepEqual(tree(releaseDir(data, name)), before, 'the previous release is untouched');
  rmSync(data, { recursive: true, force: true });
});

test('upgrade with a failing migration: Giftly refuses to start, current and its data unchanged', async () => {
  const { data, name } = await olderRelease({ broken: true });
  const before = tree(releaseDir(data, name));
  const msg = await startFails({}, { dataDir: data });
  assert.match(msg, /upgrading the data .* failed/);
  assert.equal(currentName(data), name);
  assert.deepEqual(listReleases(data), [name], 'no half-made release');
  assert.deepEqual(readdirSync(join(data, 'releases')).filter((n) => n.startsWith('.tmp-')), [], 'no temporary folder left');
  assert.deepEqual(tree(releaseDir(data, name)), before);
  // Restarting again (Docker's restart policy) doesn't pile up releases either.
  await startFails({}, { dataDir: data });
  assert.deepEqual(listReleases(data), [name]);
  rmSync(data, { recursive: true, force: true });
});

test('a release newer than this Giftly is refused', async () => {
  const { data, name } = await olderRelease();
  const db = new DatabaseSync(join(releaseDir(data, name), 'giftly.db'));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.match(await startFails({}, { dataDir: data }), /newer than this Giftly/);
  rmSync(data, { recursive: true, force: true });
});

test('retention: the newest 3 releases are kept, plus current and its parent', async () => {
  const data = await tmp('keep');
  const names = [];
  for (let i = 0; i < 6; i++) names.push(buildRelease(data, { origin: 'initial', verified_at: 'x' }, () => {}));
  // current = the 2nd oldest, an upgrade of the oldest.
  const cur = buildRelease(data, { origin: 'upgrade', parent: names[0], verified_at: 'x' }, () => {});
  switchCurrent(data, cur);
  mkdirSync(join(data, 'releases', '.tmp-stale'));
  const removed = pruneReleases(data, { log: quiet });
  const left = listReleases(data);
  assert.deepEqual(left, [names[0], names[4], names[5], cur].sort());
  assert.equal(removed.length, 3);
  assert.ok(existsSync(join(data, 'releases', '.tmp-stale')), 'a recent temporary folder may still be in use');
  rmSync(data, { recursive: true, force: true });
});

// ---------- backup and restore (scripts/backup.js, scripts/restore.js) ----------

test('backup → restore into a new release → switch → the restored data is served, the old release untouched', async () => {
  const s = await startServer();
  const seed = await seeded(s);
  const out = join(await tmp('bk'), 'b.tar.gz');
  const b = script('backup.js', [], { data: s.dataDir, output: out });
  assert.equal(b.status, 0, b.err);
  assert.deepEqual(readdirSync(s.dataDir).filter((n) => n.startsWith('.backup-')), [], 'no staging left');
  // Change the data after the backup: the restore must bring back the backup's version.
  await seed.admin.post(`/admin/lists/${seed.listId}/delete`, {}, { from: `/admin/lists/${seed.listId}` });
  const prev = currentName(s.dataDir);

  const r = script('restore.js', [], { data: s.dataDir, input: out });
  assert.equal(r.status, 0, r.err);
  const name = /release=(\S+)/.exec(r.out)[1];
  assert.equal(currentName(s.dataDir), prev, 'preparing a restore never switches');
  const m = readManifest(s.dataDir, name);
  assert.equal(m.origin, 'restore');
  assert.equal(m.parent, prev);
  assert.equal(m.verified_at, null, 'checked again by Giftly when it first opens it');
  await s.stop({ keepData: true });
  // No secret in the backup: the one in use carries over (guest cookies and CSRF tokens stay valid).
  const secret = (n) => { try { return readFileSync(join(releaseDir(s.dataDir, n), '.session-secret'), 'utf8'); } catch { return null; } };
  assert.equal(secret(name), secret(prev));
  const prevTree = tree(releaseDir(s.dataDir, prev));

  assert.equal(script('release.js', ['switch', name], { data: s.dataDir }).status, 0);
  const s2 = await startServer({}, { dataDir: s.dataDir });
  try {
    await servesSeed(s2.base, seed);
    assert.equal((await moved(seed.admin, s2.base).get('/admin')).status, 200, 'same secret: still signed in');
    const ok = script('served.js', ['--expect', name], { data: s.dataDir, env: { PORT: new URL(s2.base).port } });
    assert.equal(ok.status, 0, ok.err);
  } finally {
    await s2.stop();
  }
  assert.deepEqual(tree(releaseDir(s.dataDir, prev)), prevTree, 'the replaced release is untouched');
  assert.ok(readManifest(s.dataDir, name).verified_at);
  rmSync(s.dataDir, { recursive: true, force: true });
});

test('a restored release that no longer matches its fingerprint (or is an empty database) is refused at start', async () => {
  const s = await startServer();
  await seeded(s);
  const out = join(await tmp('fp'), 'b.tar.gz');
  assert.equal(script('backup.js', [], { data: s.dataDir, output: out }).status, 0);
  await s.stop({ keepData: true });
  const data = s.dataDir;
  const prev = currentName(data);

  for (const damage of ['photo', 'empty']) {
    const r = script('restore.js', [], { data, input: out });
    assert.equal(r.status, 0, r.err);
    const name = /release=(\S+)/.exec(r.out)[1];
    const dir = releaseDir(data, name);
    if (damage === 'photo') rmSync(join(dir, 'images', readdirSync(join(dir, 'images'))[0]));
    else { rmSync(join(dir, 'giftly.db')); new DatabaseSync(join(dir, 'giftly.db')).close(); }
    switchCurrent(data, name);
    assert.match(await startFails({}, { dataDir: data }), /doesn't match its manifest/, damage);
    switchCurrent(data, prev);
  }
  rmSync(data, { recursive: true, force: true });
});

/** Repack an archive's files (after `edit(dir)`) as a new tar.gz, with or without fixing sums. */
function repack(src, edit, { sums = true, extra = [] } = {}) {
  const dir = join(dirname(src), `x-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  const r = spawnSync('tar', ['xzf', src, '-C', dir]);
  assert.equal(r.status, 0);
  edit(dir);
  if (sums) {
    const files = readdirSync(dir, { recursive: true }).filter((f) => f !== 'SHA256SUMS' && statSync(join(dir, f)).isFile()).sort();
    const lines = files.map((f) => `${spawnSync('sha256sum', [join(dir, f)], { encoding: 'utf8' }).stdout.slice(0, 64)}  ${f}\n`);
    writeFileSync(join(dir, 'SHA256SUMS'), lines.join(''));
  }
  const out = `${dir}.tar.gz`;
  const t = spawnSync('tar', ['czf', out, '-C', dir, ...extra, '.']);
  assert.equal(t.status, 0, String(t.stderr));
  return out;
}

test('restore refuses damaged, foreign, newer or unsafe archives, before anything is changed', async () => {
  const s = await startServer();
  await seeded(s);
  const work = await tmp('bad');
  const good = join(work, 'good.tar.gz');
  assert.equal(script('backup.js', [], { data: s.dataDir, output: good }).status, 0);
  await s.stop({ keepData: true });
  const data = s.dataDir;
  const releasesBefore = listReleases(data);
  const cur = currentName(data);

  const garbage = join(work, 'garbage.tar.gz');
  writeFileSync(garbage, gzipSync(Buffer.from('not a tar at all, just text that is long enough to read a header from it'.repeat(20))));
  const cases = {
    'damaged database': [repack(good, (d) => writeFileSync(join(d, 'giftly.db'), 'x', { flag: 'a' }), { sums: false }), /checksums don't match/],
    'extra file': [repack(good, (d) => writeFileSync(join(d, 'notes.txt'), 'hi')), /unexpected file/],
    'symlink': [repack(good, (d) => symlinkSync('/etc/passwd', join(d, 'images', 'aaaaaaaaaa.png'))), /unexpected entry/],
    'unlisted photo': [repack(good, (d) => writeFileSync(join(d, 'images', 'bbbbbbbbbb.png'), 'x'), { sums: false }), /checksums don't cover/],
    'newer Giftly': [repack(good, (d) => {
      const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
      writeFileSync(join(d, 'manifest.json'), JSON.stringify({ ...m, giftly: '99.0.0' }));
    }), /newer than the one installed/],
    '3.x format': [repack(good, (d) => {
      const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
      writeFileSync(join(d, 'manifest.json'), JSON.stringify({ ...m, format: 1 }));
    }), /older format/],
    'wrong fingerprint': [repack(good, (d) => {
      const db = new DatabaseSync(join(d, 'giftly.db'));
      db.exec("UPDATE lists SET title = 'tampered'");
      db.close();
    }), /doesn't match the fingerprint/],
    'not an archive': [garbage, /not a valid archive|unexpected/],
    'cut gzip': [(() => { const f = join(work, 'cut.tar.gz'); writeFileSync(f, readFileSync(good).subarray(0, 300)); return f; })(), /not a readable backup/],
    // A complete gzip stream whose tar ends in the middle of a file.
    'truncated tar': [(() => { const f = join(work, 'cut-tar.tar.gz'); writeFileSync(f, gzipSync(gunzipSync(readFileSync(good)).subarray(0, 1500))); return f; })(), /truncated/],
  };
  for (const [label, [file, re]] of Object.entries(cases)) {
    const r = script('restore.js', [], { data, input: file });
    assert.notEqual(r.status, 0, label);
    assert.match(r.err, re, label);
    assert.match(r.err, /Nothing was changed/, label);
    assert.deepEqual(listReleases(data), releasesBefore, `${label}: no release left behind`);
    assert.deepEqual(readdirSync(join(data, 'releases')).filter((n) => n.startsWith('.tmp-')), [], `${label}: no temporary folder`);
    assert.equal(currentName(data), cur);
  }
  rmSync(data, { recursive: true, force: true });
});

test('backup: an incomplete one is never published; the secret only with --include-secrets', async () => {
  const s = await startServer();
  const seed = await seeded(s);
  const work = await tmp('bk2');
  try {
    const dir = releaseDir(s.dataDir, currentName(s.dataDir));
    const plain = join(work, 'plain.tar.gz');
    const withSecret = join(work, 'secret.tar.gz');
    assert.equal(script('backup.js', [], { data: s.dataDir, output: plain }).status, 0);
    assert.equal(script('backup.js', ['--include-secrets'], { data: s.dataDir, output: withSecret }).status, 0);
    const list = (f) => spawnSync('tar', ['tzf', f], { encoding: 'utf8' }).stdout;
    assert.doesNotMatch(list(plain), /session-secret/);
    assert.match(list(withSecret), /session-secret/);
    assert.match(list(plain), new RegExp(`images/${seed.photo}`));

    // A photo deleted after the snapshot on every attempt: the backup fails (exit 3).
    const gone = join(work, 'gone.tar.gz');
    const hook = `rm -f '${join(dir, 'images', seed.photo)}'`;
    const r = script('backup.js', [], { data: s.dataDir, output: gone, env: { GIFTLY_BACKUP_TEST_HOOK: hook } });
    assert.equal(r.status, 3, r.err);
    assert.match(r.err, /missing from/);
    assert.match(r.err, /trying again from a fresh snapshot/);
    assert.deepEqual(readdirSync(s.dataDir).filter((n) => n.startsWith('.backup-')), []);
    const allowed = script('backup.js', ['--allow-missing-images'], { data: s.dataDir, output: gone });
    assert.equal(allowed.status, 0, allowed.err);
    assert.match(spawnSync('tar', ['xzOf', gone, 'manifest.json'], { encoding: 'utf8' }).stdout, /missing_images/);
    // Restoring it needs the flag too.
    const refused = script('restore.js', [], { data: s.dataDir, input: gone });
    assert.notEqual(refused.status, 0);
    assert.match(refused.err, /missing 1 photo/);
    const restored = script('restore.js', ['--allow-missing-images'], { data: s.dataDir, input: gone });
    assert.equal(restored.status, 0, restored.err);
  } finally {
    await s.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
