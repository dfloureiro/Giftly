// 3.3.2: guest sessions bound to a random token + list, address normalization, bad redirects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, Client, loginAdmin, createList, joinList } from './helpers.js';

const SECRET = 'test-secret-for-hardening-332-0123456789';
let server, admin, tokens, isPrivateIp, normalizeAddress, postJson, fetchPreview, previewTest, config;

before(async () => {
  server = await startServer({ SESSION_SECRET: SECRET });
  admin = await loginAdmin(server.base);
  // Same secret in this process, to forge correctly signed guest cookies.
  process.env.SESSION_SECRET = SECRET;
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'giftly-unit-332-'));
  process.env.ADMIN_PASSWORD = '';
  ({ tokens } = await import('../src/security.js'));
  ({ isPrivateIp, normalizeAddress, postJson } = await import('../src/net.js'));
  ({ fetchPreview, __test: previewTest } = await import('../src/preview.js'));
  ({ config } = await import('../src/config.js'));
  config.notifyAllowedHosts = [];
});
after(async () => { await server?.stop(); });

const guestCookie = (c) => c.jar.get('giftly_guest');
const asGuest = (cookie) => { const c = new Client(server.base); c.jar.set('giftly_guest', cookie); return c; };
const signed = (entries) => tokens.signGuest({ s: entries, exp: Date.now() + 86_400_000 });
const isIn = async (c, token) => /Log out/.test((await c.get(`/l/${token}`)).text);

test('a deleted guest\'s cookie never opens another list, even when the row id is reused', async () => {
  const a = await createList(admin, { title: 'List A', gifts: ['A gift'] });
  const ana = await joinList(server.base, a.token, 'Ana 332');
  const oldCookie = guestCookie(ana);
  assert.ok(await isIn(ana, a.token));

  // Delete Ana (the newest guest, so SQLite hands her id to the next one), then someone joins list B.
  const adminPage = (await admin.get(`/admin/lists/${a.id}`)).text;
  const anaId = Number(/\/admin\/guests\/(\d+)\/delete/.exec(adminPage)[1]);
  await admin.post(`/admin/guests/${anaId}/delete`, {}, { from: `/admin/lists/${a.id}` });
  const b = await createList(admin, { title: 'List B', gifts: ['B gift'] });
  await joinList(server.base, b.token, 'Bia 332');
  const bPage = (await admin.get(`/admin/lists/${b.id}`)).text;
  assert.equal(Number(/\/admin\/guests\/(\d+)\/delete/.exec(bPage)[1]), anaId, 'precondition: the id was reused');

  const stale = asGuest(oldCookie);
  assert.equal(await isIn(stale, a.token), false);
  assert.equal(await isIn(stale, b.token), false);
  assert.ok(!(await stale.get('/')).text.includes(b.token), "the home page never reveals list B's link");
});

test('a correctly signed cookie for list A is not accepted for list B (list id must match)', async () => {
  const a = await createList(admin, { title: 'Bind A', gifts: ['x'] });
  const b = await createList(admin, { title: 'Bind B', gifts: ['y'] });
  const carla = await joinList(server.base, a.token, 'Carla 332');
  const [[t, listId, epoch]] = tokens.verifyGuest(guestCookie(carla)).s;
  assert.equal(typeof t, 'string');
  assert.ok(t.length >= 20, 'a random token, not a row id');

  assert.equal(await isIn(asGuest(signed([[t, b.id, epoch]])), b.token), false, 'altered list id');
  assert.equal(await isIn(asGuest(signed([[t, listId, epoch + 1]])), a.token), false, 'altered epoch');
  assert.equal(await isIn(asGuest(signed([['x'.repeat(22), listId, epoch]])), a.token), false, 'unknown token');
  // Old cookie format ([guestId, epoch]) is no longer accepted.
  assert.equal(await isIn(asGuest(signed([[1, epoch]])), a.token), false, 'pre-3.3.2 cookie');
  assert.ok(await isIn(asGuest(signed([[t, listId, epoch]])), a.token), 'the genuine entry still works');
});

