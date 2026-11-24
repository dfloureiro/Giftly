// Guests: seeing what others reserved, reserving on behalf of someone else, renaming and merging.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAdmin, inviteAdmin, createList, joinList, pickableIds, webhookReceiver, sleep, formFields } from './helpers.js';

let server, admin, hook;
before(async () => {
  hook = await webhookReceiver();
  server = await startServer({ NOTIFY_ALLOWED_HOSTS: '127.0.0.1' });
  admin = await loginAdmin(server.base);
  await admin.post('/admin/notifications', { webhook_url: hook.url, event_pick: '1' }, { from: '/admin/profile' });
});
after(async () => { await server?.stop(); await hook?.close(); });

const itemIds = async (listId) =>
  [...(await admin.get(`/admin/lists/${listId}`)).text.matchAll(/\/admin\/items\/(\d+)\/delete/g)].map((m) => Number(m[1]));
const section = (html, cls) => new RegExp(`<section class="${cls}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? '';
const guestIds = async (listId) => Object.fromEntries([...(await admin.get(`/admin/lists/${listId}`)).text
  .matchAll(/<td>([^<]+)<\/td><td>\d+<\/td>[\s\S]*?\/admin\/guests\/(\d+)\/rename/g)].map((m) => [m[1], Number(m[2])]));

/** Change list settings through the edit form, as a browser sends it. */
async function settings(id, changes) {
  const page = (await admin.get(`/admin/lists/${id}/edit`)).text;
  const pairs = Object.entries(formFields(page, `/admin/lists/${id}`)).filter(([k]) => !(k in changes));
  for (const [k, v] of Object.entries(changes)) {
    if (typeof v !== 'boolean') pairs.push([k, String(v)]); // a select
    else { pairs.push([k, '0']); if (v) pairs.push([k, '1']); }
  }
  assert.equal((await admin.request(`/admin/lists/${id}`, { method: 'POST', form: pairs })).status, 303);
}

async function listWithLink(title) {
  const { id, token } = await createList(admin, { title, gifts: ['Plain gift'] });
  await admin.post(`/admin/lists/${id}/items`, { title: 'Linked gift', url: 'https://shop.example/thing', notes: 'Blue please' }, { from: `/admin/lists/${id}` });
  return { id, token, ids: await itemIds(id) };
}

// ---------- seeing what others reserved ----------

test('off by default: only how many others picked; the levels show more, then less', async () => {
  const { id, token, ids: [plain, linked] } = await listWithLink('Taken levels');
  const ana = await joinList(server.base, token, 'Ana');
  const rui = await joinList(server.base, token, 'Rui');
  await ana.post(`/l/${token}/pick/${linked}`, {}, { from: `/l/${token}` });

  let page = (await rui.get(`/l/${token}`)).text;
  assert.match(page, /1 gift\(s\) already picked by others/);
  assert.doesNotMatch(page, /taken-section/);

  await settings(id, { show_taken: 1 });
  page = section((await rui.get(`/l/${token}`)).text, 'taken-section');
  assert.match(page, /Linked gift[\s\S]*Blue please[\s\S]*shop\.example\/thing[\s\S]*Reserved by Ana/);
  assert.doesNotMatch((await rui.get(`/l/${token}`)).text, /already picked by others/, 'the list replaces the count');
  assert.doesNotMatch(page, /Plain gift/, 'only taken gifts');

  await settings(id, { show_taken: 2 });
  page = section((await rui.get(`/l/${token}`)).text, 'taken-section');
  assert.match(page, /Linked gift[\s\S]*Blue please[\s\S]*Reserved by Ana/, 'photo and notes stay');
  assert.doesNotMatch(page, /shop\.example/, 'no link');

  await settings(id, { show_taken: 3 });
  page = section((await rui.get(`/l/${token}`)).text, 'taken-section');
  assert.match(page, /Linked gift[\s\S]*Blue please[\s\S]*Already reserved/);
  assert.doesNotMatch(page, /Ana|shop\.example/);

  // Ana is told what others see of her picks.
  await settings(id, { show_taken: 0 });
  assert.match((await ana.get(`/l/${token}`)).text, /Only you \(and the list manager\) can see these/);
  await settings(id, { show_taken: 2 });
  assert.match((await ana.get(`/l/${token}`)).text, /Other guests of this list can see that you reserved these/);
  await settings(id, { show_taken: 3 });
  assert.match((await ana.get(`/l/${token}`)).text, /Other guests see these as reserved, but not by whom/);

  // Ana's own pick is in her picks, not in "already reserved".
  assert.doesNotMatch(section((await ana.get(`/l/${token}`)).text, 'taken-section'), /Linked gift/);
  assert.ok((await pickableIds(rui, token)).includes(plain));
});

test('who buys it and "bought" never show to other guests', async () => {
  const { id, token, ids: [, linked] } = await listWithLink('Taken buyer');
  await settings(id, { show_taken: 1, ask_buyer: true });
  const ana = await joinList(server.base, token, 'Ana');
  await ana.post(`/l/${token}/pick/${linked}`, { buyer: 'us' }, { from: `/l/${token}` });
  const page = (await admin.get(`/admin/lists/${id}`)).text;
  await admin.request(`/admin/items/${linked}/bought`, { method: 'POST', form: formFields(page, `/admin/items/${linked}/bought`) });
  const rui = await joinList(server.base, token, 'Rui');
  const taken = section((await rui.get(`/l/${token}`)).text, 'taken-section');
  assert.match(taken, /Reserved by Ana/);
  assert.doesNotMatch(taken, /buy|bought/i);
});

test('a wishlist gift reserved in another list shows as reserved, never with the name', async () => {
  const person = Number(/\/admin\/people\/(\d+)/.exec((await admin.post('/admin/people', { visibility: 'shared', name: 'Leo Taken' }, { from: '/admin/people' })).location)[1]);
  await admin.post('/admin/wishlist/items', { person_id: String(person), title: 'Kite' }, { from: `/admin/people/${person}` });
  const wid = Number(/\/admin\/wishlists\/(\d+)\/new-list/.exec((await admin.get(`/admin/people/${person}/new-list`)).location)[1]);
  const make = async (title) => {
    const form = (await admin.get(`/admin/wishlists/${wid}/new-list`)).text;
    const pairs = [['_csrf', await admin.csrf(`/admin/wishlists/${wid}/new-list`)], ['title', title], ['visibility', 'shared'], ['show_taken', '1']];
    for (const [, item] of form.matchAll(/name="items" value="(\d+)"/g)) pairs.push(['items', item]);
    const id = Number(/\/admin\/lists\/(\d+)/.exec((await admin.request(`/admin/wishlists/${wid}/new-list`, { method: 'POST', form: pairs })).location)[1]);
    return { id, token: /\/l\/([A-Za-z0-9_-]{22})/.exec((await admin.get(`/admin/lists/${id}`)).text)[1] };
  };
  const a = await make('Leo A');
  const b = await make('Leo B');
  assert.match((await admin.get(`/admin/lists/${b.id}/edit`)).text, /<option value="1" selected>/, 'set from the wishlist form');
  const ana = await joinList(server.base, a.token, 'Ana Secret');
  const [kiteA] = await pickableIds(ana, a.token);
  await ana.post(`/l/${a.token}/pick/${kiteA}`, {}, { from: `/l/${a.token}` });
  const rui = await joinList(server.base, b.token, 'Rui');
  const taken = section((await rui.get(`/l/${b.token}`)).text, 'taken-section');
  assert.match(taken, /Kite[\s\S]*Already reserved/);
  assert.doesNotMatch(taken, /Ana Secret/);
});

// ---------- on behalf of someone else ----------

test('Maria reserves on behalf of Diogo: both see it, admins see who, either can give it up', async () => {
  const { id, token, ids: [plain, linked] } = await listWithLink('On behalf');
  await settings(id, { allow_on_behalf: true });
  const maria = await joinList(server.base, token, 'Maria');
  assert.match((await maria.get(`/l/${token}`)).text, /name="for"/);

  hook.calls.length = 0;
  let r = await maria.post(`/l/${token}/pick/${linked}`, { for: 'Diogo' }, { from: `/l/${token}` });
  assert.match(r.location, /m=pickedFor/);
  await maria.post(`/l/${token}/pick/${plain}`, {}, { from: `/l/${token}` });

  const mariaPage = (await maria.get(`/l/${token}`)).text;
  assert.match(section(mariaPage, 'mine for-others'), /Linked gift[\s\S]*For Diogo/);
  assert.match(section(mariaPage, 'mine'), /Plain gift/);
  assert.doesNotMatch(section(mariaPage, 'mine'), /Linked gift/, 'not in her own picks');
  assert.doesNotMatch(mariaPage, /already picked by others/, 'nor counted as someone else\'s');
  await settings(id, { show_taken: 1 });
  assert.doesNotMatch(section((await maria.get(`/l/${token}`)).text, 'taken-section'), /Linked gift/, 'nor listed as taken');
  const other = await joinList(server.base, token, 'Outsider');
  assert.match(section((await other.get(`/l/${token}`)).text, 'taken-section'), /Reserved by Maria on behalf of Diogo/);
  await settings(id, { show_taken: 0 });

  const adminPage = (await admin.get(`/admin/lists/${id}`)).text;
  assert.match(adminPage, /Reserved by Maria on behalf of Diogo/);
  assert.match(adminPage, /Diogo<\/td><td>1<\/td><td><span class="muted">not joined yet/);
  for (let i = 0; i < 50 && !hook.calls.some((c) => c.item === 'Linked gift'); i++) await sleep(20);
  const call = hook.calls.find((c) => c.item === 'Linked gift');
  assert.match(call.title, /Maria reserved a gift on behalf of Diogo/);
  assert.equal(call.on_behalf_of, 'Diogo');

  const diogo = await joinList(server.base, token, 'diogo');
  const mine = section((await diogo.get(`/l/${token}`)).text, 'mine');
  assert.match(mine, /Linked gift[\s\S]*Reserved for you by Maria/);
  assert.match(mine, new RegExp(`/l/${token}/unpick/${linked}`));

  // Someone else can't give it up; Diogo can.
  const rui = await joinList(server.base, token, 'Rui');
  await rui.post(`/l/${token}/unpick/${linked}`, {}, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Maria on behalf of Diogo/);
  await diogo.post(`/l/${token}/unpick/${linked}`, {}, { from: `/l/${token}` });
  assert.ok((await pickableIds(rui, token)).includes(linked));

  // Maria can give up what she reserved for him too.
  await maria.post(`/l/${token}/pick/${linked}`, { for: 'Diogo' }, { from: `/l/${token}` });
  await maria.post(`/l/${token}/unpick/${linked}`, {}, { from: `/l/${token}` });
  assert.ok((await pickableIds(rui, token)).includes(linked));
});

test('on behalf: her own name is a normal pick; off, the name is ignored; she can change who buys', async () => {
  const { id, token, ids: [plain, linked] } = await listWithLink('On behalf edge');
  const maria = await joinList(server.base, token, 'Maria');
  assert.doesNotMatch((await maria.get(`/l/${token}`)).text, /name="for"/, 'off by default');
  await maria.post(`/l/${token}/pick/${plain}`, { for: 'Diogo' }, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Maria </, 'ignored while off');

  await settings(id, { allow_on_behalf: true, ask_buyer: true });
  await maria.post(`/l/${token}/pick/${linked}`, { for: 'MARIA', buyer: 'guest' }, { from: `/l/${token}` });
  assert.doesNotMatch((await admin.get(`/admin/lists/${id}`)).text, /Reserved by Maria on behalf/);
  await maria.post(`/l/${token}/unpick/${linked}`, {}, { from: `/l/${token}` });

  await maria.post(`/l/${token}/pick/${linked}`, { for: 'Diogo', buyer: 'guest' }, { from: `/l/${token}` });
  await maria.post(`/l/${token}/buyer/${linked}`, { buyer: 'us' }, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /on behalf of Diogo <span class="badge buyer-us">/);
});

test('names to suggest come only from what the page already shows', async () => {
  const { id, token, ids: [, linked] } = await listWithLink('Suggest');
  await settings(id, { allow_on_behalf: true });
  const ana = await joinList(server.base, token, 'Ana');
  await joinList(server.base, token, 'Quiet Guest'); // joined, picked nothing
  await ana.post(`/l/${token}/pick/${linked}`, {}, { from: `/l/${token}` });
  const rui = await joinList(server.base, token, 'Rui');
  assert.doesNotMatch((await rui.get(`/l/${token}`)).text, /<datalist/, 'no names while the list shows none');
  await settings(id, { show_taken: 2 });
  let page = (await rui.get(`/l/${token}`)).text;
  assert.match(page, /<datalist[^>]*><option value="Ana">/);
  assert.doesNotMatch(page, /Quiet Guest/);
  await settings(id, { show_taken: 3 });
  page = (await rui.get(`/l/${token}`)).text;
  assert.doesNotMatch(page, /<datalist/);
});

// ---------- rename and merge ----------

test('rename a guest: their reservations follow; a taken name asks to merge instead', async () => {
  const { id, token, ids: [plain, linked] } = await listWithLink('Rename');
  const joao = await joinList(server.base, token, 'João');
  await joinList(server.base, token, 'Ana');
  await joao.post(`/l/${token}/pick/${plain}`, {}, { from: `/l/${token}` });
  const g = await guestIds(id);

  const page = (await admin.get(`/admin/lists/${id}`)).text;
  let r = await admin.request(`/admin/guests/${g['João']}/rename`, { method: 'POST', form: { ...formFields(page, `/admin/guests/${g['João']}/rename`), name: 'João Loureiro' } });
  assert.match(r.location, /m=guestRenamed/);
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by João Loureiro/);
  assert.match((await joao.get(`/l/${token}`)).text, /Hi, João Loureiro[\s\S]*Your picks[\s\S]*Plain gift/, 'still signed in');

  r = await admin.request(`/admin/guests/${g['João']}/rename`, { method: 'POST', form: { ...formFields(page, `/admin/guests/${g['João']}/rename`), name: 'ana' } });
  assert.equal(r.status, 409);
  assert.match(r.text, /“Ana” is already in this list/);
  assert.match(r.text, new RegExp(`action="/admin/guests/${g['João']}/merge"[\\s\\S]*name="into" value="${g.Ana}"`));
  assert.match((await admin.get(`/admin/lists/${id}`)).text, /Reserved by João Loureiro/, 'nothing changed');
  void linked;
});

test('merge: picks and on-behalf reservations move, the old name is gone and its device joins again', async () => {
  const { id, token, ids: [plain, linked] } = await listWithLink('Merge');
  await settings(id, { allow_on_behalf: true });
  const short = await joinList(server.base, token, 'João');
  const full = await joinList(server.base, token, 'João Loureiro');
  await short.post(`/l/${token}/pick/${plain}`, {}, { from: `/l/${token}` });
  await short.post(`/l/${token}/pick/${linked}`, { for: 'João Loureiro' }, { from: `/l/${token}` }); // for "himself"
  const g = await guestIds(id);

  const page = (await admin.get(`/admin/lists/${id}`)).text;
  const r = await admin.request(`/admin/guests/${g['João']}/merge`, { method: 'POST', form: { ...formFields(page, `/admin/guests/${g['João']}/merge`), into: String(g['João Loureiro']) } });
  assert.match(r.location, /m=guestsMerged/);

  const after = (await admin.get(`/admin/lists/${id}`)).text;
  assert.doesNotMatch(after, /<td>João<\/td>/);
  assert.match(after, /João Loureiro<\/td><td>2<\/td>/);
  assert.doesNotMatch(after, /Reserved by [^<]* on behalf/, 'reserved "for himself" is just his');
  const fullPage = (await full.get(`/l/${token}`)).text;
  assert.match(section(fullPage, 'mine'), /Plain gift[\s\S]*Linked gift|Linked gift[\s\S]*Plain gift/);
  assert.doesNotMatch(fullPage, /for-others/);
  assert.match((await short.get(`/l/${token}`)).text, /name="name"/, 'the merged-away device is asked to join again');
});

test('merge and rename only within a list the admin can see', async () => {
  const a = await createList(admin, { title: 'Merge A' });
  const b = await createList(admin, { title: 'Merge B' });
  await joinList(server.base, a.token, 'Ana');
  await joinList(server.base, b.token, 'Bea');
  const ga = await guestIds(a.id);
  const gb = await guestIds(b.id);
  const form = { _csrf: await admin.csrf(`/admin/lists/${a.id}`) };
  assert.equal((await admin.request(`/admin/guests/${ga.Ana}/merge`, { method: 'POST', form: { ...form, into: String(gb.Bea) } })).status, 404);
  assert.match((await admin.get(`/admin/lists/${a.id}`)).text, /<td>Ana<\/td>/);

  // Another admin can't touch the guests of a private list.
  const priv = await createList(admin, { title: 'Private merge' });
  await settings(priv.id, { visibility: 'private' });
  await joinList(server.base, priv.token, 'Zé');
  await joinList(server.base, priv.token, 'Zé 2');
  const gp = await guestIds(priv.id);
  const bea = await inviteAdmin(server.base, admin, { username: 'bea-guests' });
  const csrf = await bea.csrf('/admin/lists');
  assert.equal((await bea.request(`/admin/guests/${gp['Zé']}/rename`, { method: 'POST', form: { _csrf: csrf, name: 'Hacked' } })).status, 404);
  assert.equal((await bea.request(`/admin/guests/${gp['Zé']}/merge`, { method: 'POST', form: { _csrf: csrf, into: String(gp['Zé 2']) } })).status, 404);
  assert.match((await admin.get(`/admin/lists/${priv.id}`)).text, /<td>Zé<\/td>/);
});
