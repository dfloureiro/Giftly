// 3.2: wishlists for any person (synced to lists), gift history, and the move from "ideas".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAdmin, inviteAdmin, joinList, pickableIds, personId } from './helpers.js';

let server, diogo, maria;
before(async () => {
  server = await startServer();
  diogo = await loginAdmin(server.base);
  maria = await inviteAdmin(server.base, diogo, { username: 'maria32', name: 'Maria' });
});
after(async () => { await server?.stop(); });

const idFrom = (loc, what) => Number(new RegExp(`/admin/${what}/(\\d+)`).exec(loc)?.[1]);
const addPerson = async (admin, fields) =>
  idFrom((await admin.post('/admin/people', { visibility: 'shared', ...fields }, { from: '/admin/people' })).location, 'people');
async function addWish(admin, personId, title, extra = {}) {
  const r = await admin.post('/admin/wishlist/items', { person_id: String(personId), title, ...extra }, { from: `/admin/people/${personId}` });
  assert.equal(r.status, 303, `add wish: ${r.status}`);
  return Number(/#wish-(\d+)/.exec(r.location)?.[1]);
}
const wishlistIdOf = async (admin, personId) =>
  Number(/\/admin\/wishlists\/(\d+)\/new-list/.exec((await admin.get(`/admin/people/${personId}/new-list`)).location)[1]);

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

  await maria.post(`/admin/wishlist/items/${kite}`, { title: 'Red kite', url: '' }, { from: `/admin/people/${leo}` });
  const guest = await joinList(server.base, list.token, 'Avó');
  assert.match((await guest.get(`/l/${list.token}`)).text, /Red kite/, 'list follows the wishlist');
  const [first] = await pickableIds(guest, list.token);
  await guest.post(`/l/${list.token}/pick/${first}`, {}, { from: `/l/${list.token}` });
  const page = (await maria.get(`/admin/people/${leo}`)).text;
  assert.match(page, /Already chosen/, 'editors see what is taken (they are not the recipient)');
  assert.equal((await diogo.get(`/admin/wishlists/${wid}`)).status, 404, 'no separate wishlist page (5.0): it lives on the person');
});

