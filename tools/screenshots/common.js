// Shared helpers for the README screenshot scripts (mock data only).
const B = process.env.GIFTLY_URL || 'http://127.0.0.1:3998';
const OUT = process.env.OUT || '/work/out';
const desktop = { locale: 'en-GB', viewport: { width: 980, height: 900 }, deviceScaleFactor: 2 };
const mobile = { locale: 'en-GB', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** A drawn placeholder "product photo": an emoji on a pastel gradient (never real shop images). */
const art = (page, emoji, bg, size = 480) => page.evaluate(([e, bg, size]) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, bg[0]); grad.addColorStop(1, bg[1]);
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  g.font = `${Math.round(size * 0.55)}px "Noto Color Emoji", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(e, size / 2, size * 0.54);
  return c.toDataURL('image/png');
}, [emoji, bg, size]);

async function login(page, username, password) {
  await page.goto(`${B}/login`);
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
}

const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const inDays = (n) => ymd(new Date(Date.now() + n * 86_400_000));

/** A phone page signed in as whoever `from` (a page) is: the README shows the app as on a phone. */
async function phoneOf(browser, from, opts = {}) {
  const ctx = await browser.newContext({ ...mobile, ...opts });
  await ctx.addCookies(await from.context().cookies());
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  return page;
}

/** One phone screen of `path` (optionally scrolled to `selector`), like a real phone shows it. */
async function phoneShot(page, path, file, { selector } = {}) {
  await page.goto(`${B}${path}`);
  if (selector) await page.locator(selector).first().evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 12));
  await page.screenshot({ path: `${OUT}/${file}` });
}

module.exports = { B, OUT, desktop, mobile, art, login, inDays, phoneOf, phoneShot };
