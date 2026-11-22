import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { db, lists, guests, items } from './db.js';
import { tokens, csrfFor, safeEqual, rateLimit, resetRateLimit } from './security.js';
import { makeT } from './i18n.js';
import * as views from './views.js';
import { IMAGE_DIR, IMAGE_FILE_RE, IMAGE_TYPES, removeImage, saveImageBuffer, sweepImages } from './preview.js';
import { enqueuePreview, clearPreview, startPreviewQueue } from './previewQueue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUEST_COOKIE = 'giftly_guest';
const ADMIN_COOKIE = 'giftly_admin';
const LANG_COOKIE = 'giftly_lang';
const LANGS = ['pt', 'en'];
const DAY = 86_400_000;

// ---------- static files (loaded once) ----------

const STATIC = {
  '/static/style.css': ['text/css; charset=utf-8', readFileSync(join(ROOT, 'public/style.css'))],
  '/static/app.js': ['text/javascript; charset=utf-8', readFileSync(join(ROOT, 'public/app.js'))],
  '/static/favicon.svg': ['image/svg+xml', readFileSync(join(ROOT, 'public/favicon.svg'))],
};

// ---------- request helpers ----------

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Visitor language: explicit choice (cookie) → browser (Accept-Language) → APP_LANG. */
function pickLang(req, cookies) {
  if (LANGS.includes(cookies[LANG_COOKIE])) return cookies[LANG_COOKIE];
  for (const part of String(req.headers['accept-language'] || '').split(',')) {
    const code = part.split(';')[0].trim().slice(0, 2).toLowerCase();
    if (LANGS.includes(code)) return code;
  }
  return config.lang;
}

function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
  return `${isHttps(req) ? 'https' : 'http'}://${host}`;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const type = String(req.headers['content-type'] || '');
      if (!type.startsWith('application/x-www-form-urlencoded')) return resolve({});
      resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
  });
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

function cleanUrl(v) {
  const s = String(v ?? '').trim().slice(0, 2000);
  if (!s) return { url: '' };
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return { url: u.toString() };
  } catch { /* fallthrough */ }
  return { error: true };
}

// ---------- response helpers ----------

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function cookie(req, name, value, maxAgeMs) {
  const secure = config.cookieSecure === 'true' || (config.cookieSecure === 'auto' && isHttps(req));
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(maxAgeMs > 0 ? `Max-Age=${Math.floor(maxAgeMs / 1000)}` : 'Max-Age=0');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const html = (res, body, status = 200, headers = {}) =>
  send(res, status, String(body), { 'Content-Type': 'text/html; charset=utf-8', ...headers });

function redirect(res, location, cookies = []) {
  const headers = { Location: location };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  send(res, 303, '', headers);
}

// Flash messages travel in the query string as an allow-listed key.
const FLASH = {
  picked: ['success', 'msg.picked'],
  unpicked: ['success', 'msg.unpicked'],
  taken: ['error', 'msg.taken'],
  saved: ['success', 'admin.saved'],
  created: ['success', 'admin.created'],
  added: ['success', 'admin.added'],
  deleted: ['success', 'admin.deleted'],
  released: ['success', 'admin.released'],
  newLink: ['success', 'admin.newLinkDone'],
};

// ---------- routing ----------

const routes = [];
function route(method, path, handler, { auth } = {}) {
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) =>
    k === 'token' ? '(?<token>[A-Za-z0-9_-]{16,64})' : `(?<${k}>\\d+)`) + '/?$');
  routes.push({ method, re, handler, auth });
}

// ----- guest -----
//
// Each list has a secret link /l/<token>. Guests only type their name.
// The guest cookie holds [guestId, listEpoch] pairs, so one browser can be in several lists.

const MAX_GUEST_LISTS = 20;

function guestEntries(ctx) {
  const p = tokens.verifyGuest(ctx.cookies[GUEST_COOKIE]);
  return Array.isArray(p?.s) ? p.s.filter((e) => Array.isArray(e) && e.length === 2) : [];
}

