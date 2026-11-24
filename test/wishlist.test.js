// Wishlists (3.0): the owner must never learn what was reserved; lists made from a wishlist
// stay invisible to its owner; reservations are unique per wishlist item across lists.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import {
  startServer, Client, loginAdmin, inviteAdmin, joinList, pickableIds, webhookReceiver, sleep, formFields, wishlistOf, personId,
} from './helpers.js';

let server, diogo, maria, bea, mariaWishlist;
before(async () => {
  server = await startServer();
  diogo = await loginAdmin(server.base);
  maria = await inviteAdmin(server.base, diogo, { username: 'maria', name: 'Maria' });
  bea = await inviteAdmin(server.base, diogo, { username: 'bea', name: 'Bea' });
  await maria.get('/admin/wishlist'); // creates her wishlist
  mariaWishlist = await wishlistOf(diogo, 'Maria');
});
after(async () => { await server?.stop(); });

/** POST a form with repeated fields (e.g. several "items" checkboxes). */
async function postPairs(client, path, pairs, from) {
  const form = new URLSearchParams(pairs);
  form.append('_csrf', await client.csrf(from));
  const res = await fetch(server.base + path, {
    method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...client.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  });
  return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
}

async function addWish(title, extra = {}) {
  const r = await maria.post('/admin/wishlist/items', { title, ...extra }, { from: '/admin/wishlist' });
  return Number(/#wish-(\d+)/.exec(r.location)[1]);
}

async function listFromWishlist(admin, wishIds, { title = 'From wishlist', visibility = 'private', auto = true } = {}) {
  const pairs = [['title', title], ['visibility', visibility], ...wishIds.map((id) => ['items', String(id)])];
  if (auto) pairs.push(['auto_add_new', '1']);
  const r = await postPairs(admin, `/admin/wishlists/${mariaWishlist}/new-list`, pairs, `/admin/wishlists/${mariaWishlist}/new-list`);
  assert.equal(r.status, 303, r.text.slice(0, 300));
  const id = Number(/\/admin\/lists\/(\d+)/.exec(r.location)[1]);
  const page = (await admin.get(`/admin/lists/${id}`)).text;
  return {
    id,
    token: /\/l\/([A-Za-z0-9_-]{22})/.exec(page)[1],
    itemIds: [...page.matchAll(/\/admin\/items\/(\d+)\/delete/g)].map((m) => Number(m[1])),
  };
}

// Strip per-request bits (CSRF tokens, dates) so two renders of the same page can be compared.
const normalize = (html) => html.replace(/name="_csrf" value="[^"]+"/g, '').replace(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/g, '');

test('the owner\'s wishlist page is identical whether items are reserved or not', async () => {
  const a = await addWish('Leak test A');
  const b = await addWish('Leak test B');
  const list = await listFromWishlist(diogo, [a, b]);
  const before = normalize((await maria.get('/admin/wishlist')).text);
  const guest = await joinList(server.base, list.token, 'Tia Ana');
  const [first] = await pickableIds(guest, list.token);
  await guest.post(`/l/${list.token}/pick/${first}`, {}, { from: `/l/${list.token}` });
  const afterPick = normalize((await maria.get('/admin/wishlist')).text);
  assert.equal(afterPick, before, 'no difference at all for the owner');
});

test('a list made from someone\'s wishlist is invisible to them everywhere — even when shared', async () => {
  const c = await addWish('Shared list item');
  const list = await listFromWishlist(diogo, [c], { title: 'Shared from Maria', visibility: 'shared' });
  assert.ok(!(await maria.get('/admin/lists')).text.includes('Shared from Maria'));
  assert.equal((await maria.get(`/admin/lists/${list.id}`)).status, 404);
  assert.equal((await maria.get(`/admin/items/${list.itemIds[0]}`)).status, 404);
  assert.equal((await maria.post(`/admin/items/${list.itemIds[0]}/reserve`, { name: 'x' }, { from: '/admin/lists' })).status, 404);
  assert.equal((await maria.get(`/admin/previews?ids=${list.itemIds[0]}`)).text, '{}');
  assert.match((await bea.get('/admin/lists')).text, /Shared from Maria/, 'other admins see a shared one');
  assert.equal((await bea.get(`/admin/lists/${list.id}`)).status, 200);
});

test('private lists are only visible to their owner', async () => {
  const r = await diogo.post('/admin/lists', { title: 'Diogo private list', visibility: 'private' }, { from: '/admin/lists' });
  const id = Number(/\/admin\/lists\/(\d+)/.exec(r.location)[1]);
  assert.equal((await bea.get(`/admin/lists/${id}`)).status, 404);
  assert.ok(!(await bea.get('/admin/lists')).text.includes('Diogo private list'));
  assert.equal((await diogo.get(`/admin/lists/${id}`)).status, 200);
});

test('guest picks on that list never notify the wishlist owner', async () => {
  const hookMaria = await webhookReceiver();
  const hookDiogo = await webhookReceiver();
  try {
    await maria.post('/admin/notifications', { webhook_url: hookMaria.url, event_pick: '1', event_join: '1' }, { from: '/admin/profile' });
    await diogo.post('/admin/notifications', { webhook_url: hookDiogo.url, event_pick: '1' }, { from: '/admin/profile' });
    const d = await addWish('Notify item');
    const list = await listFromWishlist(diogo, [d], { visibility: 'shared' });
    const guest = await joinList(server.base, list.token, 'Primo');
    const [id] = await pickableIds(guest, list.token);
    await guest.post(`/l/${list.token}/pick/${id}`, {}, { from: `/l/${list.token}` });
    for (let i = 0; i < 30 && !hookDiogo.calls.length; i++) await sleep(100);
    assert.equal(hookDiogo.calls.length, 1, 'the organiser is told');
    await sleep(200);
    assert.equal(hookMaria.calls.length, 0, 'the owner never is');
  } finally {
    await hookMaria.close();
    await hookDiogo.close();
    await maria.post('/admin/notifications', {}, { from: '/admin/profile' });
    await diogo.post('/admin/notifications', {}, { from: '/admin/profile' });
  }
});

test('removing a reserved and an unreserved item gives the owner exactly the same answer', async () => {
  const hook = await webhookReceiver();
  try {
    await diogo.post('/admin/notifications', { webhook_url: hook.url }, { from: '/admin/profile' });
    const reserved = await addWish('Remove reserved');
    const free = await addWish('Remove free');
    const list = await listFromWishlist(diogo, [reserved, free], { title: 'Removal list' });
    const guest = await joinList(server.base, list.token, 'Avó');
    const ids = await pickableIds(guest, list.token);
    await guest.post(`/l/${list.token}/pick/${ids[0]}`, {}, { from: `/l/${list.token}` });

    const r1 = await maria.post(`/admin/wishlist/items/${reserved}/remove`, { reason: 'bought' }, { from: '/admin/wishlist' });
    const r2 = await maria.post(`/admin/wishlist/items/${free}/remove`, { reason: 'bought' }, { from: '/admin/wishlist' });
    assert.equal(r1.status, r2.status);
    assert.equal(r1.location, r2.location);
    assert.equal(r1.text, r2.text);

    const guestPage = (await guest.get(`/l/${list.token}`)).text;
    assert.match(guestPage, /Your picks[\s\S]*Remove reserved[\s\S]*already bought this item/, 'kept in their picks, with a warning');
    assert.ok(!(await pickableIds(guest, list.token)).length, 'the unreserved one is gone');

    for (let i = 0; i < 30 && !hook.calls.length; i++) await sleep(100);
    assert.equal(hook.calls.length, 1, 'organiser told once, for the reserved item only');
    assert.equal(hook.calls[0].event, 'wishlist_item_removed_claimed');
    assert.match((await diogo.get(`/admin/lists/${list.id}`)).text, /already bought it/);
  } finally {
    await hook.close();
    await diogo.post('/admin/notifications', {}, { from: '/admin/profile' });
  }
});

test('the same wishlist item in two lists: two simultaneous guest picks, exactly one wins', async () => {
  const e = await addWish('Contested wish');
  const l1 = await listFromWishlist(diogo, [e], { title: 'L1' });
  const l2 = await listFromWishlist(bea, [e], { title: 'L2' });
  const g1 = await joinList(server.base, l1.token, 'G1');
  const g2 = await joinList(server.base, l2.token, 'G2');
  const [i1] = await pickableIds(g1, l1.token);
  const [i2] = await pickableIds(g2, l2.token);
  const [c1, c2] = await Promise.all([g1.csrf(`/l/${l1.token}`), g2.csrf(`/l/${l2.token}`)]);
  const [r1, r2] = await Promise.all([
    g1.request(`/l/${l1.token}/pick/${i1}`, { method: 'POST', form: { _csrf: c1 } }),
    g2.request(`/l/${l2.token}/pick/${i2}`, { method: 'POST', form: { _csrf: c2 } }),
  ]);
  const won = [r1, r2].filter((r) => /m=picked/.test(r.location)).length;
  assert.equal(won, 1);
  const loser = /m=picked/.test(r1.location) ? [g2, l2] : [g1, l1];
  assert.deepEqual(await pickableIds(loser[0], loser[1].token), [], 'gone from the other list too');
});

test('"I\'ll give it" vs a guest pick at the same time: exactly one wins', async () => {
  const f = await addWish('Race give');
  const list = await listFromWishlist(diogo, [f], { title: 'Race list' });
  const occ = await bea.post('/admin/occasions', { name: 'Race occasion', date: '2099-01-01', visibility: 'shared' }, { from: '/admin/occasions' });
  const occId = Number(/occasions\/(\d+)/.exec(occ.location)[1]);
  const guest = await joinList(server.base, list.token, 'Racer');
  const [item] = await pickableIds(guest, list.token);
  const [gc, bc] = await Promise.all([guest.csrf(`/l/${list.token}`), bea.csrf(`/admin/wishlists/${mariaWishlist}`)]);
  const [rg, rb] = await Promise.all([
    guest.request(`/l/${list.token}/pick/${item}`, { method: 'POST', form: { _csrf: gc } }),
    bea.request(`/admin/wishlists/${mariaWishlist}/items/${f}/give`, { method: 'POST', form: { _csrf: bc, occasion: `occasion:${occId}` } }),
  ]);
  const guestWon = /m=picked/.test(rg.location);
  const beaWon = /m=giving/.test(rb.location);
  assert.equal(Number(guestWon) + Number(beaWon), 1, `guest ${rg.location} / bea ${rb.location}`);
});

test('"I\'ll give it" for an admin: shared with the other admins, never shown to her', async () => {
  const g = await addWish('Secret present');
  const occ = await diogo.post('/admin/occasions', { name: 'Maria party', date: '2099-02-02', visibility: 'shared' }, { from: '/admin/occasions' });
  const occId = Number(/occasions\/(\d+)/.exec(occ.location)[1]);
  const r = await diogo.post(`/admin/wishlists/${mariaWishlist}/items/${g}/give`, { occasion: `occasion:${occId}` }, { from: '/admin/people' });
  assert.match(r.location, /m=giving/);
  assert.match((await diogo.get(`/admin/occasions/${occId}`)).text, /Secret present/);
  const mariaPerson = await personId(diogo, 'Maria');
  assert.match((await diogo.get(`/admin/people/${mariaPerson}`)).text, /You&#39;re giving it/);
  assert.match((await bea.get(`/admin/occasions/${occId}`)).text, /Secret present/, 'the other admins see it (5.0)');

  // Maria: not the gift, not the occasion that is only about her, not her own record.
  for (const path of ['/admin/occasions', '/admin/occasions?view=all', `/admin/occasions/${occId}`, '/admin/people', `/admin/people/${mariaPerson}`]) {
    assert.ok(!(await maria.get(path)).text.includes('Secret present'), path);
  }
  assert.equal((await maria.get(`/admin/occasions/${occId}`)).status, 404, 'an occasion only for her is hidden from her');
  assert.equal((await maria.get(`/admin/people/${mariaPerson}`)).status, 404);
  assert.equal(await personId(maria, 'Maria'), null);
});

test('owners cannot create lists from their own wishlist, nor see claim state on it', async () => {
  const own = await maria.get(`/admin/wishlists/${mariaWishlist}/new-list`);
  assert.equal(own.location, '/admin/wishlist');
  const r = await postPairs(maria, `/admin/wishlists/${mariaWishlist}/new-list`, [['title', 'Mine']], '/admin/wishlist');
  assert.equal(r.location, '/admin/wishlist');
  assert.ok(!(await maria.get('/admin/lists')).text.includes('>Mine<'));
});

test('a private wishlist is not visible to others', async () => {
  await bea.get('/admin/wishlist');
  await bea.post('/admin/wishlist/visibility', { visibility: 'private' }, { from: '/admin/wishlist' });
  const beaPage = async () => (await diogo.get(`/admin/people/${await personId(diogo, 'Bea')}`)).text;
  assert.match(await beaPage(), /Bea&#39;s wishlist is private/);
  const ownId = Number(/\/admin\/wishlists\/(\d+)\/new-list/.exec((await bea.get('/admin/wishlist')).text)?.[1]);
  await bea.post('/admin/wishlist/visibility', { visibility: 'shared' }, { from: '/admin/wishlist' });
  assert.ok(!(await beaPage()).includes('wishlist is private'));
  assert.ok(Number.isNaN(ownId), 'her own page offers no "create a list"');
});

test('linked lists follow the wishlist: edits sync, new items join (or wait for approval)', async () => {
  const h = await addWish('Original name');
  const auto = await listFromWishlist(diogo, [h], { title: 'Auto list' });
  const manual = await listFromWishlist(diogo, [h], { title: 'Manual list', auto: false });
  await maria.post(`/admin/wishlist/items/${h}`, { title: 'Renamed item', url: '' }, { from: '/admin/wishlist' });
  assert.match((await diogo.get(`/admin/lists/${auto.id}`)).text, /Renamed item/);

  await addWish('Brand new wish');
  const guest = await joinList(server.base, auto.token, 'Auto guest');
  assert.match((await guest.get(`/l/${auto.token}`)).text, /Brand new wish/, 'joins automatically');
  const mg = await joinList(server.base, manual.token, 'Manual guest');
  assert.ok(!(await mg.get(`/l/${manual.token}`)).text.includes('Brand new wish'), 'waits for approval');
  const page = (await diogo.get(`/admin/lists/${manual.id}`)).text;
  assert.match(page, /New on the wishlist/);
  const pendingId = Number(/\/admin\/items\/(\d+)\/approve/.exec(page)[1]);
  await diogo.post(`/admin/items/${pendingId}/approve`, {}, { from: `/admin/lists/${manual.id}` });
  assert.match((await mg.get(`/l/${manual.token}`)).text, /Brand new wish/);

  // Hiding a linked item only in this list.
  const [firstItem] = (await diogo.get(`/admin/lists/${auto.id}`)).text.match(/\/admin\/items\/(\d+)\/hide/).slice(1).map(Number);
  await diogo.post(`/admin/items/${firstItem}/hide`, { hidden: '1' }, { from: `/admin/lists/${auto.id}` });
  assert.ok(!(await guest.get(`/l/${auto.token}`)).text.includes('Renamed item'));
  assert.match((await mg.get(`/l/${manual.token}`)).text, /Renamed item/, 'still shown in the other list');
});

test('archiving a list marks its reserved wishlist items as received; "given" does too; giving up frees it', async () => {
  const k = await addWish('Archive me');
  const list = await listFromWishlist(diogo, [k], { title: 'Archive list' });
  const guest = await joinList(server.base, list.token, 'Archiver');
  const [id] = await pickableIds(guest, list.token);
  await guest.post(`/l/${list.token}/pick/${id}`, {}, { from: `/l/${list.token}` });
  await diogo.post(`/admin/lists/${list.id}`, { title: 'Archive list', archived: '1', visibility: 'private' }, { from: `/admin/lists/${list.id}` });
  const own = (await maria.get('/admin/wishlist')).text;
  assert.ok(!/id="wish-\d+"[\s\S]*?Archive me/.test(own.split('Removed and received')[0]), 'left the active wishlist');
  assert.match(own, /Removed and received[\s\S]*Archive me/);

  const m = await addWish('Give then hand over');
  const occ = await diogo.post('/admin/occasions', { name: 'Hand over', date: '2099-03-03', visibility: 'shared' }, { from: '/admin/occasions' });
  const occId = Number(/occasions\/(\d+)/.exec(occ.location)[1]);
  await diogo.post(`/admin/wishlists/${mariaWishlist}/items/${m}/give`, { occasion: `occasion:${occId}` }, { from: '/admin/people' });
  const gid = Number(/id="gift-(\d+)"/.exec((await diogo.get(`/admin/occasions/${occId}`)).text)[1]);

  // Giving it up frees the item for guests again.
  const other = await listFromWishlist(bea, [m], { title: 'Free again' });
  const g2 = await joinList(server.base, other.token, 'Free guest');
  assert.deepEqual(await pickableIds(g2, other.token), [], 'reserved by Diogo');
  await diogo.post(`/admin/gifts/${gid}/delete`, {}, { from: `/admin/occasions/${occId}` });
  assert.equal((await pickableIds(g2, other.token)).length, 1, 'available again');

  // Give again and mark as given → received.
  await diogo.post(`/admin/wishlists/${mariaWishlist}/items/${m}/give`, { occasion: `occasion:${occId}` }, { from: '/admin/people' });
  const gid2 = Number(/id="gift-(\d+)"/.exec((await diogo.get(`/admin/occasions/${occId}`)).text)[1]);
  await diogo.post(`/admin/gifts/${gid2}/status`, { status: 'given' }, { from: `/admin/occasions/${occId}` });
  assert.match((await maria.get('/admin/wishlist')).text, /Removed and received[\s\S]*Give then hand over/);
});

test('saving a linked item\'s edit form opened before a guest picked keeps the pick and the claim in other lists', async () => {
  const w = await addWish('Stale-form wish');
  const l1 = await listFromWishlist(diogo, [w], { title: 'Stale L1' });
  const l2 = await listFromWishlist(bea, [w], { title: 'Stale L2' });
  const [i1] = l1.itemIds;
  const [i2] = l2.itemIds;
  const editPage = (await diogo.get(`/admin/items/${i1}`)).text;
  const stale = formFields(editPage, `/admin/items/${i1}`);
  const g1 = await joinList(server.base, l1.token, 'Stale G1');
  const g2 = await joinList(server.base, l2.token, 'Stale G2');
  assert.match((await g1.post(`/l/${l1.token}/pick/${i1}`, {}, { from: `/l/${l1.token}` })).location, /m=picked/);
  assert.ok(!(await pickableIds(g2, l2.token)).includes(i2), 'claimed: gone from L2');

  // The stale save (also with the field older pages had, empty = "release") changes only the notes.
  const r = await diogo.request(`/admin/items/${i1}`, { method: 'POST', form: { ...stale, notes: 'Blue one', reserved_name: '' } });
  assert.match(r.location, /m=saved/);
  assert.match((await g1.get(`/l/${l1.token}`)).text, /Your picks[\s\S]*Stale-form wish/);
  assert.ok(!(await pickableIds(g2, l2.token)).includes(i2), 'still claimed: not offered in L2');
  assert.match((await diogo.get(`/admin/lists/${l1.id}`)).text, /Blue one/);

  // The old page's "Reserve for…" doesn't take it from G1; a deliberate release frees it everywhere.
  const res = await diogo.request(`/admin/items/${i1}/reserve`, { method: 'POST', form: { ...formFields(editPage, `/admin/items/${i1}/reserve`), name: 'Someone' } });
  assert.match(res.location, /m=reservationChanged/);
  const fresh = (await diogo.get(`/admin/items/${i1}`)).text;
  assert.match((await diogo.request(`/admin/items/${i1}/release`, { method: 'POST', form: formFields(fresh, `/admin/items/${i1}/release`) })).location, /m=released/);
  assert.ok((await pickableIds(g2, l2.token)).includes(i2), 'released: offered in L2 again');
});
