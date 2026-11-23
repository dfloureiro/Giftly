// 3.2: wishlists for any person (synced to lists), gift history, and the move from "ideas".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, loginAdmin, inviteAdmin, joinList, pickableIds } from './helpers.js';

let server, diogo, maria, mariaUserId;
before(async () => {
  server = await startServer();
  diogo = await loginAdmin(server.base);
  maria = await inviteAdmin(server.base, diogo, { username: 'maria32', name: 'Maria' });
  mariaUserId = Number(/<code>maria32<\/code><\/td>[\s\S]*?\/admin\/users\/(\d+)\/reset-link/.exec((await diogo.get('/admin/users')).text)[1]);
});
after(async () => { await server?.stop(); });

const idFrom = (loc, what) => Number(new RegExp(`/admin/${what}/(\\d+)`).exec(loc)?.[1]);
const addPerson = async (admin, fields) =>
  idFrom((await admin.post('/admin/give/people', { visibility: 'shared', ...fields }, { from: '/admin/give/people' })).location, 'give/people');
async function addWish(admin, personId, title, extra = {}) {
  const r = await admin.post('/admin/wishlist/items', { person_id: String(personId), title, ...extra }, { from: `/admin/give/people/${personId}` });
  assert.equal(r.status, 303, `add wish: ${r.status}`);
  return Number(/#wish-(\d+)/.exec(r.location)?.[1]);
}
const wishlistIdOf = async (admin, personId) =>
  Number(/\/admin\/wishlists\/(\d+)\/new-list/.exec((await admin.get(`/admin/give/people/${personId}`)).text)[1]);

async function listFrom(admin, wid, itemIds, title) {
  const form = new URLSearchParams({ title, visibility: 'shared', auto_add_new: '1' });
  for (const id of itemIds) form.append('items', String(id));
  form.append('_csrf', await admin.csrf(`/admin/wishlists/${wid}/new-list`));
  const res = await fetch(`${server.base}/admin/wishlists/${wid}/new-list`, { method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' } });
  const id = idFrom(res.headers.get('location'), 'lists');
  const page = (await admin.get(`/admin/lists/${id}`)).text;
  return { id, token: /\/l\/([A-Za-z0-9_-]{22})/.exec(page)[1] };
}

test("a person's wishlist: edited by any admin who sees them, synced to lists, shows what's taken", async () => {
  const leo = await addPerson(diogo, { name: 'Leo32' });
  const kite = await addWish(diogo, leo, 'Kite');
  const lego = await addWish(maria, leo, 'Lego set'); // Maria can edit a shared person's wishlist too
  const wid = await wishlistIdOf(diogo, leo);
  const list = await listFrom(diogo, wid, [kite, lego], 'For Leo');

  await maria.post(`/admin/wishlist/items/${kite}`, { title: 'Red kite', url: '' }, { from: `/admin/give/people/${leo}` });
  const guest = await joinList(server.base, list.token, 'Avó');
  assert.match((await guest.get(`/l/${list.token}`)).text, /Red kite/, 'list follows the wishlist');
  const [first] = await pickableIds(guest, list.token);
  await guest.post(`/l/${list.token}/pick/${first}`, {}, { from: `/l/${list.token}` });
  const page = (await maria.get(`/admin/give/people/${leo}`)).text;
  assert.match(page, /Already chosen/, 'editors see what is taken (they are not the recipient)');
  assert.equal((await diogo.get(`/admin/wishlists/${wid}`)).location, `/admin/give/people/${leo}#wishlist`);
});

test('"I\'ll give it" from a person\'s wishlist: shared gift, item taken everywhere; history shows it', async () => {
  const sofia = await addPerson(diogo, { name: 'Sofia32', birthday_day: '1', birthday_month: '1' });
  const book = await addWish(diogo, sofia, 'Big book');
  const wid = await wishlistIdOf(diogo, sofia);
  const list = await listFrom(diogo, wid, [book], 'For Sofia');
  const page = (await diogo.get(`/admin/give/people/${sofia}`)).text;
  const occasion = /<option value="(birthday:\d+)"/.exec(page)[1];
  const r = await diogo.post(`/admin/wishlists/${wid}/items/${book}/give`, { occasion, back: `/admin/give/people/${sofia}` }, { from: `/admin/give/people/${sofia}` });
  assert.match(r.location, new RegExp(`^/admin/give/people/${sofia}\\?m=giving`));
  const guest = await joinList(server.base, list.token, 'Tio');
  assert.deepEqual(await pickableIds(guest, list.token), [], 'reserved in every list');
  const forMaria = (await maria.get(`/admin/give/people/${sofia}`)).text;
  assert.match(forMaria, /Gift history[\s\S]*Big book/, 'a shared gift: the other admin sees who gives what');
});

test('private people: their wishlist is invisible and uneditable for other admins', async () => {
  const secret = await addPerson(diogo, { name: 'Private32', visibility: 'private' });
  const item = await addWish(diogo, secret, 'Hidden wish');
  const wid = await wishlistIdOf(diogo, secret);
  assert.equal((await maria.post('/admin/wishlist/items', { person_id: String(secret), title: 'x' }, { from: '/admin/wishlist' })).status, 404);
  assert.equal((await maria.post(`/admin/wishlist/items/${item}`, { title: 'hacked' }, { from: '/admin/wishlist' })).status, 404);
  assert.equal((await maria.get(`/admin/wishlists/${wid}`)).status, 404);
  assert.equal((await maria.get(`/admin/wishlists/${wid}/new-list`)).status, 404);
  const order = await maria.request('/admin/wishlist/order', { method: 'POST', form: { _csrf: await maria.csrf('/admin/wishlist'), person_id: String(secret), order: String(item) } });
  assert.equal(order.status, 404);
});

test("a person linked to an admin shows that admin's wishlist (read-only); lists from a person's wishlist hide from them if linked later", async () => {
  await maria.post('/admin/wishlist/items', { title: 'Maria own wish' }, { from: '/admin/wishlist' });
  const mariaPerson = await addPerson(diogo, { name: 'Maria (person)', user_id: String(mariaUserId) });
  const page = (await diogo.get(`/admin/give/people/${mariaPerson}`)).text;
  assert.match(page, /Maria own wish/);
  assert.ok(!page.includes('Add to the wishlist'), 'no add form: she edits her own wishlist');
  assert.equal((await diogo.post('/admin/wishlist/items', { person_id: String(mariaPerson), title: 'x' }, { from: '/admin' })).status, 404);

  // A plain person with a list from their wishlist, later linked to Maria's account → hidden from Maria.
  const cousin = await addPerson(diogo, { name: 'Becomes admin' });
  const w = await addWish(diogo, cousin, 'Linked later');
  const list = await listFrom(diogo, await wishlistIdOf(diogo, cousin), [w], 'Before linking');
  assert.equal((await maria.get(`/admin/lists/${list.id}`)).status, 200);
  await diogo.post(`/admin/give/people/${cousin}`, { name: 'Becomes admin', user_id: String(mariaUserId) }, { from: `/admin/give/people/${cousin}` });
  assert.equal((await maria.get(`/admin/lists/${list.id}`)).status, 404);
});

test('"last year" only lists gifts that were actually bought or given', async () => {
  const p = await addPerson(diogo, { name: 'LastYear32' });
  const y = new Date().getFullYear() + 50;
  const prev = idFrom((await diogo.post('/admin/give/occasions/christmas', { year: String(y) }, { from: '/admin/give/occasions' })).location, 'give/occasions');
  const cur = idFrom((await diogo.post('/admin/give/occasions/christmas', { year: String(y + 1) }, { from: '/admin/give/occasions' })).location, 'give/occasions');
  for (const id of [prev, cur]) await diogo.post(`/admin/give/occasions/${id}/participants`, { person_id: String(p) }, { from: '/admin/give' });
  await diogo.post('/admin/give/gifts', { person_id: String(p), occasion: `occasion:${prev}`, name: 'Never bought', status: 'idea' }, { from: '/admin/give' });
  await diogo.post('/admin/give/gifts', { person_id: String(p), occasion: `occasion:${prev}`, name: 'Actually given', status: 'given' }, { from: '/admin/give' });
  const html = (await diogo.get(`/admin/give/occasions/${cur}`)).text;
  assert.match(html, /Last year[^<]*: Actually given</);
  assert.ok(!/Last year[^<]*Never bought/.test(html));
});

test('upgrading: shared ideas for non-admins move to the wishlist; private ideas and ideas for admins stay', async () => {
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'giftly-unit-32-'));
  process.env.ADMIN_PASSWORD = '';
  const { db, settings } = await import('../src/db.js');
  const g = await import('../src/giving.js');
  const { convertLegacyIdeas, wishlists, wishItems } = await import('../src/wishlist.js');
  const now = Date.now();
  const u = Number(db.prepare("INSERT INTO users (username, name, password_hash, created_at) VALUES ('a', 'A', 'x', 0)").run().lastInsertRowid);
  const admin2 = Number(db.prepare("INSERT INTO users (username, name, password_hash, created_at) VALUES ('b', 'B', 'x', 0)").run().lastInsertRowid);
  const kid = g.people.create(u, { name: 'Kid', visibility: 'shared' });
  const adminPerson = g.people.create(u, { name: 'Admin B', visibility: 'shared', user_id: admin2 });
  const mk = (person, name, visibility) => g.gifts.create(u, { person_id: person, occasion_id: null, year: 2026, name, url: 'https://shop.example/x', status: 'idea', visibility, price_cents: 1250, price_currency: 'EUR' });
  const shared = mk(kid, 'Shared idea', 'shared');
  mk(kid, 'Private idea', 'private');
  mk(adminPerson, 'Idea for admin', 'shared');
  // The shared idea had been copied to a guest list (3.1) and reserved there.
  const list = Number(db.prepare("INSERT INTO lists (title, token, created_at) VALUES ('L', 'tok32tok32tok32tok32xx', ?)").run(now).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO items (list_id, title, reserved_name, created_at) VALUES (?, 'Shared idea', 'Avó', ?)").run(list, now).lastInsertRowid);
  db.prepare('UPDATE gifts SET list_item_id = ? WHERE id = ?').run(item, shared);

  assert.equal(convertLegacyIdeas(), 1);
  assert.equal(convertLegacyIdeas(), 0, 'runs once');
  const w = wishlists.ofPerson(kid);
  const [wi] = wishItems.ownerView(w.id).active;
  assert.equal(wi.title, 'Shared idea');
  assert.equal(wi.url, 'https://shop.example/x');
  assert.match(wi.price, /12,50/);
  assert.equal(db.prepare('SELECT wishlist_item_id FROM items WHERE id = ?').get(item).wishlist_item_id, wi.id, 'list item now linked');
  assert.ok(db.prepare('SELECT 1 FROM wishlist_claims WHERE wishlist_item_id = ?').get(wi.id), 'its reservation kept');
  const left = db.prepare("SELECT name FROM gifts WHERE status = 'idea' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(left, ['Idea for admin', 'Private idea']);
  assert.equal(settings.all('migrations.').ideas_to_wishlists, '1');
});