function guestCookie(ctx, entries) {
  if (!entries.length) return cookie(ctx.req, GUEST_COOKIE, '', 0);
  const token = tokens.signGuest({ s: entries.slice(-MAX_GUEST_LISTS), exp: Date.now() + 180 * DAY });
  return cookie(ctx.req, GUEST_COOKIE, token, 180 * DAY);
}

/** All lists this browser is currently in, as { guest, list }. */
function guestSessions(ctx) {
  const out = [];
  for (const [g, e] of guestEntries(ctx)) {
    const guest = guests.get(g);
    const list = guest && lists.get(guest.list_id);
    if (list && !list.archived && list.epoch === e) out.push({ guest, list });
  }
  return out;
}

const sessionFor = (ctx, list) => guestSessions(ctx).find((s) => s.list.id === list.id) || null;

function invalidLink(ctx) {
  html(ctx.res, views.errorPage(ctx, ctx.t('error.badLink')), 404);
}

route('GET', '/', (ctx) => {
  html(ctx.res, views.homePage(ctx, { sessions: guestSessions(ctx) }));
});

route('GET', '/l/:token', (ctx) => {
  const list = lists.byToken(ctx.params.token);
  if (!list || list.archived) return invalidLink(ctx);
  const session = sessionFor(ctx, list);
  if (!session) return html(ctx.res, views.joinPage(ctx, { list }));
  const { guest } = session;
  guests.touch(guest.id);
  html(ctx.res, views.guestListPage(ctx, {
    list,
    guest,
    available: items.available(list.id),
    mine: items.reservedBy(guest.id),
    takenByOthers: items.reservedByOthers(list.id, guest.id),
    total: items.forList(list.id).length,
  }));
});

route('POST', '/l/:token/join', (ctx) => {
  const list = lists.byToken(ctx.params.token);
  if (!list || list.archived) return invalidLink(ctx);
  const name = clean(ctx.body.name, 60);
  if (!rateLimit(`join:${clientIp(ctx.req)}`, 30, 15 * 60_000)) {
    return html(ctx.res, views.joinPage(ctx, { list, name, error: ctx.t('login.tooMany') }), 429);
  }
  if (!name) return html(ctx.res, views.joinPage(ctx, { list, name, error: ctx.t('login.noName') }), 400);
  const guest = guests.findOrCreate(list.id, name);
  const others = guestEntries(ctx).filter(([g]) => guests.get(g)?.list_id !== list.id);
  redirect(ctx.res, `/l/${list.token}`, [guestCookie(ctx, [...others, [guest.id, list.epoch]])]);
});

route('POST', '/l/:token/logout', (ctx) => {
  const keep = guestEntries(ctx).filter(([g]) => g !== ctx.session.guest.id);
  redirect(ctx.res, `/l/${ctx.session.list.token}`, [guestCookie(ctx, keep)]);
}, { auth: 'guest' });

route('POST', '/l/:token/pick/:id', (ctx) => {
  const ok = items.reserve(Number(ctx.params.id), ctx.session.guest);
  redirect(ctx.res, `/l/${ctx.session.list.token}?m=${ok ? 'picked' : 'taken'}`);
}, { auth: 'guest' });

route('POST', '/l/:token/unpick/:id', (ctx) => {
  items.unreserve(Number(ctx.params.id), ctx.session.guest);
  redirect(ctx.res, `/l/${ctx.session.list.token}?m=unpicked`);
}, { auth: 'guest' });

// ----- admin -----

route('GET', '/admin', (ctx) => {
  if (!ctx.isAdmin) return html(ctx.res, views.adminLoginPage(ctx));
  html(ctx.res, views.adminDashboard(ctx, { all: lists.all(), form: {} }));
});

