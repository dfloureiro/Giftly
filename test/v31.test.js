// 3.1: favourites, search, duplicating occasions, gift ideas → guest lists, drag-and-drop order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, loginAdmin, inviteAdmin, createList, joinList, pickableIds } from './helpers.js';

let server, diogo, maria;
before(async () => {
  server = await startServer();
  diogo = await loginAdmin(server.base);
  maria = await inviteAdmin(server.base, diogo, { username: 'maria31', name: 'Maria' });
});
after(async () => { await server?.stop(); });

const idFrom = (loc, what) => Number(new RegExp(`/admin/give/${what}/(\\d+)`).exec(loc)?.[1]);
const addPerson = async (admin, fields) =>
  idFrom((await admin.post('/admin/give/people', { visibility: 'shared', ...fields }, { from: '/admin/give/people' })).location, 'people');
const namesIn = (html) => [...html.matchAll(/<a href="\/admin\/give\/people\/\d+">\s*<strong>([^<]+?) ?</g)].map((m) => m[1].trim());

async function addIdea(admin, person, occasion, name, extra = {}) {
  const r = await admin.post('/admin/give/gifts', { person_id: String(person), occasion, name, status: 'idea', visibility: 'shared', ...extra }, { from: '/admin/give' });
  return Number(/#gift-(\d+)/.exec(r.location)[1]);
}

test('favourites are per admin and come first', async () => {
  await addPerson(diogo, { name: 'Aaron' });
  const zoe = await addPerson(diogo, { name: 'Zoe' });
  await diogo.post(`/admin/give/people/${zoe}/favorite`, { on: '1' }, { from: '/admin/give/people' });
  assert.equal(namesIn((await diogo.get('/admin/give/people')).text)[0], 'Zoe');
  assert.equal(namesIn((await maria.get('/admin/give/people')).text)[0], 'Aaron', "Diogo's favourite doesn't change Maria's order");
  await diogo.post(`/admin/give/people/${zoe}/favorite`, { on: '0' }, { from: '/admin/give/people' });
  assert.equal(namesIn((await diogo.get('/admin/give/people')).text)[0], 'Aaron');
});

test('search people (name and notes) and occasions', async () => {
  await addPerson(diogo, { name: 'Bernardo', notes: 'loves chess' });
  const byName = namesIn((await diogo.get('/admin/give/people?q=berna')).text);
  assert.deepEqual(byName, ['Bernardo']);
  assert.deepEqual(namesIn((await diogo.get('/admin/give/people?q=CHESS')).text), ['Bernardo']);
  await diogo.post('/admin/give/occasions', { name: 'Graduation party', date: '2099-06-01' }, { from: '/admin/give/occasions' });
  const occ = (await diogo.get('/admin/give/occasions?q=gradu')).text;
  assert.match(occ, /Graduation party/);
  assert.ok(!/Christmas/.test(occ.split('id="occasion-list"')[1] ?? ''));
});

test('duplicating an occasion copies the people, one year later', async () => {
  const a = await addPerson(diogo, { name: 'Dup A' });
  const b = await addPerson(diogo, { name: 'Dup B' });
  const form = new URLSearchParams({ name: 'Rita christening 2030', date: '2030-05-10' });
  form.append('people', String(a)); form.append('people', String(b));
  form.append('_csrf', await diogo.csrf('/admin/give/occasions'));
  const res = await fetch(`${server.base}/admin/give/occasions`, { method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...diogo.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' } });
  const id = idFrom(res.headers.get('location'), 'occasions');
  await addIdea(diogo, a, `occasion:${id}`, 'Not copied');
  const dup = await diogo.post(`/admin/give/occasions/${id}/duplicate`, {}, { from: `/admin/give/occasions/${id}` });
  const newId = idFrom(dup.location, 'occasions');
  assert.notEqual(newId, id);
  const page = (await diogo.get(`/admin/give/occasions/${newId}`)).text;
  assert.match(page, /Rita christening 2031/);
  assert.match(page, /10 May 2031/);
  assert.match(page, /Dup A/);
  assert.match(page, /Dup B/);
  assert.ok(!page.includes('Not copied'), 'gifts are not copied');
});

test('gift ideas → a new guest list, with a trace on each idea', async () => {
  const leo = await addPerson(diogo, { name: 'Leo31', birthday_day: '1', birthday_month: '1' });
  const g1 = await addIdea(diogo, leo, 'birthday:2099', 'Telescope', { price: '89' });
  await addIdea(diogo, leo, 'birthday:2099', 'Kite');
  const form = new URLSearchParams({ title: 'Ideas for Leo', visibility: 'shared' });
  form.append('gifts', String(g1));
  form.append('_csrf', await diogo.csrf(`/admin/give/people/${leo}/new-list`));
  const res = await fetch(`${server.base}/admin/give/people/${leo}/new-list`, { method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...diogo.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' } });
  const listId = Number(/\/admin\/lists\/(\d+)/.exec(res.headers.get('location'))[1]);
  const listPage = (await diogo.get(`/admin/lists/${listId}`)).text;
  assert.match(listPage, /Telescope/);
  assert.match(listPage, /€89\.00/);
  assert.ok(!listPage.includes('Kite'), 'only the chosen ideas');

  let person = (await diogo.get(`/admin/give/people/${leo}`)).text;
  assert.match(person, /On the list Ideas for Leo<\/a> — Available/);
  const token = /\/l\/([A-Za-z0-9_-]{22})/.exec(listPage)[1];
  const guest = await joinList(server.base, token, 'Avó');
  const [item] = await pickableIds(guest, token);
  await guest.post(`/l/${token}/pick/${item}`, {}, { from: `/l/${token}` });
  person = (await diogo.get(`/admin/give/people/${leo}`)).text;
  assert.match(person, /On the list Ideas for Leo<\/a> — reserved by Avó/);
});

test('ideas for an admin never end up in a list that admin can see', async () => {
  const me = await addPerson(diogo, { name: 'Maria (admin)', user_id: String(/\/admin\/users\/(\d+)\/reset-link/.exec((await diogo.get('/admin/users')).text)[1]) });
  const idea = await addIdea(diogo, me, 'birthday:2099', 'Surprise spa day');

  // A new list from her ideas: never visible to her.
  const form = new URLSearchParams({ title: 'For Maria', visibility: 'shared', gifts: String(idea) });
  form.append('_csrf', await diogo.csrf(`/admin/give/people/${me}/new-list`));
  const res = await fetch(`${server.base}/admin/give/people/${me}/new-list`, { method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...diogo.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' } });
  const listId = Number(/\/admin\/lists\/(\d+)/.exec(res.headers.get('location'))[1]);
  assert.equal((await maria.get(`/admin/lists/${listId}`)).status, 404);
  assert.ok(!(await maria.get('/admin')).text.includes('For Maria'));

  // Copying it into a shared list she can see is refused.
  const shared = await createList(diogo, { title: 'Family list' });
  const r = await diogo.post(`/admin/give/gifts/${idea}/to-list`, { list_id: String(shared.id) }, { from: `/admin/give/people/${me}` });
  assert.equal(r.status, 400);
  assert.ok(!(await maria.get(`/admin/lists/${shared.id}`)).text.includes('Surprise spa day'));
});

test('drag and drop saves the new order; bad orders and other lists are refused', async () => {
  const { id, token } = await createList(diogo, { gifts: ['One', 'Two', 'Three'] });
  const ids = [...(await diogo.get(`/admin/lists/${id}`)).text.matchAll(/data-id="(\d+)"/g)].map((m) => Number(m[1]));
  const csrf = await diogo.csrf(`/admin/lists/${id}`);
  const send = (client, listId, order, token2 = csrf) => client.request(`/admin/lists/${listId}/order`, { method: 'POST', form: { _csrf: token2, order } });
  assert.equal((await send(diogo, id, [ids[2], ids[0], ids[1]].join(','))).status, 204);
  const guest = await joinList(server.base, token, 'Order guest');
  const shown = [...(await guest.get(`/l/${token}`)).text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(shown, ['Three', 'One', 'Two']);

  assert.equal((await send(diogo, id, [ids[0], ids[1]].join(','))).status, 400, 'must list every gift');
  assert.equal((await send(diogo, id, [ids[0], ids[0], ids[1]].join(','))).status, 400, 'no duplicates');
  assert.equal((await send(diogo, id, ids.join(','), 'forged')).status, 403, 'CSRF');
  const priv = await diogo.post('/admin/lists', { title: 'Private order', visibility: 'private' }, { from: '/admin' });
  const privId = Number(/\/admin\/lists\/(\d+)/.exec(priv.location)[1]);
  assert.equal((await send(maria, privId, '', await maria.csrf('/admin'))).status, 404, "can't reorder a list you can't see");

  // Wishlist order.
  for (const t of ['W1', 'W2']) await maria.post('/admin/wishlist/items', { title: t }, { from: '/admin/wishlist' });
  const wids = [...(await maria.get('/admin/wishlist')).text.matchAll(/data-id="(\d+)"/g)].map((m) => Number(m[1]));
  const r = await maria.request('/admin/wishlist/order', { method: 'POST', form: { _csrf: await maria.csrf('/admin/wishlist'), order: wids.reverse().join(',') } });
  assert.equal(r.status, 204);
  const titles = [...(await maria.get('/admin/wishlist')).text.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['W2', 'W1']);
});
