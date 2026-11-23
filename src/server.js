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
import { trustedProxyPeer, normalizeAddress } from './net.js';
import { enqueuePreview, clearPreview, startPreviewQueue, allImageFiles, releaseImage } from './previewQueue.js';
import { deleteUserData, gifts as givingGifts } from './giving.js';
import { registerGivingRoutes } from './givingRoutes.js';
import { registerWishlistRoutes } from './wishlistRoutes.js';
import { wishlists, wishItems, convertLegacyIdeas } from './wishlist.js';
import { startReminders, parseReminderDays, remindUser } from './reminders.js';
import { userChannels } from './notify.js';
import { notify, notifyStatus, saveNotifySettings } from './notify.js';
import { users, sessions, links, checkLogin, hashPassword, verifyPassword, validateAccount, checkSecondFactor, SESSION_DAYS } from './accounts.js';
import { newSecret, verifyTotp, otpauthUri, newRecoveryCodes } from './totp.js';
import { qrSvg } from './qr.js';
import { bootstrapAccounts } from './bootstrap.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUEST_COOKIE = 'giftly_guest';
const SESSION_COOKIE = 'giftly_session';
const TWO_FACTOR_COOKIE = 'giftly_2fa';
const LANG_COOKIE = 'giftly_lang';
const LANGS = ['pt', 'en'];
const DAY = 86_400_000;

// ---------- static files (loaded once) ----------

