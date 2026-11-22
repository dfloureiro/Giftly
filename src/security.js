import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

// Admin sessions are random tokens stored in the database (see accounts.js);
// guest sessions are signed cookies.
const guestKey = createHash('sha256').update(config.sessionSecret + '\0guest').digest();

function sign(key, payload) {
  const body = b64(JSON.stringify(payload));
  const mac = b64(createHmac('sha256', key).update(body).digest());
  return `${body}.${mac}`;
}

function verify(key, token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const tokens = {
  signGuest: (p) => sign(guestKey, p),
  verifyGuest: (t) => verify(guestKey, t),
};

/** CSRF token bound to the current session cookie value. */
export function csrfFor(sessionToken) {
  return b64(createHmac('sha256', config.sessionSecret).update('csrf\0' + (sessionToken || '')).digest()).slice(0, 32);
}

export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// ---------- simple in-memory rate limiter ----------

const buckets = new Map();

/** Returns true if the action is allowed. */
export function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) {
    b = { count: 0, reset: t + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return b.count <= max;
}

export function resetRateLimit(key) {
  buckets.delete(key);
}

setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
}, 60_000).unref();
