// Which data release the RUNNING Giftly serves (asks the server itself, not the files on disk).
// Run inside the container:
//   node scripts/served.js                 prints the server's answer (JSON)
//   node scripts/served.js --expect NAME   exit 0 only if it serves NAME, or the upgrade of NAME
// /healthz alone isn't enough: it also passes on an empty database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const args = process.argv.slice(2);
const expect = args[0] === '--expect' ? args[1] : null;
const root = process.env.DATA_DIR || './data';
const port = Number(process.env.PORT || 3000);
const fail = (msg) => { console.error(msg); process.exit(1); };

let token;
try { token = readFileSync(join(root, '.healthz-token'), 'utf8').trim(); } catch { fail('Giftly has not started (no token yet)'); }

const res = await new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/healthz/data', agent: false, timeout: 5000, headers: { authorization: `Bearer ${token}` } }, (r) => {
    let body = '';
    r.setEncoding('utf8');
    r.on('data', (c) => { body += c; });
    r.on('end', () => resolve({ status: r.statusCode, body }));
    r.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', reject);
}).catch((err) => fail(`Giftly isn't answering: ${err.message}`));

if (res.status !== 200) fail(`Giftly answered ${res.status}`);
let served;
try { served = JSON.parse(res.body); } catch { fail('Giftly gave an unexpected answer'); }
console.log(JSON.stringify(served));
if (expect) {
  const ok = served.release === expect || (served.origin === 'upgrade' && served.parent === expect);
  if (!ok) fail(`Giftly serves release ${served.release}, not ${expect}`);
  if (!served.verified_at) fail(`release ${served.release} was not verified`);
}