const STATIC = {
  '/static/style.css': ['text/css; charset=utf-8', readFileSync(join(ROOT, 'public/style.css'))],
  '/static/app.js': ['text/javascript; charset=utf-8', readFileSync(join(ROOT, 'public/app.js'))],
  // App icons live at the root, where browsers and phones look for them by default.
  ...Object.fromEntries([
    ['favicon.ico', 'image/x-icon'],
    ['favicon.svg', 'image/svg+xml'],
    ['apple-touch-icon.png', 'image/png'],
    ['icon-192.png', 'image/png'],
    ['icon-512.png', 'image/png'],
    ['site.webmanifest', 'application/manifest+json'],
  ].map(([file, type]) => [`/${file}`, [type, readFileSync(join(ROOT, 'public/icons', file))]])),
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
  if (trustedProxyPeer(req.socket.remoteAddress)) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return trustedProxyPeer(req.socket.remoteAddress) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/**
 * For invite and new-password links (they grant an account): always BASE_URL. Without it, only
 * when the admin is on this very machine (loopback connection and a localhost address), as
 * http://localhost:PORT; anywhere else → null, and the page asks for BASE_URL to be set.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1']);
function accountLinkBase(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const peer = normalizeAddress(req.socket.remoteAddress);
  const host = String(req.headers.host || '');
  const port = /:(\d+)$/.exec(host)?.[1];
  const hostName = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK.has(peer) || !['localhost', '127.0.0.1', '::1'].includes(hostName)) return null;
  return `http://localhost${port ? `:${port}` : ''}`;
}

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const host = (trustedProxyPeer(req.socket.remoteAddress) && req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
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
      // Repeated fields (e.g. several checkboxes with the same name) become arrays.
      const out = {};
      for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
        out[k] = k in out ? [].concat(out[k], v) : v;
      }
      resolve(out);
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
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** Requests to the public host of an https BASE_URL always came through HTTPS (the proxy's). */
function viaHttpsBaseUrl(req) {
  const base = process.env.BASE_URL || '';
  if (!/^https:\/\//i.test(base)) return false;
  try { return new URL(base).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

function cookie(req, name, value, maxAgeMs) {
  const secure = config.cookieSecure === 'true'
    || (config.cookieSecure === 'auto' && (isHttps(req) || viaHttpsBaseUrl(req)));
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
  passwordChanged: ['success', 'account.passwordChanged'],
  welcome: ['success', 'account.welcome'],
  giftAdded: ['success', 'give.giftAdded'],
  wishRemoved: ['success', 'wish.removedDone'],
  giving: ['success', 'wish.givingDone'],
  pickOccasion: ['error', 'give.pickOccasion'],
  reservedFor: ['success', 'admin.reservedDone'],
  reservationChanged: ['error', 'admin.reservationChanged'],
  badItem: ['error', 'admin.titleRequired'],
  twofaOff: ['success', 'tf.disabled'],
  twofaReset: ['success', 'tf.resetDone'],
  recoveryUsed: ['error', 'tf.recoveryUsed'],
  remindersSent: ['success', 'remind.testSent'],
  remindersNone: ['success', 'remind.testNone'],
  remindersNoChannel: ['error', 'remind.noChannel'],
  notifyOk: ['success', 'notify.testOk'],
  notifySaved: ['success', 'admin.saved'],
  notifyFail: ['error', 'notify.testFail'],
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
// The guest cookie (signed) holds [guestToken, listId, listEpoch] entries, so one browser can be in
// several lists. The token is random and never reused; the list id and epoch must both match.

const MAX_GUEST_LISTS = 20;

function guestEntries(ctx) {
  const p = tokens.verifyGuest(ctx.cookies[GUEST_COOKIE]);
  // Older cookies ([guestId, epoch]) are no longer accepted: the guest just types their name again.
  return Array.isArray(p?.s) ? p.s.filter((e) => Array.isArray(e) && e.length === 3
    && typeof e[0] === 'string' && Number.isInteger(e[1]) && Number.isInteger(e[2])) : [];
}

function guestCookie(ctx, entries) {
  if (!entries.length) return cookie(ctx.req, GUEST_COOKIE, '', 0);
  const token = tokens.signGuest({ s: entries.slice(-MAX_GUEST_LISTS), exp: Date.now() + 180 * DAY });
  return cookie(ctx.req, GUEST_COOKIE, token, 180 * DAY);
}

/** All lists this browser is currently in, as { guest, list }. */
function guestSessions(ctx) {
  const out = [];
  for (const [t, listId, e] of guestEntries(ctx)) {
    const guest = guests.bySession(t, listId);
    const list = guest && lists.get(listId);
    if (list && guest.list_id === list.id && !list.archived && list.epoch === e) out.push({ guest, list });
  }
  return out;
}

/**
 * May this browser see a stored image? Only if it may see a record that shows it, by the same
 * rules as the pages: an admin (past the 2FA requirement) who can see the list, the gift or the
 * wishlist; or a guest with a valid session in a list that shows it.
 */
function canSeeImage(cookies, file) {
  const user = sessions.user(cookies[SESSION_COOKIE]);
  if (user && !(config.require2fa && !user.totp_secret)) {
    const uid = user.id;
    for (const { list_id: id } of db.prepare('SELECT DISTINCT list_id FROM items WHERE image_file = ?').all(file)) {
      if (lists.canSee(uid, id)) return true;
    }
    for (const { id } of db.prepare('SELECT id FROM gifts WHERE image_file = ?').all(file)) {
      if (givingGifts.get(uid, id)) return true;
    }
    for (const { wishlist_id: id } of db.prepare('SELECT DISTINCT wishlist_id FROM wishlist_items WHERE image_file = ?').all(file)) {
      const w = wishlists.get(id);
      if (w && (w.owner_id === uid || wishlists.viewableByOther(uid, w))) return true;
    }
  }
  for (const [t, listId, e] of guestEntries({ cookies })) {
    if (db.prepare(`SELECT 1 FROM items i JOIN guests gu ON gu.list_id = i.list_id JOIN lists l ON l.id = i.list_id
        WHERE gu.token = ? AND l.id = ? AND l.epoch = ? AND l.archived = 0 AND i.image_file = ?
          AND i.pending = 0 AND i.hidden = 0 LIMIT 1`).get(t, listId, e, file)) return true;
  }
  return false;
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
    takenByOthers: items.takenByOthers(list.id, guest.id),
    total: items.guestVisibleCount(list.id),
    adminNames: adminNames(),
  }));
});

/** { userId: display name } for "reserved by …" labels. */
const adminNames = () => Object.fromEntries(users.all().map((u) => [u.id, u.name]));

route('POST', '/l/:token/join', (ctx) => {
  const list = lists.byToken(ctx.params.token);
  if (!list || list.archived) return invalidLink(ctx);
  const name = clean(ctx.body.name, 60);
  if (!rateLimit(`join:${clientIp(ctx.req)}`, 30, 15 * 60_000)) {
    return html(ctx.res, views.joinPage(ctx, { list, name, error: ctx.t('login.tooMany') }), 429);
  }
  if (!name) return html(ctx.res, views.joinPage(ctx, { list, name, error: ctx.t('login.noName') }), 400);
  // Someone already joined with this name: ask "is it you?" (re-joining from another device is
  // allowed on purpose). Not for names an admin reserved for and that never visited.
  const existing = guests.byName(list.id, name);
  if (existing && existing.last_seen !== 0 && ctx.body.confirm !== '1') {
    return html(ctx.res, views.joinPage(ctx, { list, name, sameName: existing.name }));
  }
  const guest = guests.findOrCreate(list.id, name);
  if (guest.isNew) notify('join', { list, guest });
  const others = guestEntries(ctx).filter(([, listId]) => listId !== list.id);
  redirect(ctx.res, `/l/${list.token}`, [guestCookie(ctx, [...others, [guest.token, list.id, list.epoch]])]);
});

route('POST', '/l/:token/logout', (ctx) => {
  const keep = guestEntries(ctx).filter(([t]) => t !== ctx.session.guest.token);
  redirect(ctx.res, `/l/${ctx.session.list.token}`, [guestCookie(ctx, keep)]);
}, { auth: 'guest' });

route('POST', '/l/:token/pick/:id', (ctx) => {
  const id = Number(ctx.params.id);
  const ok = items.reserve(id, ctx.session.guest);
  if (ok) notify('pick', { ...ctx.session, item: items.get(id) });
  redirect(ctx.res, `/l/${ctx.session.list.token}?m=${ok ? 'picked' : 'taken'}`);
}, { auth: 'guest' });

route('POST', '/l/:token/unpick/:id', (ctx) => {
  const id = Number(ctx.params.id);
  if (items.unreserve(id, ctx.session.guest)) notify('unpick', { ...ctx.session, item: items.get(id) });
  redirect(ctx.res, `/l/${ctx.session.list.token}?m=unpicked`);
}, { auth: 'guest' });

// ----- admin -----

route('GET', '/admin', (ctx) => {
  if (!ctx.user) return html(ctx.res, views.adminLoginPage(ctx, { noAccounts: users.count() === 0 }));
  html(ctx.res, views.adminDashboard(ctx, { all: lists.all(ctx.user.id), form: {} }));
});

route('POST', '/admin/login', async (ctx) => {
  const username = clean(ctx.body.username, 64).toLowerCase();
  const ipKey = `login:${clientIp(ctx.req)}`;
  const userKey = `login-user:${username}`;
  const fail = (error, status) => html(ctx.res, views.adminLoginPage(ctx, { username, error }), status);
  if (!rateLimit(ipKey, 8, 15 * 60_000) || !rateLimit(userKey, 10, 15 * 60_000)) return fail(ctx.t('login.tooMany'), 429);
  const user = await checkLogin(username, String(ctx.body.password ?? ''));
  if (!user) return fail(ctx.t('account.badLogin'), 401);
  resetRateLimit(ipKey);
  resetRateLimit(userKey);
  startSession(ctx, user.id, '/admin');
});

route('POST', '/admin/logout', (ctx) => {
  sessions.delete(ctx.cookies[SESSION_COOKIE]);
  redirect(ctx.res, '/admin', [cookie(ctx.req, SESSION_COOKIE, '', 0)]);
}, { auth: 'admin' });

/**
 * Log a user in. If they use two-factor authentication and haven't given a code yet,
 * ask for it first (the password step is remembered for 5 minutes in a signed cookie).
 */
function startSession(ctx, userId, to, { secondFactorDone = false } = {}) {
  const user = users.get(userId);
  if (user?.totp_secret && !secondFactorDone) {
    const pending = tokens.signTwoFactor({ u: userId, to, exp: Date.now() + 5 * 60_000 });
    return redirect(ctx.res, '/admin/login/2fa', [cookie(ctx.req, TWO_FACTOR_COOKIE, pending, 5 * 60_000)]);
  }
  const token = sessions.create(userId);
  redirect(ctx.res, to, [
    cookie(ctx.req, SESSION_COOKIE, token, SESSION_DAYS * DAY),
    cookie(ctx.req, TWO_FACTOR_COOKIE, '', 0),
  ]);
}

// ----- two-factor: login step -----

const pendingTwoFactor = (ctx) => {
  const p = tokens.verifyTwoFactor(ctx.cookies[TWO_FACTOR_COOKIE]);
  const user = p && users.get(p.u);
  return user?.totp_secret ? { user, to: String(p.to || '/admin') } : null;
};

route('GET', '/admin/login/2fa', (ctx) => {
  if (!pendingTwoFactor(ctx)) return redirect(ctx.res, '/admin');
  html(ctx.res, views.twoFactorLoginPage(ctx));
});

route('POST', '/admin/login/2fa', (ctx) => {
  const pending = pendingTwoFactor(ctx);
  if (!pending) return redirect(ctx.res, '/admin');
  const key = `2fa:${pending.user.id}`;
  if (!rateLimit(key, 6, 15 * 60_000)) return html(ctx.res, views.twoFactorLoginPage(ctx, { error: ctx.t('login.tooMany') }), 429);
  const how = checkSecondFactor(pending.user, ctx.body.code);
  if (!how) return html(ctx.res, views.twoFactorLoginPage(ctx, { error: ctx.t('tf.badCode') }), 401);
  resetRateLimit(key);
  const to = !pending.to.startsWith('/admin') ? '/admin' : how === 'recovery'
    ? `/admin/profile/2fa?m=recoveryUsed&n=${users.recoveryHashes(pending.user.id).length}`
    : pending.to;
  startSession(ctx, pending.user.id, to, { secondFactorDone: true });
});

// ----- two-factor: set up and manage (profile) -----

function renderTwoFactor(ctx, extra = {}, status = 200) {
  const user = users.get(ctx.user.id);
  if (user.totp_secret) {
    return html(ctx.res, views.twoFactorManagePage(ctx, { user, remaining: users.recoveryHashes(user.id).length, required: config.require2fa, ...extra }), status);
  }
  const secret = users.totpPending(user.id, newSecret());
  const uri = otpauthUri({ secret, account: user.username, issuer: config.siteTitle || 'Giftly' });
  html(ctx.res, views.twoFactorSetupPage(ctx, { secret, qr: qrSvg(uri, { label: ctx.t('tf.qrLabel') }), required: config.require2fa, ...extra }), status);
}

route('GET', '/admin/profile/2fa', (ctx) => renderTwoFactor(ctx), { auth: 'admin' });

route('POST', '/admin/profile/2fa/confirm', (ctx) => {
  const user = users.get(ctx.user.id);
  if (user.totp_secret || !user.totp_pending) return redirect(ctx.res, '/admin/profile/2fa');
  const counter = verifyTotp(user.totp_pending, ctx.body.code);
  if (counter == null) return renderTwoFactor(ctx, { error: ctx.t('tf.badCode') }, 400);
  const { codes, hashes } = newRecoveryCodes();
  users.enableTotp(user.id, { secret: user.totp_pending, counter, recoveryHashes: hashes });
  sessions.deleteForUser(user.id, ctx.cookies[SESSION_COOKIE]); // other devices must log in with a code
  html(ctx.res, views.recoveryCodesPage(ctx, { codes, justEnabled: true }));
}, { auth: 'admin' });

route('POST', '/admin/profile/2fa/recovery', (ctx) => {
  if (!checkSecondFactor(users.get(ctx.user.id), ctx.body.code)) return renderTwoFactor(ctx, { error: ctx.t('tf.badCode') }, 400);
  const { codes, hashes } = newRecoveryCodes();
  users.setRecoveryHashes(ctx.user.id, hashes);
  html(ctx.res, views.recoveryCodesPage(ctx, { codes }));
}, { auth: 'admin' });

route('POST', '/admin/profile/2fa/disable', async (ctx) => {
  if (config.require2fa) return renderTwoFactor(ctx, { error: ctx.t('tf.requiredCantDisable') }, 403);
  const user = users.get(ctx.user.id);
  if (!(await verifyPassword(ctx.body.password ?? '', user.password_hash))) return renderTwoFactor(ctx, { error: ctx.t('account.badCurrent') }, 400);
  if (!checkSecondFactor(user, ctx.body.code)) return renderTwoFactor(ctx, { error: ctx.t('tf.badCode') }, 400);
  users.disableTotp(user.id);
  redirect(ctx.res, '/admin/profile?m=twofaOff');
}, { auth: 'admin' });

// Another admin turns off someone's 2FA (lost phone and recovery codes).
route('POST', '/admin/users/:id/2fa/disable', (ctx) => {
  const target = users.get(Number(ctx.params.id));
  if (!target || target.id === ctx.user.id) return notFound(ctx);
  users.disableTotp(target.id);
  sessions.deleteForUser(target.id);
  redirect(ctx.res, '/admin/users?m=twofaReset');
}, { auth: 'admin' });

// ----- profile -----

function renderProfile(ctx, extra = {}, status = 200) {
  html(ctx.res, views.profilePage(ctx, { user: ctx.user, notify: notifyStatus(ctx.user.id), ...extra }), status);
}

route('GET', '/admin/profile', (ctx) => renderProfile(ctx), { auth: 'admin' });

route('POST', '/admin/profile', (ctx) => {
  const form = { username: clean(ctx.body.username, 64), name: clean(ctx.body.name, 80) };
  const error = validateAccount(form, { exceptUserId: ctx.user.id, requirePassword: false });
  if (error) return renderProfile(ctx, { profileForm: form, profileError: ctx.t(error) }, 400);
  users.updateProfile(ctx.user.id, form);
  redirect(ctx.res, '/admin/profile?m=saved');
}, { auth: 'admin' });

route('POST', '/admin/profile/password', async (ctx) => {
  const { current = '', password = '', confirm = '' } = ctx.body;
  if (!(await verifyPassword(current, ctx.user.password_hash))) {
    return renderProfile(ctx, { passwordError: ctx.t('account.badCurrent') }, 400);
  }
  const error = validateAccount({ password, confirm });
  if (error) return renderProfile(ctx, { passwordError: ctx.t(error) }, 400);
  users.setPassword(ctx.user.id, await hashPassword(password));
  sessions.deleteForUser(ctx.user.id, ctx.cookies[SESSION_COOKIE]); // log out other devices
  redirect(ctx.res, '/admin/profile?m=passwordChanged');
}, { auth: 'admin' });

route('POST', '/admin/profile/notifications', (ctx) => {
  const { errors, values } = saveNotifySettings(ctx.user.id, ctx.body);
  if (errors.length) {
    const status = notifyStatus(ctx.user.id);
    status.values = { ...status.values, ...values, events: values.events.split(',').filter(Boolean) };
    return renderProfile(ctx, { notify: status, notifyErrors: errors }, 400);
  }
  redirect(ctx.res, '/admin/profile?m=notifySaved#notifications');
}, { auth: 'admin' });

route('POST', '/admin/profile/reminders', (ctx) => {
  const raw = clean(ctx.body.reminder_days, 60);
  const days = parseReminderDays(raw);
  if (raw && !days.length) return renderProfile(ctx, { remindersError: ctx.t('remind.badDays') }, 400);
  users.setReminderDays(ctx.user.id, days.slice().reverse().join(','));
  redirect(ctx.res, '/admin/profile?m=saved#reminders');
}, { auth: 'admin' });

// Sends whatever is due today again (ignoring what was already sent), only to this user.
route('POST', '/admin/profile/reminders/test', async (ctx) => {
  if (!userChannels(ctx.user.id).length) return redirect(ctx.res, '/admin/profile?m=remindersNoChannel#reminders');
  const n = await remindUser(ctx.user, { ignoreLog: true });
  redirect(ctx.res, `/admin/profile?m=${n ? 'remindersSent' : 'remindersNone'}&n=${n}#reminders`);
}, { auth: 'admin' });

route('POST', '/admin/profile/notify-test', async (ctx) => {
  const results = await notify('test', {}, { onlyUserId: ctx.user.id });
  const ok = results.length && results.every((r) => r.ok);
  redirect(ctx.res, `/admin/profile?m=${ok ? 'notifyOk' : 'notifyFail'}#notifications`);
}, { auth: 'admin' });

// ----- users, invites and password resets -----

function renderUsers(ctx, extra = {}, status = 200) {
  html(ctx.res, views.usersPage(ctx, { all: users.all(), invites: links.pendingInvites(), noBaseUrl: !process.env.BASE_URL, ...extra }), status);
}

route('GET', '/admin/users', (ctx) => renderUsers(ctx), { auth: 'admin' });

// The link is shown once, in this response (only its hash is stored).
route('POST', '/admin/users/invite', (ctx) => {
  const base = accountLinkBase(ctx.req);
  if (!base) return renderUsers(ctx, { error: ctx.t('account.needBaseUrl') }, 400);
  const token = links.create({ createdBy: ctx.user.id });
  renderUsers(ctx, { newLink: { kind: 'invite', url: `${base}/invite/${token}` } });
}, { auth: 'admin' });

route('POST', '/admin/users/invites/:id/revoke', (ctx) => {
  links.revoke(Number(ctx.params.id));
  redirect(ctx.res, '/admin/users?m=deleted');
}, { auth: 'admin' });

route('POST', '/admin/users/:id/reset-link', (ctx) => {
  const target = users.get(Number(ctx.params.id));
  if (!target) return notFound(ctx);
  const base = accountLinkBase(ctx.req);
  if (!base) return renderUsers(ctx, { error: ctx.t('account.needBaseUrl') }, 400);
  const token = links.create({ createdBy: ctx.user.id, userId: target.id });
  renderUsers(ctx, { newLink: { kind: 'reset', user: target, url: `${base}/reset/${token}` } });
}, { auth: 'admin' });

route('POST', '/admin/users/:id/delete', (ctx) => {
  const target = users.get(Number(ctx.params.id));
  if (!target) return notFound(ctx);
  if (target.id === ctx.user.id) return renderUsers(ctx, { error: ctx.t('account.cantDeleteSelf') }, 400);
  deleteUserData(target.id); // their private people/occasions/gifts; shared ones stay
  users.delete(target.id); // cascades to sessions, channels and pending reset links
  sweepImages(allImageFiles());
  redirect(ctx.res, '/admin/users?m=deleted');
}, { auth: 'admin' });

// Public pages opened from an invite / reset link.
function linkLimited(ctx) {
  return !rateLimit(`link:${clientIp(ctx.req)}`, 20, 15 * 60_000);
}

route('GET', '/invite/:token', (ctx) => {
  const link = links.find(ctx.params.token, 'invite');
  if (!link) return html(ctx.res, views.errorPage(ctx, ctx.t('account.badLink')), 404);
  html(ctx.res, views.invitePage(ctx, { token: ctx.params.token }));
});

route('POST', '/invite/:token', async (ctx) => {
  if (linkLimited(ctx)) return html(ctx.res, views.errorPage(ctx, ctx.t('login.tooMany')), 429);
  const link = links.find(ctx.params.token, 'invite');
  if (!link) return html(ctx.res, views.errorPage(ctx, ctx.t('account.badLink')), 404);
  const form = { username: clean(ctx.body.username, 64), name: clean(ctx.body.name, 80) };
  const error = validateAccount({ ...form, password: ctx.body.password ?? '', confirm: ctx.body.confirm ?? '' });
  if (error) return html(ctx.res, views.invitePage(ctx, { token: ctx.params.token, form, error: ctx.t(error) }), 400);
  const passwordHash = await hashPassword(ctx.body.password);
  if (!links.consume(link.id)) return html(ctx.res, views.errorPage(ctx, ctx.t('account.badLink')), 404);
  const id = users.create({ ...form, passwordHash });
  startSession(ctx, id, '/admin/profile?m=welcome');
});

route('GET', '/reset/:token', (ctx) => {
  const link = links.find(ctx.params.token, 'reset');
  if (!link) return html(ctx.res, views.errorPage(ctx, ctx.t('account.badLink')), 404);
  html(ctx.res, views.resetPage(ctx, { token: ctx.params.token, user: users.get(link.user_id) }));
});

route('POST', '/reset/:token', async (ctx) => {
  if (linkLimited(ctx)) return html(ctx.res, views.errorPage(ctx, ctx.t('login.tooMany')), 429);
  const link = links.find(ctx.params.token, 'reset');
  if (!link) return html(ctx.res, views.errorPage(ctx, ctx.t('account.badLink')), 404);
  const user = users.get(link.user_id);
  const error = validateAccount({ password: ctx.body.password ?? '', confirm: ctx.body.confirm ?? '' });
  if (error) return html(ctx.res, views.resetPage(ctx, { token: ctx.params.token, user, error: ctx.t(error) }), 400);
  const passwordHash = await hashPassword(ctx.body.password);
  if (!links.consume(link.id)) return html(ctx.res, views.errorPage(ctx, ctx.t('account.badLink')), 404);
  users.setPassword(user.id, passwordHash);
  sessions.deleteForUser(user.id); // everywhere logged out, then logged in here
  startSession(ctx, user.id, '/admin?m=passwordChanged');
});

function validateList(ctx, body) {
  const form = {
    title: clean(body.title, 120),
    description: cleanMultiline(body.description, 2000),
    archived: body.archived === '1',
    visibility: body.visibility === 'private' ? 'private' : 'shared',
    auto_add_new: body.auto_add_new === undefined ? undefined : body.auto_add_new === '1',
  };
  return { form, error: form.title ? undefined : ctx.t('admin.titleRequired') };
}

route('POST', '/admin/lists', (ctx) => {
  const { form, error } = validateList(ctx, ctx.body);
  if (error) return html(ctx.res, views.adminDashboard(ctx, { all: lists.all(ctx.user.id), form, error }), 400);
  const id = lists.create({ ...form, owner_id: ctx.user.id });
  redirect(ctx.res, `/admin/lists/${id}?m=created`);
}, { auth: 'admin' });

function renderAdminList(ctx, list, extra = {}, status = 200) {
  html(ctx.res, views.adminListPage(ctx, {
    list,
    allItems: items.forList(list.id),
    allGuests: guests.forList(list.id),
    baseUrl: baseUrl(ctx.req),
    adminNames: adminNames(),
    sourceOwner: list.source_wishlist_id ? (wishlists.get(list.source_wishlist_id)?.owner_name ?? '') : '',
    ...extra,
  }), status);
}

/** A list this admin may see (private lists of others and lists from their own wishlist are 404). */
function loadList(ctx) {
  const list = lists.visible(ctx.user.id, Number(ctx.params.id));
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
  lists.update(list.id, form, ctx.user.id);
  redirect(ctx.res, `/admin/lists/${list.id}?m=saved`);
}, { auth: 'admin' });

