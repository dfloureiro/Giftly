// Wishlists: an admin's own ('own'), and the ideas admins keep for a person ('ideas': shared with
// everyone who sees the person, or private to one admin). Lists can be created from both.
//
// SURPRISE RULE: nothing in this module ever tells a wishlist's OWNER whether an item was
// reserved. Owner-facing functions (`ownerView`, `remove`, …) don't read claims at all and
// behave identically either way. Claim state is only exposed to *other* admins
// (`othersView`), and lists made from a wishlist are hidden from its owner by LIST_VISIBLE.
// Ideas kept for an admin are never visible to that admin (their person is invisible to them).
//
// WISHLIST ACCESS RULE (the only place it lives): `wishlists.canView` / `viewableByOther` / `canEdit`.
import { db, tx, lists } from './db.js';
import { people } from './giving.js';

const now = () => Date.now();
export const WISHLIST_VISIBILITIES = ['shared', 'private'];
export const REMOVE_REASONS = ['bought', 'unwanted', 'received'];

// ---------- wishlists ----------

const GET = `SELECT w.*, COALESCE(u.name, p.name) AS owner_name,
    CASE w.kind WHEN 'own' THEN w.owner_id ELSE p.user_id END AS recipient_user_id
  FROM wishlists w LEFT JOIN users u ON u.id = w.owner_id AND w.kind = 'own' LEFT JOIN people p ON p.id = w.person_id`;

