// Background queue for link previews (image, title, price) so admin requests never wait on shops.
// Serves two kinds of records: list gifts ("item") and gifts to give ("gift").
import { config } from './config.js';
import { items } from './db.js';
import { gifts } from './giving.js';
import { wishItems } from './wishlist.js';
import { fetchPreview, removeImage, sweepImages } from './preview.js';

const CONCURRENCY = 2;
const PRICE_MAX_AGE = 24 * 3600_000; // re-check shop prices once a day
const queue = [];
const queued = new Map(); // "kind:id" → job
let running = 0;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// How each kind of record is read and updated. `title` is the display name field.
const STORES = {
  item: {
    get: (id) => items.get(id),
    title: (r) => r.title,
    save: (id, u) => items.setPreview(id, u), // lists keep the shop's price text (u.price)
    stale: (olderThan) => items.stalePrices(olderThan, 50),
    pending: () => items.pendingPreviews(),
    files: () => items.allImageFiles(),
  },
  gift: {
    get: (id) => gifts.raw(id),
    title: (r) => r.name,
    save(id, u) {
      const { title, price, priceCents, priceCurrency, ...rest } = u;
      gifts.setPreview(id, {
        ...rest,
        ...(title && { name: title }),
        // Shop prices only update ideas; bought/given gifts keep the price they had.
        ...(priceCents != null && { link_price_cents: priceCents, link_price_currency: priceCurrency }),
      });
    },
    stale: (olderThan) => gifts.stalePrices(olderThan, 50),
    pending: () => gifts.pendingPreviews(),
    files: () => gifts.allImageFiles(),
  },
  // Wishlist items: list items linked to them get the same image/price (syncLinked).
  wish: {
    get: (id) => wishItems.get(id),
    title: (r) => r.title,
    save(id, u) {
      const { priceCents, priceCurrency, ...rest } = u;
      wishItems.setPreview(id, { ...rest, ...(priceCents != null && { price_cents: priceCents, price_currency: priceCurrency }) });
    },
    stale: (olderThan) => wishItems.stalePrices(olderThan, 50),
    pending: () => wishItems.pendingPreviews(),
    files: () => wishItems.allImageFiles(),
  },
};

/**
 * Delete a stored image only when no record uses it any more (list items linked to a
 * wishlist item share its file). Call after the database no longer points to it.
 */
export function releaseImage(file) {
  if (file && !allImageFiles().includes(file)) removeImage(file);
}

/**
 * Fetch a record's preview in the background.
 * - force:     admin pressed "reload from link" → replace even an uploaded image.
 * - priceOnly: daily price check → never touch the image.
 */
export function enqueuePreview(id, { force = false, priceOnly = false, kind = 'item' } = {}) {
  const store = STORES[kind];
  const rec = store.get(id);
  if (!rec || !config.previews) return;
  const keepImage = priceOnly || (rec.preview_status === 'uploaded' && !force);

  if (!rec.url && (keepImage || !rec.image_source)) {
    if (!keepImage) clearPreview(id, '', kind);
    return;
  }
  // Remember the status to restore if the fetch fails but we still have an image.
  const prevStatus = rec.preview_status === 'pending' ? 'ok' : rec.preview_status;
  if (!keepImage) store.save(id, { preview_status: 'pending' });

  const key = `${kind}:${id}`;
  const existing = queued.get(key);
  if (existing) {
    existing.keepImage &&= keepImage; // a full refresh wins over a price-only one
    return;
  }
  const job = { id, kind, keepImage, prevStatus };
  queued.set(key, job);
  queue.push(job);
  pump();
}

export function clearPreview(id, status = 'removed', kind = 'item') {
  const store = STORES[kind];
  const rec = store.get(id);
  if (!rec) return;
  store.save(id, { image_file: null, preview_status: status });
  releaseImage(rec.image_file);
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    queued.delete(`${job.kind}:${job.id}`);
    running++;
    run(job).finally(() => { running--; pump(); });
  }
}

// Tests replace the fetcher to control timing; production always uses fetchPreview.
let fetchImpl = fetchPreview;
export const __test = { setFetch: (fn) => { fetchImpl = fn || fetchPreview; }, enqueue: (...a) => enqueuePreview(...a) };

async function run({ id, kind, keepImage, prevStatus }) {
  const store = STORES[kind];
  const before = store.get(id);
  if (!before) return;
  let result, status;
  try {
    result = await fetchImpl(before.url, keepImage ? '' : before.image_source, { wantImage: !keepImage });
    status = result.file ? 'ok' : 'none';
  } catch (err) {
    console.warn(`preview for ${kind} ${id} failed: ${err.message}`);
    status = 'failed';
  }
  const rec = store.get(id);
  // Deleted, or its links changed while we were fetching: discard.
  if (!rec || rec.url !== before.url || rec.image_source !== before.image_source) {
    releaseImage(result?.file);
    return;
  }
  // Compare-and-set on the image itself: if it was uploaded, replaced or removed while we were
  // fetching (no await between this check and the save below, so nothing can slip in), what the
  // admin did wins and this fetch only updates the price.
  const imageChanged = rec.image_file !== before.image_file || rec.preview_status !== before.preview_status;
  if (imageChanged) keepImage = true; // the fetched image (if any) is released below
  const update = { price_checked_at: Date.now() };
  // An image is only ever replaced by another image: a failed fetch or a page without
  // one never loses what we have (e.g. an uploaded photo for a shop that blocks us).
  if (!keepImage) update.preview_status = status !== 'ok' && rec.image_file ? (prevStatus || 'ok') : status;
  if (result) {
    if (!keepImage && result.file && rec.image_file !== result.file) update.image_file = result.file;
    else if (keepImage && result.file && result.file !== rec.image_file) releaseImage(result.file);
    // Bare links get the hostname as a placeholder title: replace it.
    if (result.title && rec.url && store.title(rec) === hostOf(rec.url)) update.title = result.title;
    // Shop prices: keep the last known one if this read found none.
    if (result.price) Object.assign(update, { price: result.price, priceCents: result.priceCents, priceCurrency: result.priceCurrency });
  }
  store.save(id, update);
  if (update.image_file) releaseImage(rec.image_file); // the old one, if nothing else uses it
}

/** Daily price check for list gifts still available and gift ideas with a link. */
function refreshStalePrices() {
  for (const kind of Object.keys(STORES)) {
    for (const id of STORES[kind].stale(Date.now() - PRICE_MAX_AGE)) enqueuePreview(id, { priceOnly: true, kind });
  }
}

/** Every stored image any record still uses (anything else can be deleted). */
export const allImageFiles = () => Object.values(STORES).flatMap((s) => s.files());

export function startPreviewQueue() {
  sweepImages(allImageFiles());
  for (const kind of Object.keys(STORES)) {
    for (const id of STORES[kind].pending()) enqueuePreview(id, { force: true, kind });
  }
  if (!config.previews) return;
  setTimeout(refreshStalePrices, 60_000).unref();
  setInterval(refreshStalePrices, 3600_000).unref();
}
