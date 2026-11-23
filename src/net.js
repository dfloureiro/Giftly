// Network guards shared by link previews, notifications and the proxy-header rule.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { config } from './config.js';

/** Loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** DNS lookup that refuses private addresses — used by http(s).request, so it also covers DNS rebinding. */
export function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const bad = addresses.find((a) => isPrivateIp(a.address));
    if (bad || !addresses.length) return cb(new Error(`Refusing private address for ${hostname}`));
    if (options.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * Proxy headers (X-Forwarded-*, CF-Connecting-IP) are only believed when TRUST_PROXY is on AND
 * the connection comes from a private or loopback address — i.e. from a reverse proxy or
 * cloudflared next to Giftly. Someone reaching the port directly from the internet can't fake them.
 */
export const trustedProxyPeer = (remoteAddress) => config.trustProxy && !!remoteAddress && isPrivateIp(remoteAddress);

const bare = (host) => String(host).replace(/^\[|\]$/g, '').toLowerCase();

/** Hosts the operator explicitly allowed for notifications on the local network (NOTIFY_ALLOWED_HOSTS). */
export const notifyHostAllowed = (host) => config.notifyAllowedHosts.includes(bare(host));

/** Is this notification URL's host obviously local (checked when saving; DNS is checked when sending)? */
export function isLocalNotifyHost(host) {
  const h = bare(host);
  if (notifyHostAllowed(h)) return false;
  return h === 'localhost' || h.endsWith('.localhost') || (net.isIP(h) > 0 && isPrivateIp(h));
}

/**
 * POST JSON for notifications. Private/local destinations are refused unless allowed in
 * NOTIFY_ALLOWED_HOSTS (checked on the resolved address, so DNS tricks don't help), redirects
 * are never followed, and the response body is never returned (no reading internal services).
 */
export function postJson(url, body, headers = {}, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Bad URL')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Bad protocol'));
    const allowed = notifyHostAllowed(u.hostname);
    if (!allowed && isLocalNotifyHost(u.hostname)) {
      return reject(new Error(`Refusing private address ${bare(u.hostname)} (allow it with NOTIFY_ALLOWED_HOSTS)`));
    }
    const data = Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      lookup: allowed ? undefined : safeLookup,
      timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
      reject(new Error(res.statusCode >= 300 && res.statusCode < 400 ? `HTTP ${res.statusCode} (redirects are not followed)` : `HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (err) => reject(new Error(err.message.includes('Refusing private')
      ? `Refusing private address for ${bare(u.hostname)} (allow it with NOTIFY_ALLOWED_HOSTS)` : err.message)));
    req.end(data);
  });
}
