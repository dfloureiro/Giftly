// Network guards shared by link previews, notifications and the proxy-header rule.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { config } from './config.js';

// ---------- non-public addresses ----------

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) are NOT listed: a BlockList IPv6 rule
  // for them also matches every plain IPv4 address. normalizeAddress turns them into IPv4 first.
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], // unspecified, loopback, NAT64
  ['100::', 64], ['2001::', 32], ['2002::', 16], // discard, Teredo, 6to4
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], // unique local, link-local, site-local, multicast
]) BLOCKED.addSubnet(addr, prefix, 'ipv6');

/** The 8 groups of an IPv6 address (handles "::" and a trailing dotted IPv4), or null. */
function ipv6Groups(ip) {
  let s = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * One canonical form for comparisons: brackets and zone removed, lower case, and IPv6 forms
 * that carry an IPv4 address (::ffff:a.b.c.d, ::ffff:7f00:1, ::a.b.c.d) turned into that IPv4.
 */
export function normalizeAddress(raw) {
  let ip = String(raw ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  ip = ip.replace(/%.*$/, '');
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return ip;
  const g = ipv6Groups(ip);
  if (!g) return ip;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4(g[6], g[7]); // IPv4-mapped
  if (zeros(6) && (g[6] || g[7] > 1)) return v4(g[6], g[7]); // IPv4-compatible (not :: or ::1)
  return g.map((x) => x.toString(16)).join(':');
}

/**
 * Loopback, private, link-local, CGNAT, multicast, documentation and other non-public
 * addresses, in any notation (IPv4-mapped/compatible IPv6, NAT64, 6to4, Teredo…).
 * Anything that isn't a valid IP address counts as non-public too.
 */
export function isPrivateIp(raw) {
  const ip = normalizeAddress(raw);
  if (net.isIPv4(ip)) return BLOCKED.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return BLOCKED.check(ip, 'ipv6');
  return true;
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

const bare = (host) => normalizeAddress(host);

/** Hosts the operator explicitly allowed for notifications on the local network (NOTIFY_ALLOWED_HOSTS). */
export const notifyHostAllowed = (host) => config.notifyAllowedHosts.map(normalizeAddress).includes(bare(host));

/** Is this notification URL's host obviously local (checked when saving; DNS is checked when sending)? */
export function isLocalNotifyHost(host) {
  const h = bare(host);
  if (notifyHostAllowed(h)) return false;
  return h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.' || (net.isIP(h) > 0 && isPrivateIp(h));
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
