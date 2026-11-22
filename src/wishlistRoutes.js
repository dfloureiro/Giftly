// Routes for personal wishlists, lists created from them, and "I'll give it".
import { config } from './config.js';
import { db, tx, lists } from './db.js';
import { users } from './accounts.js';
import {
  wishlists, wishItems, createListFromWishlist, claimForGift, REMOVE_REASONS, WISHLIST_VISIBILITIES,
} from './wishlist.js';
import { people, occasions, gifts, nextBirthday, today } from './giving.js';
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

  /** The owner's own item (anything else is 404). */
  function ownItem(ctx) {
    const wi = wishItems.get(Number(ctx.params.id));
    const w = wi && wishlists.get(wi.wishlist_id);
    if (!w || w.owner_id !== ctx.user.id) {
      notFound(ctx);
      return null;
    }
    return wi;
  }

  // ----- my wishlist (claim-blind) -----

  function renderOwn(ctx, extra = {}, status = 200) {
    const w = wishlists.ofUser(ctx.user.id);
    html(ctx.res, wv.ownWishlistPage(ctx, { wishlist: w, ...wishItems.ownerView(w.id), ...extra }), status);
  }

  route('GET', '/admin/wishlist', (ctx) => renderOwn(ctx), A);

  route('POST', '/admin/wishlist/visibility', (ctx) => {
    wishlists.ofUser(ctx.user.id);
    const v = WISHLIST_VISIBILITIES.includes(ctx.body.visibility) ? ctx.body.visibility : 'admins';
    wishlists.setVisibility(ctx.user.id, v);
    redirect(ctx.res, '/admin/wishlist?m=saved');
  }, A);

  route('POST', '/admin/wishlist/items', (ctx) => {
    const w = wishlists.ofUser(ctx.user.id);
    const { f, error } = itemForm(ctx);
    if (error) return renderOwn(ctx, { error: ctx.t(error), form: f }, 400);
    const id = wishItems.create(w.id, f);
    if (!applyUpload(id, ctx.body.image_data)) enqueuePreview(id, { kind: 'wish' });
    else if (f.url) enqueuePreview(id, { kind: 'wish' }); // keeps the photo, still reads the price
    redirect(ctx.res, `/admin/wishlist?m=added&n=1#wish-${id}`);
  }, A);

  route('POST', '/admin/wishlist/items/:id', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    const { f, error } = itemForm(ctx);
    if (error) return renderOwn(ctx, { error: ctx.t(error) }, 400);
    if (ctx.body.remove_image === '1') f.image_source = '';
    wishItems.update(wi.id, f);
    const uploaded = applyUpload(wi.id, ctx.body.image_data);
    if (!uploaded && ctx.body.remove_image === '1') clearPreview(wi.id, 'removed', 'wish');
    if (!uploaded && f.image_source && f.image_source !== wi.image_source) enqueuePreview(wi.id, { force: true, kind: 'wish' });
    else if (f.url !== wi.url) enqueuePreview(wi.id, { kind: 'wish' });
    redirect(ctx.res, `/admin/wishlist?m=saved#wish-${wi.id}`);
  }, A);

  route('POST', '/admin/wishlist/items/:id/move', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    wishItems.move(wi.id, ctx.body.dir === 'up' ? 'up' : 'down');
    redirect(ctx.res, `/admin/wishlist#wish-${wi.id}`);
  }, A);

  route('POST', '/admin/wishlist/items/:id/preview', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    enqueuePreview(wi.id, { force: true, kind: 'wish' });
    redirect(ctx.res, `/admin/wishlist#wish-${wi.id}`);
  }, A);

  // Same answer whether the item was reserved or not; whoever must know is told in the background.
  route('POST', '/admin/wishlist/items/:id/remove', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    const reason = REMOVE_REASONS.includes(ctx.body.reason) ? ctx.body.reason : 'unwanted';
    const watchers = wi.status === 'active' ? wishItems.remove(wi.id, reason) : [];
    redirect(ctx.res, '/admin/wishlist?m=wishRemoved');
    setImmediate(() => tellWatchers(watchers, wi, reason, ctx.user));
  }, A);

  route('POST', '/admin/wishlist/items/:id/restore', (ctx) => {
    const wi = ownItem(ctx);
    if (!wi) return;
    wishItems.restore(wi.id);
    redirect(ctx.res, `/admin/wishlist?m=saved#wish-${wi.id}`);
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
        click: base ? (list ? `${base}/admin/lists/${list.id}` : `${base}/admin/give`) : undefined,
        data: { item: wi.title, reason, list: list?.title },
      }).catch(() => {});
    }
  }

  // ----- other admins' wishlists -----

  route('GET', '/admin/wishlists', (ctx) => {
    html(ctx.res, wv.othersIndexPage(ctx, { list: wishlists.others(ctx.user.id) }));
  }, A);

  /** Gift occasions for "I'll give it": the recipient's next birthday + upcoming occasions. */
  function giveChoices(uid, person) {
    const out = [];
    if (person?.birthday_month) {
      const nb = nextBirthday(person.birthday_month, person.birthday_day);
      out.push({ value: `birthday:${nb.year}`, label: { key: 'give.birthdayYear', vars: { year: nb.year } }, date: nb.date });
    }
    for (const o of occasions.list(uid).filter((o) => o.date >= today())) {
      out.push({ value: `occasion:${o.id}`, label: { text: o.name }, date: o.date });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** The "gifts to give" person for an admin (created, shared, on first "I'll give it"). */
  function personFor(uid, ownerId) {
    const existing = people.list(uid).find((p) => p.user_id === ownerId);
    if (existing) return existing;
    const owner = users.get(ownerId);
    const id = people.create(uid, { name: owner.name, visibility: 'shared', gives_christmas: false, user_id: ownerId });
    return people.get(uid, id);
  }

  function loadOthers(ctx) {
    const w = wishlists.get(Number(ctx.params.id));
    if (w && w.owner_id === ctx.user.id) {
      redirect(ctx.res, '/admin/wishlist'); // your own: the claim-blind page
      return null;
    }
    if (!wishlists.viewableByOther(ctx.user.id, w)) {
      notFound(ctx);
      return null;
    }
    return w;
  }

  route('GET', '/admin/wishlists/:id', (ctx) => {
    const w = loadOthers(ctx);
    if (!w) return;
    const person = people.list(ctx.user.id).find((p) => p.user_id === w.owner_id) ?? null;
    html(ctx.res, wv.othersWishlistPage(ctx, {
      wishlist: w,
      items: wishItems.othersView(w.id, ctx.user.id),
      choices: giveChoices(ctx.user.id, person),
      preselect: String(ctx.url.searchParams.get('occasion') || ''),
      linkedLists: lists.all(ctx.user.id).filter((l) => l.source_wishlist_id === w.id),
    }));
  }, A);

  route('GET', '/admin/wishlists/:id/new-list', (ctx) => {
    const w = loadOthers(ctx);
    if (!w) return;
    html(ctx.res, wv.newListPage(ctx, { wishlist: w, items: wishItems.othersView(w.id, ctx.user.id) }));
  }, A);

  route('POST', '/admin/wishlists/:id/new-list', (ctx) => {
    const w = loadOthers(ctx);
    if (!w) return;
    const title = clean(ctx.body.title, 120);
    if (!title) {
      return html(ctx.res, wv.newListPage(ctx, { wishlist: w, items: wishItems.othersView(w.id, ctx.user.id), error: ctx.t('admin.titleRequired') }), 400);
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
    const back = `/admin/wishlists/${w.id}`;

    const [kind, ref] = String(ctx.body.occasion || '').split(':');
    const person = personFor(uid, w.owner_id);
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
        status: 'idea', visibility: 'private', // the recipient is an admin: never shared with them
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
    if (!giftId) return redirect(ctx.res, `${back}?m=taken#wish-${wi.id}`);
    redirect(ctx.res, `${back}?m=giving#wish-${wi.id}`);
  }, A);
}
