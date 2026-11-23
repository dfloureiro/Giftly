// 3.4.2: a late preview never replaces an image changed meanwhile; total deadlines on outgoing
// requests; one user's slow channel never delays the others' reminders.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let db, preview, queue, net, config, accounts, g, notify, reminders, listId;

before(async () => {
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'giftly-unit-342-'));
  process.env.ADMIN_PASSWORD = '';
  process.env.LINK_PREVIEWS = 'true';
  process.env.APP_LANG = 'en';
  process.env.TZ = 'Europe/Lisbon';
  process.env.NOTIFY_ALLOWED_HOSTS = '127.0.0.1';
  db = await import('../src/db.js');
  preview = await import('../src/preview.js');
  queue = await import('../src/previewQueue.js');
  net = await import('../src/net.js');
  ({ config } = await import('../src/config.js'));
  accounts = await import('../src/accounts.js');
  g = await import('../src/giving.js');
  notify = await import('../src/notify.js');
  reminders = await import('../src/reminders.js');
  listId = db.lists.create({ title: 'L', description: '' });
});

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const fileOnDisk = (f) => existsSync(join(preview.IMAGE_DIR, f));

test('a photo uploaded while a preview is being fetched survives the late preview', async () => {
  const id = db.items.create(listId, { title: 'Lamp', url: 'https://shop.example/lamp', notes: '' });
  let finish;
  queue.__test.setFetch(() => new Promise((resolve) => { finish = resolve; }));
  try {
    queue.__test.enqueue(id, { force: true });
    await waitFor(() => finish);
    // Meanwhile the admin uploads a photo.
    const uploaded = preview.saveImageBuffer(PNG);
    db.items.setPreview(id, { image_file: uploaded, preview_status: 'uploaded' });
    // The shop finally answers with its own image.
    const fetched = preview.saveImageBuffer(PNG);
    finish({ file: fetched, price: '€ 9.99', priceCents: 999, priceCurrency: 'EUR' });
    await waitFor(() => db.items.get(id).price === '€ 9.99');
    const it = db.items.get(id);
    assert.equal(it.image_file, uploaded, 'the upload wins');
    assert.equal(it.preview_status, 'uploaded');
    assert.ok(fileOnDisk(uploaded), 'and its file is still there');
    assert.equal(fileOnDisk(fetched), false, 'the late image was discarded');
  } finally { queue.__test.setFetch(null); }
});

test('the daily price check never replaces an uploaded photo', async () => {
  const id = db.items.create(listId, { title: 'Mug', url: 'https://shop.example/mug', notes: '' });
  const uploaded = preview.saveImageBuffer(PNG);
  db.items.setPreview(id, { image_file: uploaded, preview_status: 'uploaded' });
  const fetched = preview.saveImageBuffer(PNG);
  queue.__test.setFetch(async () => ({ file: fetched, price: '€ 5.00', priceCents: 500, priceCurrency: 'EUR' }));
  try {
    queue.__test.enqueue(id, { priceOnly: true });
    await waitFor(() => db.items.get(id).price === '€ 5.00');
    assert.equal(db.items.get(id).image_file, uploaded);
    assert.ok(fileOnDisk(uploaded));
  } finally { queue.__test.setFetch(null); }
});

/** A server that never goes quiet: one byte every 200 ms, forever. */
async function trickler() {
  const timers = new Set();
  const srv = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/html' });
    const t = setInterval(() => res.write('.'), 200);
    timers.add(t);
    res.on('close', () => { clearInterval(t); timers.delete(t); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => { timers.forEach(clearInterval); srv.closeAllConnections(); srv.close(); } };
}

test('previews and notifications have a total deadline, not just an idle timeout', { timeout: 15_000 }, async () => {
  const t = await trickler();
  try {
    let start = Date.now();
    await assert.rejects(preview.__test.get(t.url, { deadlineMs: 1200, limit: 10_000_000 }), /Too slow/);
    assert.ok(Date.now() - start < 3000, 'preview aborted on time');
  } finally { t.close(); }

  // A notification server that never goes quiet while sending its headers, one byte at a time.
  const { default: netmod } = await import('node:net');
  const socks = new Set();
  const raw = netmod.createServer((sock) => {
    socks.add(sock);
    sock.on('error', () => {});
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\r\nX-Slow: ');
      const iv = setInterval(() => sock.write('a'), 200);
      sock.on('close', () => clearInterval(iv));
    });
  });
  await new Promise((r) => raw.listen(0, '127.0.0.1', r));
  try {
    const start = Date.now();
    await assert.rejects(net.postJson(`http://127.0.0.1:${raw.address().port}/`, { a: 1 }, {}, { deadline: 1200 }), /Too slow/);
    assert.ok(Date.now() - start < 3000, 'notification aborted on time');
  } finally { socks.forEach((x) => x.destroy()); raw.close(); }
});

test("one user's slow notification channel doesn't delay another user's reminders", async () => {
  let fastAt = null;
  const holds = new Set();
  const slow = http.createServer((req, res) => { req.resume(); holds.add(res); setTimeout(() => res.end(), 4000); });
  const fast = http.createServer((req, res) => { req.resume(); fastAt ??= Date.now(); res.end('ok'); });
  await Promise.all([slow, fast].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  try {
    const mk = (name, srv) => {
      const id = accounts.users.create({ username: name, name, passwordHash: 'x' });
      accounts.users.setReminderDays(id, '14');
      notify.seedUserNotifySettings(id, { webhook_url: `http://127.0.0.1:${srv.address().port}/`, events: '' });
      g.people.create(id, { name: `${name}'s kid`, visibility: 'private', birthday_day: 25, birthday_month: 6 });
      return id;
    };
    // The slow user comes first, so a sequential loop would make the fast one wait.
    mk('slowuser', slow);
    mk('fastuser', fast);
    const start = Date.now();
    const run = reminders.runReminders({ now: new Date('2030-06-20T10:00:00Z'), force: true });
    await waitFor(() => fastAt !== null, 3000);
    assert.ok(fastAt - start < 2000, `fast user reminded after ${fastAt - start} ms`);
    await run;
  } finally { slow.closeAllConnections(); slow.close(); fast.close(); }
});
