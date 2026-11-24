// Seeds a running Giftly with real data (lists, wishlist, gifts to give, uploaded photos) and
// later checks that it's all there and served. Used by test/backup/run.sh.
//   node data.mjs seed|verify|absent BASE USERNAME PASSWORD STATEFILE
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, loginAdmin } from '../helpers.js';

const [mode, base, username, password, state] = process.argv.slice(2);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgs = (html) => [...new Set([...html.matchAll(/\/img\/([a-z0-9]+\.(?:png|jpg|webp|gif|avif))/g)].map((m) => m[1]))];
const fail = (msg) => { console.error(`data.mjs ${mode}: ${msg}`); process.exit(1); };

const admin = await loginAdmin(base, { username, password }).catch((e) => fail(e.message));

if (mode === 'seed') {
  const r = await admin.post('/admin/lists', { title: 'Backup list', visibility: 'shared' }, { from: '/admin/lists' });
  const listId = Number(/\/admin\/lists\/(\d+)/.exec(r.location)?.[1]);
  await admin.post(`/admin/lists/${listId}/items`, { title: 'Photo gift', image_data: PNG }, { from: `/admin/lists/${listId}` });
  await admin.post('/admin/wishlist/items', { title: 'Wished lamp', image_data: PNG }, { from: '/admin/wishlist' });
  const p = await admin.post('/admin/people', { name: 'Backup Leo', visibility: 'shared' }, { from: '/admin/people' });
  const personId = Number(/people\/(\d+)/.exec(p.location)?.[1]);
  await admin.post('/admin/gifts', { person_id: String(personId), occasion: 'birthday:2030', name: 'Kite', status: 'bought', image_data: PNG }, { from: `/admin/people/${personId}` });
  const files = [
    ...imgs((await admin.get(`/admin/lists/${listId}`)).text),
    ...imgs((await admin.get('/admin/wishlist')).text),
    ...imgs((await admin.get(`/admin/people/${personId}`)).text),
  ];
  if (files.length < 3) fail(`expected 3 photos, found ${files.length}`);
  writeFileSync(state, JSON.stringify({ listId, personId, files }));
  console.log(`seeded: list ${listId}, person ${personId}, ${files.length} photos`);
} else if (mode === 'verify') {
  const { listId, personId, files } = JSON.parse(readFileSync(state, 'utf8'));
  if (!(await admin.get(`/admin/lists/${listId}`)).text.includes('Photo gift')) fail('list gift missing');
  if (!(await admin.get('/admin/wishlist')).text.includes('Wished lamp')) fail('wishlist item missing');
  if (!(await admin.get(`/admin/people/${personId}`)).text.includes('Kite')) fail('gift to give missing');
  for (const f of files) {
    const res = await admin.request(`/img/${f}`);
    if (res.status !== 200) fail(`photo ${f} not served (${res.status})`);
  }
  if ((await new Client(base).request(`/img/${files[0]}`)).status !== 404) fail('photos must not be public');
  console.log(`verified: everything back, ${files.length} photos served`);
} else if (mode === 'absent') {
  if ((await admin.get('/admin/lists')).text.includes('Backup list')) fail('data still there');
  console.log('verified: the data is gone');
} else fail('unknown mode');
