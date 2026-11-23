// Reminders: thresholds, catch-up, privacy between admins, no duplicates, daily schedule.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webhookReceiver } from './helpers.js';

let r, g, accounts, notify, hookA, hookB, A, B, ids;
const ON = '2030-06-01'; // a fixed "today"

before(async () => {
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'giftly-unit-remind-'));
  process.env.ADMIN_PASSWORD = '';
  process.env.TZ = 'Europe/Lisbon';
  process.env.APP_LANG = 'en';
  process.env.NOTIFY_ALLOWED_HOSTS = '127.0.0.1'; // the test's webhook receivers
  r = await import('../src/reminders.js');
  g = await import('../src/giving.js');
  accounts = await import('../src/accounts.js');
  notify = await import('../src/notify.js');
  hookA = await webhookReceiver();
  hookB = await webhookReceiver();

  const mk = (username, hook) => {
    const id = accounts.users.create({ username, name: username, passwordHash: 'x' });
    notify.seedUserNotifySettings(id, { webhook_url: hook.url, events: 'pick' });
    return accounts.users.get(id);
  };
  A = mk('ana-admin', hookA);
  B = mk('bruno-admin', hookB);

  const person = (uid, name, month, day, visibility = 'shared') =>
    g.people.create(uid, { name, birthday_month: month, birthday_day: day, notes: '', visibility, gives_christmas: false });
  ids = {
    soon14: person(A.id, 'In Thirteen', 6, 14),   // 13 days: 14-day window (catch-up)
    covered: person(A.id, 'Has Gift', 6, 3),      // 2 days but already has a bought gift
    secret: person(A.id, 'Secret Uncle', 6, 10, 'private'),
    far: person(A.id, 'Far Away', 9, 1),          // outside every window
    surprise: person(B.id, 'Surprise Target', 6, 4), // 3 days
  };
  g.gifts.create(A.id, { person_id: ids.covered, occasion_id: null, year: 2030, name: 'Done', status: 'bought', visibility: 'shared' });
  // A private bought gift by A for a shared person: A is covered, B (who can't see it) is not.
  g.gifts.create(A.id, { person_id: ids.surprise, occasion_id: null, year: 2030, name: 'Hidden', status: 'bought', visibility: 'private' });
  const party = g.occasions.create(A.id, { type: 'custom', name: 'Summer party', date: '2030-06-04', visibility: 'shared' }, [ids.soon14, ids.covered]);
  g.gifts.create(A.id, { person_id: ids.covered, occasion_id: party, year: 2030, name: 'Party gift', status: 'given', visibility: 'shared' });
  ids.party = party;
});
after(async () => { await hookA?.close(); await hookB?.close(); });

const keys = (list) => list.map((x) => `${x.key}@${x.threshold}`).sort();
const waitFor = async (fn) => { for (let i = 0; i < 30 && !fn(); i++) await new Promise((res) => setTimeout(res, 50)); };

test('reminder days parsing and threshold windows', () => {
  assert.deepEqual(r.parseReminderDays('14, 3'), [3, 14]);
  assert.deepEqual(r.parseReminderDays('3;14 x 200 14'), [3, 14]);
  assert.deepEqual(r.parseReminderDays(''), []);
  assert.equal(r.thresholdFor([3, 14], 13), 14);
  assert.equal(r.thresholdFor([3, 14], 3), 3);
  assert.equal(r.thresholdFor([3, 14], 0), 3);
  assert.equal(r.thresholdFor([3, 14], 15), null);
});

test('each admin is reminded only of what they can see, and only when a gift is missing', () => {
  assert.deepEqual(keys(r.dueReminders(A, ON)), [
    `birthday:${ids.secret}:2030@14`,
    `birthday:${ids.soon14}:2030@14`,
    `occasion:${ids.party}@3`,
  ].sort(), 'A: catch-up 14-day for In Thirteen, private Secret Uncle, party; Has Gift and Surprise covered');
  assert.deepEqual(keys(r.dueReminders(B, ON)), [
    `birthday:${ids.soon14}:2030@14`,
    `birthday:${ids.surprise}:2030@3`,
    `occasion:${ids.party}@3`,
  ].sort(), "B: no private person; Surprise Target still missing (A's gift is private)");
  const party = r.dueReminders(B, ON).find((x) => x.kind === 'occasion');
  assert.equal(party.missing, 1);
  assert.equal(party.total, 2);
});

test('reminders are sent once per threshold; the test mode resends without recording', async () => {
  assert.equal(await r.remindUser(A, { on: ON }), 3);
  await waitFor(() => hookA.calls.length >= 3);
  assert.equal(hookA.calls.length, 3);
  const titles = hookA.calls.map((c) => c.title).join('\n');
  assert.match(titles, /In 13 days: In Thirteen's birthday/);
  assert.match(titles, /In 3 days: Summer party/);
  assert.ok(hookA.calls.every((c) => c.event === 'reminder'));

  assert.equal(await r.remindUser(A, { on: ON }), 0, 'same day: nothing new');
  assert.equal(await r.remindUser(A, { on: '2030-06-02' }), 0, 'next day, same windows: nothing new');
  assert.equal(await r.remindUser(A, { on: '2030-06-11' }), 1, 'In Thirteen enters the 3-day window');
  assert.equal(await r.remindUser(A, { on: ON, ignoreLog: true }), 3, 'test button resends today\'s');
  assert.equal(await r.remindUser(A, { on: ON }), 0, '…without recording');
});

test('no channel: nothing sent or recorded; reminders off: nothing due', async () => {
  const lonely = accounts.users.get(accounts.users.create({ username: 'no-channel', name: 'N', passwordHash: 'x' }));
  assert.ok(r.dueReminders(lonely, ON).length > 0);
  assert.equal(await r.remindUser(lonely, { on: ON }), 0);
  notify.seedUserNotifySettings(lonely.id, { webhook_url: hookB.url, events: '' });
  const before = hookB.calls.length;
  assert.ok(await r.remindUser(lonely, { on: ON }) > 0, 'once a channel exists, the pending reminders go out');
  await waitFor(() => hookB.calls.length > before);

  accounts.users.setReminderDays(lonely.id, '');
  assert.deepEqual(r.dueReminders(accounts.users.get(lonely.id), ON), []);
});

test('daily run: waits for the configured hour and runs once per day', async () => {
  // 07:00 in Lisbon (summer, UTC+1) is before the default 09:00.
  assert.equal(await r.runReminders({ now: new Date('2030-06-20T06:00:00Z') }), null);
  const first = await r.runReminders({ now: new Date('2030-06-20T09:30:00Z') });
  assert.equal(typeof first, 'number');
  assert.equal(await r.runReminders({ now: new Date('2030-06-20T15:00:00Z') }), null, 'already ran today');
  assert.equal(typeof await r.runReminders({ now: new Date('2030-06-21T09:30:00Z') }), 'number', 'next day runs again');
});
