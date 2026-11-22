import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, 'giftly.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Migrations, indexed by PRAGMA user_version.
const migrations = [
  `
  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL UNIQUE,
    epoch INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    UNIQUE (list_id, name)
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    reserved_guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    reserved_name TEXT,
    reserved_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX items_list ON items(list_id, position);
  CREATE INDEX guests_list ON guests(list_id);
  `,
  // v2: link previews
  `
  ALTER TABLE items ADD COLUMN image_file TEXT;
  ALTER TABLE items ADD COLUMN image_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE items ADD COLUMN preview_status TEXT NOT NULL DEFAULT '';
  `,
  // v3: prices come only from the shop link and are re-checked daily
  `
  ALTER TABLE items ADD COLUMN price_checked_at INTEGER;
  UPDATE items SET price = '' WHERE url = '';
  `,
  // v4: settings edited in the admin (notifications, ...)
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // v5: anonymous lists (the admin sees that a gift is reserved, not by whom)
  `
  ALTER TABLE lists ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;
  `,
  // v6: user accounts (replace the single ADMIN_PASSWORD), per-user notifications;
  // anonymous lists were dropped (all admins see who reserved what).
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    notify_events TEXT NOT NULL DEFAULT 'pick,unpick',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  -- Invites create a new account; with user_id set, the token is a password reset for that user.
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE notification_channels (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, type)
  );
  ALTER TABLE lists DROP COLUMN anonymous;
  `,
  // v7: "Gifts to give" — people, occasions (birthdays are virtual, from people.birthday_*)
  // and the gifts admins plan to give. Every row is 'shared' (all admins) or 'private' (owner only).
  `
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    birthday_month INTEGER,
    birthday_day INTEGER,
    birth_year INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    gives_christmas INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE occasions (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('christmas', 'custom')),
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE occasion_people (
    occasion_id INTEGER NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (occasion_id, person_id)
  );
  CREATE TABLE gifts (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    occasion_id INTEGER REFERENCES occasions(id) ON DELETE CASCADE, -- NULL: the person's birthday in \`year\`
    year INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'bought', 'given')),
    price_cents INTEGER,
    price_currency TEXT,
    price_source TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    image_file TEXT,
    image_source TEXT NOT NULL DEFAULT '',
    preview_status TEXT NOT NULL DEFAULT '',
    price_checked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX gifts_person ON gifts(person_id, year);
  CREATE INDEX gifts_occasion ON gifts(occasion_id);
  `,
  // v8: reminders. Each user picks how many days before (empty = off); every reminder is
  // sent at most once per (user, occasion, threshold).
  `
  ALTER TABLE users ADD COLUMN reminder_days TEXT NOT NULL DEFAULT '14,3';
  CREATE TABLE reminder_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    days_before INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key, days_before)
  );
  `,
];

{
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let v = version; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function tx(fn) {
  // Reentrant: inside an open transaction, just run (the outer one commits or rolls back).
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const now = () => Date.now();
// 16 random bytes → 22 url-safe chars; unguessable, short enough to paste in a message.
const newToken = () => randomBytes(16).toString('base64url');

// ---------- settings ----------

export const settings = {
  /** All settings whose key starts with `prefix`, returned without the prefix. */
  all(prefix = '') {
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`${prefix}%`)) {
      out[r.key.slice(prefix.length)] = r.value;
    }
    return out;
  },
  setMany(obj) {
    tx(() => {
      const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(obj)) stmt.run(k, String(v));
    });
  },
};

// ---------- lists ----------

export const lists = {
  all() {
    return db.prepare(`
      SELECT l.*,
        (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id) AS item_count,
        (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.reserved_name IS NOT NULL) AS reserved_count,
        (SELECT COUNT(*) FROM guests g WHERE g.list_id = l.id) AS guest_count
      FROM lists l ORDER BY l.archived, l.created_at DESC`).all();
  },
  get(id) {
    return db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  },
  byToken(token) {
    return db.prepare('SELECT * FROM lists WHERE token = ?').get(token);
  },
  create({ title, description }) {
    return Number(db.prepare(
      'INSERT INTO lists (title, description, token, created_at) VALUES (?, ?, ?, ?)'
    ).run(title, description, newToken(), now()).lastInsertRowid);
  },
  update(id, { title, description, archived }) {
    db.prepare('UPDATE lists SET title = ?, description = ?, archived = ? WHERE id = ?')
      .run(title, description, archived ? 1 : 0, id);
  },
  /** New secret link: the old one stops working and everyone is logged out of this list. */
  regenerateToken(id) {
    db.prepare('UPDATE lists SET token = ?, epoch = epoch + 1 WHERE id = ?').run(newToken(), id);
  },
  delete(id) {
    db.prepare('DELETE FROM lists WHERE id = ?').run(id);
  },
};

// ---------- guests ----------

export const guests = {
  get(id) {
    return db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  },
  forList(listId) {
    return db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM items i WHERE i.reserved_guest_id = g.id) AS pick_count
      FROM guests g WHERE g.list_id = ? ORDER BY g.last_seen DESC`).all(listId);
  },
  findOrCreate(listId, name) {
    return tx(() => {
      const existing = db.prepare('SELECT * FROM guests WHERE list_id = ? AND name = ?').get(listId, name);
      if (existing) {
        db.prepare('UPDATE guests SET last_seen = ? WHERE id = ?').run(now(), existing.id);
        return { ...existing, isNew: false };
      }
      const id = Number(db.prepare(
        'INSERT INTO guests (list_id, name, created_at, last_seen) VALUES (?, ?, ?, ?)'
      ).run(listId, name, now(), now()).lastInsertRowid);
      return { ...guests.get(id), isNew: true };
    });
  },
  touch(id) {
    db.prepare('UPDATE guests SET last_seen = ? WHERE id = ?').run(now(), id);
  },
  delete(id) {
    tx(() => {
      db.prepare(
        'UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL WHERE reserved_guest_id = ?'
      ).run(id);
      db.prepare('DELETE FROM guests WHERE id = ?').run(id);
    });
  },
};

