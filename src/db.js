import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';
import { migrate } from './migrations.js';

export const db = new DatabaseSync(join(config.dataDir, 'giftly.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

migrate(db);

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
 * PERSON PRIVACY RULE (the only place it lives): person row `alias` is visible to admin $uid when
 * it is shared or theirs, AND it isn't $uid's own record (a person linked to that admin): what the
 * others plan for an admin never reaches them, shared or not. Gifts, occasions, checklists, totals
 * and reminders are all built on it (giving.js).
 */
export const PERSON_VISIBLE = (alias) => `((${alias}.visibility = 'shared' OR ${alias}.owner_id = $uid)
  AND (${alias}.user_id IS NULL OR ${alias}.user_id != $uid))`;

/**
 * LIST PRIVACY RULE (the only place it lives): an admin ($uid) sees a list when it is shared
 * or theirs, AND it isn't a list made *for* them (from gift ideas for them), AND it contains
 * nothing from their own wishlist or the ideas kept for them — such lists would reveal what was
 * reserved for them — AND nothing from another admin's private ideas.
 */
export const LIST_VISIBLE = `((l.visibility = 'shared' OR l.owner_id = $uid)
  AND (l.recipient_user_id IS NULL OR l.recipient_user_id != $uid)
  AND NOT EXISTS (SELECT 1 FROM wishlists w WHERE (
        (w.kind = 'own' AND w.owner_id = $uid)
     OR (w.kind = 'ideas' AND w.person_id IN (SELECT pp.id FROM people pp WHERE pp.user_id = $uid))
     OR (w.kind = 'ideas' AND w.owner_id IS NOT NULL AND w.owner_id != $uid)) AND (
        w.id = l.source_wishlist_id
     OR EXISTS (SELECT 1 FROM list_sources ls WHERE ls.list_id = l.id AND ls.wishlist_id = w.id)
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
  create({ title, description, owner_id = null, visibility = 'shared', source_wishlist_id = null, auto_add_new = true, recipient_user_id = null, ask_buyer = false }) {
    const id = Number(db.prepare(
      `INSERT INTO lists (title, description, token, owner_id, visibility, source_wishlist_id, auto_add_new, recipient_user_id, ask_buyer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(title, description, newToken(), owner_id, visibility, source_wishlist_id, auto_add_new ? 1 : 0, recipient_user_id, ask_buyer ? 1 : 0, now()).lastInsertRowid);
    if (source_wishlist_id) db.prepare('INSERT OR IGNORE INTO list_sources (list_id, wishlist_id) VALUES (?, ?)').run(id, source_wishlist_id);
    return id;
  },
  /**
   * Only the owner changes visibility; an ownerless (pre-3.0) list becomes yours if you make
   * it private. Archiving marks its reserved wishlist items as received.
   */
  update(id, { title, description, archived, visibility, auto_add_new, ask_buyer }, uid) {
    tx(() => {
      const l = lists.get(id);
      let owner = l.owner_id;
      let vis = l.visibility;
      if (visibility && (owner === uid || owner == null)) {
        vis = visibility;
        if (owner == null && visibility === 'private') owner = uid;
      }
      const flag = (v, current) => (v === undefined ? current : (v ? 1 : 0));
      db.prepare('UPDATE lists SET title = ?, description = ?, archived = ?, visibility = ?, owner_id = ?, auto_add_new = ?, ask_buyer = ? WHERE id = ?')
        .run(title, description, archived ? 1 : 0, vis, owner, flag(auto_add_new, l.auto_add_new), flag(ask_buyer, l.ask_buyer), id);
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

/** 128 random bits: what a guest's cookie points to (never reused, unlike row ids). */
const guestToken = () => randomBytes(16).toString('base64url');

export const guests = {
  byName: (listId, name) => db.prepare('SELECT * FROM guests WHERE list_id = ? AND name = ?').get(listId, name) ?? null,
  /** The guest a cookie entry names: by token, and only if it belongs to that list. */
  bySession: (token, listId) => (typeof token === 'string' && token.length >= 20
    ? db.prepare('SELECT * FROM guests WHERE token = ? AND list_id = ?').get(token, listId) ?? null : null),
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
          'INSERT INTO guests (list_id, name, token, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'
        ).run(listId, name, guestToken(), now(), now()).lastInsertRowid);
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
    const id = Number(db.prepare('INSERT INTO guests (list_id, name, token, created_at, last_seen) VALUES (?, ?, ?, ?, 0)')
      .run(listId, name, guestToken(), now()).lastInsertRowid);
    return guests.get(id);
  },
  touch(id) {
    db.prepare('UPDATE guests SET last_seen = ? WHERE id = ?').run(now(), id);
  },
  delete(id) {
    tx(() => {
      db.prepare('DELETE FROM wishlist_claims WHERE item_id IN (SELECT id FROM items WHERE reserved_guest_id = ?)').run(id);
      db.prepare(
        'UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL, reserved_by_user_id = NULL, reserved_buyer = NULL, bought_at = NULL, bought_by_user_id = NULL WHERE reserved_guest_id = ?'
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
const ITEM_COLS = `i.*, wi.status AS wish_status, wi.removed_reason AS wish_removed_reason, wi.wishlist_id AS wish_list_id,
  (wc.wishlist_item_id IS NOT NULL AND (wc.item_id IS NULL OR wc.item_id != i.id)) AS claimed_elsewhere,
  EXISTS (SELECT 1 FROM list_item_overrides ov WHERE ov.item_id = i.id) AS overridden`;
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
  /**
   * An admin reserves (or re-assigns) a gift on behalf of a guest named `name`. The guest is
   * found or created in that list, so the gift shows in their picks when they open the list.
   * Returns the guest, or null if nothing changed / the item doesn't exist.
   */
  reserveForGuest(id, name, userId, buyer = null) {
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
      db.prepare('UPDATE items SET reserved_guest_id = ?, reserved_name = ?, reserved_at = ?, reserved_by_user_id = ?, reserved_buyer = ?, bought_at = NULL, bought_by_user_id = NULL WHERE id = ?')
        .run(guest.id, guest.name, now(), userId ?? null, buyer, id);
      return guest;
    });
  },
  /** Atomic: only succeeds if nobody else got there first. */
  reserve(id, guest, buyer = null) {
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
        'UPDATE items SET reserved_guest_id = ?, reserved_name = ?, reserved_at = ?, reserved_by_user_id = NULL, reserved_buyer = ?, bought_at = NULL, bought_by_user_id = NULL WHERE id = ? AND reserved_name IS NULL'
      ).run(guest.id, guest.name, now(), buyer, id).changes === 1;
    });
  },
  /** A guest gives up a gift — not once the managers bought it for them (an admin can still release it). */
  unreserve(id, guest) {
    db.prepare('DELETE FROM wishlist_claims WHERE item_id = ? AND item_id IN (SELECT id FROM items WHERE reserved_guest_id = ? AND bought_at IS NULL)').run(id, guest.id);
    const r = db.prepare(
      'UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL, reserved_by_user_id = NULL, reserved_buyer = NULL, bought_at = NULL, bought_by_user_id = NULL WHERE id = ? AND reserved_guest_id = ? AND bought_at IS NULL'
    ).run(id, guest.id);
    return r.changes === 1;
  },
  /**
   * Who buys a reserved gift ('guest': the guest does; 'us': the list's managers). With a guest,
   * only a gift they hold; without (an admin's page), any reserved gift. Never once it was bought.
   */
  setBuyer(id, guest, buyer) {
    return (guest
      ? db.prepare('UPDATE items SET reserved_buyer = ? WHERE id = ? AND reserved_guest_id = ? AND bought_at IS NULL').run(buyer, id, guest.id)
      : db.prepare('UPDATE items SET reserved_buyer = ? WHERE id = ? AND reserved_name IS NOT NULL AND bought_at IS NULL').run(buyer, id)).changes === 1;
  },
  /** An admin marks a gift they were asked to buy as bought (userId), or not bought yet (null). */
  setBought(id, userId) {
    return db.prepare(`UPDATE items SET bought_at = ?, bought_by_user_id = ?
      WHERE id = ? AND reserved_name IS NOT NULL AND reserved_buyer = 'us'`).run(userId ? now() : null, userId ?? null, id).changes === 1;
  },
  release(id) {
    db.prepare('DELETE FROM wishlist_claims WHERE item_id = ?').run(id);
    db.prepare('UPDATE items SET reserved_guest_id = NULL, reserved_name = NULL, reserved_at = NULL, reserved_by_user_id = NULL, reserved_buyer = NULL, bought_at = NULL, bought_by_user_id = NULL WHERE id = ?').run(id);
  },
  delete(id) {
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  },
  /** Drag and drop: `ids` in their new order (must be exactly this list's non-pending items). */
  setOrder(listId, ids) {
    return tx(() => {
      const current = db.prepare('SELECT id FROM items WHERE list_id = ? AND pending = 0').all(listId).map((r) => r.id);
      const wanted = ids.map(Number);
      if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((id) => current.includes(id))) return false;
      const stmt = db.prepare('UPDATE items SET position = ? WHERE id = ?');
      wanted.forEach((id, i) => stmt.run(i + 1, id));
      return true;
    });
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
