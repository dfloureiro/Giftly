// Unit tests for "gifts to give": dates, typed prices, price freezing and totals.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let g, parsePrice, db;
before(async () => {
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'giftly-unit-give-'));
  process.env.ADMIN_PASSWORD = '';
  g = await import('../src/giving.js');
  ({ parsePrice } = await import('../src/givingRoutes.js'));
  ({ db } = await import('../src/db.js'));
});

test('next birthday: today counts, past dates roll to next year, 29 Feb in non-leap years', () => {
  assert.deepEqual(g.nextBirthday(3, 10, '2026-03-10'), { date: '2026-03-10', year: 2026 });
  assert.deepEqual(g.nextBirthday(3, 10, '2026-03-11'), { date: '2027-03-10', year: 2027 });
  assert.deepEqual(g.nextBirthday(2, 29, '2026-01-01'), { date: '2026-02-28', year: 2026 });
  assert.deepEqual(g.nextBirthday(2, 29, '2027-03-01'), { date: '2028-02-29', year: 2028 });
  assert.equal(g.daysBetween('2026-12-20', '2027-01-02'), 13);
});

test('date validation', () => {
  assert.equal(g.validDate('2026-12-25'), true);
  assert.equal(g.validDate('2026-02-30'), false);
  assert.equal(g.validDate('25/12/2026'), false);
});

test('typed prices', () => {
  assert.equal(parsePrice('24,90'), 2490);
  assert.equal(parsePrice('24.9'), 2490);
  assert.equal(parsePrice('€ 12'), 1200);
  assert.equal(parsePrice('1.234,50'), 123450);
  assert.equal(parsePrice(''), null);
  assert.ok(Number.isNaN(parsePrice('cheap')));
});

test('link prices update ideas only; a typed price is replaced by a link price; totals per currency', () => {
  const uid = Number(db.prepare("INSERT INTO users (username, name, password_hash, created_at) VALUES ('u', 'U', 'x', 0)").run().lastInsertRowid);
  const person = g.people.create(uid, { name: 'P', notes: '', visibility: 'shared', gives_christmas: false });
  const base = { person_id: person, occasion_id: null, year: 2026, url: 'https://shop.example/x', notes: '', visibility: 'shared' };
  const idea = g.gifts.create(uid, { ...base, name: 'Idea', status: 'planned', price_cents: 1000, price_currency: 'EUR' });
  const bought = g.gifts.create(uid, { ...base, name: 'Bought', status: 'bought', price_cents: 2000, price_currency: 'EUR' });

  g.gifts.setPreview(idea, { link_price_cents: 1500, link_price_currency: 'EUR' });
  g.gifts.setPreview(bought, { link_price_cents: 9999, link_price_currency: 'EUR' });
  assert.equal(g.gifts.raw(idea).price_cents, 1500, 'link price wins over the typed one');
  assert.equal(g.gifts.raw(idea).price_source, 'link');
  assert.equal(g.gifts.raw(bought).price_cents, 2000, 'bought gifts keep their price');

  // While the link gives a price, a typed price is ignored; changing the link drops it.
  g.gifts.update(uid, idea, { ...g.gifts.raw(idea), name: 'Idea', price_cents: 1, price_currency: 'EUR' });
  assert.equal(g.gifts.raw(idea).price_cents, 1500);
  g.gifts.update(uid, idea, { ...g.gifts.raw(idea), name: 'Idea', url: 'https://other.example/y', price_cents: null });
  assert.equal(g.gifts.raw(idea).price_cents, null);

  const usd = g.gifts.create(uid, { ...base, name: 'USD', status: 'given', price_cents: 500, price_currency: 'USD' });
  const totals = g.spent(g.gifts.forPerson(uid, person));
  assert.deepEqual(totals.sort((a, b) => a.currency.localeCompare(b.currency)), [{ currency: 'EUR', cents: 2000 }, { currency: 'USD', cents: 500 }]);
  assert.ok(usd > 0);
});

test('Christmas is pinned on top of "Upcoming" from 1 November to Christmas day', () => {
  assert.equal(g.christmasSeason('2026-10-31'), false);
  assert.equal(g.christmasSeason('2026-11-01'), true);
  assert.equal(g.christmasSeason('2026-12-25'), true);
  assert.equal(g.christmasSeason('2026-12-26'), false);
});
