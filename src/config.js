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

if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD must be set (at least 8 characters).');
  process.exit(1);
}

export const config = {
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  dataDir,
  adminPassword: env.ADMIN_PASSWORD,
  sessionSecret: loadSecret(),
  siteTitle: env.SITE_TITLE || '',
  lang: (env.APP_LANG || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt',
  timeZone: env.TZ || 'Europe/Lisbon',
  // Trust X-Forwarded-* / CF-Connecting-IP headers (set when behind Cloudflare Tunnel or a reverse proxy).
  trustProxy: ['1', 'true', 'yes'].includes(String(env.TRUST_PROXY ?? 'true').toLowerCase()),
  // 'auto' = Secure cookies when the request arrived over HTTPS.
  cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(),
};
