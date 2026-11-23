// Giftly backup, run INSIDE the container by scripts/backup.sh (archive on stdout):
//   node scripts/backup.js [--include-secrets] [--allow-missing-images] > backup.tar.gz
//
// Giftly keeps running. A consistent snapshot of the current release's database (VACUUM INTO),
// exactly the photos THAT snapshot uses (hard links: a photo deleted meanwhile is still held),
// their fingerprint and checksums, written as one archive. If a photo was replaced between the
// snapshot and the copy, it retries from a fresh snapshot. An incomplete backup fails (exit 3)
// unless --allow-missing-images; the staging folder is always removed.
// GIFTLY_BACKUP_TEST_HOOK (tests only): a shell command run after each snapshot (ATTEMPT=n).
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentName, fingerprint, imageRefs, linkImages, releaseDir, snapshotDb, APP_VERSION } from '../src/release.js';
import { writeTarGz } from '../src/archive.js';

const args = process.argv.slice(2);
const secrets = args.includes('--include-secrets');
const allowMissing = args.includes('--allow-missing-images');
for (const a of args) if (!['--include-secrets', '--allow-missing-images'].includes(a)) { console.error(`Error: unknown option ${a}`); process.exit(2); }
const fail = (msg, code = 3) => { console.error(`Error: ${msg}`); process.exitCode = code; throw new Error(msg); };
if (process.stdout.isTTY) { console.error('Error: the archive goes to stdout; redirect it to a file (backup.sh does this).'); process.exit(2); }

const root = process.env.DATA_DIR || './data';
const T = join(root, `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`);

try {
  const name = currentName(root);
  if (!name) fail(`no data release in ${root}; has Giftly started?`);
  const live = releaseDir(root, name);
  let missing = [];
  for (let attempt = 1; ; attempt++) {
    rmSync(T, { recursive: true, force: true });
    mkdirSync(join(T, 'images'), { recursive: true });
    snapshotDb(join(live, 'giftly.db'), join(T, 'giftly.db'));
    const db = new DatabaseSync(join(T, 'giftly.db'), { readOnly: true });
    let refs;
    try { refs = imageRefs(db); } finally { db.close(); }
    if (process.env.GIFTLY_BACKUP_TEST_HOOK) {
      spawnSync('sh', ['-c', process.env.GIFTLY_BACKUP_TEST_HOOK], { stdio: ['ignore', 2, 2], env: { ...process.env, ATTEMPT: String(attempt) } });
    }
    missing = linkImages(join(live, 'images'), join(T, 'images'), refs);
    if (!missing.length || attempt >= 3) break;
    console.error(`Note: photo(s) ${missing.join(' ')} changed while backing up; trying again from a fresh snapshot.`);
  }
  if (missing.length) {
    if (!allowMissing) {
      fail(`the database uses photo(s) missing from ${join(live, 'images')}: ${missing.join(' ')}. Put them back, or replace or remove the photo on the gift that uses each one; or run with --allow-missing-images to back up without them.`);
    }
    console.error(`Warning: backing up WITHOUT these missing photo(s) (--allow-missing-images): ${missing.join(' ')}`);
  }
  // The archive holds exactly the photos the snapshot uses (minus allowed missing ones), none empty.
  const got = readdirSync(join(T, 'images')).sort();
  const db = new DatabaseSync(join(T, 'giftly.db'), { readOnly: true });
  let expected;
  try { expected = imageRefs(db).filter((f) => !missing.includes(f)); } finally { db.close(); }
  if (got.join() !== expected.join()) fail("the photos copied don't match the ones the database uses");
  for (const f of got) if (readFileSync(join(T, 'images', f)).length === 0) fail(`photo ${f} is empty`);

  const fp = fingerprint(T);
  const files = [{ name: 'giftly.db', file: join(T, 'giftly.db') }, ...got.map((f) => ({ name: `images/${f}`, file: join(T, 'images', f) }))];
  const secretFile = join(live, '.session-secret');
  if (secrets && existsSync(secretFile)) files.push({ name: 'session-secret', data: readFileSync(secretFile) });
  const manifest = {
    format: 2, giftly: APP_VERSION, schema: fp.schema, created_at: new Date().toISOString(), release: name,
    images: got.length, includes_secrets: secrets && existsSync(secretFile), fingerprint: fp,
    ...(missing.length ? { missing_images: missing } : {}),
  };
  files.push({ name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });
  const sums = files.map((e) => {
    const h = createHash('sha256').update(e.data !== undefined ? Buffer.from(e.data) : readFileSync(e.file)).digest('hex');
    return `${h}  ${e.name}\n`;
  }).join('');
  files.push({ name: 'SHA256SUMS', data: sums });
  await writeTarGz(files, process.stdout);
  console.error(`Backup of release ${name}: Giftly ${APP_VERSION}, schema ${fp.schema}, ${got.length} photo(s)${manifest.includes_secrets ? ', with session secret' : ''}.`);
} catch (err) {
  if (!process.exitCode) { console.error(`Error: ${err.message}`); process.exitCode = 1; }
} finally {
  rmSync(T, { recursive: true, force: true });
}
