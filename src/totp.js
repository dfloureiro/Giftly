// TOTP two-factor authentication (RFC 6238 / RFC 4226): SHA-1, 6 digits, 30-second steps —
// what Google Authenticator, Aegis, 1Password, Bitwarden etc. expect. Plus recovery codes.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits), base32. */
export const newSecret = () => base32Encode(randomBytes(20));

/** HOTP code for a counter (RFC 4226), as a zero-padded string. */
export function hotp(secret, counter, digits = DIGITS) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const counterAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

/**
 * Check a 6-digit code, allowing one step of clock drift either way. Returns the matching
 * counter (to store, so the same code can't be used twice) or null. `after` rejects counters
 * at or before the last one used.
 */
export function verifyTotp(secret, code, { now = Date.now(), after = -1 } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const current = counterAt(now);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter <= after) continue;
    const expected = Buffer.from(hotp(secret, counter));
    if (timingSafeEqual(expected, Buffer.from(c))) return counter;
  }
  return null;
}

/** otpauth:// URI for authenticator apps (and the QR code). */
export function otpauthUri({ secret, account, issuer = 'Giftly' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// ---------- recovery codes ----------

const hashCode = (code) => createHash('sha256').update(normalizeRecovery(code)).digest('hex');
export const normalizeRecovery = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 10 codes like "k7d2-m9qx" (shown once) and their hashes (stored). */
export function newRecoveryCodes(n = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
  const codes = Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => chars[x % chars.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}

/** If `code` matches one of `hashes`, returns the remaining hashes (that code is used up); else null. */
export function useRecoveryCode(hashes, code) {
  if (normalizeRecovery(code).length !== 8) return null;
  const h = hashCode(code);
  const i = hashes.indexOf(h);
  return i < 0 ? null : hashes.filter((_, j) => j !== i);
}