route('POST', '/admin/login', (ctx) => {
  const ip = clientIp(ctx.req);
  const key = `admin:${ip}`;
  if (!rateLimit(key, 8, 15 * 60_000)) {
    return html(ctx.res, views.adminLoginPage(ctx, { error: ctx.t('login.tooMany') }), 429);
  }
  if (!safeEqual(ctx.body.password || '', config.adminPassword)) {
    return html(ctx.res, views.adminLoginPage(ctx, { error: ctx.t('admin.bad') }), 401);
  }
  resetRateLimit(key);
  const token = tokens.signAdmin({ a: 1, exp: Date.now() + 14 * DAY });
  redirect(ctx.res, '/admin', [cookie(ctx.req, ADMIN_COOKIE, token, 14 * DAY)]);
});

route('POST', '/admin/logout', (ctx) => {
  redirect(ctx.res, '/admin', [cookie(ctx.req, ADMIN_COOKIE, '', 0)]);
}, { auth: 'admin' });

function validateList(ctx, body) {
  const form = {
    title: clean(body.title, 120),
    description: cleanMultiline(body.description, 2000),
    archived: body.archived === '1',
  };
  return { form, error: form.title ? undefined : ctx.t('admin.titleRequired') };
}

route('POST', '/admin/lists', (ctx) => {
  const { form, error } = validateList(ctx, ctx.body);
  if (error) return html(ctx.res, views.adminDashboard(ctx, { all: lists.all(), form, error }), 400);
  const id = lists.create(form);
  redirect(ctx.res, `/admin/lists/${id}?m=created`);
}, { auth: 'admin' });

function renderAdminList(ctx, list, extra = {}, status = 200) {
  html(ctx.res, views.adminListPage(ctx, {
    list,
    allItems: items.forList(list.id),
    allGuests: guests.forList(list.id),
    baseUrl: baseUrl(ctx.req),
    ...extra,
  }), status);
}

function loadList(ctx) {
  const list = lists.get(Number(ctx.params.id));
  if (!list) notFound(ctx);
  return list;
}

route('GET', '/admin/lists/:id', (ctx) => {
  const list = loadList(ctx);
  if (list) renderAdminList(ctx, list);
}, { auth: 'admin' });

route('POST', '/admin/lists/:id', (ctx) => {
  const list = loadList(ctx);
  if (!list) return;
  const { form, error } = validateList(ctx, ctx.body);
  if (error) return renderAdminList(ctx, list, { listForm: form, listError: error }, 400);
  lists.update(list.id, form);
  redirect(ctx.res, `/admin/lists/${list.id}?m=saved`);
}, { auth: 'admin' });

route('POST', '/admin/lists/:id/new-link', (ctx) => {
  lists.regenerateToken(Number(ctx.params.id));
  redirect(ctx.res, `/admin/lists/${ctx.params.id}?m=newLink`);
}, { auth: 'admin' });

route('POST', '/admin/lists/:id/delete', (ctx) => {
  lists.delete(Number(ctx.params.id));
  sweepImages(items.allImageFiles());
  redirect(ctx.res, '/admin?m=deleted');
}, { auth: 'admin' });

function validateItem(ctx, body) {
  const { url, error: urlError } = cleanUrl(body.url);
  const { url: imageSource, error: imageError } = cleanUrl(body.image_source);
  const form = {
    title: clean(body.title, 200),
    url: url ?? String(body.url ?? ''),
    image_source: imageSource ?? String(body.image_source ?? ''),
    remove_image: body.remove_image === '1',
    notes: clean(body.notes, 1000),
    reserved_name: clean(body.reserved_name, 60),
  };
  let error;
  if (!form.title) error = ctx.t('admin.titleRequired');
  else if (urlError || imageError) error = ctx.t('admin.badUrl');
  return { form, error };
}

route('POST', '/admin/lists/:id/items', (ctx) => {
  const list = loadList(ctx);
  if (!list) return;
  const { form, error } = validateItem(ctx, ctx.body);
  if (error) return renderAdminList(ctx, list, { itemError: error }, 400);
  const id = items.create(list.id, form);
  applyUpload(id, ctx.body.image_data);
  enqueuePreview(id); // keeps an uploaded image, still reads the price
  redirect(ctx.res, `/admin/lists/${list.id}?m=added&n=1`);
}, { auth: 'admin' });