test('"I\'ll give it" from a person\'s wishlist: shared gift, item taken everywhere; history shows it', async () => {
  const sofia = await addPerson(diogo, { name: 'Sofia32', birthday_day: '1', birthday_month: '1' });
  const book = await addWish(diogo, sofia, 'Big book');
  const wid = await wishlistIdOf(diogo, sofia);
  const list = await listFrom(diogo, wid, [book], 'For Sofia');
  const page = (await diogo.get(`/admin/people/${sofia}`)).text;
  const occasion = /<option value="(birthday:\d+)"/.exec(page)[1];
  const r = await diogo.post(`/admin/wishlists/${wid}/items/${book}/give`, { occasion, back: `/admin/people/${sofia}` }, { from: `/admin/people/${sofia}` });
  assert.match(r.location, new RegExp(`^/admin/people/${sofia}\\?m=giving`));
  const guest = await joinList(server.base, list.token, 'Tio');
  assert.deepEqual(await pickableIds(guest, list.token), [], 'reserved in every list');
  const forMaria = (await maria.get(`/admin/people/${sofia}`)).text;
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

test("an admin's record: her own wishlist (read-only) + ideas for her she never sees; lists can mix both", async () => {
  await maria.post('/admin/wishlist/items', { title: 'Maria own wish' }, { from: '/admin/wishlist' });
  const mariaPerson = await personId(diogo, 'Maria'); // created when she joined (5.0)
  assert.ok(mariaPerson);
  const page = (await diogo.get(`/admin/people/${mariaPerson}`)).text;
  assert.match(page, /Maria own wish/);
  assert.match(page, /Ideas for Maria/);
  const idea = await addWish(diogo, mariaPerson, 'Secret idea for Maria');

  // Maria never sees nor touches the ideas for her.
  assert.ok(!(await maria.get(`/admin/people/${mariaPerson}`)).text.includes('Secret idea'));
  assert.equal((await maria.post('/admin/wishlist/items', { person_id: String(mariaPerson), title: 'x' }, { from: '/admin/lists' })).status, 404);
  assert.equal((await maria.post(`/admin/wishlist/items/${idea}`, { title: 'peek' }, { from: '/admin/lists' })).status, 404);
  const ideasWid = Number(new RegExp(`/admin/wishlists/(\\d+)/items/${idea}/give`).exec((await diogo.get(`/admin/people/${mariaPerson}`)).text)[1]);
  assert.equal((await maria.get(`/admin/wishlists/${ideasWid}/new-list`)).status, 404);
  assert.equal((await maria.get(`/admin/wishlists/${ideasWid}`)).status, 404);

  // A list from both wishlists: Diogo picks items from each; new items of either join it; Maria can't see it.
  const ownWid = await wishlistIdOf(diogo, mariaPerson);
  const newList = (await diogo.get(`/admin/wishlists/${ownWid}/new-list`)).text;
  assert.match(newList, /Maria own wish/);
  assert.match(newList, /Secret idea for Maria/);
  const ids = [...newList.matchAll(/name="items" value="(\d+)"/g)].map((m) => Number(m[1]));
  const list = await listFrom(diogo, ownWid, ids, 'For Maria');
  await addWish(diogo, mariaPerson, 'Later idea');
  const guest = await joinList(server.base, list.token, 'Primo');
  const shown = (await guest.get(`/l/${list.token}`)).text;
  for (const t of ['Maria own wish', 'Secret idea for Maria', 'Later idea']) assert.match(shown, new RegExp(t));
  assert.equal((await maria.get(`/admin/lists/${list.id}`)).status, 404);
  assert.ok(!(await maria.get('/admin/lists')).text.includes('For Maria'));

  // A plain person with a list from their wishlist; an admin with that name joins and the others
  // are asked whether it is the same person (never linked alone). Once linked: hidden from her.
  const joana = await addPerson(diogo, { name: 'Joana32' });
  const w = await addWish(diogo, joana, 'Linked later');
  const list2 = await listFrom(diogo, await wishlistIdOf(diogo, joana), [w], 'Before linking');
  const joanaAdmin = await inviteAdmin(server.base, diogo, { username: 'joana32', name: 'Joana32' });
  assert.equal((await joanaAdmin.get(`/admin/lists/${list2.id}`)).status, 200, 'not linked by itself');
  const people = (await diogo.get('/admin/people')).text;
  assert.match(people, /There is already a person called “Joana32”. Is it the same one\?/);
  const uid = Number(/\/admin\/people\/admins\/(\d+)\/link/.exec(people)[1]);
  assert.equal((await joanaAdmin.post(`/admin/people/admins/${uid}/link`, { person_id: String(joana) }, { from: '/admin/people' })).status, 404, 'not by herself');
  assert.equal((await diogo.post(`/admin/people/admins/${uid}/link`, { person_id: String(joana) }, { from: '/admin/people' })).status, 303);
  assert.equal((await joanaAdmin.get(`/admin/lists/${list2.id}`)).status, 404);
  assert.equal((await joanaAdmin.get(`/admin/people/${joana}`)).status, 404);
  assert.ok(!(await diogo.get('/admin/people')).text.includes('Is it the same one'), 'answered once for everyone');
  assert.equal((await diogo.post(`/admin/people/${joana}/delete`, {}, { from: '/admin/people' })).status, 404, "an admin's record can't be deleted");
});

test('"last year" only lists gifts that were actually bought or given', async () => {
  const p = await addPerson(diogo, { name: 'LastYear32' });
  const y = new Date().getFullYear() + 50;
  const prev = idFrom((await diogo.post('/admin/occasions/christmas', { year: String(y) }, { from: '/admin/occasions' })).location, 'occasions');
  const cur = idFrom((await diogo.post('/admin/occasions/christmas', { year: String(y + 1) }, { from: '/admin/occasions' })).location, 'occasions');
  for (const id of [prev, cur]) await diogo.post(`/admin/occasions/${id}/participants`, { person_id: String(p) }, { from: '/admin/occasions' });
  await diogo.post('/admin/gifts', { person_id: String(p), occasion: `occasion:${prev}`, name: 'Never bought', status: 'planned' }, { from: '/admin/occasions' });
  await diogo.post('/admin/gifts', { person_id: String(p), occasion: `occasion:${prev}`, name: 'Actually given', status: 'given' }, { from: '/admin/occasions' });
  const html = (await diogo.get(`/admin/occasions/${cur}`)).text;
  assert.match(html, /Last year[^<]*: Actually given</);
  assert.ok(!/Last year[^<]*Never bought/.test(html));
});

test('"pick from the wishlist" from an occasion: one-tap buttons, then back to the occasion', async () => {
  const kid = await addPerson(diogo, { name: 'Pick32' });
  const wi = await addWish(diogo, kid, 'Robot kit');
  await addWish(diogo, kid, 'Paint set');
  const y = new Date().getFullYear() + 40;
  const occ = idFrom((await diogo.post('/admin/occasions/christmas', { year: String(y) }, { from: '/admin/occasions' })).location, 'occasions');
  const page = (await diogo.get(`/admin/people/${kid}?occasion=occasion:${occ}`)).text;
  assert.match(page, new RegExp(`Choosing for <strong>Christmas ${y}</strong>`));
  assert.equal((page.match(/class="give-now"/g) || []).length, 2, 'one button per free item');
  assert.ok(!/<details class="edit" open>/.test(page), 'no forms opened all at once');
  const wid = await wishlistIdOf(diogo, kid);
  const r = await diogo.post(`/admin/wishlists/${wid}/items/${wi}/give`, { occasion: `occasion:${occ}`, back: `/admin/occasions/${occ}` }, { from: `/admin/people/${kid}` });
  assert.match(r.location, new RegExp(`^/admin/occasions/${occ}\\?m=giving#gift-\\d+$`));
  assert.match((await diogo.get(`/admin/occasions/${occ}`)).text, /Robot kit/);
});