route('POST', '/admin/lists/:id/new-link', (ctx) => {
  const list = loadList(ctx); // only lists this admin can see (was missing before 3.4)
  if (!list) return;
  lists.regenerateToken(list.id);
  redirect(ctx.res, `/admin/lists/${list.id}?m=newLink`);
}, { auth: 'admin' });

// Drag and drop: the full new order of the list's gifts ("order=3,1,2").
route('POST', '/admin/lists/:id/order', (ctx) => {
  const list = loadList(ctx);
  if (!list) return;
  const ok = items.setOrder(list.id, String(ctx.body.order || '').split(',').filter(Boolean));
  send(ctx.res, ok ? 204 : 400, '');
}, { auth: 'admin' });

route('POST', '/admin/lists/:id/delete', (ctx) => {
  const list = loadList(ctx); // only lists this admin can see (was missing before 3.4)
  if (!list) return;
  lists.delete(list.id);
  sweepImages(allImageFiles());
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
  releaseImage(old);
  return true;
}

function loadItem(ctx) {
  const item = items.get(Number(ctx.params.id));
  if (!item || !lists.canSee(ctx.user.id, item.list_id)) {
    notFound(ctx);
    return null;
  }
  return item;
}

const itemPageData = (item) => ({ item, list: lists.get(item.list_id), allGuests: guests.forList(item.list_id), adminNames: adminNames() });

route('GET', '/admin/items/:id', (ctx) => {
  const item = loadItem(ctx);
  if (item) html(ctx.res, views.adminItemPage(ctx, itemPageData(item)));
}, { auth: 'admin' });

route('POST', '/admin/items/:id', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  // Saving never touches the reservation: the form may be older than a guest's pick or a release.
  // Reserve, reassign and release are their own actions (below).
  // Linked to a wishlist: name/link/image come from the wishlist; only this list's notes change here.
  if (item.wishlist_item_id) {
    items.setListNotes(item.id, cleanMultiline(ctx.body.notes, 1000));
    return redirect(ctx.res, `/admin/lists/${item.list_id}?m=saved#item-${item.id}`);
  }
  const { form, error } = validateItem(ctx, ctx.body);
  if (error) return html(ctx.res, views.adminItemPage(ctx, { ...itemPageData(item), form, error }), 400);
  if (form.remove_image) form.image_source = '';
  items.update(item.id, form);
  const uploaded = applyUpload(item.id, ctx.body.image_data);
  if (!uploaded && form.remove_image) clearPreview(item.id);
  if (!uploaded && form.image_source && form.image_source !== item.image_source) {
    enqueuePreview(item.id, { force: true }); // a new image link replaces an uploaded photo
  } else if (form.url !== item.url) {
    enqueuePreview(item.id); // new link: new price (and image, unless one was uploaded)
  }
  redirect(ctx.res, `/admin/lists/${item.list_id}?m=saved`);
}, { auth: 'admin' });

