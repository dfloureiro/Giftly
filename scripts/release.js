// Giftly's data releases (see the README, "Data and recovery"). Run inside the container:
//   node scripts/release.js current          the release /data/current points to
//   node scripts/release.js list             all releases, newest last (* = current)
//   node scripts/release.js switch NAME      point /data/current at NAME (ONLY while Giftly is stopped)
//   node scripts/release.js discard NAME     delete a release that is neither current nor its parent
//   node scripts/release.js detach           remove the current link (releases stay), so the next start
//                                            copies the 3.x data in /data again (after going back to 3.x)
// Used by restore.sh and install.sh; also the manual way back to an earlier release.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { currentName, listReleases, readManifest, releaseDir, RELEASE_NAME_RE, switchCurrent } from '../src/release.js';
import { runAsDataOwner } from './_common.js';

runAsDataOwner();
const root = process.env.DATA_DIR || './data';
const [cmd, name] = process.argv.slice(2);
const fail = (msg) => { console.error(`Error: ${msg}`); process.exit(1); };

try {
  if (cmd === 'current') {
    const cur = currentName(root);
    if (!cur) fail(`no data release yet in ${root} (Giftly creates one on its first start)`);
    console.log(cur);
  } else if (cmd === 'list') {
    const cur = currentName(root);
    for (const n of listReleases(root)) {
      const m = readManifest(root, n) || {};
      console.log(`${n === cur ? '*' : ' '} ${n}  ${m.origin ?? '?'}  Giftly ${m.giftly ?? '?'}  schema ${m.schema ?? '?'}${m.parent ? `  from ${m.parent}` : ''}`);
    }
  } else if (cmd === 'switch') {
    if (!name) fail('switch which release?');
    switchCurrent(root, name);
    console.log(`current -> releases/${name}`);
  } else if (cmd === 'discard') {
    if (!name || !RELEASE_NAME_RE.test(name) || !readManifest(root, name)) fail(`no data release named ${name}`);
    const cur = currentName(root);
    if (name === cur || name === readManifest(root, cur)?.parent) fail(`${name} is the current release or its parent; it is kept`);
    rmSync(releaseDir(root, name), { recursive: true, force: true });
    console.log(`removed releases/${name}`);
  } else if (cmd === 'detach') {
    if (!existsSync(join(root, 'giftly.db'))) fail(`no 3.x data in ${root}: detaching would make the next start empty; refused`);
    rmSync(join(root, 'current'), { force: true });
    console.log('current link removed; the next start copies the 3.x data again');
  } else {
    fail('usage: node scripts/release.js current|list|switch NAME|discard NAME|detach');
  }
} catch (err) {
  fail(err.message);
}