route('POST', '/admin/lists/:id/items/bulk', (ctx) => {
  const list = loadList(ctx);
  if (!list) return;
  let n = 0;
  for (const line of String(ctx.body.lines || '').split(/\r?\n/).slice(0, 500)) {
    if (!line.trim()) continue;
    let [title, url = '', notes = ''] = line.split('|').map((s) => s.trim());
    // A bare link: use the hostname as a provisional title.
    if (/^https?:\/\//i.test(title) && !url) {
      url = title;
      try { title = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
    }
    const { form, error } = validateItem(ctx, { title, url, notes });
    if (error) continue;
    enqueuePreview(items.create(list.id, form));
    n++;
  }
  redirect(ctx.res, `/admin/lists/${list.id}?m=added&n=${n}`);
}, { auth: 'admin' });

/** Store an image uploaded as a data: URL. Returns true if one was saved. */
function applyUpload(itemId, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp|gif|avif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return false;
  let file;
  try { file = saveImageBuffer(Buffer.from(m[2], 'base64')); } catch { return false; }
  const old = items.get(itemId)?.image_file;
  items.setPreview(itemId, { image_file: file, preview_status: 'uploaded' });
  removeImage(old);
  return true;
}

function loadItem(ctx) {
  const item = items.get(Number(ctx.params.id));
  if (!item) notFound(ctx);
  return item;
}

route('GET', '/admin/items/:id', (ctx) => {
  const item = loadItem(ctx);
  if (item) html(ctx.res, views.adminItemPage(ctx, { item, list: lists.get(item.list_id) }));
}, { auth: 'admin' });

route('POST', '/admin/items/:id', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  const { form, error } = validateItem(ctx, ctx.body);
  if (error) return html(ctx.res, views.adminItemPage(ctx, { item, list: lists.get(item.list_id), form, error }), 400);
  if (form.remove_image) form.image_source = '';
  items.update(item.id, form);
  items.setManualReservation(item.id, form.reserved_name);
  const uploaded = applyUpload(item.id, ctx.body.image_data);
  if (!uploaded && form.remove_image) clearPreview(item.id);
  if (!uploaded && form.image_source && form.image_source !== item.image_source) {
    enqueuePreview(item.id, { force: true }); // a new image link replaces an uploaded photo
  } else if (form.url !== item.url) {
    enqueuePreview(item.id); // new link: new price (and image, unless one was uploaded)
  }
  redirect(ctx.res, `/admin/lists/${item.list_id}?m=saved`);
}, { auth: 'admin' });

route('POST', '/admin/items/:id/preview', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  enqueuePreview(item.id, { force: true });
  redirect(ctx.res, `/admin/items/${item.id}`);
}, { auth: 'admin' });

// Polled by app.js while previews are loading: { "<id>": { status, image } }
route('GET', '/admin/previews', (ctx) => {
  const ids = String(ctx.url.searchParams.get('ids') || '').split(',').map(Number).filter(Boolean).slice(0, 200);
  const out = {};
  for (const id of ids) {
    const it = items.get(id);
    if (it) out[id] = { status: it.preview_status, image: it.image_file ? `/img/${it.image_file}` : null, title: it.title, price: it.price };
  }
  send(ctx.res, 200, JSON.stringify(out), { 'Content-Type': 'application/json' });
}, { auth: 'admin' });

route('POST', '/admin/items/:id/delete', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  items.delete(item.id);
  removeImage(item.image_file);
  redirect(ctx.res, `/admin/lists/${item.list_id}?m=deleted`);
}, { auth: 'admin' });

route('POST', '/admin/items/:id/release', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  items.release(item.id);
  redirect(ctx.res, `/admin/lists/${item.list_id}?m=released`);
}, { auth: 'admin' });

route('POST', '/admin/items/:id/move', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  items.move(item.id, ctx.body.dir === 'up' ? 'up' : 'down');
  redirect(ctx.res, `/admin/lists/${item.list_id}#item-${item.id}`);
}, { auth: 'admin' });

