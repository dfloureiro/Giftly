// Personal wishlists (one per admin) and lists created from them.
//
// SURPRISE RULE: nothing in this module ever tells a wishlist's OWNER whether an item was
// reserved. Owner-facing functions (`ownerView`, `remove`, …) don't read claims at all and
// behave identically either way. Claim state is only exposed to *other* admins
// (`othersView`), and lists made from a wishlist are hidden from its owner by LIST_VISIBLE.
import { db, tx, lists, settings, LIST_VISIBLE } from './db.js';
import { users } from './accounts.js';
import { people } from './giving.js';
import { config } from './config.js';

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
  /** owner_name is the admin's name, or the person's name for a person's wishlist. */
  get: (id) => db.prepare(`SELECT w.*, COALESCE(u.name, p.name) AS owner_name, p.user_id AS person_user_id FROM wishlists w
    LEFT JOIN users u ON u.id = w.owner_id LEFT JOIN people p ON p.id = w.person_id WHERE w.id = ?`).get(id) ?? null,
  /** The wishlist of a person in "gifts to give" (created on first use). Admins use their own. */
  ofPerson(personId) {
    let w = db.prepare('SELECT * FROM wishlists WHERE person_id = ?').get(personId);
    if (!w) {
      db.prepare('INSERT INTO wishlists (person_id, created_at) VALUES (?, ?)').run(personId, now());
      w = db.prepare('SELECT * FROM wishlists WHERE person_id = ?').get(personId);
    }
    return wishlists.get(w.id);
  },
  setVisibility(uid, visibility) {
    db.prepare('UPDATE wishlists SET visibility = ? WHERE owner_id = ?').run(visibility, uid);
  },
  /**
   * Can `uid` look at this wishlist as a giver (with what's reserved)? Never its owner.
   * A person's wishlist: whoever can see that person (unless the person is `uid` themselves).
   */
  viewableByOther(uid, w) {
    if (!w) return false;
    if (w.person_id) {
      const p = people.get(uid, w.person_id);
      return !!p && p.user_id !== uid;
    }
    return w.owner_id !== uid && w.visibility === 'admins';
  },
  /** Who may add, edit, reorder and remove items: the owner, or anyone who sees the person. */
  canEdit(uid, w) {
    if (!w) return false;
    if (w.person_id) return wishlists.viewableByOther(uid, w);
    return w.owner_id === uid;
  },
  /** Other admins' wishlists `uid` can look at. */
  others(uid) {
    return db.prepare(`SELECT w.*, u.name AS owner_name,
        (SELECT COUNT(*) FROM wishlist_items wi WHERE wi.wishlist_id = w.id AND wi.status = 'active') AS item_count
      FROM wishlists w JOIN users u ON u.id = w.owner_id
      WHERE w.owner_id IS NOT NULL AND w.owner_id != ? AND w.visibility = 'admins' ORDER BY u.name COLLATE NOCASE`).all(uid);
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

  /** Drag and drop: `ids` in their new order (must be exactly the active items). */
  setOrder(wishlistId, ids) {
    return tx(() => {
      const current = db.prepare("SELECT id FROM wishlist_items WHERE wishlist_id = ? AND status = 'active'").all(wishlistId).map((r) => r.id);
      const wanted = ids.map(Number);
      if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((id) => current.includes(id))) return false;
      const stmt = db.prepare('UPDATE wishlist_items SET position = ? WHERE id = ?');
      wanted.forEach((id, i) => stmt.run(i + 1, id));
      return true;
    });
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
  for (const l of db.prepare(`SELECT l.id, l.auto_add_new FROM lists l JOIN list_sources ls ON ls.list_id = l.id
      WHERE ls.wishlist_id = ? AND l.archived = 0`).all(wi.wishlist_id)) {
    insertLinked(l.id, wi, { pending: !l.auto_add_new });
  }
}

/**
 * The wishlists that belong to the same recipient as `w`, as `uid` may use them: an admin's
 * own wishlist and the ideas others keep on that admin's record in "gifts to give". The first
 * is `w` itself. Only wishlists `uid` may view as a giver.
 */
