import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;

const dataDir = env.DATA_DIR || './data';

function loadSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  // Generate once and persist alongside the database so sessions survive restarts.
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, '.session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}


export const config = {
  port: env.PORT ? Number(env.PORT) : 3000, // 0 = random free port (tests)
  // Unset = Node's default: all interfaces, IPv6 and IPv4 (dual-stack) when available.
  host: env.HOST || undefined,
  dataDir,
  // Only used on first start, to create the first account when none exists.
  bootstrapUsername: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
  bootstrapPassword: env.ADMIN_PASSWORD || '',
  sessionSecret: loadSecret(),
  siteTitle: env.SITE_TITLE || '',
  // Currency for prices typed by hand (shop prices keep their own currency).
  currency: /^[A-Z]{3}$/.test(env.CURRENCY || '') ? env.CURRENCY : 'EUR',
  // Require two-factor authentication for every admin (default: optional per user).
  require2fa: ['1', 'true', 'yes'].includes(String(env.REQUIRE_2FA ?? 'false').toLowerCase()),
  // Hour of the day (0–23, in TZ) when daily reminders are sent.
  reminderHour: Number.isInteger(Number(env.REMINDER_HOUR)) && env.REMINDER_HOUR !== '' && Number(env.REMINDER_HOUR) >= 0 && Number(env.REMINDER_HOUR) <= 23
    ? Number(env.REMINDER_HOUR) : 9,
  lang: (env.APP_LANG || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt',
  timeZone: env.TZ || 'Europe/Lisbon',
  // Trust X-Forwarded-* / CF-Connecting-IP headers (set when behind Cloudflare Tunnel or a reverse proxy).
  // Only ever believed from private/loopback peers (see trustedProxyPeer in net.js).
  trustProxy: ['1', 'true', 'yes'].includes(String(env.TRUST_PROXY ?? 'true').toLowerCase()),
  // Fetch product pages to show an image for each gift.
  previews: !['0', 'false', 'no'].includes(String(env.LINK_PREVIEWS ?? 'true').toLowerCase()),
  // Notification servers on your own network (e.g. a self-hosted ntfy): host names or IPs, comma-separated.
  notifyAllowedHosts: String(env.NOTIFY_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().replace(/^\[|\]$/g, '').toLowerCase()).filter(Boolean),
  // 'auto' = Secure cookies when the request arrived over HTTPS.
  cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(),
};
