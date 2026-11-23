// Giftly restore, step 1, run INSIDE a container with Giftly's /data by scripts/restore.sh:
//   node scripts/restore.js [--allow-missing-images] < giftly-backup-….tar.gz
//
// Unpacks the backup into a NEW data release and checks it; never touches the current one, so
// Giftly may keep running meanwhile. Prints "release=<name>" on stdout when the release is
// ready; restore.sh then stops Giftly, switches /data/current to it, starts Giftly and checks
// that it serves it (Giftly itself refuses a release that doesn't match its fingerprint).
// Checks: only expected files, every checksum, manifest format, not from a newer Giftly or
// schema, database integrity, every photo it uses present, fingerprint as recorded.
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_VERSION, IMAGE_FILE_RE, SCHEMA_VERSION, abortRelease, checkRelease, currentName, finishRelease, fingerprint, releaseDir, startRelease,
} from '../src/release.js';
import { readTarGz } from '../src/archive.js';
import { runAsDataOwner } from './_common.js';

runAsDataOwner();
const args = process.argv.slice(2);
const allowMissing = args.includes('--allow-missing-images');
for (const a of args) if (a !== '--allow-missing-images') { console.error(`Error: unknown option ${a}`); process.exit(2); }
const root = process.env.DATA_DIR || './data';

const ALLOWED = (n) => ['manifest.json', 'SHA256SUMS', 'giftly.db', 'session-secret', 'images/'].includes(n)
  || (n.startsWith('images/') && IMAGE_FILE_RE.test(n.slice(7)));
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

let release = null;
try {
  const parent = currentName(root);
  if (!parent) throw new Error(`no data release in ${root} yet; start Giftly once, then restore`);
  release = startRelease(root);
  const dir = release.tmp;
  const sums = await readTarGz(process.stdin, dir, ALLOWED).catch((err) => {
    throw new Error(`${err.message}. Is this a Giftly backup?`);
  });
  if (!('manifest.json' in sums) || !('SHA256SUMS' in sums) || !('giftly.db' in sums)) {
    throw new Error('not a Giftly backup (manifest, checksums or database missing)');
  }
  // Every file is listed in SHA256SUMS with the hash it arrived with, and nothing else is.
  const listed = {};
  for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m || m[2] in listed) throw new Error("the backup is damaged: its checksum list is invalid");
    listed[m[2]] = m[1];
  }
  const got = Object.keys(sums).filter((n) => n !== 'SHA256SUMS').sort();
  if (got.join() !== Object.keys(listed).sort().join()) throw new Error("the backup has files its checksums don't cover (or lacks some it lists)");
  for (const n of got) if (sums[n] !== listed[n]) throw new Error(`the backup is damaged: checksums don't match (${n})`);

  const backup = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (backup.format !== 2) {
    throw new Error('this backup is in an older format (Giftly 3.x). Restore it with Giftly 3.5, then update and take a new backup');
  }
  if (newer(backup.giftly, APP_VERSION) || backup.schema > SCHEMA_VERSION) {
    throw new Error(`this backup is from Giftly ${backup.giftly} (database schema ${backup.schema}), newer than the one installed (${APP_VERSION}, schema ${SCHEMA_VERSION}). Update Giftly first, then restore`);
  }
  const { missing } = checkRelease(dir, { allowMissingImages: true });
  if (missing.length) {
    if (!allowMissing) {
      throw new Error(`the backup is missing ${missing.length} photo(s) its database uses: ${missing.join(' ')}. To restore it anyway (those gifts show no photo), add --allow-missing-images`);
    }
    console.error(`Warning: restoring WITHOUT ${missing.length} missing photo(s) (--allow-missing-images): ${missing.join(' ')}`);
  }
  const fp = fingerprint(dir);
  if (!backup.fingerprint || fp.sha256 !== backup.fingerprint.sha256) {
    throw new Error("the backup's data doesn't match the fingerprint in its manifest");
  }
  // The session secret: the backup's (--include-secrets), or else the one in use now.
  if (existsSync(join(dir, 'session-secret'))) {
    copyFileSync(join(dir, 'session-secret'), join(dir, '.session-secret'));
  } else if (existsSync(join(releaseDir(root, parent), '.session-secret'))) {
    copyFileSync(join(releaseDir(root, parent), '.session-secret'), join(dir, '.session-secret'));
  }
  for (const f of ['session-secret', 'SHA256SUMS']) rmSync(join(dir, f), { force: true });
  renameSync(join(dir, 'manifest.json'), join(dir, 'backup-manifest.json'));
  const name = finishRelease(root, release, {
    origin: 'restore', parent, fingerprint: fp,
    backup: { giftly: backup.giftly, created_at: backup.created_at, release: backup.release ?? null },
    ...(missing.length ? { missing_images: missing } : {}),
  });
  release = null;
  const images = readdirSync(join(releaseDir(root, name), 'images')).length;
  console.error(`Backup: Giftly ${backup.giftly}, schema ${backup.schema}, ${backup.created_at}, ${images} photo(s)${backup.includes_secrets ? ', with session secret' : ''}.`);
  console.error(`Checked and unpacked into ${releaseDir(root, name)} (the current data, ${parent}, is untouched).`);
  console.log(`release=${name}`);
} catch (err) {
  if (release) abortRelease(release);
  console.error(`Error: ${err.message}. Nothing was changed.`);
  process.exit(1);
}