test('every notation of a non-public address is refused', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '[0:0:0:0:0:ffff:7f00:1]',
    '64:ff9b::7f00:1', '2002:7f00:1::', '169.254.169.254', '::ffff:a9fe:a9fe', '10.0.0.1', '192.168.1.1', '100.64.0.1',
    'fd00::1', 'fe80::1', 'fe80::1%eth0', '0.0.0.0', '::', '::ffff:10.0.0.1', '2001::1', 'not-an-ip']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4003:80b::200e']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
  assert.equal(normalizeAddress('[::FFFF:7F00:1]'), '127.0.0.1');
  assert.equal(normalizeAddress('::ffff:192.168.0.1'), '192.168.0.1');
});

test('previews and notifications refuse private targets in every notation, and names resolving to them', async () => {
  const hits = { n: 0 };
  const target = http.createServer((req, res) => { hits.n++; res.end('<html><head><title>x</title></head></html>'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const port = target.address().port;
  try {
    for (const host of ['[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '[0:0:0:0:0:ffff:7f00:1]', '127.0.0.1', 'localhost.']) {
      await assert.rejects(fetchPreview(`http://${host}:${port}/`, ''), /Refusing private|ENOTFOUND|EAI_AGAIN/, `preview ${host}`);
      await assert.rejects(postJson(`http://${host}:${port}/`, {}), /Refusing private|ENOTFOUND|EAI_AGAIN/, `notify ${host}`);
    }
    assert.equal(hits.n, 0, 'nothing ever reached the local server');
  } finally { target.close(); }
});

test('a garbage redirect from a shop fails that preview only; the process keeps working', async () => {
  // Raw TCP so we can send headers Node's http server would refuse to write.
  const bad = ['http://[', '://', 'http://exa mple.com/', 'http://ÿþ/x', ''];
  let i = 0;
  const raw = net.createServer((sock) => {
    sock.once('data', () => {
      const loc = bad[i++ % bad.length];
      sock.end(`HTTP/1.1 302 Found\r\nLocation: ${loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, 'latin1');
    });
  });
  await new Promise((r) => raw.listen(0, '127.0.0.1', r));
  const good = http.createServer((req, res) => res.end('fine'));
  await new Promise((r) => good.listen(0, '127.0.0.1', r));
  try {
    const results = await Promise.allSettled([
      ...bad.map(() => previewTest.get(`http://127.0.0.1:${raw.address().port}/`)),
      previewTest.get(`http://127.0.0.1:${good.address().port}/`),
    ]);
    for (const r of results.slice(0, bad.length)) assert.equal(r.status, 'rejected');
    assert.equal(results.at(-1).status, 'fulfilled', 'the good one in the middle of bad ones still works');
    assert.equal(results.at(-1).value.body.toString(), 'fine');
    // And the app server is still answering.
    assert.equal((await new Client(server.base).request('/healthz')).status, 200);
  } finally { raw.close(); good.close(); }
});

test("a preview never reuses a connection opened for an allowed notification host", async () => {
  // The notification target is allowed (NOTIFY_ALLOWED_HOSTS) and keeps connections alive.
  let requests = 0;
  const srv = http.createServer((req, res) => { requests++; res.end('<html><head><title>internal</title></head></html>'); });
  srv.keepAliveTimeout = 10_000;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${srv.address().port}/`;
  try {
    config.notifyAllowedHosts = ['localhost'];
    await postJson(url, { hello: 1 });
    assert.equal(requests, 1, 'the notification went through');
    // Right after, a preview of the same host:port must still be refused (localhost → 127.0.0.1).
    await assert.rejects(fetchPreview(url, ''), /Refusing private address/);
    assert.equal(requests, 1, 'the preview never reached the internal server');
  } finally { config.notifyAllowedHosts = []; srv.close(); }
});
