// 5.0: navigation (Occasions · People · Lists · My wishlist, /login), every admin's record invisible
// to that admin, ideas wishlists (shared or private) instead of "idea" gifts, and editing wishlist
// items from a list (ideas → the wishlist; someone's own wishlist → that list only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  startServer, Client, loginAdmin, inviteAdmin, joinList, pickableIds, webhookReceiver, sleep, personId, wishlistOf,
} from './helpers.js';
import { migrations, migrate, SCHEMA_VERSION } from '../src/migrations.js';

let server, diogo, maria, bea;
before(async () => {
  server = await startServer();
  diogo = await loginAdmin(server.base);
  maria = await inviteAdmin(server.base, diogo, { username: 'maria50', name: 'Maria' });
  bea = await inviteAdmin(server.base, diogo, { username: 'bea50', name: 'Bea' });
});
after(async () => { await server?.stop(); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const text = async (c, path) => (await c.get(path)).text;
const idFrom = (loc, what) => Number(new RegExp(`/admin/${what}/(\\d+)`).exec(loc)?.[1]);
const addPerson = async (admin, fields) =>
  idFrom((await admin.post('/admin/people', { visibility: 'shared', ...fields }, { from: '/admin/people' })).location, 'people');
const lisbonDay = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date(Date.now() + n * 86_400_000));
const birthdayIn = (n) => { const d = lisbonDay(n); return { birthday_day: String(Number(d.slice(8))), birthday_month: String(Number(d.slice(5, 7))) }; };

async function addIdea(admin, person, title, extra = {}) {
  const r = await admin.post('/admin/wishlist/items', { person_id: String(person), title, ...extra }, { from: `/admin/people/${person}` });
  assert.equal(r.status, 303);
  return Number(/#wish-(\d+)/.exec(r.location)?.[1]);
}
async function addOwnWish(admin, title, extra = {}) {
  const r = await admin.post('/admin/wishlist/items', { title, ...extra }, { from: '/admin/wishlist' });
  return Number(/#wish-(\d+)/.exec(r.location)?.[1]);
}
async function listFrom(admin, wid, itemIds, title, visibility = 'shared') {
  const form = new URLSearchParams({ title, visibility, auto_add_new: '1' });
  for (const id of itemIds) form.append('items', String(id));
  form.append('_csrf', await admin.csrf('/admin/lists'));
  const res = await fetch(`${server.base}/admin/wishlists/${wid}/new-list`, { method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' } });
  const id = idFrom(res.headers.get('location'), 'lists');
  const page = await text(admin, `/admin/lists/${id}`);
  return {
    id,
    token: /\/l\/([A-Za-z0-9_-]{22})/.exec(page)[1],
    itemIds: [...page.matchAll(/\/admin\/items\/(\d+)\/delete/g)].map((m) => Number(m[1])),
  };
}
const normalize = (html) => html.replace(/name="_csrf" value="[^"]+"/g, '');

// ---------- navigation ----------

test('navigation: Occasions · People · Lists · My wishlist (top and bottom bar); settings in the account menu', async () => {
  const page = await text(diogo, '/admin/occasions');
  const top = page.slice(page.indexOf('class="admin-nav"'), page.indexOf('</nav>', page.indexOf('class="admin-nav"')));
  assert.deepEqual([...top.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/admin/occasions', '/admin/people', '/admin/lists', '/admin/wishlist']);
  const bottom = page.slice(page.indexOf('class="bottom-nav"'), page.indexOf('</nav>', page.indexOf('class="bottom-nav"')));
  assert.deepEqual([...bottom.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/admin/occasions', '/admin/people', '/admin/lists', '/admin/wishlist']);
  assert.match(bottom, /<span>My wishlist<\/span>/, 'the full name on the phone too');
  assert.match(bottom, /<svg class="nav-icon"/);
  const menu = page.slice(page.indexOf('class="account-menu"'), page.indexOf('</details>', page.indexOf('class="account-menu"')));
  assert.deepEqual([...menu.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/admin/profile', '/admin/notifications', '/admin/users']);
  assert.match(menu, /action="\/admin\/logout"/);
  assert.ok(!page.includes('Gifts to give'));
  // The old back-office addresses are gone (no redirects).
  for (const old of ['/admin/give', '/admin/give/people', '/admin/give/occasions', '/admin/wishlists']) {
    assert.equal((await diogo.get(old)).status, 404, old);
  }
});

test('after login the home page is Occasions (upcoming); guest links never ask for a login', async () => {
  const c = new Client(server.base);
  const r = await c.request('/login', { method: 'POST', form: { username: 'admin', password: 'test-password-123' } });
  assert.equal(r.location, '/admin');
  assert.equal((await c.get('/admin')).location, '/admin/occasions');
  const home = await text(c, '/admin/occasions');
  assert.match(home, /class="subtab active" aria-current="page">Upcoming</);

  const list = await diogo.post('/admin/lists', { title: 'Guest link 50' }, { from: '/admin/lists' });
  const token = /\/l\/([A-Za-z0-9_-]{22})/.exec(await text(diogo, list.location.split('?')[0]))[1];
  const stranger = new Client(server.base);
  const open = await stranger.get(`/l/${token}`);
  assert.equal(open.status, 200, 'the share link opens without any login');
  assert.match(open.text, /action="\/l\/[^"]+\/join"/);
  const guest = await joinList(server.base, token, 'Guest 50');
  assert.equal((await guest.get(`/l/${token}`)).status, 200);
  assert.ok(!(await guest.get(`/l/${token}`)).location.includes('/login'));
});

test('Occasions: Upcoming (60 days, cards with their state) and All (by year); Christmas pinned from 1 November', async () => {
  const kid = await addPerson(diogo, { name: 'Upcoming Kid', ...birthdayIn(10) });
  const far = await addPerson(diogo, { name: 'Far Kid', ...birthdayIn(120) });
  const y = new Date().getFullYear() + 3;
  const occ = idFrom((await diogo.post('/admin/occasions', { name: `Party ${y}`, date: `${y}-06-01`, people: String(kid) }, { from: '/admin/occasions' })).location, 'occasions');
  const up = await text(diogo, '/admin/occasions');
  assert.match(up, /Upcoming Kid&#39;s birthday[\s\S]{0,300}no gift yet/);
  assert.ok(!up.includes('Far Kid'));
  assert.ok(!up.includes(`Party ${y}`), 'not in the next 60 days');
  const all = await text(diogo, '/admin/occasions?view=all');
  assert.match(all, new RegExp(`<h2>${y}</h2>\\s*<ul class="upcoming compact">[\\s\\S]*Party ${y}`));
  assert.match(all, /class="subtab active" aria-current="page">All</);
  assert.ok(far && occ);

  const xYear = Number(lisbonDay(0).slice(0, 4)) + (lisbonDay(0).slice(5) > '12-25' ? 1 : 0);
  await diogo.post('/admin/occasions/christmas', { year: String(xYear) }, { from: '/admin/occasions' });
  const now = await text(diogo, '/admin/occasions');
  const season = lisbonDay(0).slice(5) >= '11-01' && lisbonDay(0).slice(5) <= '12-25'; // see giving-unit
  if (season) {
    assert.match(now, new RegExp(`<ul class="upcoming pinned-list"><li class="[^"]*pinned">[\\s\\S]*?Christmas ${xYear}`), 'pinned on top');
  } else {
    assert.ok(!now.includes('pinned-list'));
  }
});

// ---------- every admin's record, invisible to that admin ----------

test("each admin gets a record the others see; it never reaches them (people, occasions, checklists, totals, search, API)", async () => {
  const mariaP = await personId(diogo, 'Maria');
  assert.ok(mariaP, 'created when she accepted the invite');
  assert.ok(await personId(bea, 'Maria'));
  assert.equal(await personId(maria, 'Maria'), null, 'not in her People');
  assert.equal((await maria.get(`/admin/people/${mariaP}`)).status, 404);
  assert.ok(!(await text(maria, '/admin/people?q=Maria')).includes(`/admin/people/${mariaP}`), 'nor in a search');

  // Her birthday comes from her profile (and wins over one typed on the record).
  await diogo.post(`/admin/people/${mariaP}`, { name: 'Maria', birthday_day: '1', birthday_month: '1', visibility: 'shared' }, { from: `/admin/people/${mariaP}` });
  const bd = birthdayIn(9);
  const saved = await maria.post('/admin/profile', { name: 'Maria', username: 'maria50', ...bd }, { from: '/admin/profile' });
  assert.match(saved.location, /m=saved/);
  const record = await text(diogo, `/admin/people/${mariaP}/edit`);
  assert.match(record, new RegExp(`name="birthday_day"[^>]*value="${bd.birthday_day}"`));
  await diogo.post(`/admin/people/${mariaP}`, { name: 'Maria', birthday_day: '2', birthday_month: '2', visibility: 'shared' }, { from: `/admin/people/${mariaP}` });
  assert.match(await text(diogo, `/admin/people/${mariaP}/edit`), new RegExp(`name="birthday_day"[^>]*value="${bd.birthday_day}"`), 'the profile wins');
  assert.match(await text(diogo, '/admin/occasions'), /Maria&#39;s birthday/, 'the others are reminded of it');
  assert.ok(!(await text(maria, '/admin/occasions')).includes('Maria&#39;s birthday'), 'she is not');

  // Shared gifts for her: the others see them (and the totals), she never does.
  const kid = await addPerson(diogo, { name: 'Xmas Kid' });
  const y = new Date().getFullYear() + 5;
  const xmas = idFrom((await diogo.post('/admin/occasions/christmas', { year: String(y) }, { from: '/admin/occasions' })).location, 'occasions');
  for (const p of [mariaP, kid]) await diogo.post(`/admin/occasions/${xmas}/participants`, { person_id: String(p) }, { from: '/admin/occasions' });
  const gift = await diogo.post('/admin/gifts', { person_id: String(mariaP), occasion: `occasion:${xmas}`, name: 'Hidden necklace', status: 'bought', price: '40', visibility: 'shared', image_data: PNG }, { from: '/admin/occasions' });
  const giftId = Number(/#gift-(\d+)/.exec(gift.location)[1]);
  const forBea = await text(bea, `/admin/occasions/${xmas}`);
  assert.match(forBea, /Hidden necklace/, 'shared among the other admins');
  assert.match(forBea, /1 of 2 people have a gift|1\/2|Total spent: €40\.00/);
  const forMaria = await text(maria, `/admin/occasions/${xmas}`);
  assert.ok(!forMaria.includes('Hidden necklace'));
  assert.ok(!forMaria.includes('€40'), 'not in the totals');
  assert.ok(!/<strong>[^<]*Maria<\/strong><\/a>/.test(forMaria), 'not among the participants');
  assert.ok(!(await text(maria, `/admin/occasions?view=all`)).includes('1/2'));
  const preview = JSON.parse((await maria.get(`/admin/previews?kind=gift&ids=${giftId}`)).text);
  assert.deepEqual(preview, {}, 'nor through the preview API');
  const img = /src="\/img\/([^"]+)"/.exec((await text(diogo, `/admin/people/${mariaP}`)).split('Hidden necklace')[0].split('<li class="gift"').pop())?.[1];
  if (img) assert.equal((await maria.request(`/img/${img}`)).status, 404, 'nor its photo');
  assert.equal((await maria.post(`/admin/gifts/${giftId}/delete`, {}, { from: '/admin/lists' })).status, 404);

  // Reminders: Maria has a channel, her own birthday is never in them; Diogo gets it.
  const hook = await webhookReceiver();
  try {
    await maria.post('/admin/notifications', { webhook_url: hook.url }, { from: '/admin/notifications' });
    await maria.post('/admin/notifications/reminders', { reminder_days: '14' }, { from: '/admin/notifications' });
    await maria.post('/admin/notifications/reminders/test', {}, { from: '/admin/notifications' });
    await sleep(200);
    assert.ok(!hook.calls.some((c) => /Maria/.test(c.title || '')), 'never reminded of her own birthday');
    await diogo.post('/admin/notifications', { webhook_url: hook.url }, { from: '/admin/notifications' });
    await diogo.post('/admin/notifications/reminders', { reminder_days: '14' }, { from: '/admin/notifications' });
    await diogo.post('/admin/notifications/reminders/test', {}, { from: '/admin/notifications' });
    for (let i = 0; i < 30 && !hook.calls.some((c) => /Maria/.test(c.title || '')); i++) await sleep(100);
    assert.ok(hook.calls.some((c) => c.event === 'reminder' && /Maria/.test(c.title)));
  } finally {
    await maria.post('/admin/notifications', {}, { from: '/admin/notifications' });
    await diogo.post('/admin/notifications', {}, { from: '/admin/notifications' });
    await hook.close();
  }
});

test('a new admin whose name is already a person: asked, never linked alone; "Create a new one" makes a fresh record', async () => {
  const old = await addPerson(diogo, { name: 'Rui50' });
  const rui = await inviteAdmin(server.base, diogo, { username: 'rui50', name: 'Rui50' });
  const people = await text(diogo, '/admin/people');
  assert.match(people, /Rui50 is now a Giftly admin/);
  assert.match(people, /There is already a person called “Rui50”. Is it the same one\?/);
  assert.equal((await rui.get(`/admin/people/${old}`)).status, 200, 'not linked until someone answers');
  assert.ok(!(await text(rui, '/admin/people')).includes('Is it the same one'), 'never asked about yourself');
  const uid = Number(/\/admin\/people\/admins\/(\d+)\/new/.exec(people)[1]);
  assert.equal((await rui.post(`/admin/people/admins/${uid}/new`, {}, { from: '/admin/people' })).status, 404);
  assert.equal((await diogo.post(`/admin/people/admins/${uid}/new`, {}, { from: '/admin/people' })).status, 303);
  assert.equal((await diogo.post(`/admin/people/admins/${uid}/new`, {}, { from: '/admin/people' })).status, 404, 'only once');
  assert.equal((await diogo.post(`/admin/people/admins/${uid}/link`, { person_id: String(old) }, { from: '/admin/people' })).status, 404, 'already has a record');
  assert.equal((await rui.get(`/admin/people/${old}`)).status, 200, 'the old person stays a separate, visible person');
  assert.ok(!(await text(diogo, '/admin/people')).includes('Is it the same one'));
  const mine = await personId(diogo, 'Rui50');
  assert.ok(mine);
});

// ---------- ideas wishlists ----------

test('ideas: shared ones for everyone who sees the person; private ones only for you (and lists with them stay private)', async () => {
  const kid = await addPerson(diogo, { name: 'Ideas Kid', ...birthdayIn(20) });
  const shared = await addIdea(diogo, kid, 'Shared puzzle');
  const secret = await addIdea(diogo, kid, 'Secret drone', { private: '1' });
  const forDiogo = await text(diogo, `/admin/people/${kid}`);
  assert.match(forDiogo, /Your private ideas for Ideas Kid[\s\S]*Secret drone/);
  const forBea = await text(bea, `/admin/people/${kid}`);
  assert.match(forBea, /Shared puzzle/);
  assert.ok(!forBea.includes('Secret drone'));
  assert.equal((await bea.post(`/admin/wishlist/items/${secret}`, { title: 'peek' }, { from: '/admin/lists' })).status, 404);
  assert.equal((await bea.post(`/admin/wishlist/items/${secret}/remove`, { reason: 'unwanted' }, { from: '/admin/lists' })).status, 404);

  // "I'll give it" works on both; a private idea becomes a private gift.
  const occasion = /<option value="(birthday:\d+)"/.exec(forDiogo)[1];
  const sharedW = Number(new RegExp(`/admin/wishlists/(\\d+)/items/${shared}/give`).exec(forDiogo)[1]);
  const privateW = Number(new RegExp(`/admin/wishlists/(\\d+)/items/${secret}/give`).exec(forDiogo)[1]);
  assert.equal((await bea.post(`/admin/wishlists/${privateW}/items/${secret}/give`, { occasion }, { from: '/admin/lists' })).status, 404);
  assert.match((await diogo.post(`/admin/wishlists/${privateW}/items/${secret}/give`, { occasion }, { from: '/admin/lists' })).location, /m=giving/);
  assert.match((await bea.post(`/admin/wishlists/${sharedW}/items/${shared}/give`, { occasion }, { from: '/admin/lists' })).location, /m=giving/);
  const history = await text(diogo, `/admin/people/${kid}`);
  assert.match(history, /Gift history[\s\S]*Secret drone[\s\S]*Private/);
  assert.match(await text(diogo, `/admin/people/${kid}`), /Gift history[\s\S]*Shared puzzle/);
  assert.ok(!(await text(bea, `/admin/people/${kid}`)).split('Gift history')[1].includes('Secret drone'));

  // A list with private ideas is private, and stays hidden from the others even if made shared.
  const more = await addIdea(diogo, kid, 'Another secret', { private: '1' });
  const list = await listFrom(diogo, sharedW, [more], 'With secrets', 'shared');
  const made = await text(diogo, `/admin/lists/${list.id}`);
  assert.match(made, /Another secret/);
  assert.match(made, /<h1>With secrets [\s\S]{0,120}badge private/, 'created private even though "shared" was asked');
  assert.equal((await bea.get(`/admin/lists/${list.id}`)).status, 404);
  await diogo.post(`/admin/lists/${list.id}`, { title: 'With secrets', visibility: 'shared' }, { from: `/admin/lists/${list.id}` });
  assert.equal((await bea.get(`/admin/lists/${list.id}`)).status, 404, 'still hidden: it has private ideas');
  const beaList = await listFrom(bea, sharedW, [], 'Bea for kid', 'shared');
  assert.ok(!(await text(bea, `/admin/lists/${beaList.id}`)).includes('Another secret'));
});

test('the checklist only keeps what will be given; "pick from the wishlist" works for ideas and for an admin\'s own wishlist', async () => {
  const p = await addPerson(diogo, { name: 'Check Kid' });
  const y = new Date().getFullYear() + 7;
  const occ = idFrom((await diogo.post('/admin/occasions/christmas', { year: String(y) }, { from: '/admin/occasions' })).location, 'occasions');
  const beaP = await personId(diogo, 'Bea');
  for (const id of [p, beaP]) await diogo.post(`/admin/occasions/${occ}/participants`, { person_id: String(id) }, { from: '/admin/occasions' });
  const page = await text(diogo, `/admin/occasions/${occ}`);
  assert.ok(!/<option value="idea"/.test(page));
  assert.match(page, /<option value="planned"[^>]*>📌 Planned/);
  assert.equal((await diogo.post('/admin/gifts', { person_id: String(p), occasion: `occasion:${occ}`, name: 'x', status: 'idea' }, { from: '/admin/lists' })).location.includes('m=giftAdded'), true, 'an unknown status falls back to planned');
  assert.match(page, new RegExp(`/admin/people/${beaP}\\?occasion=occasion%3A${occ}#wishlist`));

  const idea = await addIdea(diogo, p, 'Checklist idea');
  const own = await addOwnWish(bea, 'Bea own wish');
  const beaBefore = normalize(await text(bea, '/admin/wishlist'));
  for (const [person, item] of [[p, idea], [beaP, own]]) {
    const pick = await text(diogo, `/admin/people/${person}?occasion=occasion:${occ}`);
    assert.match(pick, new RegExp(`Choosing for <strong>Christmas ${y}</strong>`));
    const w = Number(new RegExp(`/admin/wishlists/(\\d+)/items/${item}/give`).exec(pick)[1]);
    const r = await diogo.post(`/admin/wishlists/${w}/items/${item}/give`, { occasion: `occasion:${occ}`, back: `/admin/occasions/${occ}` }, { from: '/admin/lists' });
    assert.match(r.location, new RegExp(`^/admin/occasions/${occ}\\?m=giving#gift-\\d+$`));
  }
  const after = await text(diogo, `/admin/occasions/${occ}`);
  assert.match(after, /Checklist idea/);
  assert.match(after, /Bea own wish/);
  assert.equal(normalize(await text(bea, '/admin/wishlist')), beaBefore, 'Bea learns nothing');
});

// ---------- editing wishlist items from a list ----------

test("ideas edited from a list change the wishlist item: every linked list follows", async () => {
  const kid = await addPerson(diogo, { name: 'Edit Kid' });
  const idea = await addIdea(diogo, kid, 'Jigsaw');
  const w = await wishlistOf(diogo, 'Edit Kid');
  const a = await listFrom(diogo, w, [idea], 'List A');
  const b = await listFrom(bea, w, [idea], 'List B');
  const guest = await joinList(server.base, a.token, 'Avó 50');
  await guest.post(`/l/${a.token}/pick/${a.itemIds[0]}`, {}, { from: `/l/${a.token}` });

  const form = await text(diogo, `/admin/items/${a.itemIds[0]}`);
  assert.match(form, /This change applies to every list with this item/);
  await diogo.post(`/admin/items/${a.itemIds[0]}`, { title: 'Jigsaw 1000', url: '', notes: 'ages 8+', list_notes: '' }, { from: `/admin/items/${a.itemIds[0]}` });
  assert.match(await text(bea, `/admin/lists/${b.id}`), /Jigsaw 1000/);
  assert.match(await text(diogo, `/admin/people/${kid}`), /Jigsaw 1000[\s\S]*ages 8\+/);
  assert.match(await text(guest, `/l/${a.token}`), /Jigsaw 1000/);
  assert.match(await text(diogo, `/admin/lists/${a.id}`), /Reserved by Avó 50/, 'editing never touches the reservation');
});

test("someone's own wishlist edited from a list: only that list changes; she never notices; overrides, \"the wishlist changed\", reset", async () => {
  const scarf = await addOwnWish(maria, 'Blue scarf', { notes: 'size M' });
  const w = await wishlistOf(diogo, 'Maria');
  const mine = await listFrom(diogo, w, [scarf], 'Diogo for Maria');
  const other = await listFrom(bea, w, [scarf], 'Bea for Maria');
  const item = mine.itemIds[0];
  const guest = await joinList(server.base, mine.token, 'Tio 50');
  await guest.post(`/l/${mine.token}/pick/${item}`, {}, { from: `/l/${mine.token}` });

  const ownerBefore = normalize(await text(maria, '/admin/wishlist'));
  const form = await text(diogo, `/admin/items/${item}`);
  assert.match(form, /From Maria&#39;s wishlist: what you change here stays in this list only/);
  await diogo.post(`/admin/items/${item}`, { title: 'Blue wool scarf', url: '', notes: 'size M', list_notes: '', image_data: PNG }, { from: `/admin/items/${item}` });
  const photo = /<li class="item[^"]*" id="item-\d+"[\s\S]*?src="\/img\/([^"]+)"/.exec(await text(diogo, `/admin/lists/${mine.id}`))?.[1];
  assert.ok(photo, 'a photo uploaded in this list');

  assert.match(await text(diogo, `/admin/lists/${mine.id}`), /Blue wool scarf[\s\S]*Edited in this list/);
  assert.match(await text(guest, `/l/${mine.token}`), /Blue wool scarf/);
  assert.match(await text(bea, `/admin/lists/${other.id}`), /Blue scarf</, 'other lists keep following the wishlist');
  assert.equal(normalize(await text(maria, '/admin/wishlist')), ownerBefore, 'her wishlist and her view are unchanged');
  assert.match(await text(diogo, `/admin/lists/${mine.id}`), /Reserved by Tio 50/, 'the reservation is untouched');

  // She edits the same field and another one: the list keeps its name, takes her notes, and says so.
  const a = await maria.post(`/admin/wishlist/items/${scarf}`, { title: 'Blue scarf XL', url: '', notes: 'size L' }, { from: '/admin/wishlist' });
  const b = await maria.post(`/admin/wishlist/items/${scarf}`, { title: 'Blue scarf XL', url: '', notes: 'size L' }, { from: '/admin/wishlist' });
  assert.equal(a.location, b.location, 'same answer for her');
  const listPage = await text(diogo, `/admin/lists/${mine.id}`);
  assert.match(listPage, /Blue wool scarf/);
  assert.ok(listPage.includes(`/img/${photo}`), 'its own photo stays when the wishlist changes');
  assert.match(listPage, /size L/);
  assert.match(listPage, /The wishlist changed/);
  assert.match(await text(bea, `/admin/lists/${other.id}`), /Blue scarf XL/);
  const changed = await text(diogo, `/admin/items/${item}`);
  assert.match(changed, /The wishlist changed \(name\)/);
  assert.match(changed, /In the wishlist: Blue scarf XL/);

  await diogo.post(`/admin/items/${item}/override/accept`, {}, { from: `/admin/items/${item}` });
  let page = await text(diogo, `/admin/lists/${mine.id}`);
  assert.match(page, /Blue scarf XL/);
  assert.ok(!page.includes('The wishlist changed'));
  assert.match(page, /Edited in this list/, 'only what changed there was taken: its own photo stays');
  assert.ok(page.includes(`/img/${photo}`));

  await diogo.post(`/admin/items/${item}`, { title: 'Scarf (Diogo)', url: 'https://shop.example/scarf', notes: 'size L', list_notes: 'wrap it' }, { from: `/admin/items/${item}` });
  page = await text(diogo, `/admin/lists/${mine.id}`);
  assert.match(page, /Scarf \(Diogo\)/);
  assert.match(page, /shop\.example/);
  await diogo.post(`/admin/items/${item}/override/reset`, {}, { from: `/admin/items/${item}` });
  page = await text(diogo, `/admin/lists/${mine.id}`);
  assert.match(page, /Blue scarf XL/);
  assert.ok(!page.includes('shop.example'));
  assert.match(page, /wrap it/, "the list's own note stays");
  assert.ok(!page.includes('Edited in this list'));
  assert.ok(!page.includes(`/img/${photo}`), 'back to the wishlist (which has no photo)');
  assert.match(page, /Reserved by Tio 50/);
  assert.ok(!(await text(maria, '/admin/wishlist')).includes('Scarf (Diogo)'));
  assert.equal((await maria.post(`/admin/items/${item}/override/reset`, {}, { from: '/admin/lists' })).status, 404, 'she can never reach that list');
});

// ---------- the 5.0 migration ----------

test('migration to 5.0: ideas move to ideas wishlists without losses; "I\'ll give it" gifts become planned; records for admins', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (let v = 0; v < 16; v++) db.exec(typeof migrations[v] === 'string' ? migrations[v] : migrations[v].sql);
  db.exec('PRAGMA user_version = 16');
  const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
  const A = ins("INSERT INTO users (username, name, password_hash, created_at) VALUES ('a', 'Ana', 'x', 0)");
  const B = ins("INSERT INTO users (username, name, password_hash, created_at) VALUES ('b', 'Bruno', 'x', 0)");
  const C = ins("INSERT INTO users (username, name, password_hash, created_at) VALUES ('c', 'Kid', 'x', 0)");
  const kid = ins("INSERT INTO people (name, visibility, owner_id, created_at) VALUES ('Kid', 'shared', ?, 0)", A);
  const other = ins("INSERT INTO people (name, visibility, owner_id, created_at) VALUES ('Other', 'shared', ?, 0)", A);
  const bruno = ins("INSERT INTO people (name, visibility, owner_id, user_id, created_at) VALUES ('Bruno', 'shared', ?, ?, 0)", A, B);
  const ownB = ins("INSERT INTO wishlists (owner_id, visibility, created_at) VALUES (?, 'admins', 0)", B);
  const ownA = ins("INSERT INTO wishlists (owner_id, visibility, created_at) VALUES (?, 'private', 0)", A);
  const kidW = ins('INSERT INTO wishlists (person_id, visibility, created_at) VALUES (?, \'admins\', 0)', kid);
  const wish = ins("INSERT INTO wishlist_items (wishlist_id, title, created_at, updated_at) VALUES (?, 'Bruno wants', 0, 0)", ownB);
  const gift = (person, name, status, visibility, extra = {}) => {
    const id = ins(`INSERT INTO gifts (person_id, year, name, url, status, visibility, owner_id, price_cents, price_currency, wishlist_item_id, created_at, updated_at)
      VALUES (?, 2026, ?, 'https://shop.example/x', ?, ?, ?, ?, 'EUR', ?, 0, 0)`, person, name, status, visibility, A, extra.cents ?? null, extra.wish ?? null);
    for (const p of [person, ...(extra.also ?? [])]) db.prepare('INSERT INTO gift_people (gift_id, person_id) VALUES (?, ?)').run(id, p);
    return id;
  };
  const sharedIdea = gift(kid, 'Shared idea', 'idea', 'shared', { cents: 1250 });
  gift(kid, 'Private idea', 'idea', 'private');
  gift(bruno, 'Idea for Bruno', 'idea', 'private');
  gift(kid, 'Joint idea', 'idea', 'shared', { also: [other] });
  const giving = gift(bruno, 'Giving it', 'idea', 'private', { wish });
  db.prepare('INSERT INTO wishlist_claims (wishlist_item_id, gift_id, created_at) VALUES (?, ?, 0)').run(wish, giving);
  const bought = gift(kid, 'Bought one', 'bought', 'shared');
  const list = ins("INSERT INTO lists (title, token, created_at) VALUES ('L', 'tok50tok50tok50tok50xx', 0)");
  const item = ins("INSERT INTO items (list_id, title, reserved_name, created_at) VALUES (?, 'Shared idea', 'Avó', 0)", list);
  db.prepare('UPDATE gifts SET list_item_id = ? WHERE id = ?').run(item, sharedIdea);

  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(db.prepare('SELECT name, status FROM gifts ORDER BY id').all().map((r) => ({ ...r })),
    [{ name: 'Giving it', status: 'planned' }, { name: 'Bought one', status: 'bought' }]);
  assert.ok(db.prepare('SELECT 1 FROM wishlist_claims WHERE gift_id = ?').get(giving), '"I\'ll give it" keeps its reservation');
  assert.ok(bought);

  const ideasOf = (person, owner) => db.prepare(`SELECT wi.title, wi.price, wi.url FROM wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id
    WHERE w.kind = 'ideas' AND w.person_id = ? AND COALESCE(w.owner_id, 0) = ? ORDER BY wi.id`).all(person, owner ?? 0).map((r) => ({ ...r }));
  const shared = ideasOf(kid, null);
  assert.deepEqual(shared.map((r) => r.title), ['Shared idea', 'Joint idea']);
  assert.match(shared[0].price, /12[,.]50/);
  assert.equal(shared[0].url, 'https://shop.example/x');
  assert.deepEqual(ideasOf(kid, A).map((r) => r.title), ['Private idea'], 'private ideas stay private to their admin');
  assert.deepEqual(ideasOf(bruno, A).map((r) => r.title), ['Idea for Bruno'], 'ideas for an admin: private to the giver');
  assert.equal(db.prepare("SELECT visibility FROM wishlists WHERE kind = 'ideas' AND person_id = ? AND owner_id = ?").get(kid, A).visibility, 'private');

  const linked = db.prepare('SELECT wishlist_item_id FROM items WHERE id = ?').get(item).wishlist_item_id;
  assert.ok(linked, 'the guest-list copy is now linked to the new wishlist item');
  assert.ok(db.prepare('SELECT 1 FROM wishlist_claims WHERE wishlist_item_id = ? AND item_id = ?').get(linked, item), 'its reservation kept');

  const w = (id) => ({ ...db.prepare('SELECT kind, owner_id, person_id, visibility FROM wishlists WHERE id = ?').get(id) });
  assert.deepEqual(w(ownB), { kind: 'own', owner_id: B, person_id: null, visibility: 'shared' });
  assert.deepEqual(w(ownA), { kind: 'own', owner_id: A, person_id: null, visibility: 'private' });
  assert.deepEqual(w(kidW), { kind: 'ideas', owner_id: null, person_id: kid, visibility: 'shared' });

  const linkedTo = (u) => db.prepare('SELECT name FROM people WHERE user_id = ?').all(u).map((r) => r.name);
  assert.deepEqual(linkedTo(A), ['Ana'], 'a record is created for each admin');
  assert.deepEqual(linkedTo(B), ['Bruno'], 'an existing link is kept');
  assert.deepEqual(linkedTo(C), [], 'same name as an unlinked person: asked in the app, not linked alone');
  db.close();
});

// ---------- 5.0.1: one way to add things ----------

test('every main screen has its "＋ New …" button on top, opening a page with the form', async () => {
  const head = (html) => html.slice(html.indexOf('<div class="page-head">'), html.indexOf('</div>', html.indexOf('<div class="page-head">')));
  for (const [page, href] of [['/admin/occasions', '/admin/occasions/new'], ['/admin/people', '/admin/people/new'],
    ['/admin/lists', '/admin/lists/new'], ['/admin/wishlist', '/admin/wishlist/new']]) {
    const html = await text(diogo, page);
    assert.match(head(html), new RegExp(`<a class="button primary" href="${href}">＋ `), page);
    assert.equal((await diogo.get(href)).status, 200, href);
  }
  assert.ok(!(await text(diogo, '/admin/lists')).includes('action="/admin/lists"'), 'no form on the index any more');
  assert.match(await text(diogo, '/admin/lists/new'), /action="\/admin\/lists"/);
  assert.match(await text(diogo, '/admin/people/new'), /action="\/admin\/people"/);
  assert.match(await text(diogo, '/admin/wishlist/new'), /action="\/admin\/wishlist\/items"/);

  // A list: "Add a gift" on top of its gifts, with its own page (one or many).
  const list = idFrom((await diogo.post('/admin/lists', { title: 'Add flow' }, { from: '/admin/lists/new' })).location, 'lists');
  assert.match(await text(diogo, `/admin/lists/${list}`), new RegExp(`href="/admin/lists/${list}/items/new"`));
  const add = await text(diogo, `/admin/lists/${list}/items/new`);
  assert.match(add, new RegExp(`action="/admin/lists/${list}/items"`));
  assert.match(add, new RegExp(`action="/admin/lists/${list}/items/bulk"`));
  assert.equal((await maria.get(`/admin/lists/${list}/items/new`)).status, 200, 'shared list: other admins too');
  const priv = idFrom((await diogo.post('/admin/lists', { title: 'Private add', visibility: 'private' }, { from: '/admin/lists/new' })).location, 'lists');
  assert.equal((await maria.get(`/admin/lists/${priv}/items/new`)).status, 404, 'only lists you can see');

  // Mistakes come back on the same page, with what was typed.
  const bad = await diogo.post(`/admin/lists/${list}/items`, { title: 'Bad link', url: 'javascript:alert(1)' }, { from: `/admin/lists/${list}/items/new` });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /value="Bad link"/);
  const noName = await diogo.post('/admin/people', { name: '', notes: 'kept' }, { from: '/admin/people/new' });
  assert.equal(noName.status, 400);
  assert.match(noName.text, /kept<\/textarea>/);
  const noTitle = await diogo.post('/admin/lists', { title: '', description: 'kept too' }, { from: '/admin/lists/new' });
  assert.equal(noTitle.status, 400);
  assert.match(noTitle.text, /kept too/);
  const noWish = await diogo.post('/admin/wishlist/items', { title: '', notes: 'still here' }, { from: '/admin/wishlist/new' });
  assert.equal(noWish.status, 400);
  assert.match(noWish.text, /value="still here"/);
});

test('"All" occasions include birthdays: everyone\'s this year, and earlier ones that had gifts', async () => {
  const year = Number(lisbonDay(0).slice(0, 4));
  const ana = await addPerson(diogo, { name: 'Allyear Ana', birthday_day: '15', birthday_month: '3' });
  const old = await addPerson(diogo, { name: 'Allyear Old', birthday_day: '20', birthday_month: '7' });
  await diogo.post('/admin/gifts', { person_id: String(old), occasion: `birthday:${year - 2}`, name: 'Old kite', status: 'given' }, { from: '/admin/lists' });
  const all = await text(diogo, '/admin/occasions?view=all');
  const section = (y) => all.slice(all.indexOf(`<h2>${y}</h2>`), all.indexOf('</ul>', all.indexOf(`<h2>${y}</h2>`)));
  assert.match(section(year), /Allyear Ana&#39;s birthday/);
  assert.match(section(year), /Allyear Old&#39;s birthday/);
  assert.match(section(year - 2), /Allyear Old&#39;s birthday[\s\S]*has a gift/, 'an earlier birthday with a gift');
  assert.ok(!section(year - 1).includes('Allyear'), 'earlier birthdays without gifts are left out');
  assert.match(all, new RegExp(`href="/admin/people/${ana}#year-${year}"`));
  const found = await text(diogo, '/admin/occasions?view=all&q=allyear%20ana');
  assert.match(found, /Allyear Ana/);
  assert.ok(!found.includes('Allyear Old'));
  // Your own birthday is never there (your record is invisible to you).
  assert.ok(!(await text(maria, '/admin/occasions?view=all')).includes('Maria&#39;s birthday'));
  assert.match(await text(diogo, '/admin/occasions?view=all'), /Maria&#39;s birthday/);
});

// ---------- 5.2: back links, ⚙️ menus, deleting from the history ----------

test('back links go where you came from; the star on a person page shows the favourite', async () => {
  const backOf = (html) => /<p class="backline"><a href="([^"]+)"/.exec(html)?.[1];
  assert.equal(backOf(await text(diogo, '/admin/occasions/new')), '/admin/occasions');
  assert.equal(backOf(await text(diogo, '/admin/occasions/new?from=all')), '/admin/occasions?view=all');
  assert.match(await text(diogo, '/admin/occasions?view=all'), /href="\/admin\/occasions\/new\?from=all"/);
  const y = new Date().getFullYear() + 9;
  const occ = idFrom((await diogo.post('/admin/occasions/christmas', { year: String(y) }, { from: '/admin/occasions' })).location, 'occasions');
  assert.match(await text(diogo, '/admin/occasions?view=all'), new RegExp(`href="/admin/occasions/${occ}\\?from=all"`));
  assert.equal(backOf(await text(diogo, `/admin/occasions/${occ}?from=all`)), '/admin/occasions?view=all');
  assert.equal(backOf(await text(diogo, `/admin/occasions/${occ}`)), '/admin/occasions');
  assert.match(await text(diogo, `/admin/occasions/${occ}?from=all`), new RegExp(`/admin/occasions/${occ}\\?missing=1&amp;from=all`));

  const list = idFrom((await diogo.post('/admin/lists', { title: 'Back list' }, { from: '/admin/lists/new' })).location, 'lists');
  assert.equal(backOf(await text(diogo, `/admin/lists/${list}`)), '/admin/lists');
  const p = await addPerson(diogo, { name: 'Star Person' });
  assert.equal(backOf(await text(diogo, `/admin/people/${p}`)), '/admin/people');
  assert.equal(backOf(await text(diogo, `/admin/people/${p}/new-list`.replace('/new-list', '')) ), '/admin/people');
  const w = await wishlistOf(diogo, 'Star Person');
  assert.equal(backOf(await text(diogo, `/admin/wishlists/${w}/new-list`)), `/admin/people/${p}`);

  await diogo.post(`/admin/people/${p}/favorite`, { on: '1', back: `/admin/people/${p}` }, { from: `/admin/people/${p}` });
  const page = await text(diogo, `/admin/people/${p}`);
  assert.match(page, /class="fav on" aria-pressed="true"/, 'filled star on the person page');
  assert.match(page, /name="on" value="0"/, 'pressing it again removes the favourite');
});

test('settings live in a ⚙️ menu: list, occasion, person and my wishlist', async () => {
  const menu = (html) => html.slice(html.indexOf('class="account-menu gear-menu"'), html.indexOf('</details>', html.indexOf('gear-menu')));
  const list = idFrom((await diogo.post('/admin/lists', { title: 'Gear list' }, { from: '/admin/lists/new' })).location, 'lists');
  const lp = await text(diogo, `/admin/lists/${list}`);
  assert.match(menu(lp), new RegExp(`href="/admin/lists/${list}/edit"`));
  assert.match(menu(lp), new RegExp(`action="/admin/lists/${list}/new-link"`));
  assert.match(menu(lp), new RegExp(`action="/admin/lists/${list}/delete"`));
  assert.ok(!lp.includes(`action="/admin/lists/${list}" `) && !lp.includes(`action="/admin/lists/${list}" class`), 'no settings form at the bottom');
  assert.match(lp, /<details>\s*<summary><strong>Guests<\/strong> <span class="muted small">\(0\)<\/span>/, 'guests folded, with their count');
  assert.match(await text(diogo, `/admin/lists/${list}/edit`), new RegExp(`action="/admin/lists/${list}"`));
  const bad = await diogo.post(`/admin/lists/${list}`, { title: '' }, { from: `/admin/lists/${list}/edit` });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /List settings/);

  const priv = idFrom((await diogo.post('/admin/lists', { title: 'Gear private', visibility: 'private' }, { from: '/admin/lists/new' })).location, 'lists');
  assert.equal((await maria.get(`/admin/lists/${priv}/edit`)).status, 404);

  const occ = idFrom((await diogo.post('/admin/occasions', { name: 'Gear party', date: '2099-01-01' }, { from: '/admin/occasions/new' })).location, 'occasions');
  const op = await text(diogo, `/admin/occasions/${occ}`);
  assert.match(menu(op), new RegExp(`href="/admin/occasions/${occ}/edit"`));
  assert.match(menu(op), new RegExp(`action="/admin/occasions/${occ}/duplicate"`));
  assert.match(menu(op), new RegExp(`action="/admin/occasions/${occ}/delete"`));
  assert.match(await text(diogo, `/admin/occasions/${occ}/edit`), /name="date"[^>]*value="2099-01-01"/);
  assert.equal((await diogo.post(`/admin/occasions/${occ}`, { name: '', date: '2099-01-01' }, { from: `/admin/occasions/${occ}/edit` })).status, 400);

  const p = await addPerson(diogo, { name: 'Gear Person' });
  const pp = await text(diogo, `/admin/people/${p}`);
  assert.match(menu(pp), new RegExp(`href="/admin/people/${p}/edit"`));
  assert.match(menu(pp), new RegExp(`action="/admin/people/${p}/delete"`));
  const mariaP = await personId(diogo, 'Maria');
  const adminMenu = menu(await text(diogo, `/admin/people/${mariaP}`));
  assert.ok(!adminMenu.includes('/delete'), "an admin's record has no delete");
  assert.match(adminMenu, /can&#39;t be deleted/);
  assert.equal((await bea.get(`/admin/people/${(await personId(diogo, 'Bea'))}/edit`)).status, 404, 'never your own record');

  const wp = menu(await text(bea, '/admin/wishlist'));
  assert.match(wp, /✓ Visible to the other admins/);
  await bea.post('/admin/wishlist/visibility', { visibility: 'private' }, { from: '/admin/wishlist' });
  assert.match(menu(await text(bea, '/admin/wishlist')), /✓ Only me/);
  await bea.post('/admin/wishlist/visibility', { visibility: 'shared' }, { from: '/admin/wishlist' });
});

test('removed and received items can be deleted for good — the same answer whether reserved or not', async () => {
  const a = await addOwnWish(bea, 'Delete me reserved');
  const b = await addOwnWish(bea, 'Delete me free');
  const w = await wishlistOf(diogo, 'Bea');
  const list = await listFrom(diogo, w, [a], 'Delete test');
  const guest = await joinList(server.base, list.token, 'Deleter');
  await guest.post(`/l/${list.token}/pick/${list.itemIds[0]}`, {}, { from: `/l/${list.token}` });
  for (const id of [a, b]) await bea.post(`/admin/wishlist/items/${id}/remove`, { reason: 'bought' }, { from: '/admin/wishlist' });
  const page = await text(bea, '/admin/wishlist');
  assert.match(page, new RegExp(`action="/admin/wishlist/items/${a}/delete"`));
  const ra = await bea.post(`/admin/wishlist/items/${a}/delete`, {}, { from: '/admin/wishlist' });
  const rb = await bea.post(`/admin/wishlist/items/${b}/delete`, {}, { from: '/admin/wishlist' });
  assert.equal(ra.status, rb.status);
  assert.equal(ra.location, rb.location, 'identical answers');
  const after = await text(bea, '/admin/wishlist');
  assert.ok(!after.includes('Delete me reserved') && !after.includes('Delete me free'));
  assert.match(await text(diogo, `/admin/lists/${list.id}`), /Delete me reserved[\s\S]*Reserved by Deleter/, 'the list keeps its copy and the reservation');

  // Active items can't be deleted this way (they are removed first, with a reason).
  const c = await addOwnWish(bea, 'Still active');
  await bea.post(`/admin/wishlist/items/${c}/delete`, {}, { from: '/admin/wishlist' });
  assert.match(await text(bea, '/admin/wishlist'), /Still active/);
  assert.equal((await diogo.post(`/admin/wishlist/items/${c}/delete`, {}, { from: '/admin/lists' })).status, 404, "not someone else's");

  // Ideas: whoever can edit them.
  const kid = await addPerson(diogo, { name: 'History Kid' });
  const idea = await addIdea(diogo, kid, 'Old idea');
  await diogo.post(`/admin/wishlist/items/${idea}/remove`, { reason: 'unwanted' }, { from: `/admin/people/${kid}` });
  assert.match(await text(bea, `/admin/people/${kid}`), new RegExp(`/admin/wishlist/items/${idea}/delete`));
  await bea.post(`/admin/wishlist/items/${idea}/delete`, {}, { from: `/admin/people/${kid}` });
  assert.ok(!(await text(diogo, `/admin/people/${kid}`)).includes('Old idea'));
});
