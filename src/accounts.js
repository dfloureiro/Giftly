// Admin accounts: users, login sessions, invite / password-reset links, password hashing.
//
// Tokens (session cookies, invite and reset links) are random and only their SHA-256
// is stored, so a leaked database does not hand out live sessions or links.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { db, tx } from './db.js';

const scrypt = promisify(scryptCb);
const now = () => Date.now();
const DAY = 86_400_000;

export const SESSION_DAYS = 30;
export const LINK_HOURS = 48;
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const MIN_PASSWORD = 8;

const newToken = () => randomBytes(24).toString('base64url'); // 32 chars
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

export const normalizeUsername = (u) => String(u ?? '').trim().toLowerCase();

// ---------- passwords (scrypt, per-user salt) ----------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Used when the username does not exist, so a failed login takes the same time either way.
let dummyHash;
export async function checkLogin(username, password) {
  const user = users.byUsername(username);
  dummyHash ||= await hashPassword(randomBytes(8).toString('hex'));
  const ok = await verifyPassword(password, user?.password_hash ?? dummyHash);
  return ok && user ? user : null;
}

// ---------- users ----------

export const users = {
  count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  all: () => db.prepare('SELECT * FROM users ORDER BY created_at').all(),
  get: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  byUsername: (u) => db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(u)),
  create({ username, name, passwordHash }) {
    return Number(db.prepare(
      'INSERT INTO users (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(normalizeUsername(username), name, passwordHash, now()).lastInsertRowid);
  },
  updateProfile(id, { username, name }) {
    db.prepare('UPDATE users SET username = ?, name = ? WHERE id = ?').run(normalizeUsername(username), name, id);
  },
  setPassword(id, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  },
  setNotifyEvents(id, events) {
    db.prepare('UPDATE users SET notify_events = ? WHERE id = ?').run(events, id);
  },
  delete: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
};

/** Returns a translation key for an invalid username/name/password, or null. */
export function validateAccount({ username, name, password, confirm }, { exceptUserId = 0, requirePassword = true } = {}) {
  if (username !== undefined) {
    const u = normalizeUsername(username);
    if (!USERNAME_RE.test(u)) return 'account.badUsername';
    const other = users.byUsername(u);
    if (other && other.id !== exceptUserId) return 'account.usernameTaken';
  }
  if (name !== undefined && !String(name).trim()) return 'account.nameRequired';
  if (requirePassword || password) {
    if (String(password ?? '').length < MIN_PASSWORD) return 'account.shortPassword';
    if (confirm !== undefined && password !== confirm) return 'account.passwordMismatch';
  }
  return null;
}

// ---------- sessions ----------

export const sessions = {
  create(userId) {
    const token = newToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, now() + SESSION_DAYS * DAY, now());
    return token;
  },
  /** The user behind a session cookie, or null. */
  user(token) {
    if (!token) return null;
    return db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), now()) ?? null;
  },
  delete: (token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)),
  /** Log a user out everywhere (optionally keeping the current session). */
  deleteForUser(userId, exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptToken ? hashToken(exceptToken) : '');
  },
  purgeExpired: () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()),
};

// ---------- invite and password-reset links ----------

export const links = {
  /** New-account invite (userId null) or password reset for `userId`. Returns the raw token. */
  create({ createdBy = null, userId = null } = {}) {
    const token = newToken();
    tx(() => {
      // Only one live reset link per user.
      if (userId) db.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').run(userId);
      db.prepare('INSERT INTO invites (token_hash, created_by, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(hashToken(token), createdBy, userId, now() + LINK_HOURS * 3600_000, now());
    });
    return token;
  },
  /** A usable link of the given kind ('invite' | 'reset'), or null. */
  find(token, kind) {
    if (!token) return null;
    const row = db.prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(hashToken(token), now());
    if (!row || (kind === 'invite') !== (row.user_id == null)) return null;
    return row;
  },
  /** Mark a link as used; false if someone else used it first. */
  consume(id) {
    return db.prepare('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), id).changes === 1;
  },
  pendingInvites() {
    return db.prepare(`
      SELECT i.*, u.name AS created_by_name FROM invites i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.user_id IS NULL AND i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`).all(now());
  },
  revoke: (id) => db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(id),
  purgeExpired: () => db.prepare('DELETE FROM invites WHERE expires_at <= ? OR used_at IS NOT NULL AND used_at <= ?')
    .run(now() - DAY, now() - 30 * DAY),
};

setInterval(() => { sessions.purgeExpired(); links.purgeExpired(); }, 6 * 3600_000).unref();