export function siblingWishlists(uid, w) {
  const out = [w];
  if (w.owner_id) {
    const person = people.list(uid).find((p) => p.user_id === w.owner_id);
    if (person) out.push(wishlists.ofPerson(person.id));
  } else if (w.person_user_id) {
    const own = wishlists.byOwner(w.person_user_id);
    if (own) out.push(wishlists.get(own.id));
  }
  return out.filter((x) => wishlists.viewableByOther(uid, x));
}

/** Ids of the lists made from (also) this wishlist. */
export const listIdsFrom = (wishlistId) =>
  new Set(db.prepare('SELECT list_id FROM list_sources WHERE wishlist_id = ?').all(wishlistId).map((r) => r.list_id));

/**
 * Create a guest list from a wishlist (and its siblings: an admin's own + the ideas for them),
 * with the chosen items in wishlist order. Returns the new list id, or null if not allowed.
 */
export function createListFromWishlist(uid, wishlistId, { title, description = '', visibility = 'private', auto_add_new = true, itemIds = null }) {
  const w = wishlists.get(wishlistId);
  if (!wishlists.viewableByOther(uid, w)) return null; // never from your own wishlist (you could never see it)
  const sources = siblingWishlists(uid, w);
  return tx(() => {
    const id = lists.create({ title, description, owner_id: uid, visibility, source_wishlist_id: w.id, auto_add_new });
    const chosen = itemIds ? new Set(itemIds.map(Number)) : null;
    for (const src of sources) {
      db.prepare('INSERT OR IGNORE INTO list_sources (list_id, wishlist_id) VALUES (?, ?)').run(id, src.id);
      for (const wi of db.prepare("SELECT * FROM wishlist_items WHERE wishlist_id = ? AND status = 'active' ORDER BY position, id").all(src.id)) {
        if (!chosen || chosen.has(wi.id)) insertLinked(id, wi);
      }
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
export const ownerName = (w) => wishlists.get(w.id)?.owner_name ?? '';

/**
 * 3.2, once: shared gift ideas for people who aren't admins become items of that person's
 * wishlist (with their link, notes, image and price). Private ideas, and ideas for admins,
 * stay as gifts "to buy" — moving them would show them to others. If an idea had been copied
 * to a guest list, that list item becomes linked to the new wishlist item.
 */
export function convertLegacyIdeas() {
  if (settings.all('migrations.').ideas_to_wishlists) return 0;
  let n = 0;
  tx(() => {
    const ideas = db.prepare(`SELECT g.* FROM gifts g JOIN people p ON p.id = g.person_id
      WHERE g.status = 'idea' AND g.wishlist_item_id IS NULL AND g.visibility = 'shared' AND p.user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM gift_people gp JOIN people pa ON pa.id = gp.person_id
                        WHERE gp.gift_id = g.id AND pa.user_id IS NOT NULL)
      ORDER BY g.person_id, g.id`).all();
    for (const g of ideas) {
      const w = wishlists.ofPerson(g.person_id);
      const { p } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM wishlist_items WHERE wishlist_id = ?').get(w.id);
      const price = g.price_cents != null
        ? new Intl.NumberFormat(config.lang === 'en' ? 'en-GB' : 'pt-PT', { style: 'currency', currency: g.price_currency || config.currency }).format(g.price_cents / 100)
        : '';
      const wiId = Number(db.prepare(`INSERT INTO wishlist_items (wishlist_id, title, url, notes, position, image_file, image_source,
          price, price_cents, price_currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(w.id, g.name, g.url, g.notes, p, g.image_file, g.image_source, price, g.price_cents, g.price_currency, g.created_at, now()).lastInsertRowid);
      if (g.list_item_id) {
        db.prepare('UPDATE items SET wishlist_item_id = ? WHERE id = ?').run(wiId, g.list_item_id);
        const it = db.prepare('SELECT reserved_name FROM items WHERE id = ?').get(g.list_item_id);
        if (it?.reserved_name) db.prepare('INSERT OR IGNORE INTO wishlist_claims (wishlist_item_id, item_id, created_at) VALUES (?, ?, ?)').run(wiId, g.list_item_id, now());
      }
      db.prepare('DELETE FROM gifts WHERE id = ?').run(g.id);
      n++;
    }
    settings.setMany({ 'migrations.ideas_to_wishlists': '1' });
  });
  if (n) console.log(`3.2: moved ${n} shared gift idea(s) into people's wishlists.`);
  return n;
}

export { LIST_VISIBLE };
