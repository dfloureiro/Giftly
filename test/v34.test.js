// 3.4: images follow their record's access rules, proxies and account links, "is it you?" on join.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, Client, loginAdmin, inviteAdmin, createList, joinList } from './helpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgIn = (html) => /\/img\/([a-z0-9]+\.png)/.exec(html)?.[1];

let server, diogo, maria;
before(async () => {
  server = await startServer();
  diogo = await loginAdmin(server.base);
  maria = await inviteAdmin(server.base, diogo, { username: 'maria34', name: 'Maria' });
});
after(async () => { await server?.stop(); });

/** A raw request with chosen headers (Host, X-Forwarded-*), carrying a client's cookies. */
function rawRequest(base, path, { method = 'GET', headers = {}, client, form } = {}) {
  const u = new URL(path, base);
  const body = form ? new URLSearchParams(form).toString() : '';
  return new Promise((resolve, reject) => {
    const req = http.request(u, {
      method,
      headers: {
        ...(client?.jar.size && { cookie: [...client.jar].map(([k, v]) => `${k}=${v}`).join('; ') }),
        ...(form && { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test("images: another admin can't fetch a private gift's photo; guests only their list's; revalidated", async () => {
  const person = Number(/people\/(\d+)/.exec((await diogo.post('/admin/give/people', { name: 'Private img', visibility: 'private' }, { from: '/admin/give/people' })).location)[1]);
  await diogo.post('/admin/give/gifts', { person_id: String(person), occasion: 'birthday:2031', name: 'Hidden photo', status: 'idea', image_data: PNG }, { from: `/admin/give/people/${person}` });
  const file = imgIn((await diogo.get(`/admin/give/people/${person}`)).text);
  assert.ok(file);
  const mine = await diogo.request(`/img/${file}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('cache-control'), 'private, no-cache');
  assert.equal(mine.headers.get('etag'), `"${file}"`);
  assert.equal((await diogo.request(`/img/${file}`, { headers: { 'if-none-match': `"${file}"` } })).status, 304);
  assert.equal((await maria.request(`/img/${file}`)).status, 404, "Maria can't see that gift, so not its photo");

  // A private list's photo: not for Maria; for its guests until the link is regenerated.
  const priv = Number(/\/admin\/lists\/(\d+)/.exec((await diogo.post('/admin/lists', { title: 'Private pics', visibility: 'private' }, { from: '/admin' })).location)[1]);
  await diogo.post(`/admin/lists/${priv}/items`, { title: 'Pic', image_data: PNG }, { from: `/admin/lists/${priv}` });
  const listPage = (await diogo.get(`/admin/lists/${priv}`)).text;
  const listFile = imgIn(listPage);
  const token = /\/l\/([A-Za-z0-9_-]{22})/.exec(listPage)[1];
  assert.equal((await maria.request(`/img/${listFile}`)).status, 404);
  const guest = await joinList(server.base, token, 'Pic guest');
  assert.equal((await guest.request(`/img/${listFile}`)).status, 200);
  await diogo.post(`/admin/lists/${priv}/new-link`, {}, { from: `/admin/lists/${priv}` });
  assert.equal((await guest.request(`/img/${listFile}`)).status, 404, 'a new link drops old guests, images included');
  assert.equal((await new Client(server.base).request(`/img/${listFile}`)).status, 404, 'no session');
});

test('images respect REQUIRE_2FA like any admin page', async () => {
  const first = await startServer();
  const admin = await loginAdmin(first.base);
  const { id } = await createList(admin, { title: '2FA pics' });
  await admin.post(`/admin/lists/${id}/items`, { title: 'Pic', image_data: PNG }, { from: `/admin/lists/${id}` });
  const file = imgIn((await admin.get(`/admin/lists/${id}`)).text);
  assert.equal((await admin.request(`/img/${file}`)).status, 200);
  await first.stop({ keepData: true });
  // Same data, now with 2FA required: the admin (no 2FA yet) is signed in but can't see images.
  const strict = await startServer({ REQUIRE_2FA: 'true' }, { dataDir: first.dataDir });
  try {
    const again = await loginAdmin(strict.base);
    assert.equal((await again.request(`/img/${file}`)).status, 404);
  } finally { await strict.stop({ keepData: false }); }
});

test('account links use BASE_URL; without it, the Host — never X-Forwarded-Host', async () => {
  const withBase = await startServer({ BASE_URL: 'https://gifts.example.com', TRUST_PROXY: 'true' });
  const noBase = await startServer({ TRUST_PROXY: 'true' });
  try {
    for (const [srv, expected] of [[withBase, 'https://gifts.example.com/invite/'], [noBase, null]]) {
      const admin = await loginAdmin(srv.base);
      const csrf = await admin.csrf('/admin/users');
      const r = await rawRequest(srv.base, '/admin/users/invite', {
        method: 'POST', client: admin, form: { _csrf: csrf },
        headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
      });
      const link = /id="new-link"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*id="new-link"/.exec(r.text);
      const url = link[1] || link[2];
      assert.ok(!url.includes('evil.example'), url);
      if (expected) assert.ok(url.startsWith(expected), url);
      else assert.ok(url.startsWith(`https://127.0.0.1:${new URL(srv.base).port}/invite/`) || url.startsWith(`http://127.0.0.1:${new URL(srv.base).port}/invite/`), url);
      if (!expected) assert.match((await admin.get('/admin/users')).text, /BASE_URL is not set/);
    }
  } finally { await withBase.stop(); await noBase.stop(); }
});

test('TRUSTED_PROXIES: a peer not on the list cannot pick its rate-limit IP; Secure cookies on the https host', async () => {
  const srv = await startServer({ TRUST_PROXY: 'true', TRUSTED_PROXIES: '10.9.9.9', BASE_URL: 'https://gifts.example.com' });
  try {
    const admin = await loginAdmin(srv.base);
    const { token } = await createList(admin, { title: 'Rate' });
    let last;
    for (let i = 0; i < 31; i++) {
      last = await rawRequest(srv.base, `/l/${token}/join`, { method: 'POST', form: { name: `G${i}` }, headers: { 'x-forwarded-for': `203.0.113.${i}` } });
    }
    assert.equal(last.status, 429, 'X-Forwarded-For from an untrusted peer is ignored: one real IP, one limit');

    const cookieOf = (r) => [].concat(r.headers['set-cookie'] || []).join('\n');
    // The language switch always sets a cookie: check its Secure flag per host.
    const viaPublic = await rawRequest(srv.base, '/lang?to=en&back=/', { headers: { host: 'gifts.example.com' } });
    const viaLan = await rawRequest(srv.base, '/lang?to=en&back=/', { headers: { host: '192.168.1.50:3010' } });
    assert.match(cookieOf(viaPublic), /; Secure/);
    assert.doesNotMatch(cookieOf(viaLan), /; Secure/, 'LAN access over http keeps working');
  } finally { await srv.stop(); }

  const { trustedProxyPeer } = await import('../src/net.js');
  const { config } = await import('../src/config.js');
  Object.assign(config, { trustProxy: true, trustedProxies: ['172.18.0.0/16', '::1'] });
  assert.equal(trustedProxyPeer('172.18.0.5'), true);
  assert.equal(trustedProxyPeer('::ffff:172.18.0.5'), true);
  assert.equal(trustedProxyPeer('::1'), true);
  assert.equal(trustedProxyPeer('10.0.0.5'), false, 'private but not listed');
  config.trustedProxies = [];
  assert.equal(trustedProxyPeer('10.0.0.5'), true, 'default: any private peer');
});

test('joining with a name already used: "is it you?"; new names go straight in', async () => {
  const { token } = await createList(diogo, { title: 'Names', gifts: ['g'] });
  await joinList(server.base, token, 'Ana Silva');
  const second = new Client(server.base);
  const ask = await second.request(`/l/${token}/join`, { method: 'POST', form: { name: 'ana silva' } });
  assert.equal(ask.status, 200);
  assert.match(ask.text, /Someone already joined this list as “Ana Silva”/);
  assert.equal(second.jar.has('giftly_guest'), false, 'not in yet');

  const yes = await second.request(`/l/${token}/join`, { method: 'POST', form: { name: 'Ana Silva', confirm: '1' } });
  assert.equal(yes.status, 303);
  assert.match((await second.get(`/l/${token}`)).text, /Ana Silva/);

  const other = new Client(server.base);
  assert.equal((await other.request(`/l/${token}/join`, { method: 'POST', form: { name: 'Ana Costa' } })).status, 303, 'a new name: straight in');

  // A name an admin reserved a gift for (never visited) isn't "already used": straight in.
  const { id: listId, token: t2 } = await createList(diogo, { title: 'Reserved', gifts: ['Scarf'] });
  const itemId = Number(/\/admin\/items\/(\d+)\/reserve/.exec((await diogo.get(`/admin/lists/${listId}`)).text)[1]);
  await diogo.post(`/admin/items/${itemId}/reserve`, { name: 'Tia Rosa' }, { from: `/admin/lists/${listId}` });
  const rosa = new Client(server.base);
  assert.equal((await rosa.request(`/l/${t2}/join`, { method: 'POST', form: { name: 'Tia Rosa' } })).status, 303);
});

test("another admin can't delete or re-link a list they can't see", async () => {
  const priv = Number(/\/admin\/lists\/(\d+)/.exec((await diogo.post('/admin/lists', { title: 'Mine only', visibility: 'private' }, { from: '/admin' })).location)[1]);
  const token = /\/l\/([A-Za-z0-9_-]{22})/.exec((await diogo.get(`/admin/lists/${priv}`)).text)[1];
  assert.equal((await maria.post(`/admin/lists/${priv}/new-link`, {}, { from: '/admin' })).status, 404);
  assert.equal((await maria.post(`/admin/lists/${priv}/delete`, {}, { from: '/admin' })).status, 404);
  const page = (await diogo.get(`/admin/lists/${priv}`)).text;
  assert.ok(page.includes(token), 'still there, same link');
});
