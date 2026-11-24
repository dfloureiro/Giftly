// Guest lists: a demo list with gifts, two guests, and screenshots of guest and admin pages.
const { chromium } = require('playwright');
const fs = require('node:fs');
const { B, OUT, desktop, mobile, art, login } = require('./common.js');

const ITEMS = [
  { emoji: '🎧', bg: ['#dbeafe', '#bfdbfe'], title: 'Wireless headphones', url: 'https://shop.example/headphones', notes: 'Over-ear, black or navy' },
  { emoji: '📚', bg: ['#fde68a', '#fcd34d'], title: 'Illustrated fairy tale collection', url: 'https://books.example/fairy-tales', notes: 'Hardcover edition' },
  { emoji: '🧣', bg: ['#fecaca', '#fca5a5'], title: 'Wool scarf', url: '', notes: 'Something warm — any colour except yellow' },
  { emoji: '🪴', bg: ['#d1fae5', '#a7f3d0'], title: 'Monstera plant', url: 'https://plants.example/monstera', notes: 'Medium size, with pot' },
  { emoji: '☕', bg: ['#e7e5e4', '#d6d3d1'], title: 'Pour-over coffee set', url: 'https://shop.example/coffee-set', notes: '' },
  { emoji: '🧩', bg: ['#ede9fe', '#ddd6fe'], title: '1000-piece puzzle', url: 'https://games.example/puzzle', notes: 'Landscapes or maps' },
];

