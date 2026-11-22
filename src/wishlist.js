// Personal wishlists (one per admin) and lists created from them.
//
// SURPRISE RULE: nothing in this module ever tells a wishlist's OWNER whether an item was
// reserved. Owner-facing functions (`ownerView`, `remove`, …) don't read claims at all and
// behave identically either way. Claim state is only exposed to *other* admins
// (`othersView`), and lists made from a wishlist are hidden from its owner by LIST_VISIBLE.
import { db, tx, lists, LIST_VISIBLE } from './db.js';
import { users } from './accounts.js';

const now = () => Date.now();
export const WISHLIST_VISIBILITIES = ['admins', 'private'];
export const REMOVE_REASONS = ['bought', 'unwanted', 'received'];

// ---------- wishlists ----------

export const wishlists = {
  /** The admin's own wishlist (created on first use). */
  ofUser(uid) {
    let w = db.prepare('SELECT * FROM wishlists WHERE owner_id = ?').get(uid);
    if (!w) {
      db.prepare('INSERT INTO wishlists (owner_id, created_at) VALUES (?, ?)').run(uid, now());
      w = db.prepare('SELECT * FROM wishlists WHERE owner_id = ?').get(uid);
    }
    return w;
  },
  get: (id) => db.prepare('SELECT w.*, u.name AS owner_name FROM wishlists w JOIN users u ON u.id = w.owner_id WHERE w.id = ?').get(id) ?? null,
  setVisibility(uid, visibility) {
    db.prepare('UPDATE wishlists SET visibility = ? WHERE owner_id = ?').run(visibility, uid);
  },
  /** Can `uid` look at this wishlist as a giver (never its owner)? */
  viewableByOther(uid, w) {
    return !!w && w.owner_id !== uid && w.visibility === 'admins';
  },
  /** Other admins' wishlists `uid` can look at. */
  others(uid) {
    return db.prepare(`SELECT w.*, u.name AS owner_name,
        (SELECT COUNT(*) FROM wishlist_items wi WHERE wi.wishlist_id = w.id AND wi.status = 'active') AS item_count
      FROM wishlists w JOIN users u ON u.id = w.owner_id
      WHERE w.owner_id != ? AND w.visibility = 'admins' ORDER BY u.name COLLATE NOCASE`).all(uid);
  },
  byOwner: (uid) => db.prepare('SELECT * FROM wishlists WHERE owner_id = ?').get(uid) ?? null,
};

// ---------- wishlist items ----------

