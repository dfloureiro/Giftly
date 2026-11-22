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
        return existing;
      }
      const id = Number(db.prepare(
        'INSERT INTO guests (list_id, name, created_at, last_seen) VALUES (?, ?, ?, ?)'
      ).run(listId, name, now(), now()).lastInsertRowid);
      return guests.get(id);
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
  create(listId, { title, url, notes, price }) {
    const { p } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM items WHERE list_id = ?').get(listId);
    return Number(db.prepare(
      'INSERT INTO items (list_id, title, url, notes, price, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(listId, title, url, notes, price, p, now()).lastInsertRowid);
  },
  update(id, { title, url, notes, price }) {
    db.prepare('UPDATE items SET title = ?, url = ?, notes = ?, price = ? WHERE id = ?')
      .run(title, url, notes, price, id);
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