// Linked items: hide in this list only / approve or ignore items new in the wishlist.
route('POST', '/admin/items/:id/hide', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  items.setHidden(item.id, ctx.body.hidden === '1');
  redirect(ctx.res, `/admin/lists/${item.list_id}#item-${item.id}`);
}, { auth: 'admin' });

route('POST', '/admin/items/:id/approve', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  items.approve(item.id);
  redirect(ctx.res, `/admin/lists/${item.list_id}#item-${item.id}`);
}, { auth: 'admin' });

route('POST', '/admin/items/:id/ignore', (ctx) => {
  const item = loadItem(ctx);
  if (!item || !item.pending) return item ? redirect(ctx.res, `/admin/lists/${item.list_id}`) : undefined;
  items.delete(item.id);
  redirect(ctx.res, `/admin/lists/${item.list_id}`);
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
  const kind = ctx.url.searchParams.get('kind');
  const isGift = kind === 'gift';
  for (const id of ids) {
    // Only report what this admin may see.
    let it;
    if (kind === 'wish') {
      it = wishItems.get(id);
      const w = it && wishlists.get(it.wishlist_id);
      if (!w || (w.owner_id !== ctx.user.id && !wishlists.viewableByOther(ctx.user.id, w))) continue;
    } else {
      it = isGift ? givingGifts.get(ctx.user.id, id) : items.get(id);
      if (it && !isGift && !lists.canSee(ctx.user.id, it.list_id)) continue;
    }
    if (it) out[id] = { status: it.preview_status, image: it.image_file ? `/img/${it.image_file}` : null };
  }
  send(ctx.res, 200, JSON.stringify(out), { 'Content-Type': 'application/json' });
}, { auth: 'admin' });

