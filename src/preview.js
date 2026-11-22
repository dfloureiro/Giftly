// Link previews: fetch a product page, find its image/title/price, store the image locally.
//
// Safety: only http(s); every DNS answer is checked so private/loopback/link-local
// addresses are refused (also on redirects); response sizes and time are capped;
// images are accepted only if their magic bytes match a raster format (no SVG).

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

export const IMAGE_DIR = join(config.dataDir, 'images');
mkdirSync(IMAGE_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (compatible; GiftlyLinkPreview/1.0; +https://github.com/dfloureiro/giftly)';
const PAGE_LIMIT = 3 * 1024 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

// ---------- network guard ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** DNS lookup that refuses private addresses — used by http(s).request, so it also covers DNS rebinding. */
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const bad = addresses.find((a) => isPrivateIp(a.address));
    if (bad || !addresses.length) return cb(new Error(`Refusing private address for ${hostname}`));
    if (options.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}

function get(url, { limit, accept }, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Bad URL')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Bad protocol'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) {
      return reject(new Error('Refusing private address'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': UA,
        Accept: accept,
        'Accept-Language': config.lang === 'en' ? 'en,pt;q=0.8' : 'pt-PT,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('Too many redirects'));
        return resolve(get(new URL(res.headers.location, u).toString(), { limit, accept }, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'deflate' ? res.pipe(zlib.createInflate())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          req.destroy();
          // For pages, the <head> is what matters: keep what we have.
          resolve({ body: Buffer.concat(chunks), type: res.headers['content-type'] || '', url: u.toString(), truncated: true });
        } else chunks.push(c);
      });
      stream.on('end', () => resolve({ body: Buffer.concat(chunks), type: res.headers['content-type'] || '', url: u.toString() }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

// ---------- HTML metadata ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

function findProduct(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const p = findProduct(n); if (p) return p; }
    return null;
  }
  const type = [].concat(node['@type'] || []);
  if (type.includes('Product')) return node;
  return findProduct(node['@graph']);
}

/**
 * Fallback for shops that don't publish og:image (notably Amazon):
 * look for well-known product-image markup in the page body.
 */
function imageFromMarkup(html) {
  // Amazon: main product image (#landingImage) or book cover (#imgBlkFront).
  for (const id of ['landingImage', 'imgBlkFront', 'ebooksImgBlkFront']) {
    const tag = html.match(new RegExp(`<img\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i'));
    if (!tag) continue;
    const a = attrs(tag[0]);
    if (a['data-old-hires']) return resizeKnownCdn(a['data-old-hires']);
    if (a['data-a-dynamic-image']) {
      try {
        // {"url": [w, h], ...} — take the largest.
        const best = Object.entries(JSON.parse(a['data-a-dynamic-image']))
          .sort(([, x], [, y]) => y[0] * y[1] - x[0] * x[1])[0];
        if (best) return resizeKnownCdn(best[0]);
      } catch { /* ignore */ }
    }
    if (a.src && !a.src.startsWith('data:')) return resizeKnownCdn(a.src);
  }
  // schema.org microdata: <img itemprop="image" src="…"> / <link itemprop="image" href="…">
  for (const m of html.matchAll(/<(?:img|link)\b[^>]*\bitemprop=["']image["'][^>]*>/gi)) {
    const a = attrs(m[0]);
    const src = a.src || a.href || a['data-src'];
    if (src && !src.startsWith('data:')) return src;
  }
  return undefined;
}

/** Ask Amazon's image CDN for a ~500px version instead of the 1500px original. */
function resizeKnownCdn(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)media-amazon\.com$|(^|\.)ssl-images-amazon\.com$/.test(u.hostname)) {
      u.pathname = u.pathname.replace(/\._[^/]+_\.(jpg|jpeg|png|webp)$/i, '._AC_SL500_.$1');
      return u.toString();
    }
  } catch { /* ignore */ }
  return url;
}

const SYMBOLS = { '€': 'EUR', '£': 'GBP', '$': 'USD', 'R$': 'BRL', 'CHF': 'CHF' };

function formatPrice(amount, currency) {
  const raw = String(amount ?? '').trim();
  if (!/^\d{1,7}([.,]\d{1,2})?$/.test(raw)) return undefined;
  const n = Number(raw.replace(',', '.'));
  if (!(n > 0)) return undefined;
  const code = SYMBOLS[currency] || (/^[A-Z]{3}$/.test(currency || '') ? currency : null);
  try {
    if (code) return new Intl.NumberFormat(config.lang === 'en' ? 'en-GB' : 'pt-PT', { style: 'currency', currency: code }).format(n);
  } catch { /* unknown currency code */ }
  return raw;
}

/** Price as published by the shop: meta tags → JSON-LD offer → microdata → Amazon's page data. */
function findPrice(html, meta, product) {
  const offers = product ? [].concat(product.offers || []) : [];
  const offer = offers[0]?.offers ? [].concat(offers[0].offers)[0] : offers[0]; // AggregateOffer nesting
  const candidates = [
    [meta['product:price:amount'], meta['product:price:currency']],
    [meta['og:price:amount'], meta['og:price:currency']],
    [offer?.price ?? offer?.lowPrice, offer?.priceCurrency],
    [meta.price, meta.pricecurrency], // itemprop on <meta>
  ];
  const itemprop = html.match(/<[^>]+\bitemprop=["']price["'][^>]*>/i);
  if (itemprop) {
    const cur = html.match(/<[^>]+\bitemprop=["']priceCurrency["'][^>]*>/i);
    candidates.push([attrs(itemprop[0]).content, cur && attrs(cur[0]).content]);
  }
  // Amazon
  const amz = html.match(/"priceAmount":(\d+(?:\.\d+)?)/);
  if (amz) candidates.push([amz[1], (html.match(/"currencySymbol":"([^"]{1,3})"/) || [])[1]]);

  for (const [amount, currency] of candidates) {
    const p = amount != null && formatPrice(amount, currency);
    if (p) return p;
  }
  return undefined;
}

export function parseMeta(html, baseUrl) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content && !(key in meta)) meta[key] = a.content.trim();
  }
  let linkImage;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.rel || '').toLowerCase() === 'image_src' && a.href) { linkImage = a.href; break; }
  }
  let product = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { product = findProduct(JSON.parse(m[1].trim())); } catch { /* ignore bad JSON-LD */ }
    if (product) break;
  }

  const ldImage = product && [].concat(product.image || [])[0];
  const image = meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] ||
    meta['twitter:image'] || meta['twitter:image:src'] ||
    (typeof ldImage === 'string' ? ldImage : ldImage?.url) || linkImage || meta.image ||
    imageFromMarkup(html);

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = meta['og:title'] || meta['twitter:title'] || product?.name || (titleTag && decode(titleTag[1]).trim());

  const price = findPrice(html, meta, product);

  let imageUrl;
  try { if (image) imageUrl = new URL(image, baseUrl).toString(); } catch { /* ignore */ }
  return {
    image: imageUrl,
    title: title ? title.replace(/\s+/g, ' ').slice(0, 200) : undefined,
    price,
  };
}

// ---------- images ----------

function imageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buf.subarray(4, 12).toString('ascii').match(/^ftyp(avif|avis)/)) return 'avif';
  return null;
}

export const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
export const IMAGE_FILE_RE = /^[a-z0-9]{8,40}\.(jpg|png|webp|gif|avif)$/;

/** Save an uploaded image (already resized by the browser). Returns the file name or throws. */
export function saveImageBuffer(buf) {
  if (!buf || buf.length > IMAGE_LIMIT) throw new Error('Image too large');
  const ext = imageExt(buf);
  if (!ext) throw new Error('Not a supported image');
  const file = `${randomBytes(12).toString('hex')}.${ext}`;
  writeFileSync(join(IMAGE_DIR, file), buf);
  return file;
}

async function downloadImage(url) {
  const { body, truncated } = await get(url, { limit: IMAGE_LIMIT, accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' });
  if (truncated) throw new Error('Image too large');
  const ext = imageExt(body);
  if (!ext) throw new Error('Not a supported image');
  const file = `${randomBytes(12).toString('hex')}.${ext}`;
  writeFileSync(join(IMAGE_DIR, file), body);
  return file;
}

export function removeImage(file) {
  if (file && IMAGE_FILE_RE.test(file)) {
    try { unlinkSync(join(IMAGE_DIR, file)); } catch { /* already gone */ }
  }
}

/** Delete image files no item references (e.g. after a list was deleted). */
export function sweepImages(referenced) {
  const keep = new Set(referenced);
  for (const f of readdirSync(IMAGE_DIR)) if (!keep.has(f)) removeImage(f);
}

/**
 * Build a preview for an item.
 * @param {string} pageUrl  product page (may be empty)
 * @param {string} imageUrl explicit image link set by the admin (optional, wins over the page)
 * @param {{ wantImage?: boolean }} opts  false = only read title/price (keep the current image)
 */
export async function fetchPreview(pageUrl, imageUrl, { wantImage = true } = {}) {
  let meta = {};
  if (pageUrl) {
    try {
      const page = await get(pageUrl, { limit: PAGE_LIMIT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' });
      if (/html|xml/i.test(page.type) || !page.type) meta = parseMeta(page.body.toString('utf8'), page.url);
      else if (imageExt(page.body)) imageUrl ||= pageUrl; // the link itself is an image
    } catch (err) {
      if (!imageUrl) throw err;
    }
  }
  if (!wantImage) return { file: undefined, title: meta.title, price: meta.price };
  const src = imageUrl || meta.image;
  const file = src ? await downloadImage(src) : null;
  return { file, title: meta.title, price: meta.price };
}
