// 3.3.1 hardening: private images, notification destinations, proxy headers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, Client, loginAdmin, createList, joinList } from './helpers.js';

// A 1×1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgIn = (html) => /\/img\/([a-z0-9]+\.png)/.exec(html)?.[1];

let server, admin;
before(async () => {
  server = await startServer();
  admin = await loginAdmin(server.base);
});
after(async () => { await server?.stop(); });

test('images: only signed-in admins and guests of a list showing them; never in shared caches', async () => {
  const { id, token } = await createList(admin, { title: 'Img list' });
  await admin.post(`/admin/lists/${id}/items`, { title: 'With photo', image_data: PNG }, { from: `/admin/lists/${id}` });
  const file = imgIn((await admin.get(`/admin/lists/${id}`)).text);
  assert.ok(file, 'the upload is shown');

  const asAdmin = await admin.request(`/img/${file}`);
  assert.equal(asAdmin.status, 200);
  assert.match(asAdmin.headers.get('cache-control'), /^private\b/);

  const anonymous = new Client(server.base);
  assert.equal((await anonymous.request(`/img/${file}`)).status, 404, 'no session: as if it did not exist');

  const guest = await joinList(server.base, token, 'Img guest');
  assert.equal((await guest.request(`/img/${file}`)).status, 200, "a guest of the list sees its images");

  // A guest of another list doesn't.
  const other = await createList(admin, { title: 'Other list', gifts: ['Plain'] });
  const stranger = await joinList(server.base, other.token, 'Stranger');
  assert.equal((await stranger.request(`/img/${file}`)).status, 404);

  // A private gift's photo in "gifts to give" is never shown to guests.
  const person = Number(/people\/(\d+)/.exec((await admin.post('/admin/people', { name: 'Img person', visibility: 'private' }, { from: '/admin/people' })).location)[1]);
  await admin.post('/admin/gifts', { person_id: String(person), occasion: 'birthday:2030', name: 'Secret photo gift', status: 'planned', image_data: PNG }, { from: `/admin/people/${person}` });
  const giftFile = imgIn((await admin.get(`/admin/people/${person}`)).text);
  assert.ok(giftFile, "the gift's photo is shown to the admin");
  assert.equal((await admin.request(`/img/${giftFile}`)).status, 200);
  assert.equal((await guest.request(`/img/${giftFile}`)).status, 404);
});

test('notifications: local addresses refused unless allowed; checked again when sending', async () => {
  const strict = await startServer({ NOTIFY_ALLOWED_HOSTS: '' });
  try {
    const a = await loginAdmin(strict.base);
    for (const form of [
      { webhook_url: 'http://127.0.0.1:9/hook' },
      { webhook_url: 'http://localhost:8080/x' },
      { webhook_url: 'http://[::1]/x' },
      { ntfy_url: 'http://192.168.1.20/giftly' },
      { webhook_url: 'http://169.254.169.254/latest/meta-data' },
    ]) {
      const r = await a.post('/admin/notifications', form, { from: '/admin/profile' });
      assert.equal(r.status, 400, JSON.stringify(form));
      assert.match(r.text, /Local network addresses/);
    }
    const ok = await a.post('/admin/notifications', { webhook_url: 'https://hooks.example.com/x' }, { from: '/admin/profile' });
    assert.equal(ok.status, 303, 'public addresses are fine');
  } finally { await strict.stop(); }
});

test('notifications: no redirects followed, no response body leaked, DNS checked', async () => {
  process.env.NOTIFY_ALLOWED_HOSTS = '127.0.0.1';
  const { postJson, trustedProxyPeer } = await import('../src/net.js');
  const { config } = await import('../src/config.js');
  config.notifyAllowedHosts = ['127.0.0.1'];

  const hits = { target: 0 };
  const target = http.createServer((req, res) => { hits.target++; res.end('ok'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const redirector = http.createServer((req, res) => {
    if (req.url === '/secret') { res.writeHead(500); return res.end('INTERNAL-SECRET-DATA'); }
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/` }); res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${redirector.address().port}`;
  try {
    await assert.rejects(postJson(`${base}/`, { a: 1 }), /redirects are not followed/);
    assert.equal(hits.target, 0, 'the redirect target was never contacted');
    await assert.rejects(postJson(`${base}/secret`, {}), (err) => !err.message.includes('INTERNAL-SECRET') && /HTTP 500/.test(err.message));

    config.notifyAllowedHosts = [];
    await assert.rejects(postJson(`${base}/`, {}), /Refusing private address/);
    // A name that resolves to a private address is refused at connection time (not just by its spelling).
    await assert.rejects(postJson(`http://localhost.:${target.address().port}/`, {}), /Refusing private address|ENOTFOUND|EAI_AGAIN/);
    assert.equal(hits.target, 0);

    // Proxy headers: only from private/loopback peers, and only with TRUST_PROXY on.
    config.trustProxy = true;
    for (const ip of ['127.0.0.1', '::1', '::ffff:172.18.0.2', '10.1.2.3', '192.168.1.9']) assert.equal(trustedProxyPeer(ip), true, ip);
    for (const ip of ['203.0.113.7', '8.8.8.8', '2001:db8::1', '::ffff:1.2.3.4', '', undefined]) assert.equal(trustedProxyPeer(ip), false, String(ip));
    config.trustProxy = false;
    assert.equal(trustedProxyPeer('127.0.0.1'), false, 'TRUST_PROXY=false: never');
  } finally {
    target.close(); redirector.close();
  }
});
