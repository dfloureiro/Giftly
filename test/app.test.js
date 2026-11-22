// End-to-end tests against a real server process (HTTP only, no browser).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, Client, loginAdmin, createList, joinList, pickableIds, webhookReceiver, sleep,
} from './helpers.js';

let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

test('health check and security headers', async () => {
  const c = new Client(server.base);
  const health = await c.get('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.text, 'ok');
  const home = await c.get('/');
  assert.match(home.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
});

test('app icons and web manifest are served', async () => {
  const c = new Client(server.base);
  for (const [path, type] of [
    ['/favicon.ico', 'image/x-icon'], ['/favicon.svg', 'image/svg+xml'], ['/apple-touch-icon.png', 'image/png'],
    ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/site.webmanifest', 'application/manifest+json'],
  ]) {
    const r = await c.get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), type, path);
  }
  const manifest = JSON.parse((await c.get('/site.webmanifest')).text);
  assert.equal(manifest.name, 'Giftly');
  const home = (await c.get('/')).text;
  assert.match(home, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.match(home, /rel="manifest" href="\/site.webmanifest"/);
  assert.match((await c.get('/')).headers.get('content-security-policy'), /manifest-src 'self'/);
});

test('admin pages require login, wrong password is refused', async () => {
  const c = new Client(server.base);
  const r = await c.get('/admin/lists/1');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/admin');
  const bad = await c.request('/admin/login', { method: 'POST', form: { password: 'nope' } });
  assert.equal(bad.status, 401);
});

test('admin POSTs without a valid CSRF token are rejected', async () => {
  const admin = await loginAdmin(server.base);
  const noToken = await admin.post('/admin/lists', { title: 'x' }, { csrf: false });
  assert.equal(noToken.status, 403);
  const wrong = await admin.request('/admin/lists', { method: 'POST', form: { title: 'x', _csrf: 'forged' } });
  assert.equal(wrong.status, 403);
});

test('guest joins with a name and sees the gifts', async () => {
  const admin = await loginAdmin(server.base);
  const { token } = await createList(admin, { gifts: ['Book', 'Scarf | https://shop.example/scarf | red'] });
  const guest = await joinList(server.base, token, 'Ana');
  const page = await guest.get(`/l/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Hi, Ana/);
  assert.match(page.text, /Book/);
  assert.match(page.text, /View on shop\.example/);
});

test('unknown or malformed list links show an error, not a list', async () => {
  const c = new Client(server.base);
  assert.equal((await c.get('/l/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await c.get('/l/short')).status, 404);
});

test('a picked gift disappears for other guests', async () => {
  const admin = await loginAdmin(server.base);
  const { token } = await createList(admin, { gifts: ['One', 'Two'] });
  const ana = await joinList(server.base, token, 'Ana');
  const rui = await joinList(server.base, token, 'Rui');
  const [first] = await pickableIds(ana, token);
  const r = await ana.post(`/l/${token}/pick/${first}`, {}, { from: `/l/${token}` });
  assert.match(r.location, /m=picked/);
  assert.deepEqual(await pickableIds(rui, token), (await pickableIds(ana, token)));
  assert.ok(!(await pickableIds(rui, token)).includes(first));
  assert.match((await rui.get(`/l/${token}`)).text, /1 gift\(s\) already picked by others/);
});

test('when two guests pick the same gift at once, exactly one gets it', async () => {
  const admin = await loginAdmin(server.base);
  const { token } = await createList(admin, { gifts: ['Contested'] });
  const guests = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => joinList(server.base, token, n)));
  const [id] = await pickableIds(guests[0], token);
  const tokens = await Promise.all(guests.map((g) => g.csrf(`/l/${token}`)));
  const results = await Promise.all(guests.map((g, i) =>
    g.request(`/l/${token}/pick/${id}`, { method: 'POST', form: { _csrf: tokens[i] } })));
  const won = results.filter((r) => /m=picked/.test(r.location)).length;
  const lost = results.filter((r) => /m=taken/.test(r.location)).length;
  assert.equal(won, 1);
  assert.equal(lost, 4);
});

test("a guest cannot give up someone else's gift", async () => {
  const admin = await loginAdmin(server.base);
  const { id: listId, token } = await createList(admin, { gifts: ['Mine'] });
  const ana = await joinList(server.base, token, 'Ana');
  const rui = await joinList(server.base, token, 'Rui');
  const [gift] = await pickableIds(ana, token);
  await ana.post(`/l/${token}/pick/${gift}`, {}, { from: `/l/${token}` });
  await rui.post(`/l/${token}/unpick/${gift}`, {}, { from: `/l/${token}` });
  assert.match((await admin.get(`/admin/lists/${listId}`)).text, /Reserved by Ana/);
});

test('a guest of one list cannot pick gifts from another list', async () => {
  const admin = await loginAdmin(server.base);
  const a = await createList(admin, { title: 'List A', gifts: ['A gift'] });
  const b = await createList(admin, { title: 'List B', gifts: ['B gift'] });
  const ana = await joinList(server.base, a.token, 'Ana');
  const bobOnB = await joinList(server.base, b.token, 'Bob');
  const [bGift] = await pickableIds(bobOnB, b.token);

  // Using list A's link with a gift id from list B must not reserve it.
  await ana.post(`/l/${a.token}/pick/${bGift}`, {}, { from: `/l/${a.token}` });
  // Using list B's link without having joined B redirects to the join page.
  const r = await ana.request(`/l/${b.token}/pick/${bGift}`, { method: 'POST', form: {} });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/l/${b.token}`);

  assert.ok((await pickableIds(bobOnB, b.token)).includes(bGift), 'gift from list B is still available');
});

test('same name on another device sees the same picks', async () => {
  const admin = await loginAdmin(server.base);
  const { token } = await createList(admin, { gifts: ['Lamp'] });
  const phone = await joinList(server.base, token, 'Maria');
  const [gift] = await pickableIds(phone, token);
  await phone.post(`/l/${token}/pick/${gift}`, {}, { from: `/l/${token}` });
  const laptop = await joinList(server.base, token, 'maria'); // case-insensitive
  assert.match((await laptop.get(`/l/${token}`)).text, /Your picks[\s\S]*Lamp/);
});

test('generating a new link revokes the old link and logs guests out', async () => {
  const admin = await loginAdmin(server.base);
  const { id, token } = await createList(admin, { gifts: ['X'] });
  const guest = await joinList(server.base, token, 'Ana');
  await admin.post(`/admin/lists/${id}/new-link`, {}, { from: `/admin/lists/${id}` });
  assert.equal((await guest.get(`/l/${token}`)).status, 404);
  const newToken = /\/l\/([A-Za-z0-9_-]{22})/.exec((await admin.get(`/admin/lists/${id}`)).text)[1];
  assert.notEqual(newToken, token);
  assert.match((await guest.get(`/l/${newToken}`)).text, /name="name"/, 'must join again');
});

test('archived lists cannot be opened', async () => {
  const admin = await loginAdmin(server.base);
  const { id, token } = await createList(admin, { title: 'Old' });
  await admin.post(`/admin/lists/${id}`, { title: 'Old', archived: '1' }, { from: `/admin/lists/${id}` });
  assert.equal((await new Client(server.base).get(`/l/${token}`)).status, 404);
});

test('user input is HTML-escaped', async () => {
  const admin = await loginAdmin(server.base);
  const { token } = await createList(admin, { title: '<b>List</b>', gifts: ['<script>alert(1)</script>'] });
  const guest = await joinList(server.base, token, '<img src=x onerror=alert(1)>');
  const page = (await guest.get(`/l/${token}`)).text;
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(!page.includes('<img src=x'));
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(page.includes('&lt;b&gt;List&lt;/b&gt;'));
});

test('only http(s) links are accepted for gifts', async () => {
  const admin = await loginAdmin(server.base);
  const { id } = await createList(admin);
  const r = await admin.post(`/admin/lists/${id}/items`, { title: 'Bad', url: 'javascript:alert(1)' }, { from: `/admin/lists/${id}` });
  assert.equal(r.status, 400);
});

test('image route rejects path traversal', async () => {
  const c = new Client(server.base);
  assert.equal((await c.get('/img/..%2fgiftly.db')).status, 404);
  assert.equal((await c.get('/img/../.session-secret')).status, 404);
});

test('language follows the browser and can be switched', async () => {
  const c = new Client(server.base);
  const pt = await fetch(`${server.base}/`, { headers: { 'accept-language': 'pt-PT' } });
  assert.match(await pt.text(), /<html lang="pt-PT"/);
  const r = await c.get('/lang?to=pt&back=//evil.example');
  assert.equal(r.location, '/', 'open redirect is blocked');
  assert.match((await c.get('/')).text, /<html lang="pt-PT"/);
});

test('anonymous lists hide who picked, in the admin and in notifications', async () => {
  const hook = await webhookReceiver();
  try {
    const admin = await loginAdmin(server.base);
    await admin.post('/admin/notifications', { webhook_url: hook.url, event_pick: '1' }, { from: '/admin' });
    const { id, token } = await createList(admin, { title: 'My own list', anonymous: true, gifts: ['Surprise'] });
    const guest = await joinList(server.base, token, 'Secret Santa');
    const [gift] = await pickableIds(guest, token);
    await guest.post(`/l/${token}/pick/${gift}`, {}, { from: `/l/${token}` });

    const listPage = (await admin.get(`/admin/lists/${id}`)).text;
    assert.match(listPage, /🎀 Reserved/);
    assert.ok(!/Reserved by/.test(listPage));
    assert.equal(listPage.split('Secret Santa').length - 1, 1, 'name only in the people table');
    const editPage = (await admin.get(`/admin/items/${gift}`)).text;
    assert.ok(!editPage.includes('Secret Santa'));
    assert.ok(!editPage.includes('name="reserved_name"'));

    for (let i = 0; i < 20 && !hook.calls.length; i++) await sleep(100);
    assert.equal(hook.calls.length, 1);
    assert.equal(hook.calls[0].event, 'pick');
    assert.equal(hook.calls[0].guest, undefined);
    assert.ok(!JSON.stringify(hook.calls[0]).includes('Secret Santa'));
  } finally {
    await hook.close();
    const admin = await loginAdmin(server.base);
    await admin.post('/admin/notifications', { event_pick: '1' }, { from: '/admin' });
  }
});

test('notification settings: invalid topic is refused, secrets are never shown', async () => {
  const admin = await loginAdmin(server.base);
  const bad = await admin.post('/admin/notifications', { ntfy_url: 'bad*topic&' }, { from: '/admin' });
  assert.equal(bad.status, 400);
  await admin.post('/admin/notifications', { ntfy_url: 'giftly-test_topic', ntfy_token: 'super-secret-token' }, { from: '/admin' });
  const page = (await admin.get('/admin')).text;
  assert.match(page, /Active: ntfy/);
  assert.ok(!page.includes('super-secret-token'));
  await admin.post('/admin/notifications', { ntfy_url: '', clear_ntfy_token: '1' }, { from: '/admin' });
  assert.ok(!(await admin.get('/admin')).text.includes('Active:'));
});

// Keep last: it exhausts the admin login attempts for 127.0.0.1.
test('admin login is rate limited', async () => {
  const c = new Client(server.base);
  let last;
  for (let i = 0; i < 9; i++) last = await c.request('/admin/login', { method: 'POST', form: { password: 'wrong' } });
  assert.equal(last.status, 429);
});