route('POST', '/admin/guests/:id/delete', (ctx) => {
  const guest = guests.get(Number(ctx.params.id));
  if (!guest) return notFound(ctx);
  guests.delete(guest.id);
  redirect(ctx.res, `/admin/lists/${guest.list_id}?m=deleted`);
}, { auth: 'admin' });

route('GET', '/healthz', (ctx) => {
  db.prepare('SELECT 1').get();
  send(ctx.res, 200, 'ok', { 'Content-Type': 'text/plain' });
});

function notFound(ctx) {
  html(ctx.res, views.errorPage(ctx, ctx.t('error.notFound')), 404);
}

// ---------- server ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'GET' && STATIC[path]) {
    const [type, body] = STATIC[path];
    return send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
  }

  // Stored preview images: random names, never change → cache forever.
  if (req.method === 'GET' && path.startsWith('/img/')) {
    const file = path.slice(5);
    if (IMAGE_FILE_RE.test(file)) {
      try {
        const body = await readFile(join(IMAGE_DIR, file));
        return send(res, 200, body, {
          'Content-Type': IMAGE_TYPES[file.split('.').pop()],
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
      } catch { /* fall through to 404 */ }
    }
  }

  const cookies = parseCookies(req.headers.cookie);

  // Language switch: GET /lang?to=en&back=/list
  if (req.method === 'GET' && path === '/lang') {
    const to = url.searchParams.get('to');
    let back = url.searchParams.get('back') || '/';
    if (!back.startsWith('/') || back.startsWith('//') || back.startsWith('/\\')) back = '/';
    const set = LANGS.includes(to) ? [cookie(req, LANG_COOKIE, to, 365 * DAY)] : [];
    return redirect(res, back, set);
  }

  const lang = pickLang(req, cookies);
  const ctx = {
    req, res, url, lang, cookies,
    t: makeT(lang),
    params: {},
    body: {},
  };
  ctx.isAdmin = !!tokens.verifyAdmin(ctx.cookies[ADMIN_COOKIE]);

  const m = url.searchParams.get('m');
  if (FLASH[m]) {
    const [type, key] = FLASH[m];
    ctx.flash = { type, text: ctx.t(key, { n: Number(url.searchParams.get('n')) || 0 }) };
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  let match;
  const r = routes.find((r) => r.method === method && (match = r.re.exec(path)));
  if (!r) return notFound(ctx);
  ctx.params = match.groups || {};

  // Authentication
  let sessionCookie = '';
  if (r.auth === 'admin' || path.startsWith('/admin')) sessionCookie = ctx.cookies[ADMIN_COOKIE] || '';
  else sessionCookie = ctx.cookies[GUEST_COOKIE] || '';

  if (r.auth === 'admin' && !ctx.isAdmin) return redirect(res, '/admin');
  if (r.auth === 'guest') {
    const list = lists.byToken(ctx.params.token);
    ctx.session = list && !list.archived ? sessionFor(ctx, list) : null;
    if (!ctx.session) return redirect(res, list ? `/l/${list.token}` : '/');
  }
  ctx.csrf = csrfFor(sessionCookie);

  if (method === 'POST') {
    // Admin forms may carry an uploaded image (resized client-side to ~800px).
    ctx.body = await readBody(req, r.auth === 'admin' ? 8 * 1024 * 1024 : 64 * 1024);
    // Authenticated POSTs must carry a CSRF token bound to the session cookie.
    if (r.auth && !safeEqual(ctx.body._csrf || '', ctx.csrf)) {
      return html(res, views.errorPage(ctx, ctx.t('error.csrf')), 403);
    }
  }

  await r.handler(ctx);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, 'Error', { 'Content-Type': 'text/plain' });
    else res.end();
  });
});

server.listen(config.port, config.host, () => {
  startPreviewQueue();
  console.log(`giftly listening on http://${config.host}:${config.port} (lang=${config.lang}, data=${config.dataDir})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
