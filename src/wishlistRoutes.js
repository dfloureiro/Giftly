// Routes for personal wishlists, lists created from them, and "I'll give it".
import { config } from './config.js';
import { db, tx, lists } from './db.js';
import {
  wishlists, wishItems, createListFromWishlist, claimForGift, REMOVE_REASONS, WISHLIST_VISIBILITIES,
  siblingWishlists, listIdsFrom,
} from './wishlist.js';
import { people, occasions, gifts, occasionOptions } from './giving.js';
import { saveImageBuffer } from './preview.js';
import { enqueuePreview, clearPreview, releaseImage } from './previewQueue.js';
import { notifyUser } from './notify.js';
import { makeT } from './i18n.js';
import * as wv from './wishlistViews.js';

export function registerWishlistRoutes({ route, html, redirect, notFound, clean, cleanMultiline, cleanUrl }) {
  const A = { auth: 'admin' };

  function itemForm(ctx) {
    const { url, error: urlError } = cleanUrl(ctx.body.url);
    const { url: imageSource, error: imageError } = cleanUrl(ctx.body.image_source);
    const f = {
      title: clean(ctx.body.title, 200),
      url: url ?? String(ctx.body.url ?? ''),
      notes: cleanMultiline(ctx.body.notes, 1000),
      image_source: imageSource ?? String(ctx.body.image_source ?? ''),
    };
    let error;
    if (!f.title) error = 'admin.titleRequired';
    else if (urlError || imageError) error = 'admin.badUrl';
    return { f, error };
  }

  function applyUpload(id, dataUrl) {
    const m = /^data:image\/(jpeg|png|webp|gif|avif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return false;
    let file;
    try { file = saveImageBuffer(Buffer.from(m[2], 'base64')); } catch { return false; }
    const old = wishItems.get(id)?.image_file;
    wishItems.setPreview(id, { image_file: file, preview_status: 'uploaded' });
    releaseImage(old);
    return true;
  }

  /** Where a wishlist is edited: your own page, or the person's page (ideas). */
  const homeOf = (w) => (w.kind === 'ideas' ? `/admin/people/${w.person_id}` : '/admin/wishlist');
  const at = (w, m, anchor) => `${homeOf(w)}${m ? `?m=${m}` : ''}${anchor ? `#${anchor}` : ''}`;

  /** An item of a wishlist this admin may edit (own, or a person's they can see); else 404. */
  function ownItem(ctx) {
    const wi = wishItems.get(Number(ctx.params.id));
    const w = wi && wishlists.get(wi.wishlist_id);
    if (!wishlists.canEdit(ctx.user.id, w)) {
      notFound(ctx);
      return null;
    }
    ctx.wishlist = w;
    return wi;
  }

  /**
   * The wishlist a form is about: ideas for a person (person_id; private=1 → only yours), an
   * existing wishlist (wishlist_id, for reordering), or your own.
   */
  function targetWishlist(ctx) {
    const uid = ctx.user.id;
    if (ctx.body.wishlist_id) {
      const w = wishlists.get(Number(ctx.body.wishlist_id));
      return wishlists.canEdit(uid, w) ? w : null;
    }
    if (!ctx.body.person_id) return wishlists.ofUser(uid);
    const person = people.get(uid, Number(ctx.body.person_id)); // never your own record (invisible to you)
    if (!person) return null;
    return wishlists.ideas(person.id, ctx.body.private === '1' ? uid : null);
  }

  // ----- my wishlist (claim-blind) -----

  function renderOwn(ctx, extra = {}, status = 200) {
    const w = wishlists.ofUser(ctx.user.id);
    html(ctx.res, wv.ownWishlistPage(ctx, { wishlist: w, ...wishItems.ownerView(w.id), ...extra }), status);
  }

  route('GET', '/admin/wishlist', (ctx) => renderOwn(ctx), A);
  route('GET', '/admin/wishlist/new', (ctx) => html(ctx.res, wv.newWishPage(ctx, {})), A);

  route('POST', '/admin/wishlist/visibility', (ctx) => {
    wishlists.ofUser(ctx.user.id);
    const v = WISHLIST_VISIBILITIES.includes(ctx.body.visibility) ? ctx.body.visibility : 'shared';
    wishlists.setVisibility(ctx.user.id, v);
    redirect(ctx.res, '/admin/wishlist?m=saved');
  }, A);

  route('POST', '/admin/wishlist/items', (ctx) => {
    const w = targetWishlist(ctx);
    if (!w) return notFound(ctx);
    const { f, error } = itemForm(ctx);
    if (error) {
      if (w.kind === 'own') return html(ctx.res, wv.newWishPage(ctx, { form: f, error: ctx.t(error) }), 400);
      return redirect(ctx.res, at(w, 'badItem', 'wishlist'));
    }
    const id = wishItems.create(w.id, f);
    if (!applyUpload(id, ctx.body.image_data)) enqueuePreview(id, { kind: 'wish' });
    else if (f.url) enqueuePreview(id, { kind: 'wish' }); // keeps the photo, still reads the price
    redirect(ctx.res, at(w, 'added&n=1', `wish-${id}`));
  }, A);

  route('POST', '/admin/wishlist/items/:id', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    const { f, error } = itemForm(ctx);
    if (error) return ctx.wishlist.kind === 'own' ? renderOwn(ctx, { error: ctx.t(error) }, 400) : redirect(ctx.res, at(ctx.wishlist, 'badItem', `wish-${wi.id}`));
    if (ctx.body.remove_image === '1') f.image_source = '';
    wishItems.update(wi.id, f);
    const uploaded = applyUpload(wi.id, ctx.body.image_data);
    if (!uploaded && ctx.body.remove_image === '1') clearPreview(wi.id, 'removed', 'wish');
    if (!uploaded && f.image_source && f.image_source !== wi.image_source) enqueuePreview(wi.id, { force: true, kind: 'wish' });
    else if (f.url !== wi.url) enqueuePreview(wi.id, { kind: 'wish' });
    redirect(ctx.res, at(ctx.wishlist, 'saved', `wish-${wi.id}`));
  }, A);

  route('POST', '/admin/wishlist/items/:id/move', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    wishItems.move(wi.id, ctx.body.dir === 'up' ? 'up' : 'down');
    redirect(ctx.res, at(ctx.wishlist, '', `wish-${wi.id}`));
  }, A);

  // Drag and drop (your own wishlist, or a person's with person_id).
  route('POST', '/admin/wishlist/order', (ctx) => {
    const w = targetWishlist(ctx);
    if (!w) return notFound(ctx);
    const ok = wishItems.setOrder(w.id, String(ctx.body.order || '').split(',').filter(Boolean));
    ctx.res.writeHead(ok ? 204 : 400, { 'Cache-Control': 'no-store' });
    ctx.res.end();
  }, A);

  route('POST', '/admin/wishlist/items/:id/preview', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    enqueuePreview(wi.id, { force: true, kind: 'wish' });
    redirect(ctx.res, at(ctx.wishlist, '', `wish-${wi.id}`));
  }, A);

  // Same answer whether the item was reserved or not; whoever must know is told in the background.
  route('POST', '/admin/wishlist/items/:id/remove', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    const reason = REMOVE_REASONS.includes(ctx.body.reason) ? ctx.body.reason : 'unwanted';
    const watchers = wi.status === 'active' ? wishItems.remove(wi.id, reason) : [];
    redirect(ctx.res, at(ctx.wishlist, 'wishRemoved', 'wishlist'));
    setImmediate(() => tellWatchers(watchers, wi, reason, ctx.user));
  }, A);

  route('POST', '/admin/wishlist/items/:id/restore', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    wishItems.restore(wi.id);
    redirect(ctx.res, at(ctx.wishlist, 'saved', `wish-${wi.id}`));
  }, A);

  function tellWatchers(watchers, wi, reason, owner) {
    const t = makeT(config.lang);
    const base = (process.env.BASE_URL || '').replace(/\/$/, '');
    for (const w of watchers) {
      const list = w.listId ? lists.get(w.listId) : null;
      notifyUser(w.userId, {
        event: 'wishlist_item_removed_claimed',
        title: t('wish.notifyRemovedTitle', { name: owner.name, item: wi.title }),
        message: t(`wish.notifyRemoved.${reason}`, { name: owner.name, list: list?.title ?? '' }),
        click: base ? (list ? `${base}/admin/lists/${list.id}` : `${base}/admin/occasions`) : undefined,
        data: { item: wi.title, reason, list: list?.title },
      }).catch(() => {});
    }
  }

  // ----- other admins' wishlists and ideas (shown on the person's page) -----

  const giveChoices = occasionOptions;

  /** A wishlist `uid` may use as a giver; your own goes to its claim-blind page; anything else 404. */
  function loadOthers(ctx) {
    const w = wishlists.get(Number(ctx.params.id));
    if (w && w.kind === 'own' && w.owner_id === ctx.user.id) {
      redirect(ctx.res, '/admin/wishlist');
      return null;
    }
    if (!wishlists.viewableByOther(ctx.user.id, w)) {
      notFound(ctx);
      return null;
    }
    return w;
  }

  /** The person a gift from wishlist `w` is for, as `uid` sees them (null: none visible). */
  function recipientOf(uid, w) {
    if (w.kind === 'ideas') return people.get(uid, w.person_id);
    return people.list(uid).find((p) => p.user_id === w.owner_id) ?? null;
  }

  /** The items to choose from: this wishlist and its sibling (an admin's own + ideas for them). */
  const groupsFor = (uid, w) => siblingWishlists(uid, w).map((x) => ({ w: x, items: wishItems.othersView(x.id, uid) }));

  route('GET', '/admin/wishlists/:id/new-list', (ctx) => {
    const w = loadOthers(ctx);
    if (!w) return;
    html(ctx.res, wv.newListPage(ctx, { wishlist: w, groups: groupsFor(ctx.user.id, w) }));
  }, A);

  route('POST', '/admin/wishlists/:id/new-list', (ctx) => {
    const w = loadOthers(ctx);
    if (!w) return;
    const title = clean(ctx.body.title, 120);
    if (!title) {
      return html(ctx.res, wv.newListPage(ctx, { wishlist: w, groups: groupsFor(ctx.user.id, w), error: ctx.t('admin.titleRequired') }), 400);
    }
    const id = createListFromWishlist(ctx.user.id, w.id, {
      title,
      description: cleanMultiline(ctx.body.description, 2000),
      visibility: ctx.body.visibility === 'shared' ? 'shared' : 'private',
      auto_add_new: ctx.body.auto_add_new === '1',
      itemIds: [].concat(ctx.body.items ?? []).map(Number),
    });
    if (!id) return notFound(ctx);
    redirect(ctx.res, `/admin/lists/${id}?m=created`);
  }, A);

  // "I'll give it": reserve the item everywhere + a private gift in "gifts to give", atomically.
  route('POST', '/admin/wishlists/:id/items/:itemId/give', (ctx) => {
    const w = loadOthers(ctx);
    if (!w) return;
    const uid = ctx.user.id;
    const wi = wishItems.get(Number(ctx.params.itemId));
    if (!wi || wi.wishlist_id !== w.id || wi.status !== 'active') return notFound(ctx);
    const person = recipientOf(uid, w);
    if (!person) return notFound(ctx);
    const b = String(ctx.body.back || '');
    const back = b.startsWith('/admin/') && !b.startsWith('//') ? b.split('#')[0].split('?')[0] : `/admin/people/${person.id}`;

    const [kind, ref] = String(ctx.body.occasion || '').split(':');
    let occasionId = null;
    let year;
    if (kind === 'birthday' && Number(ref) >= 2000 && Number(ref) <= 2200) year = Number(ref);
    else if (kind === 'occasion' && occasions.get(uid, Number(ref))) {
      occasionId = Number(ref);
      year = Number(occasions.get(uid, occasionId).date.slice(0, 4));
    } else return redirect(ctx.res, `${back}?m=pickOccasion#wish-${wi.id}`);

    let giftId = null;
    try {
      giftId = tx(() => {
      const id = gifts.create(uid, {
        person_id: person.id, occasion_id: occasionId, year, name: wi.title, url: wi.url, notes: wi.notes,
        // Shared with the other admins (never visible to whoever it is for); private ideas stay private.
        status: 'planned', visibility: w.kind === 'ideas' && w.owner_id ? 'private' : 'shared',
        price_cents: wi.price_cents ?? null, price_currency: wi.price_currency ?? config.currency,
      });
      if (!claimForGift(wi.id, id)) throw Object.assign(new Error('taken'), { taken: true });
      db.prepare("UPDATE gifts SET wishlist_item_id = ?, image_file = ?, price_source = CASE WHEN ? IS NOT NULL THEN 'link' ELSE price_source END WHERE id = ?")
        .run(wi.id, wi.image_file, wi.price_cents ?? null, id);
      if (occasionId) occasions.addParticipant(uid, occasionId, person.id);
      return id;
      });
    } catch (err) {
      if (!err.taken) throw err; // someone reserved it first (a guest, or another admin)
    }
    if (!giftId) return redirect(ctx.res, `${back}?m=taken${back.startsWith('/admin/occasions/') ? '' : `#wish-${wi.id}`}`);
    redirect(ctx.res, `${back}?m=giving${back.startsWith('/admin/occasions/') ? `#gift-${giftId}` : `#wish-${wi.id}`}`);
  }, A);
}
