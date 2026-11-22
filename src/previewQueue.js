// Background queue that builds link previews without blocking admin requests.
import { config } from './config.js';
import { items } from './db.js';
import { fetchPreview, removeImage, sweepImages } from './preview.js';

const CONCURRENCY = 2;
const queue = [];
const queued = new Set();
let running = 0;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Mark an item as pending and fetch its preview in the background. */
export function enqueuePreview(id) {
  const item = items.get(id);
  if (!item) return;
  if (!config.previews || (!item.url && !item.image_source)) {
    clearPreview(id, '');
    return;
  }
  items.setPreview(id, { preview_status: 'pending' });
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
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
    const id = queue.shift();
    queued.delete(id);
    running++;
    run(id).finally(() => { running--; pump(); });
  }
}

async function run(id) {
  const before = items.get(id);
  if (!before) return;
  let result, status;
  try {
    result = await fetchPreview(before.url, before.image_source);
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
  const update = { preview_status: status };
  if (result) {
    if (item.image_file !== result.file) {
      removeImage(item.image_file);
      update.image_file = result.file;
    }
    // Replace placeholder titles (bulk-added bare links use the hostname) and fill an empty price.
    if (result.title && item.url && item.title === hostOf(item.url)) update.title = result.title;
    if (result.price && !item.price) update.price = result.price;
  }
  items.setPreview(id, update);
}

export function startPreviewQueue() {
  sweepImages(items.allImageFiles());
  for (const id of items.pendingPreviews()) enqueuePreview(id);
}