route('POST', '/admin/items/:id/delete', (ctx) => {
  const item = loadItem(ctx);
  if (!item) return;
  items.delete(item.id);
  releaseImage(item.image_file);
  redirect(ctx.res, `/admin/lists/${item.list_id}?m=deleted`);
}, { auth: 'admin' });

/** Tell the other admins that `ctx.user` reserved a gift for a guest. */
function notifyAdminReservation(ctx, itemId, guest) {
  const item = items.get(itemId);
  notify('pick', { list: lists.get(item.list_id), guest, item, byUser: ctx.user }, { exceptUserId: ctx.user.id });
}

/**
 * Reserve/reassign/release act only on the reservation the admin's page showed (`expect`, see
 * views.reservationKey; missing = "free"). A page opened before a guest picked or gave it up
 * gets a "changed meanwhile" message instead of overriding the guest.
 */
function reservationStillAsShown(ctx, item) {
  if (views.reservationKey(item) === String(ctx.body.expect || 'free')) return true;
  redirect(ctx.res, `/admin/lists/${item.list_id}?m=reservationChanged#item-${item.id}`);
  return false;
}

// Reserve on behalf of a guest (by name), or reassign to someone else. They see it in their
// picks when they open the list.
route('POST', '/admin/items/:id/reserve', (ctx) => {
  const item = loadItem(ctx);
  if (!item || !reservationStillAsShown(ctx, item)) return;
  const name = clean(ctx.body.name, 60);
  if (!name) return redirect(ctx.res, `/admin/lists/${item.list_id}#item-${item.id}`);
  const guest = items.reserveForGuest(item.id, name, ctx.user.id);
  if (guest) notifyAdminReservation(ctx, item.id, guest);
  redirect(ctx.res, `/admin/lists/${item.list_id}?m=reservedFor#item-${item.id}`);
}, { auth: 'admin' });

