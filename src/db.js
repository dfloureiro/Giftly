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
  // v9: joint gifts — a gift can be for several people (e.g. a couple at Christmas).
  // gifts.person_id stays as the "main" person; gift_people lists everyone (main included).
  `
  CREATE TABLE gift_people (
    gift_id INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (gift_id, person_id)
  );
  CREATE INDEX gift_people_person ON gift_people(person_id);
  INSERT INTO gift_people (gift_id, person_id) SELECT id, person_id FROM gifts;
  `,
  // v10: admins can reserve a list gift on behalf of a guest. The reservation belongs to that
  // guest (by name, created if needed) so they see it in their picks; we remember which admin
  // made it. Older name-only reservations are linked to an existing guest with that name.
  `
  ALTER TABLE items ADD COLUMN reserved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  UPDATE items SET reserved_guest_id = (
    SELECT g.id FROM guests g WHERE g.list_id = items.list_id AND g.name = items.reserved_name
  ) WHERE reserved_guest_id IS NULL AND reserved_name IS NOT NULL;
  `,
  // v11: optional two-factor authentication (TOTP) per admin, with one-time recovery codes.
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending TEXT;
  ALTER TABLE users ADD COLUMN totp_last_counter INTEGER NOT NULL DEFAULT -1;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';
  `,
  // v12 (3.0): personal wishlists, lists created from them, list owners/privacy, reservations
  // shared across lists for the same wishlist item, and links to "gifts to give".
  `
  CREATE TABLE wishlists (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'admins' CHECK (visibility IN ('admins', 'private')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE wishlist_items (
    id INTEGER PRIMARY KEY,
    wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'received')),
    removed_reason TEXT CHECK (removed_reason IN ('bought', 'unwanted', 'received')),
    removed_at INTEGER,
    image_file TEXT,
    image_source TEXT NOT NULL DEFAULT '',
    preview_status TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT '',
    price_cents INTEGER,
    price_currency TEXT,
    price_checked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX wishlist_items_list ON wishlist_items(wishlist_id, status, position);

  ALTER TABLE lists ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE lists ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
  ALTER TABLE lists ADD COLUMN source_wishlist_id INTEGER REFERENCES wishlists(id) ON DELETE SET NULL;
  ALTER TABLE lists ADD COLUMN auto_add_new INTEGER NOT NULL DEFAULT 1;

  -- A list item can be linked to a wishlist item (its name/link/image/price follow the wishlist).
  ALTER TABLE items ADD COLUMN wishlist_item_id INTEGER REFERENCES wishlist_items(id) ON DELETE SET NULL;
  ALTER TABLE items ADD COLUMN wish_notes TEXT NOT NULL DEFAULT '';
  ALTER TABLE items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;   -- hidden in this list only
  ALTER TABLE items ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;  -- new in the wishlist, waiting for approval
  CREATE INDEX items_wishlist ON items(wishlist_item_id);

  -- At most one reservation per wishlist item, across every list (or a "I'll give it" gift).
  CREATE TABLE wishlist_claims (
    wishlist_item_id INTEGER PRIMARY KEY REFERENCES wishlist_items(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    gift_id INTEGER REFERENCES gifts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  ALTER TABLE gifts ADD COLUMN wishlist_item_id INTEGER REFERENCES wishlist_items(id) ON DELETE SET NULL;
  ALTER TABLE people ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
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

/**
 * LIST PRIVACY RULE (the only place it lives): an admin ($uid) sees a list when it is shared
 * or theirs, AND it contains nothing from their own wishlist (a list made from someone's
 * wishlist must never be visible to that person — it would reveal what was reserved).
 */
export const LIST_VISIBLE = `((l.visibility = 'shared' OR l.owner_id = $uid)
  AND NOT EXISTS (SELECT 1 FROM wishlists w WHERE w.owner_id = $uid AND (
        w.id = l.source_wishlist_id
     OR EXISTS (SELECT 1 FROM items li JOIN wishlist_items lwi ON lwi.id = li.wishlist_item_id
                WHERE li.list_id = l.id AND lwi.wishlist_id = w.id))))`;

export const lists = {
  /** Lists this admin can see, with counters. */
  all(uid) {
    return db.prepare(`
      SELECT l.*,
        (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.pending = 0) AS item_count,
        (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.reserved_name IS NOT NULL) AS reserved_count,
        (SELECT COUNT(*) FROM guests g WHERE g.list_id = l.id) AS guest_count
      FROM lists l WHERE ${LIST_VISIBLE} ORDER BY l.archived, l.created_at DESC`).all({ uid });
  },
  /** Raw access (guest pages, background jobs). Admin pages use `visible()`. */
  get(id) {
    return db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  },
  visible(uid, id) {
    return db.prepare(`SELECT l.* FROM lists l WHERE l.id = $id AND ${LIST_VISIBLE}`).get({ uid, id }) ?? null;
  },
  canSee: (uid, id) => !!lists.visible(uid, id),
  byToken(token) {
    return db.prepare('SELECT * FROM lists WHERE token = ?').get(token);
  },
  create({ title, description, owner_id = null, visibility = 'shared', source_wishlist_id = null, auto_add_new = true }) {
    return Number(db.prepare(
      `INSERT INTO lists (title, description, token, owner_id, visibility, source_wishlist_id, auto_add_new, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(title, description, newToken(), owner_id, visibility, source_wishlist_id, auto_add_new ? 1 : 0, now()).lastInsertRowid);
  },
  /**
   * Only the owner changes visibility; an ownerless (pre-3.0) list becomes yours if you make
   * it private. Archiving marks its reserved wishlist items as received.
   */
  update(id, { title, description, archived, visibility, auto_add_new }, uid) {
    tx(() => {
      const l = lists.get(id);
      let owner = l.owner_id;
      let vis = l.visibility;
      if (visibility && (owner === uid || owner == null)) {
        vis = visibility;
        if (owner == null && visibility === 'private') owner = uid;
      }
      db.prepare('UPDATE lists SET title = ?, description = ?, archived = ?, visibility = ?, owner_id = ?, auto_add_new = ? WHERE id = ?')
        .run(title, description, archived ? 1 : 0, vis, owner, auto_add_new === undefined ? l.auto_add_new : (auto_add_new ? 1 : 0), id);
      if (archived && !l.archived) {
        db.prepare(`UPDATE wishlist_items SET status = 'received', removed_reason = 'received', removed_at = ?
          WHERE status = 'active' AND id IN (SELECT wishlist_item_id FROM items
            WHERE list_id = ? AND wishlist_item_id IS NOT NULL AND reserved_name IS NOT NULL)`).run(now(), id);
      }
    });
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
  /** A guest joining with their name. `isNew` is true on their first real visit. */
  findOrCreate(listId, name) {
    return tx(() => {
      const existing = db.prepare('SELECT * FROM guests WHERE list_id = ? AND name = ?').get(listId, name);
      let guest;
      if (existing) {
        db.prepare('UPDATE guests SET last_seen = ? WHERE id = ?').run(now(), existing.id);
        guest = { ...existing, isNew: existing.last_seen === 0 }; // 0 = created by an admin, never visited
      } else {
        const id = Number(db.prepare(
          'INSERT INTO guests (list_id, name, created_at, last_seen) VALUES (?, ?, ?, ?)'
        ).run(listId, name, now(), now()).lastInsertRowid);
        guest = { ...guests.get(id), isNew: true };
      }
      // Reservations made for this name without a guest (older admin reservations) become theirs.
      db.prepare(`UPDATE items SET reserved_guest_id = ? WHERE list_id = ? AND reserved_guest_id IS NULL
        AND reserved_name = ? COLLATE NOCASE`).run(guest.id, listId, guest.name);
      return guest;
    });
  },
  /** The guest with this name in a list, created (as "never visited") if needed. For admin reservations. */
  placeholder(listId, name) {
    const existing = db.prepare('SELECT * FROM guests WHERE list_id = ? AND name = ?').get(listId, name);
    if (existing) return existing;
    const id = Number(db.prepare('INSERT INTO guests (list_id, name, created_at, last_seen) VALUES (?, ?, ?, 0)')
      .run(listId, name, now()).lastInsertRowid);
    return guests.get(id);
  },
  touch(id) {
    db.prepare('UPDATE guests SET last_seen = ? WHERE id = ?').run(now(), id);
  },
  delete(id) {
    tx(() => {
      db.prepare('DELETE FROM wishlist_claims WHERE item_id IN (SELECT id FROM items WHERE reserved_guest_id = ?)').run(id);
      db.prepare(
        'UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL, reserved_by_user_id = NULL WHERE reserved_guest_id = ?'
      ).run(id);
      db.prepare('DELETE FROM guests WHERE id = ?').run(id);
    });
  },
};

// ---------- items ----------

// Linked items (wishlist_item_id) are only offered while the wishlist item is active and not
// reserved anywhere (in any list, or as an admin's "I'll give it").
const ITEM_JOIN = `LEFT JOIN wishlist_items wi ON wi.id = i.wishlist_item_id
  LEFT JOIN wishlist_claims wc ON wc.wishlist_item_id = i.wishlist_item_id`;
const ITEM_COLS = `i.*, wi.status AS wish_status, wi.removed_reason AS wish_removed_reason,
  (wc.wishlist_item_id IS NOT NULL AND (wc.item_id IS NULL OR wc.item_id != i.id)) AS claimed_elsewhere`;
const GUEST_OFFERABLE = `i.hidden = 0 AND i.pending = 0
  AND (i.wishlist_item_id IS NULL OR (wi.status = 'active' AND wc.wishlist_item_id IS NULL))`;

export const items = {
  get(id) {
    return db.prepare(`SELECT ${ITEM_COLS} FROM items i ${ITEM_JOIN} WHERE i.id = ?`).get(id);
  },
  /** Admin view of a list (includes hidden/pending items and wishlist state). */
  forList(listId) {
    return db.prepare(`SELECT ${ITEM_COLS} FROM items i ${ITEM_JOIN} WHERE i.list_id = ? ORDER BY i.pending, i.position, i.id`).all(listId);
  },
  available(listId) {
    return db.prepare(`SELECT ${ITEM_COLS} FROM items i ${ITEM_JOIN}
      WHERE i.list_id = ? AND i.reserved_name IS NULL AND ${GUEST_OFFERABLE} ORDER BY i.position, i.id`).all(listId);
  },
  /** A guest's picks — kept even if the wishlist item was removed afterwards (with its reason). */
  reservedBy(guestId) {
    return db.prepare(`SELECT ${ITEM_COLS} FROM items i ${ITEM_JOIN} WHERE i.reserved_guest_id = ? ORDER BY i.reserved_at`).all(guestId);
  },
  /** How many gifts guests of this list no longer see because someone (else) has them. */
  takenByOthers(listId, guestId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM items i ${ITEM_JOIN}
      WHERE i.list_id = ? AND i.hidden = 0 AND i.pending = 0
        AND (i.reserved_guest_id IS NULL OR i.reserved_guest_id != ?)
        AND (i.reserved_name IS NOT NULL OR (i.wishlist_item_id IS NOT NULL AND wi.status = 'active' AND wc.wishlist_item_id IS NOT NULL))`)
      .get(listId, guestId).n;
  },
  /** Items a guest of this list could ever see (for the "this list is empty" message). */
  guestVisibleCount(listId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM items i ${ITEM_JOIN} WHERE i.list_id = ? AND i.hidden = 0 AND i.pending = 0
      AND (i.wishlist_item_id IS NULL OR wi.status = 'active' OR i.reserved_name IS NOT NULL)`).get(listId).n;
  },
  setListNotes(id, notes) {
    db.prepare('UPDATE items SET notes = ? WHERE id = ?').run(notes, id);
  },
  setHidden(id, hidden) {
    db.prepare('UPDATE items SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
  },
  approve(id) {
    db.prepare('UPDATE items SET pending = 0 WHERE id = ?').run(id);
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
  /**
   * An admin reserves (or re-assigns) a gift on behalf of a guest named `name`. The guest is
   * found or created in that list, so the gift shows in their picks when they open the list.
   * Returns the guest, or null if nothing changed / the item doesn't exist.
   */
  reserveForGuest(id, name, userId) {
    return tx(() => {
      const item = items.get(id);
      if (!item) return null;
      if (item.claimed_elsewhere) return null; // that wishlist item is already someone's (another list / "I'll give it")
      const guest = guests.placeholder(item.list_id, name);
      if (item.reserved_guest_id === guest.id) return null; // already theirs
      if (item.wishlist_item_id) {
        db.prepare('INSERT OR REPLACE INTO wishlist_claims (wishlist_item_id, item_id, gift_id, created_at) VALUES (?, ?, NULL, ?)')
          .run(item.wishlist_item_id, id, now());
      }
      db.prepare('UPDATE items SET reserved_guest_id = ?, reserved_name = ?, reserved_at = ?, reserved_by_user_id = ? WHERE id = ?')
        .run(guest.id, guest.name, now(), userId ?? null, id);
      return guest;
    });
  },
  /** The edit form's "Reserved by" field: empty releases, a name reserves for that guest. */
  setManualReservation(id, name, userId) {
    if (!name) {
      items.release(id);
      return null;
    }
    return items.reserveForGuest(id, name, userId);
  },
  /** Atomic: only succeeds if nobody else got there first. */
  reserve(id, guest) {
    return tx(() => {
      const item = db.prepare(`SELECT ${ITEM_COLS} FROM items i ${ITEM_JOIN}
        WHERE i.id = ? AND i.list_id = ? AND i.reserved_name IS NULL AND ${GUEST_OFFERABLE}`).get(id, guest.list_id);
      if (!item) return false;
      // Linked item: one reservation per wishlist item across every list (primary key).
      if (item.wishlist_item_id) {
        const claim = db.prepare('INSERT OR IGNORE INTO wishlist_claims (wishlist_item_id, item_id, created_at) VALUES (?, ?, ?)')
          .run(item.wishlist_item_id, id, now());
        if (claim.changes !== 1) return false;
      }
      return db.prepare(
        'UPDATE items SET reserved_guest_id = ?, reserved_name = ?, reserved_at = ?, reserved_by_user_id = NULL WHERE id = ? AND reserved_name IS NULL'
      ).run(guest.id, guest.name, now(), id).changes === 1;
    });
  },
  unreserve(id, guest) {
    db.prepare('DELETE FROM wishlist_claims WHERE item_id = ? AND item_id IN (SELECT id FROM items WHERE reserved_guest_id = ?)').run(id, guest.id);
    const r = db.prepare(
      'UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL, reserved_by_user_id = NULL WHERE id = ? AND reserved_guest_id = ?'
    ).run(id, guest.id);
    return r.changes === 1;
  },
  release(id) {
    db.prepare('DELETE FROM wishlist_claims WHERE item_id = ?').run(id);
    db.prepare('UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL, reserved_by_user_id = NULL WHERE id = ?').run(id);
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