export const wishlists = {
  /** The admin's own wishlist (created on first use). */
  ofUser(uid) {
    let w = db.prepare("SELECT * FROM wishlists WHERE kind = 'own' AND owner_id = ?").get(uid);
    if (!w) {
      db.prepare("INSERT INTO wishlists (kind, owner_id, visibility, created_at) VALUES ('own', ?, 'shared', ?)").run(uid, now());
      w = db.prepare("SELECT * FROM wishlists WHERE kind = 'own' AND owner_id = ?").get(uid);
    }
    return wishlists.get(w.id);
  },
  /**
   * owner_name: the admin (own) or the person (ideas). recipient_user_id: the admin it is for, if
   * any. For ideas, owner_id is the admin they are private to (NULL = shared).
   */
  get: (id) => db.prepare(`${GET} WHERE w.id = ?`).get(id) ?? null,
  byOwner: (uid) => {
    const w = db.prepare("SELECT id FROM wishlists WHERE kind = 'own' AND owner_id = ?").get(uid);
    return w ? wishlists.get(w.id) : null;
  },
  /**
   * The ideas wishlist for a person: the shared one (`ownerId` null) or the one private to
   * `ownerId`. Created on first use when `create` is set; null otherwise.
   */
  ideas(personId, ownerId = null, { create = true } = {}) {
    const find = () => db.prepare("SELECT id FROM wishlists WHERE kind = 'ideas' AND person_id = ? AND COALESCE(owner_id, 0) = ?")
      .get(personId, ownerId ?? 0);
    let w = find();
    if (!w && !create) return null;
    if (!w) {
      db.prepare("INSERT INTO wishlists (kind, owner_id, person_id, visibility, created_at) VALUES ('ideas', ?, ?, ?, ?)")
        .run(ownerId, personId, ownerId ? 'private' : 'shared', now());
      w = find();
    }
    return wishlists.get(w.id);
  },
  setVisibility(uid, visibility) {
    db.prepare("UPDATE wishlists SET visibility = ? WHERE kind = 'own' AND owner_id = ?").run(visibility, uid);
  },
  /**
   * Can `uid` look at this wishlist as a giver (with what's reserved)? Never its recipient.
   * Own: another admin, if the owner shares it. Ideas: whoever can see the person (never the
   * person themselves), and for private ideas only the admin they belong to.
   */
  viewableByOther(uid, w) {
    if (!w) return false;
    if (w.kind === 'own') return w.owner_id !== uid && w.visibility === 'shared';
    if (w.owner_id != null && w.owner_id !== uid) return false;
    return !!people.get(uid, w.person_id);
  },
  /** Any view at all: the owner's own (claim-blind) page, or as a giver. */
  canView: (uid, w) => !!w && ((w.kind === 'own' && w.owner_id === uid) || wishlists.viewableByOther(uid, w)),
  /** Who may add, edit, reorder and remove items: the owner of an own wishlist; for ideas, whoever may view them. */
  canEdit(uid, w) {
    if (!w) return false;
    if (w.kind === 'own') return w.owner_id === uid;
    return wishlists.viewableByOther(uid, w);
  },
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

  /**
   * Delete a removed or received item for good (claims go with it; list copies stay, unlinked).
   * Active items are never deleted here: they are removed first, with a reason. Returns true if deleted.
   */
  delete(id) {
    return tx(() => {
      if (!db.prepare("SELECT 1 FROM wishlist_items WHERE id = ? AND status != 'active'").get(id)) return false;
      db.prepare('DELETE FROM list_item_overrides WHERE item_id IN (SELECT id FROM items WHERE wishlist_item_id = ?)').run(id);
      db.prepare('DELETE FROM wishlist_items WHERE id = ?').run(id);
      return true;
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

/**
 * Copy a wishlist item's shown data onto every list item linked to it. Fields a list changed for
 * itself (list_item_overrides) keep that list's version: a new link there brings its own price and
 * picture, and a picture set there stays. The wishlist itself is never changed by this.
 */
export function syncLinked(wishItemId) {
  const wi = wishItems.get(wishItemId);
  if (!wi) return;
  const plain = db.prepare(`UPDATE items SET title = ?, url = ?, wish_notes = ?, price = ?, image_file = ?, preview_status = '',
      price_checked_at = ? WHERE wishlist_item_id = ? AND id NOT IN (SELECT item_id FROM list_item_overrides)`);
  plain.run(wi.title, wi.url, wi.notes, wi.price, wi.image_file, wi.price_checked_at, wishItemId);
  for (const ov of db.prepare(`SELECT ov.* FROM list_item_overrides ov JOIN items i ON i.id = ov.item_id
      WHERE i.wishlist_item_id = ?`).all(wishItemId)) {
    const ownLink = ov.url != null;
    const ownPicture = ownLink || !!ov.image;
    db.prepare(`UPDATE items SET title = ?, url = ?, wish_notes = ?,
        price = CASE WHEN ? THEN price ELSE ? END, price_checked_at = CASE WHEN ? THEN price_checked_at ELSE ? END,
        image_file = CASE WHEN ? THEN image_file ELSE ? END, preview_status = CASE WHEN ? THEN preview_status ELSE '' END
      WHERE id = ?`).run(ov.title ?? wi.title, ov.url ?? wi.url, ov.notes ?? wi.notes,
      ownLink ? 1 : 0, wi.price, ownLink ? 1 : 0, wi.price_checked_at,
      ownPicture ? 1 : 0, wi.image_file, ownPicture ? 1 : 0, ov.item_id);
  }
}

// ---------- a list's own version of an item from another admin's wishlist ----------

const OVERRIDABLE = ['title', 'url', 'notes'];

/**
 * When a list edits an item that comes from someone's OWN wishlist, the change is stored for that
 * list only (the wishlist and its owner never see it). Fields equal to the wishlist follow it again.
 * `base_*` remembers the wishlist's value when the field was changed here, to tell "the wishlist
 * changed since" (shown with an option to take its version).
 */
export const overrides = {
  get: (itemId) => db.prepare('SELECT * FROM list_item_overrides WHERE item_id = ?').get(itemId) ?? null,
  /**
   * `f`: { title, url, notes } as submitted; `picture`: 'upload' | 'remove' | 'source' | null.
   * Returns what changed: { urlChanged, pictureChanged }.
   */
  save(item, wi, f, picture = null) {
    return tx(() => {
      const cur = overrides.get(item.id) ?? {};
      const row = { image: cur.image ?? 0, image_source: cur.image_source ?? null, base_image: cur.base_image ?? null };
      for (const k of OVERRIDABLE) {
        const shown = cur[k] ?? wi[k];
        if (f[k] === wi[k]) { row[k] = null; row[`base_${k}`] = null; }
        else if (f[k] === shown && cur[k] != null) { row[k] = cur[k]; row[`base_${k}`] = cur[`base_${k}`]; } // untouched: keep its base
        else { row[k] = f[k]; row[`base_${k}`] = wi[k]; }
      }
      if (picture) {
        row.image = 1;
        row.base_image = wi.image_file;
        row.image_source = picture === 'source' ? f.image_source : null;
      }
      const urlChanged = (row.url ?? wi.url) !== item.url;
      if (!OVERRIDABLE.some((k) => row[k] != null) && !row.image) {
        db.prepare('DELETE FROM list_item_overrides WHERE item_id = ?').run(item.id);
      } else {
        db.prepare(`INSERT INTO list_item_overrides (item_id, title, url, notes, image, image_source, base_title, base_url, base_notes, base_image, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET title = excluded.title, url = excluded.url,
          notes = excluded.notes, image = excluded.image, image_source = excluded.image_source, base_title = excluded.base_title,
          base_url = excluded.base_url, base_notes = excluded.base_notes, base_image = excluded.base_image, updated_at = excluded.updated_at`)
          .run(item.id, row.title, row.url, row.notes, row.image, row.image_source, row.base_title, row.base_url, row.base_notes, row.base_image, now());
      }
      db.prepare('UPDATE items SET image_source = ? WHERE id = ?').run(row.image ? row.image_source ?? '' : '', item.id);
      if (urlChanged) db.prepare("UPDATE items SET price = '', price_checked_at = NULL WHERE id = ?").run(item.id);
      syncLinked(wi.id);
      return { urlChanged, pictureChanged: !!picture };
    });
  },
  /** Fields changed in this list whose wishlist version changed since (['title', 'image', …]). */
  changed(ov, wi) {
    if (!ov || !wi) return [];
    const out = OVERRIDABLE.filter((k) => ov[k] != null && ov[`base_${k}`] !== wi[k]);
    if (ov.image && ov.base_image !== wi.image_file) out.push('image');
    return out;
  },
  /** Take the wishlist's version of what changed there (the rest stays as this list has it). */
  acceptChanged(itemId) {
    return tx(() => {
      const ov = overrides.get(itemId);
      const item = ov && db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
      const wi = item && wishItems.get(item.wishlist_item_id);
      if (!wi) return false;
      const fields = overrides.changed(ov, wi);
      for (const k of fields) {
        if (k === 'image') db.prepare('UPDATE list_item_overrides SET image = 0, image_source = NULL, base_image = NULL WHERE item_id = ?').run(itemId);
        else db.prepare(`UPDATE list_item_overrides SET ${k} = NULL, base_${k} = NULL WHERE item_id = ?`).run(itemId);
      }
      db.prepare(`DELETE FROM list_item_overrides WHERE item_id = ? AND title IS NULL AND url IS NULL AND notes IS NULL AND image = 0`).run(itemId);
      syncLinked(wi.id);
      return true;
    });
  },
  /** "Use the wishlist's details again": this list follows the wishlist in everything. */
  reset(itemId) {
    return tx(() => {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
      if (!item?.wishlist_item_id) return false;
      db.prepare('DELETE FROM list_item_overrides WHERE item_id = ?').run(itemId);
      db.prepare("UPDATE items SET image_source = '' WHERE id = ?").run(itemId);
      syncLinked(item.wishlist_item_id);
      return true;
    });
  },
};

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
 * The wishlists that belong to the same recipient as `w`, as `uid` may use them: an admin's own
 * wishlist, the shared ideas kept for that person and `uid`'s private ideas for them. The first is
 * `w` itself. Only wishlists `uid` may view as a giver.
 */
export function siblingWishlists(uid, w) {
  const out = [w];
  const personIds = w.kind === 'own'
    ? people.list(uid).filter((p) => p.user_id === w.owner_id).map((p) => p.id)
    : [w.person_id];
  const userId = w.kind === 'own' ? w.owner_id : w.recipient_user_id;
  if (w.kind !== 'own' && userId) {
    const own = wishlists.byOwner(userId);
    if (own) out.push(own);
  }
  for (const pid of personIds) {
    for (const x of [wishlists.ideas(pid, null, { create: false }), wishlists.ideas(pid, uid, { create: false })]) {
      if (x && !out.some((y) => y.id === x.id)) out.push(x);
    }
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
export function createListFromWishlist(uid, wishlistId, { title, description = '', visibility = 'private', auto_add_new = true, ask_buyer = false, itemIds = null }) {
  const w = wishlists.get(wishlistId);
  if (!wishlists.viewableByOther(uid, w)) return null; // never from your own wishlist (you could never see it)
  const sources = siblingWishlists(uid, w);
  // Private ideas only ever go into a private list (LIST_VISIBLE also hides it from everyone else).
  if (sources.some((x) => x.kind === 'ideas' && x.owner_id != null)) visibility = 'private';
  return tx(() => {
    const id = lists.create({ title, description, owner_id: uid, visibility, source_wishlist_id: w.id, auto_add_new, ask_buyer });
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
