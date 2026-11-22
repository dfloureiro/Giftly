// Shared bits for the account scripts run with `docker exec`.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docker exec` runs as root by default. Writing the database as another user than the
 * app's would leave files the app can't write, so re-run this script as the owner of
 * the data directory (the "node" user in the official image).
 */
export function runAsDataOwner() {
  if (process.getuid?.() !== 0) return;
  const dataDir = process.env.DATA_DIR || './data';
  let owner;
  try { owner = statSync(join(dataDir, 'giftly.db')); } catch { owner = statSync(dataDir, { throwIfNoEntry: false }); }
  if (!owner || owner.uid === 0) return; // root-owned data: nothing to switch to
  const r = spawnSync('su-exec', [`${owner.uid}:${owner.gid}`, process.execPath, '--disable-warning=ExperimentalWarning', ...process.argv.slice(1)], { stdio: 'inherit' });
  if (r.error) {
    console.error('Running as root and could not switch to the data owner. Use: docker exec -u node giftly node scripts/…');
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

export function linkUrl(path) {
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}${path}` : `https://<your-giftly-address>${path}`;
}