// PHASE=1: create the list and gifts. PHASE=2 (after demo prices are set in the DB): guests + screenshots.
(async () => {
  const browser = await chromium.launch();
  const admin = await (await browser.newContext(desktop)).newPage();
  admin.on('dialog', (d) => d.accept());
  await login(admin, 'emma', 'demo-password-1');
  if (process.env.PHASE === '2') await phase2(browser, admin);
  else await phase1(admin);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

async function phase1(admin) {
  await admin.goto(`${B}/admin/lists/new`);
  await admin.fill('input[name=title]', "Emma's Christmas list");
  await admin.fill('textarea[name=description]', 'Emma is 34, loves reading, plants and good coffee. Clothes size M.');
  await admin.click('form[action="/admin/lists"] button[type=submit]');
  const listUrl = admin.url().split('?')[0];
  fs.writeFileSync(`${OUT}/../listurl`, listUrl);
  for (const it of ITEMS) {
    await admin.goto(`${listUrl}/items/new`);
    const form = admin.locator('form[action$="/items"]').first();
    await form.locator('input[name=title]').fill(it.title);
    await form.locator('input[name=url]').fill(it.url);
    await form.locator('input[name=notes]').fill(it.notes);
    await form.locator('[data-upload-data]').evaluate((el, v) => { el.value = v; }, await art(admin, it.emoji, it.bg));
    await form.locator('button[type=submit]').click();
    await admin.waitForURL(/m=added/);
  }
}

async function phase2(browser, admin) {
  const listUrl = fs.readFileSync(`${OUT}/../listurl`, 'utf8');
  await admin.goto(listUrl);
  const share = (await admin.inputValue('#share-link')).replace('https://giftly.example.com', B);

  async function guest(name, opts, picks) {
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept());
    await p.goto(share);
    await p.fill('input[name=name]', name);
    await p.click('button[type=submit]');
    for (const title of picks) {
      await p.locator('li.item', { hasText: title }).locator('button').click();
      await p.waitForURL(/m=/);
    }
    await p.goto(share);
    return { ctx, p };
  }

  {
    const ctx = await browser.newContext(mobile);
    const p = await ctx.newPage();
    await p.goto(share);
    await p.fill('input[name=name]', 'Grandma Rose');
    await p.screenshot({ path: `${OUT}/join-mobile.png` });
    await ctx.close();
  }
  const tom = await guest('Uncle Tom', desktop, ['Wireless headphones']);
  await tom.ctx.close();
  await recordGuestFlow(browser, share);
  const rose = await guest('Grandma Rose', desktop, ['Wool scarf']);
  await rose.p.screenshot({ path: `${OUT}/guest-list.png`, fullPage: true });
  await rose.ctx.close();
  const dark = await guest('Grandma Rose', { ...mobile, colorScheme: 'dark' }, []);
  await dark.p.screenshot({ path: `${OUT}/guest-mobile-dark.png` });
  await dark.ctx.close();

  await admin.goto(listUrl);
  await admin.setViewportSize({ width: 980, height: 1350 });
  await admin.screenshot({ path: `${OUT}/admin-list.png` });

  await admin.goto(`${B}/admin/notifications`);
  await admin.setViewportSize({ width: 980, height: 900 });
  await admin.fill('input[name=ntfy_url]', 'https://ntfy.example/giftly-demo');
  await admin.locator('#notifications button[type=submit]').first().click();
  await admin.waitForURL(/notifySaved/);
  await admin.locator('#notifications').screenshot({ path: `${OUT}/notifications.png` });

  // Admins page: Lucas joins through an invite link.
  await admin.goto(`${B}/admin/users`);
  await admin.locator('form[action="/admin/users/invite"] button').click();
  const invite = (await admin.inputValue('#new-link')).replace('https://giftly.example.com', B);
  const other = await (await browser.newContext(desktop)).newPage();
  await other.goto(invite);
  await other.fill('input[name=name]', 'Lucas');
  await other.fill('input[name=username]', 'lucas');
  await other.fill('input[name=password]', 'demo-password-2');
  await other.fill('input[name=confirm]', 'demo-password-2');
  await other.click('button[type=submit]');
  await admin.goto(`${B}/admin/users`);
  await admin.setViewportSize({ width: 980, height: 620 });
  await admin.screenshot({ path: `${OUT}/admins.png` });
}

/**
 * README GIF: a guest opens the list link on a phone, types their name and picks a gift.
 * Recorded as video (converted to GIF by run.sh). Taps are drawn as a fading circle.
 */
async function recordGuestFlow(browser, share) {
  const size = { width: 390, height: 760 };
  const ctx = await browser.newContext({ ...mobile, viewport: size, deviceScaleFactor: 1, recordVideo: { dir: `${OUT}/video`, size } });
  await ctx.addInitScript(() => {
    // Native confirm dialogs freeze Chromium's screencast: answer "yes" without one in the recording.
    window.confirm = () => true;
    addEventListener('pointerdown', (e) => {
      const d = document.createElement('div');
      Object.assign(d.style, { position: 'fixed', left: `${e.clientX - 22}px`, top: `${e.clientY - 22}px`, width: '44px', height: '44px',
        borderRadius: '50%', background: 'rgba(184,50,42,.35)', border: '2px solid rgba(184,50,42,.7)', pointerEvents: 'none',
        zIndex: 99999, transition: 'opacity .6s, transform .6s' });
      document.documentElement.appendChild(d);
      requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'scale(1.6)'; });
      setTimeout(() => d.remove(), 700);
    }, true);
  });
  const p = await ctx.newPage();
  const pause = (ms) => p.waitForTimeout(ms);
  const tap = async (loc) => {
    const b = await loc.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down(); await pause(120); await p.mouse.up();
  };

  await p.goto(share);
  await pause(1200);
  await tap(p.locator('input[name=name]'));
  await p.locator('input[name=name]').pressSequentially('Aunt Clara', { delay: 110 });
  await pause(600);
  await tap(p.locator('button[type=submit]'));
  await p.waitForLoadState();
  await pause(1500);
  const item = p.locator('li.item', { hasText: 'Monstera plant' });
  // A gentle scroll down to the gift, then wait until it has stopped moving.
  const target = await item.evaluate((el) => el.getBoundingClientRect().top + scrollY - innerHeight / 2 + el.offsetHeight / 2);
  await p.evaluate(async (y) => {
    const from = scrollY, steps = 40;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, ease = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      scrollTo(0, from + (y - from) * ease);
      await new Promise((r) => setTimeout(r, 25));
    }
  }, target);
  await pause(1000);
  const before = p.url();
  await tap(item.locator('button'));
  await p.waitForURL((u) => u.href !== before);
  await p.waitForLoadState();
  await pause(1200);
  await p.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await pause(2800);
  await ctx.close();
  fs.renameSync(await p.video().path(), `${OUT}/guest-flow.webm`);
}