route('POST', '/admin/items/:id/release', (ctx) => {
  const item = loadItem(ctx);
  if (!item || !reservationStillAsShown(ctx, item)) return;
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
  if (!guest || !lists.canSee(ctx.user.id, guest.list_id)) return notFound(ctx);
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

  const cookies = parseCookies(req.headers.cookie);

  // Stored images (shop photos and uploads): only for whoever may see a record showing them
  // (else 404, as if they didn't exist). Revalidated on every use, so losing access is immediate;
  // the file name never changes, so it doubles as the ETag and a revalidation costs a 304.
  if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/img/')) {
    const file = path.slice(5);
    if (IMAGE_FILE_RE.test(file) && canSeeImage(cookies, file)) {
      const etag = `"${file}"`;
      const headers = { 'Cache-Control': 'private, no-cache', ETag: etag };
      if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
      try {
        const body = await readFile(join(IMAGE_DIR, file));
        return send(res, 200, body, { 'Content-Type': IMAGE_TYPES[file.split('.').pop()], ...headers });
      } catch { /* fall through to 404 */ }
    }
  }

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
  ctx.user = sessions.user(ctx.cookies[SESSION_COOKIE]);
  ctx.isAdmin = !!ctx.user;

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
  if (r.auth === 'admin' || path.startsWith('/admin')) sessionCookie = ctx.cookies[SESSION_COOKIE] || '';
  else sessionCookie = ctx.cookies[GUEST_COOKIE] || '';

  if (r.auth === 'admin' && !ctx.isAdmin) return redirect(res, '/admin');
  // REQUIRE_2FA: logged-in admins without two-factor can only set it up (or log out).
  if (config.require2fa && ctx.user && !ctx.user.totp_secret && path.startsWith('/admin')
      && !path.startsWith('/admin/profile/2fa') && path !== '/admin/logout') {
    return redirect(res, '/admin/profile/2fa?required=1');
  }
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

registerGivingRoutes({ route, html, redirect, notFound, clean, cleanMultiline, cleanUrl });
registerWishlistRoutes({ route, html, redirect, notFound, clean, cleanMultiline, cleanUrl });

await bootstrapAccounts();
convertLegacyIdeas();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, 'Error', { 'Content-Type': 'text/plain' });
    else res.end();
  });
});

// Last line of defence: a bug in a background job must never take the site down silently.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, exiting (Docker restarts Giftly):', err);
  process.exit(1);
});

server.listen({ port: config.port, host: config.host }, () => {
  startPreviewQueue();
  startReminders();
  const { address, port } = server.address();
  console.log(`giftly listening on ${address}:${port} (lang=${config.lang}, data=${config.dataDir})`);
  if (!process.env.BASE_URL) {
    console.warn('BASE_URL is not set: invite, reset and notification links use the address each request came in on. '
      + 'Set BASE_URL=https://your.domain when Giftly is reachable from the internet.');
  }
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
