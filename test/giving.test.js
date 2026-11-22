// "Gifts to give": end-to-end tests, focused on the shared/private rule between admins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, loginAdmin, inviteAdmin } from './helpers.js';

let server, diogo, maria;
before(async () => {
  server = await startServer();
  diogo = await loginAdmin(server.base);
  maria = await inviteAdmin(server.base, diogo, { username: 'maria', name: 'Maria' });
});
after(async () => { await server?.stop(); });

// Dates as the server sees them (TZ defaults to Europe/Lisbon).
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = ymd(new Date());
const YEAR = Number(TODAY.slice(0, 4));
const inDays = (n) => ymd(new Date(Date.now() + n * 86_400_000));

const idFrom = (loc, what) => Number(new RegExp(`/admin/give/${what}/(\\d+)`).exec(loc)?.[1]);

async function addPerson(admin, fields) {
  const r = await admin.post('/admin/give/people', { visibility: 'shared', ...fields }, { from: '/admin/give/people' });
  assert.equal(r.status, 303, `create person: ${r.status}`);
  return idFrom(r.location, 'people');
}

async function addOccasion(admin, { name, date, visibility = 'shared', people = [] }) {
  const form = new URLSearchParams({ name, date, visibility });
  for (const p of people) form.append('people', String(p));
  form.append('_csrf', await admin.csrf('/admin/give/occasions'));
  const res = await fetch(`${server.base}/admin/give/occasions`, {
    method: 'POST', body: form, redirect: 'manual',
    headers: { cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.status, 303);
  return idFrom(res.headers.get('location'), 'occasions');
}

async function addGift(admin, { person, occasion, ...fields }) {
  const r = await admin.post('/admin/give/gifts', {
    person_id: String(person), occasion, status: 'idea', visibility: 'shared', ...fields,
  }, { from: '/admin/give' });
  assert.equal(r.status, 303, `create gift: ${r.status} ${r.text.slice(0, 200)}`);
  return Number(/#gift-(\d+)/.exec(r.location)[1]);
}

const page = async (admin, path) => (await admin.get(path)).text;

test('people: create, list and open', async () => {
  const id = await addPerson(diogo, { name: 'Tomás', birthday_day: '3', birthday_month: '5', birth_year: '2019', gives_christmas: '1' });
  assert.match(await page(diogo, '/admin/give/people'), /Tomás/);
  assert.match(await page(maria, `/admin/give/people/${id}`), /Tomás/, 'shared by default');
  const bad = await diogo.post('/admin/give/people', { name: 'X', birthday_day: '31', birthday_month: '2' }, { from: '/admin/give/people' });
  assert.equal(bad.status, 400, '31 February is refused');
});

test('a private person is invisible to the other admin everywhere, and untouchable', async () => {
  const secret = await addPerson(diogo, {
    name: 'Secret Sam', visibility: 'private', birthday_day: inDays(5).slice(8), birthday_month: String(Number(inDays(5).slice(5, 7))), gives_christmas: '1',
  });
  assert.match(await page(diogo, '/admin/give/people'), /Secret Sam/);
  assert.match(await page(diogo, '/admin/give'), /Secret Sam/, 'owner sees the birthday in upcoming');

  assert.ok(!(await page(maria, '/admin/give/people')).includes('Secret Sam'));
  assert.ok(!(await page(maria, '/admin/give')).includes('Secret Sam'));
  assert.equal((await maria.get(`/admin/give/people/${secret}`)).status, 404);
  assert.equal((await maria.post(`/admin/give/people/${secret}`, { name: 'hacked' }, { from: '/admin/give/people' })).status, 404);
  assert.equal((await maria.post(`/admin/give/people/${secret}/delete`, {}, { from: '/admin/give/people' })).status, 404);
  const gift = await maria.post('/admin/give/gifts', { person_id: String(secret), occasion: `birthday:${YEAR}`, name: 'x' }, { from: '/admin/give' });
  assert.equal(gift.status, 404, 'cannot add gifts for someone you cannot see');
  assert.match(await page(diogo, `/admin/give/people/${secret}`), /Secret Sam/, 'still there for the owner');
});

test('a private gift for a shared person: hidden from the other admin, including progress and totals', async () => {
  const ana = await addPerson(diogo, { name: 'Ana Shared' });
  const xmas = await addOccasion(diogo, { name: `Xmas test ${YEAR}`, date: `${YEAR}-12-24`, people: [ana] });
  const secretGift = await addGift(diogo, { person: ana, occasion: `occasion:${xmas}`, name: 'Secret necklace', status: 'bought', price: '50', visibility: 'private' });

  const forDiogo = await page(diogo, `/admin/give/occasions/${xmas}`);
  assert.match(forDiogo, /Secret necklace/);
  assert.match(forDiogo, /1 of 1 people already have a gift/);
  assert.match(forDiogo, /Total spent: €50\.00/);

  const forMaria = await page(maria, `/admin/give/occasions/${xmas}`);
  assert.ok(!forMaria.includes('Secret necklace'));
  assert.match(forMaria, /0 of 1 people already have a gift/);
  assert.ok(!forMaria.includes('Total spent'));
  assert.ok(!(await page(maria, `/admin/give/people/${ana}`)).includes('Secret necklace'));
  assert.ok(!(await page(maria, '/admin/give/occasions')).includes('1/1'), 'counters in the occasions list too');

  // Direct requests on the private gift fail for the other admin.
  for (const path of [`/admin/give/gifts/${secretGift}`, `/admin/give/gifts/${secretGift}/status`, `/admin/give/gifts/${secretGift}/delete`, `/admin/give/gifts/${secretGift}/preview`]) {
    assert.equal((await maria.post(path, { name: 'x', status: 'given' }, { from: '/admin/give' })).status, 404, path);
  }
  assert.equal((await maria.get(`/admin/previews?kind=gift&ids=${secretGift}`)).text, '{}');

  // A shared gift by Maria is visible to both and counts for both.
  await addGift(maria, { person: ana, occasion: `occasion:${xmas}`, name: 'Shared book', status: 'given', price: '12,50' });
  assert.match(await page(maria, `/admin/give/occasions/${xmas}`), /Total spent: €12\.50/);
  assert.match(await page(diogo, `/admin/give/occasions/${xmas}`), /Total spent: €62\.50/);
});

test('a private occasion is invisible to the other admin', async () => {
  const p = await addPerson(diogo, { name: 'Party Person' });
  const occ = await addOccasion(diogo, { name: 'Surprise party', date: inDays(10), visibility: 'private', people: [p] });
  assert.match(await page(diogo, '/admin/give'), /Surprise party/);
  assert.ok(!(await page(maria, '/admin/give')).includes('Surprise party'));
  assert.ok(!(await page(maria, '/admin/give/occasions')).includes('Surprise party'));
  assert.equal((await maria.get(`/admin/give/occasions/${occ}`)).status, 404);
  const g = await addGift(diogo, { person: p, occasion: `occasion:${occ}`, name: 'Party hat' });
  assert.ok(!(await page(maria, `/admin/give/people/${p}`)).includes('Party hat'), 'gifts of a private occasion stay hidden');
  assert.ok(g > 0);
});

test('only the owner can change who sees a person', async () => {
  const p = await addPerson(diogo, { name: 'Owned by Diogo' });
  await maria.post(`/admin/give/people/${p}`, { name: 'Owned by Diogo', visibility: 'private' }, { from: `/admin/give/people/${p}` });
  assert.equal((await diogo.get(`/admin/give/people/${p}`)).status, 200, 'still shared: Maria could not make it private');
  await diogo.post(`/admin/give/people/${p}`, { name: 'Owned by Diogo', visibility: 'private' }, { from: `/admin/give/people/${p}` });
  assert.equal((await maria.get(`/admin/give/people/${p}`)).status, 404, 'the owner could');
});

test("new Christmas is pre-filled with \"gives Christmas\" people; other admins' private people are kept but hidden", async () => {
  const year = YEAR + 1;
  const visible = await addPerson(maria, { name: 'Xmas Cousin', gives_christmas: '1' });
  const hidden = await addPerson(diogo, { name: 'Xmas Secret', gives_christmas: '1', visibility: 'private' });
  const r = await maria.post('/admin/give/occasions/christmas', { year: String(year) }, { from: '/admin/give/occasions' });
  const id = idFrom(r.location, 'occasions');
  const forMaria = await page(maria, `/admin/give/occasions/${id}`);
  assert.match(forMaria, /Xmas Cousin/);
  assert.ok(!forMaria.includes('Xmas Secret'), "Maria's Christmas doesn't pick up Diogo's private people");

  // Diogo adds his private person; Maria editing participants must not remove them.
  await diogo.post(`/admin/give/occasions/${id}/participants`, { person_id: String(hidden) }, { from: `/admin/give/occasions/${id}` });
  await maria.post(`/admin/give/occasions/${id}/participants/${visible}/remove`, {}, { from: `/admin/give/occasions/${id}` });
  const forDiogo = await page(diogo, `/admin/give/occasions/${id}`);
  const rowNames = (html) => [...html.matchAll(/<div class="who-row">\s*<a [^>]*><strong>(?:✓ )?([^<]+)<\/strong>/g)].map((m) => m[1]);
  assert.ok(rowNames(forDiogo).includes('Xmas Secret'), "Diogo's private participant kept");
  assert.ok(!rowNames(forDiogo).includes('Xmas Cousin'), 'removed by Maria');
  const mariaView = await page(maria, `/admin/give/occasions/${id}`);
  assert.ok(!rowNames(mariaView).includes('Xmas Secret'));
  const shown = rowNames(mariaView).length;
  assert.match(mariaView, new RegExp(`0 of ${shown} people`), 'hidden participant is not counted for Maria');
  assert.equal(rowNames(forDiogo).length, shown + 1, 'but is counted for Diogo');

  // Asking for the same Christmas again opens the existing one.
  const again = await maria.post('/admin/give/occasions/christmas', { year: String(year) }, { from: '/admin/give/occasions' });
  assert.equal(idFrom(again.location, 'occasions'), id);
});

test('upcoming birthdays: in the next 60 days, with gift status', async () => {
  const soon = inDays(2);
  const p = await addPerson(diogo, { name: 'Birthday Soon', birthday_day: String(Number(soon.slice(8))), birthday_month: String(Number(soon.slice(5, 7))) });
  const far = inDays(90);
  await addPerson(diogo, { name: 'Birthday Far', birthday_day: String(Number(far.slice(8))), birthday_month: String(Number(far.slice(5, 7))) });
  let up = await page(maria, '/admin/give');
  assert.match(up, /Birthday Soon/);
  assert.ok(!up.includes('Birthday Far'));
  const block = (html) => html.slice(html.indexOf('Birthday Soon') - 400, html.indexOf('Birthday Soon') + 600);
  assert.match(block(up), /no gift yet/);

  await addGift(maria, { person: p, occasion: `birthday:${soon.slice(0, 4)}`, name: 'Idea only' });
  assert.match(block(await page(maria, '/admin/give')), /1 idea/);
  await addGift(maria, { person: p, occasion: `birthday:${soon.slice(0, 4)}`, name: 'Bought one', status: 'bought' });
  assert.match(block(await page(maria, '/admin/give')), /has a gift/);
});

test("the checklist shows last year's gifts for the same occasion", async () => {
  const p = await addPerson(diogo, { name: 'Repeat Guest' });
  const last = await addOccasion(diogo, { name: 'Christmas past', date: `${YEAR - 2}-12-25`, people: [p] });
  // Mark it as Christmas through the dedicated route so the type is right.
  const r = await diogo.post('/admin/give/occasions/christmas', { year: String(YEAR - 3) }, { from: '/admin/give/occasions' });
  const prev = idFrom(r.location, 'occasions');
  const cur = idFrom((await diogo.post('/admin/give/occasions/christmas', { year: String(YEAR - 2) + '' }, { from: '/admin/give/occasions' })).location, 'occasions');
  await diogo.post(`/admin/give/occasions/${prev}/participants`, { person_id: String(p) }, { from: '/admin/give' });
  await diogo.post(`/admin/give/occasions/${cur}/participants`, { person_id: String(p) }, { from: '/admin/give' });
  await addGift(diogo, { person: p, occasion: `occasion:${prev}`, name: 'Woolly socks', status: 'given' });
  const html = await page(diogo, `/admin/give/occasions/${cur}`);
  assert.match(html, /Last year[^<]*: Woolly socks/);
  assert.ok(last > 0);
});

test('prices: typed by hand when there is no link price; invalid prices refused; "only missing" filter', async () => {
  const p = await addPerson(diogo, { name: 'Price Person' });
  const xmas = await addOccasion(diogo, { name: 'Price occasion', date: inDays(20), people: [p] });
  const bad = await diogo.post('/admin/give/gifts', { person_id: String(p), occasion: `occasion:${xmas}`, name: 'x', price: 'abc' }, { from: '/admin/give' });
  assert.equal(bad.status, 400);
  const g = await addGift(diogo, { person: p, occasion: `occasion:${xmas}`, name: 'Lamp', price: '1.234,50', status: 'bought' });
  assert.match(await page(diogo, `/admin/give/occasions/${xmas}`), /Total spent: €1,234\.50/);

  const other = await addPerson(diogo, { name: 'Still Missing' });
  await diogo.post(`/admin/give/occasions/${xmas}/participants`, { person_id: String(other) }, { from: '/admin/give' });
  const missing = await page(diogo, `/admin/give/occasions/${xmas}?missing=1`);
  assert.match(missing, /Still Missing/);
  assert.ok(!missing.includes('>Lamp<'), 'people who have a gift are hidden by the filter');
  assert.ok(g > 0);
});

test('removing an admin removes their private entries and keeps shared ones', async () => {
  const temp = await inviteAdmin(server.base, diogo, { username: 'leaving' });
  const shared = await addPerson(temp, { name: 'Left Shared' });
  await addPerson(temp, { name: 'Left Private', visibility: 'private' });
  const users = await page(diogo, '/admin/users');
  const id = Number(new RegExp('<code>leaving</code></td>[\\s\\S]*?/admin/users/(\\d+)/reset-link').exec(users)[1]);
  await diogo.post(`/admin/users/${id}/delete`, {}, { from: '/admin/users' });
  assert.equal((await diogo.get(`/admin/give/people/${shared}`)).status, 200);
  const list = await page(diogo, '/admin/give/people');
  assert.match(list, /Left Shared/);
  assert.ok(!list.includes('Left Private'));
});