// ---------- items ----------

export const items = {
  get(id) {
    return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  },
  forList(listId) {
    return db.prepare('SELECT * FROM items WHERE list_id = ? ORDER BY position, id').all(listId);
  },
  available(listId) {
    return db.prepare(
      'SELECT * FROM items WHERE list_id = ? AND reserved_name IS NULL ORDER BY position, id'
    ).all(listId);
  },
  reservedBy(guestId) {
    return db.prepare('SELECT * FROM items WHERE reserved_guest_id = ? ORDER BY reserved_at').all(guestId);
  },
  reservedByOthers(listId, guestId) {
    return db.prepare(
      'SELECT COUNT(*) AS n FROM items WHERE list_id = ? AND reserved_name IS NOT NULL AND (reserved_guest_id IS NULL OR reserved_guest_id != ?)'
    ).get(listId, guestId).n;
  },
  create(listId, { title, url, notes, image_source = '' }) {
    const { p } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM items WHERE list_id = ?').get(listId);
    return Number(db.prepare(
      'INSERT INTO items (list_id, title, url, notes, image_source, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(listId, title, url, notes, image_source, p, now()).lastInsertRowid);
  },
  /** Price is not editable: it only comes from the shop link, and is dropped when the link changes. */
  update(id, { title, url, notes, image_source = '' }) {
    db.prepare(`UPDATE items SET title = ?, notes = ?, image_source = ?,
        price = CASE WHEN url = ? THEN price ELSE '' END,
        price_checked_at = CASE WHEN url = ? THEN price_checked_at ELSE NULL END,
        url = ? WHERE id = ?`)
      .run(title, notes, image_source, url, url, url, id);
  },
  stalePrices(olderThan, limit) {
    return db.prepare(`
      SELECT i.id FROM items i JOIN lists l ON l.id = i.list_id
      WHERE i.url != '' AND i.reserved_name IS NULL AND l.archived = 0
        AND i.preview_status != 'pending' AND COALESCE(i.price_checked_at, 0) < ?
      ORDER BY COALESCE(i.price_checked_at, 0) LIMIT ?`).all(olderThan, limit).map((r) => r.id);
  },
  setPreview(id, fields) {
    const keys = Object.keys(fields).filter((k) => ['image_file', 'preview_status', 'title', 'price', 'price_checked_at'].includes(k));
    if (!keys.length) return;
    db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  },
  pendingPreviews() {
    return db.prepare("SELECT id FROM items WHERE preview_status = 'pending'").all().map((r) => r.id);
  },
  allImageFiles() {
    return db.prepare('SELECT image_file FROM items WHERE image_file IS NOT NULL').all().map((r) => r.image_file);
  },
  /** Admin sets/clears the reservation by free-text name (e.g. someone who told you in person). */
  setManualReservation(id, name) {
    const item = items.get(id);
    if (!item) return;
    if (!name) return items.release(id);
    if (item.reserved_name === name) return;
    db.prepare('UPDATE items SET reserved_guest_id = NULL, reserved_name = ?, reserved_at = ? WHERE id = ?')
      .run(name, now(), id);
  },
  /** Atomic: only succeeds if nobody else got there first. */
  reserve(id, guest) {
    const r = db.prepare(
      'UPDATE items SET reserved_guest_id = ?, reserved_name = ?, reserved_at = ? WHERE id = ? AND list_id = ? AND reserved_name IS NULL'
    ).run(guest.id, guest.name, now(), id, guest.list_id);
    return r.changes === 1;
  },
  unreserve(id, guest) {
    const r = db.prepare(
      'UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL WHERE id = ? AND reserved_guest_id = ?'
    ).run(id, guest.id);
    return r.changes === 1;
  },
  release(id) {
    db.prepare('UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL WHERE id = ?').run(id);
  },
  delete(id) {
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  },
  move(id, dir) {
    tx(() => {
      const all = items.forList(items.get(id)?.list_id ?? -1);
      const idx = all.findIndex((i) => i.id === id);
      const swap = idx + (dir === 'up' ? -1 : 1);
      if (idx < 0 || swap < 0 || swap >= all.length) return;
      [all[idx], all[swap]] = [all[swap], all[idx]];
      const stmt = db.prepare('UPDATE items SET position = ? WHERE id = ?');
      all.forEach((it, i) => stmt.run(i + 1, it.id));
    });
  },
};
