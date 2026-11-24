// Occasions and People: mock people, two Christmases, gifts (one joint) and mobile screenshots.
const { chromium } = require('playwright');
const { B, OUT, desktop, mobile, art, login, inDays } = require('./common.js');

const YEAR = Number(inDays(0).slice(0, 4));
const PEOPLE = [
  { name: 'Grandma Rose', bd: inDays(9), xmas: true, notes: 'Loves gardening and crosswords.' },
  { name: 'Leo', bd: inDays(23), year: YEAR - 7 + (inDays(23).slice(0, 4) > String(YEAR) ? 1 : 0), xmas: true, notes: 'Into dinosaurs and space. Shoe size 31.' },
  { name: 'Uncle Tom', bd: inDays(140), xmas: true },
  { name: 'Aunt Clara', bd: inDays(170), xmas: true },
  { name: 'Sofia', bd: inDays(41), xmas: true, notes: 'Reads a lot; already has a Kindle.' },
  { name: 'Mark', bd: inDays(200), xmas: true },
  { name: 'Aunt Julia', bd: inDays(250), xmas: true, private: true },
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(desktop);
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept());
  await login(p, 'emma', 'demo-password-1');

  const ids = {};
  for (const x of PEOPLE) {
    await p.goto(`${B}/admin/people/new`);
    const f = p.locator('form[action="/admin/people"]');
    await f.locator('input[name=name]').fill(x.name);
    await f.locator('input[name=birthday_day]').fill(String(Number(x.bd.slice(8))));
    await f.locator('select[name=birthday_month]').selectOption(String(Number(x.bd.slice(5, 7))));
    if (x.year) await f.locator('input[name=birth_year]').fill(String(x.year));
    if (x.notes) await f.locator('textarea[name=notes]').fill(x.notes);
    if (x.xmas) await f.locator('input[name=gives_christmas]').check();
    if (x.private) await f.locator('select[name=visibility]').selectOption('private');
    await f.locator('button[type=submit]').click();
    ids[x.name] = Number(/people\/(\d+)/.exec(p.url())[1]);
  }

  for (const y of [YEAR - 1, YEAR]) {
    await p.goto(`${B}/admin/occasions/new`);
    await p.evaluate((y) => {
      const f = document.querySelector('form[action="/admin/occasions/christmas"]');
      if (f) { f.querySelector('[name=year]').value = y; f.submit(); }
    }, String(y));
    await p.waitForLoadState();
  }
  const xmas = {};
  await p.goto(`${B}/admin/occasions?view=all`);
  for (const a of await p.locator('#occasion-list a[href^="/admin/occasions/"]').all()) {
    const t = await a.innerText();
    const id = Number(/occasions\/(\d+)/.exec(await a.getAttribute('href'))[1]);
    if (t.includes(String(YEAR - 1))) xmas.last = id; else if (t.includes(String(YEAR))) xmas.cur = id;
  }

  async function gift(person, occasion, { name, status = 'planned', price = '', notes = '', emoji, bg, url = '', also = '' }) {
    let d;
    if (occasion.startsWith('occasion:')) {
      await p.goto(`${B}/admin/occasions/${occasion.split(':')[1]}`);
      d = p.locator('ul.checklist > li').filter({ has: p.locator('.who-row strong', { hasText: person }) }).locator('details.add-gift');
    } else {
      await p.goto(`${B}/admin/people/${ids[person]}`);
      d = p.locator('details.add-gift:not(.add-wish)').first();
    }
    if (!(await d.evaluate((el) => el.open))) await d.locator(':scope > summary').click();
    const f = d.locator('form');
    if (!occasion.startsWith('occasion:')) await f.locator('select[name=occasion]').selectOption(occasion);
    await f.locator('input[name=name]').fill(name);
    if (url) await f.locator('input[name=url]').fill(url);
    await f.locator('select[name=status]').selectOption(status);
    if (price) await f.locator('input[name=price]').fill(price);
    if (notes) await f.locator('input[name=notes]').fill(notes);
    if (also) {
      await f.locator('details.joint summary').click();
      await f.locator('details.joint label', { hasText: also }).locator('input').check();
    }
    if (emoji) await f.locator('[data-upload-data]').evaluate((el, v) => { el.value = v; }, await art(p, emoji, bg, 320));
    await f.locator('button[type=submit]').click();
    await p.waitForURL(/giftAdded/);
  }
  const last = `occasion:${xmas.last}`, cur = `occasion:${xmas.cur}`;
  await gift('Grandma Rose', last, { name: 'Gardening gloves', status: 'given', price: '18', emoji: '🧤', bg: ['#d1fae5', '#a7f3d0'] });
  await gift('Leo', last, { name: 'Dinosaur puzzle', status: 'given', price: '22,50', emoji: '🦕', bg: ['#fef3c7', '#fde68a'] });
  await gift('Sofia', last, { name: 'Bookshop voucher', status: 'given', price: '30', emoji: '📚', bg: ['#fde68a', '#fcd34d'] });
  await gift('Grandma Rose', cur, { name: 'Crossword book', status: 'bought', price: '14,90', emoji: '🧩', bg: ['#ede9fe', '#ddd6fe'], url: 'https://books.example/crosswords' });
  await gift('Leo', cur, { name: 'Space LEGO set', status: 'bought', price: '49,99', emoji: '🚀', bg: ['#dbeafe', '#bfdbfe'], url: 'https://toys.example/space-set' });
  await gift('Uncle Tom', cur, { name: 'Wine tasting for two', status: 'bought', price: '65', also: 'Aunt Clara', emoji: '🍷', bg: ['#fce7f3', '#fbcfe8'] });
  await gift('Sofia', cur, { name: 'Coffee beans', status: 'planned', notes: 'From the market', emoji: '☕', bg: ['#e7e5e4', '#d6d3d1'] });
  await gift('Leo', `birthday:${inDays(23).slice(0, 4)}`, { name: 'Glow-in-the-dark stars', status: 'bought', price: '12', emoji: '⭐', bg: ['#e0e7ff', '#c7d2fe'] });

  // Leo's wishlist (on his page): one item will be taken through a list made from it.
  async function wish(person, { title, url = '', notes = '', emoji, bg }) {
    await p.goto(`${B}/admin/people/${ids[person]}`);
    const d = p.locator('details.add-wish');
    await d.locator(':scope > summary').click();
    const f = d.locator('form');
    await f.locator('input[name=title]').fill(title);
    if (url) await f.locator('input[name=url]').fill(url);
    if (notes) await f.locator('[name=notes]').fill(notes);
    if (emoji) await f.locator('[data-upload-data]').evaluate((el, v) => { el.value = v; }, await art(p, emoji, bg, 320));
    await f.locator('button[type=submit]').click();
    await p.waitForURL(/m=added/);
  }
  await wish('Leo', { title: 'Telescope', url: 'https://shop.example/telescope', emoji: '🔭', bg: ['#e0e7ff', '#c7d2fe'] });
  await wish('Leo', { title: 'Dinosaur encyclopedia', notes: 'The big one with pictures', emoji: '🦖', bg: ['#dcfce7', '#bbf7d0'] });
  await wish('Leo', { title: 'Rocket night light', emoji: '🌙', bg: ['#fef9c3', '#fde68a'] });

  const m = await browser.newContext(mobile);
  await m.addCookies(await ctx.cookies());
  const mp = await m.newPage();
  await mp.goto(`${B}/admin/occasions`);
  await mp.screenshot({ path: `${OUT}/give-upcoming.png` });
  await mp.goto(`${B}/admin/occasions/${xmas.cur}`);
  await mp.screenshot({ path: `${OUT}/give-checklist.png` });
  await mp.goto(`${B}/admin/people/${ids.Leo}`);
  await mp.screenshot({ path: `${OUT}/give-person.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
