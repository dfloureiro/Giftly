// Background queue for link previews (image, title, price) so admin requests never wait on shops.
import { config } from './config.js';
import { items } from './db.js';
import { fetchPreview, removeImage, sweepImages } from './preview.js';

const CONCURRENCY = 2;
const PRICE_MAX_AGE = 24 * 3600_000; // re-check shop prices once a day
const queue = [];
const queued = new Map(); // id → job
let running = 0;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * Fetch an item's preview in the background.
 * - force:     admin pressed "reload from link" → replace even an uploaded image.
 * - priceOnly: daily price check → never touch the image.
 */
export function enqueuePreview(id, { force = false, priceOnly = false } = {}) {
  const item = items.get(id);
  if (!item || !config.previews) return;
  const keepImage = priceOnly || (item.preview_status === 'uploaded' && !force);

  if (!item.url && (keepImage || !item.image_source)) {
    if (!keepImage) clearPreview(id, '');
    return;
  }
  // Remember the status to restore if the fetch fails but we still have an image.
  const prevStatus = item.preview_status === 'pending' ? 'ok' : item.preview_status;
  if (!keepImage) items.setPreview(id, { preview_status: 'pending' });

  const existing = queued.get(id);
  if (existing) {
    existing.keepImage &&= keepImage; // a full refresh wins over a price-only one
    return;
  }
  const job = { id, keepImage, prevStatus };
  queued.set(id, job);
  queue.push(job);
  pump();
}

export function clearPreview(id, status = 'removed') {
  const item = items.get(id);
  if (!item) return;
  removeImage(item.image_file);
  items.setPreview(id, { image_file: null, preview_status: status });
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    queued.delete(job.id);
    running++;
    run(job).finally(() => { running--; pump(); });
  }
}

async function run({ id, keepImage, prevStatus }) {
  const before = items.get(id);
  if (!before) return;
  let result, status;
  try {
    result = await fetchPreview(before.url, keepImage ? '' : before.image_source, { wantImage: !keepImage });
    status = result.file ? 'ok' : 'none';
  } catch (err) {
    console.warn(`preview for item ${id} failed: ${err.message}`);
    status = 'failed';
  }
  const item = items.get(id);
  // Item deleted or its links changed while we were fetching: discard.
  if (!item || item.url !== before.url || item.image_source !== before.image_source) {
    removeImage(result?.file);
    return;
  }
  const update = { price_checked_at: Date.now() };
  // An image is only ever replaced by another image: a failed fetch or a page without
  // one never loses what we have (e.g. an uploaded photo for a shop that blocks us).
  if (!keepImage) update.preview_status = status !== 'ok' && item.image_file ? (prevStatus || 'ok') : status;
  if (result) {
    if (!keepImage && result.file && item.image_file !== result.file) {
      removeImage(item.image_file);
      update.image_file = result.file;
    }
    // Bulk-added bare links get the hostname as a placeholder title: replace it.
    if (result.title && item.url && item.title === hostOf(item.url)) update.title = result.title;
    // Prices only ever come from the shop. Keep the last known one if this read found none.
    if (result.price) update.price = result.price;
  }
  items.setPreview(id, update);
}

/** Queue a price check for gifts whose price is older than a day (still available, list not archived). */
function refreshStalePrices() {
  for (const id of items.stalePrices(Date.now() - PRICE_MAX_AGE, 50)) enqueuePreview(id, { priceOnly: true });
}

export function startPreviewQueue() {
  sweepImages(items.allImageFiles());
  for (const id of items.pendingPreviews()) enqueuePreview(id, { force: true });
  if (!config.previews) return;
  setTimeout(refreshStalePrices, 60_000).unref();
  setInterval(refreshStalePrices, 3600_000).unref();
}
