// Wishlists: Sam's wishlist, Emma's list from it, a guest pick and "I'll give it".
const { chromium } = require('playwright');
const { B, OUT, desktop, mobile, art, login } = require('./common.js');

const WISHES = [
  { t: 'Noise-cancelling earbuds', u: 'https://shop.example/earbuds', e: '🎧', bg: ['#dbeafe', '#bfdbfe'] },
  { t: 'Hiking backpack, 30 L', u: 'https://outdoor.example/backpack', n: 'Green or grey', e: '🎒', bg: ['#d1fae5', '#a7f3d0'] },
  { t: 'Sourdough baking course', u: 'https://classes.example/sourdough', e: '🍞', bg: ['#fde68a', '#fcd34d'] },
  { t: 'Vinyl record: jazz classics', e: '💿', bg: ['#ede9fe', '#ddd6fe'] },
  { t: 'Cast-iron pan', u: 'https://kitchen.example/pan', e: '🍳', bg: ['#e7e5e4', '#d6d3d1'] },
];

(async () => {
  const browser = await chromium.launch();
  const emma = await (await browser.newContext(desktop)).newPage();
  emma.on('dialog', (d) => d.accept());
  await login(emma, 'emma', 'demo-password-1');

  // Sam joins through an invite link and fills their wishlist.
  await emma.goto(`${B}/admin/users`);
  await emma.locator('form[action="/admin/users/invite"] button').click();
  const invite = (await emma.inputValue('#new-link')).replace('https://giftly.example.com', B);
  const sam = await (await browser.newContext(desktop)).newPage();
  await sam.goto(invite);
  await sam.fill('input[name=name]', 'Sam');
  await sam.fill('input[name=username]', 'sam');
  await sam.fill('input[name=password]', 'demo-password-3');
  await sam.fill('input[name=confirm]', 'demo-password-3');
  await sam.click('button[type=submit]');
  for (const w of WISHES) {
    await sam.goto(`${B}/admin/wishlist`);
    const f = sam.locator('form[action="/admin/wishlist/items"]');
    await f.locator('input[name=title]').fill(w.t);
    if (w.u) await f.locator('input[name=url]').fill(w.u);
    if (w.n) await f.locator('input[name=notes]').fill(w.n);
    await f.locator('[data-upload-data]').evaluate((el, v) => { el.value = v; }, await art(sam, w.e, w.bg, 320));
    await f.locator('button[type=submit]').click();
  }

  // Emma: a list from Sam's wishlist, a guest pick, then "I'll give it" for a Christmas gift.
  await emma.goto(`${B}/admin/wishlists`);
  const wid = Number(/wishlists\/(\d+)/.exec(await emma.locator('ul.lists a').first().getAttribute('href'))[1]);
  await emma.goto(`${B}/admin/wishlists/${wid}/new-list`);
  await emma.fill('input[name=title]', "Sam's birthday");
  await emma.click('form[action$="/new-list"] button[type=submit]');
  const listUrl = emma.url().split('?')[0];
  const share = (await emma.inputValue('#share-link')).replace('https://giftly.example.com', B);
  const guest = await (await browser.newContext(mobile)).newPage();
  guest.on('dialog', (d) => d.accept());
  await guest.goto(share);
  await guest.fill('input[name=name]', 'Grandma Rose');
  await guest.click('button[type=submit]');
  await guest.locator('li.item', { hasText: 'Hiking backpack' }).locator('button').click();
  await guest.waitForURL(/m=/);

  await emma.goto(`${B}/admin/wishlists/${wid}`);
  const item = emma.locator('li.item', { hasText: 'Sourdough' });
  await item.locator('details.edit > summary').click();
  await item.locator('form button[type=submit]').click();
  await emma.waitForURL(/m=giving/);

  await sam.goto(`${B}/admin/wishlist`);
  await sam.screenshot({ path: `${OUT}/wishlist-own.png`, fullPage: true });
  await emma.goto(`${B}/admin/wishlists/${wid}`);
  await emma.screenshot({ path: `${OUT}/wishlist-others.png`, fullPage: true });
  await emma.goto(listUrl);
  await emma.setViewportSize({ width: 980, height: 1250 });
  await emma.screenshot({ path: `${OUT}/wishlist-list.png` });

  // Ideas Emma keeps for Sam (an admin) on Sam's record in "gifts to give" — Sam never sees them.
  await emma.goto(`${B}/admin/give/people`);
  await emma.locator('a', { hasText: 'Sam' }).first().click();
  const person = emma.url().split('?')[0].split('#')[0];
  for (const w of [{ t: 'Pottery workshop for two', e: '🏺', bg: ['#fed7aa', '#fdba74'] }, { t: 'Board game: Wingspan', e: '🐦', bg: ['#bae6fd', '#7dd3fc'] }]) {
    await emma.goto(person);
    const d = emma.locator('details.add-wish');
    await d.locator(':scope > summary').click();
    await d.locator('input[name=title]').fill(w.t);
    await d.locator('[data-upload-data]').evaluate((el, v) => { el.value = v; }, await art(emma, w.e, w.bg, 320));
    await d.locator('button[type=submit]').click();
    await emma.waitForURL(/m=added/);
  }
  if (process.env.CHECK) {
    await emma.setViewportSize({ width: 980, height: 900 });
    await emma.goto(person);
    await emma.screenshot({ path: `${OUT}/check-admin-person.png`, fullPage: true });
    await emma.goto(`${B}/admin/wishlists/${wid}/new-list`);
    await emma.screenshot({ path: `${OUT}/check-new-list.png`, fullPage: true });
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