export const wishItems = {
  get: (id) => db.prepare('SELECT * FROM wishlist_items WHERE id = ?').get(id) ?? null,

  /** OWNER view: active items and history. Deliberately claim-blind. */
  ownerView(wishlistId) {
    return {
      active: db.prepare("SELECT * FROM wishlist_items WHERE wishlist_id = ? AND status = 'active' ORDER BY position, id").all(wishlistId),
      history: db.prepare("SELECT * FROM wishlist_items WHERE wishlist_id = ? AND status != 'active' ORDER BY removed_at DESC LIMIT 100").all(wishlistId),
    };
  },

  /** Other admins' view: active items with whether they're taken, and whether by the viewer's gift. */
  othersView(wishlistId, viewerId) {
    return db.prepare(`SELECT wi.*,
        (c.wishlist_item_id IS NOT NULL) AS claimed,
        g.id AS my_gift_id, g.occasion_id AS my_gift_occasion_id, g.year AS my_gift_year
      FROM wishlist_items wi
      LEFT JOIN wishlist_claims c ON c.wishlist_item_id = wi.id
      LEFT JOIN gifts g ON g.id = c.gift_id AND g.owner_id = ?
      WHERE wi.wishlist_id = ? AND wi.status = 'active' ORDER BY wi.position, wi.id`).all(viewerId, wishlistId);
  },

  create(wishlistId, { title, url = '', notes = '', image_source = '' }) {
    return tx(() => {
      const { p } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM wishlist_items WHERE wishlist_id = ?').get(wishlistId);
      const t = now();
      const id = Number(db.prepare(`INSERT INTO wishlist_items (wishlist_id, title, url, notes, image_source, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(wishlistId, title, url, notes, image_source, p, t, t).lastInsertRowid);
      addToLinkedLists(id);
      return id;
    });
  },

  /** Edit (owner). A new link drops the old shop price. Linked list items follow. */
  update(id, { title, url = '', notes = '', image_source }) {
    const wi = wishItems.get(id);
    if (!wi) return;
    const linkChanged = url !== wi.url;
    db.prepare(`UPDATE wishlist_items SET title = ?, url = ?, notes = ?, image_source = ?, updated_at = ?,
        price = CASE WHEN ? THEN '' ELSE price END, price_cents = CASE WHEN ? THEN NULL ELSE price_cents END,
        price_checked_at = CASE WHEN ? THEN NULL ELSE price_checked_at END
      WHERE id = ?`).run(title, url, notes, image_source ?? wi.image_source, now(), linkChanged ? 1 : 0, linkChanged ? 1 : 0, linkChanged ? 1 : 0, id);
    syncLinked(id);
  },

  move(id, dir) {
    tx(() => {
      const wi = wishItems.get(id);
      if (!wi) return;
      const all = db.prepare("SELECT id FROM wishlist_items WHERE wishlist_id = ? AND status = 'active' ORDER BY position, id").all(wi.wishlist_id);
      const idx = all.findIndex((x) => x.id === id);
      const swap = idx + (dir === 'up' ? -1 : 1);
      if (idx < 0 || swap < 0 || swap >= all.length) return;
      [all[idx], all[swap]] = [all[swap], all[idx]];
      const stmt = db.prepare('UPDATE wishlist_items SET position = ? WHERE id = ?');
      all.forEach((x, i) => stmt.run(i + 1, x.id));
    });
  },

  /**
   * The owner removes an item (bought / unwanted / received). Same effect and same answer
   * whether it was reserved or not. Returns who must be told (computed here, sent by the
   * caller in the background): organisers of lists where a guest reserved it, or the admin
   * giving it — never the owner.
   */
  remove(id, reason) {
    return tx(() => {
      db.prepare('UPDATE wishlist_items SET status = ?, removed_reason = ?, removed_at = ?, updated_at = ? WHERE id = ?')
        .run(reason === 'received' ? 'received' : 'removed', reason, now(), now(), id);
      return claimWatchers(id);
    });
  },

  /** Back on the active wishlist (e.g. removed by mistake). */
  restore(id) {
    db.prepare("UPDATE wishlist_items SET status = 'active', removed_reason = NULL, removed_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  },

  markReceived(id) {
    db.prepare("UPDATE wishlist_items SET status = 'received', removed_reason = 'received', removed_at = ? WHERE id = ? AND status = 'active'").run(now(), id);
  },

  // ----- preview queue (images, shop prices) -----
  setPreview(id, fields) {
    const allowed = ['image_file', 'preview_status', 'title', 'price', 'price_cents', 'price_currency', 'price_checked_at'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k) && fields[k] !== undefined);
    if (keys.length) {
      db.prepare(`UPDATE wishlist_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
      syncLinked(id);
    }
  },
  pendingPreviews: () => db.prepare("SELECT id FROM wishlist_items WHERE preview_status = 'pending'").all().map((r) => r.id),
  allImageFiles: () => db.prepare('SELECT image_file FROM wishlist_items WHERE image_file IS NOT NULL').all().map((r) => r.image_file),
  stalePrices(olderThan, limit) {
    return db.prepare(`SELECT id FROM wishlist_items WHERE url != '' AND status = 'active' AND preview_status != 'pending'
      AND COALESCE(price_checked_at, 0) < ? ORDER BY COALESCE(price_checked_at, 0) LIMIT ?`).all(olderThan, limit).map((r) => r.id);
  },
};

/** Who to tell when a reserved wishlist item is removed: [{ userId, listId?, giftId? }]. */
function claimWatchers(wishItemId) {
  const c = db.prepare('SELECT * FROM wishlist_claims WHERE wishlist_item_id = ?').get(wishItemId);
  if (!c) return [];
  if (c.gift_id) {
    const g = db.prepare('SELECT id, owner_id FROM gifts WHERE id = ?').get(c.gift_id);
    return g?.owner_id ? [{ userId: g.owner_id, giftId: g.id }] : [];
  }
  const it = db.prepare('SELECT i.id, i.list_id, l.owner_id FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = ?').get(c.item_id);
  return it?.owner_id ? [{ userId: it.owner_id, listId: it.list_id }] : [];
}

// ---------- links between wishlist items and list items ----------

/** Copy a wishlist item's shown data onto every list item linked to it. */
export function syncLinked(wishItemId) {
  const wi = wishItems.get(wishItemId);
  if (!wi) return;
  db.prepare(`UPDATE items SET title = ?, url = ?, wish_notes = ?, price = ?, image_file = ?, preview_status = '',
      price_checked_at = ? WHERE wishlist_item_id = ?`)
    .run(wi.title, wi.url, wi.notes, wi.price, wi.image_file, wi.price_checked_at, wishItemId);
}

function insertLinked(listId, wi, { pending = false } = {}) {
  const { p } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM items WHERE list_id = ?').get(listId);
  return Number(db.prepare(`INSERT INTO items (list_id, title, url, notes, wish_notes, price, image_file, position,
      wishlist_item_id, pending, created_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`)
    .run(listId, wi.title, wi.url, wi.notes, wi.price, wi.image_file, p, wi.id, pending ? 1 : 0, now()).lastInsertRowid);
}

/** A new wishlist item joins every list made from that wishlist (or waits for approval). */
function addToLinkedLists(wishItemId) {
  const wi = wishItems.get(wishItemId);
  for (const l of db.prepare('SELECT id, auto_add_new FROM lists WHERE source_wishlist_id = ? AND archived = 0').all(wi.wishlist_id)) {
    insertLinked(l.id, wi, { pending: !l.auto_add_new });
  }
}

/**
 * Create a guest list from another admin's wishlist, with the chosen items in wishlist order.
 * Returns the new list id, or null if not allowed (own wishlist, or not visible).
 */
export function createListFromWishlist(uid, wishlistId, { title, description = '', visibility = 'private', auto_add_new = true, itemIds = null }) {
  const w = wishlists.get(wishlistId);
  if (!wishlists.viewableByOther(uid, w)) return null; // never from your own wishlist (you could never see it)
  return tx(() => {
    const id = lists.create({ title, description, owner_id: uid, visibility, source_wishlist_id: w.id, auto_add_new });
    const chosen = itemIds ? new Set(itemIds.map(Number)) : null;
    for (const wi of db.prepare("SELECT * FROM wishlist_items WHERE wishlist_id = ? AND status = 'active' ORDER BY position, id").all(w.id)) {
      if (!chosen || chosen.has(wi.id)) insertLinked(id, wi);
    }
    return id;
  });
}

/** "I'll give it": reserve a wishlist item for a gift (one claim per item, across everything). */
export function claimForGift(wishItemId, giftId) {
  return db.prepare('INSERT OR IGNORE INTO wishlist_claims (wishlist_item_id, gift_id, created_at) VALUES (?, ?, ?)')
    .run(wishItemId, giftId, now()).changes === 1;
}

/** A user's display name (for notifications). */
export const ownerName = (w) => users.get(w.owner_id)?.name ?? '';

export { LIST_VISIBLE };
