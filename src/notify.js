// Admin notifications: ntfy, Telegram and/or a generic webhook (Discord/Slack compatible).
//
// Settings live in the database and are edited in the admin. NOTIFY_* environment
// variables are only defaults for settings never saved there. Fire-and-forget: a
// failing channel is logged and never breaks the guest's request, and an invalid
// setting never stops the app.
import { config } from './config.js';
import { makeT } from './i18n.js';
import { settings } from './db.js';

const env = process.env;
const TIMEOUT_MS = 8000;

export const ALL_EVENTS = ['pick', 'unpick', 'join'];
const SECRET_KEYS = ['ntfy_token', 'telegram_bot_token'];
const ENV_DEFAULTS = {
  ntfy_url: 'NOTIFY_NTFY_URL',
  ntfy_token: 'NOTIFY_NTFY_TOKEN',
  telegram_bot_token: 'NOTIFY_TELEGRAM_BOT_TOKEN',
  telegram_chat_id: 'NOTIFY_TELEGRAM_CHAT_ID',
  webhook_url: 'NOTIFY_WEBHOOK_URL',
  events: 'NOTIFY_EVENTS',
};

/** Effective settings: saved in the admin, else environment, else defaults. */
export function notifySettings() {
  const saved = settings.all('notify.');
  const out = {};
  for (const [key, envName] of Object.entries(ENV_DEFAULTS)) {
    out[key] = (key in saved ? saved[key] : env[envName] ?? '').trim();
  }
  if (!('events' in saved) && !env.NOTIFY_EVENTS) out.events = 'pick,unpick';
  return out;
}

function parseNtfy(raw) {
  if (!raw) return null;
  let origin, topic;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      origin = u.origin;
      topic = u.pathname.replace(/^\/+|\/+$/g, '');
    } catch { return { error: true }; }
  } else {
    origin = 'https://ntfy.sh';
    topic = raw;
  }
  return /^[-_A-Za-z0-9]{1,64}$/.test(topic || '') ? { origin, topic } : { error: true };
}

function validWebhook(raw) {
  try { return /^https?:$/.test(new URL(raw).protocol); } catch { return false; }
}

/** Returns translation keys for invalid values (used both when saving and at runtime). */
export function validateNotifySettings(s) {
  const errors = [];
  if (s.ntfy_url && parseNtfy(s.ntfy_url)?.error) errors.push('notify.badNtfy');
  if (s.webhook_url && !validWebhook(s.webhook_url)) errors.push('notify.badWebhook');
  if (!!s.telegram_bot_token !== !!s.telegram_chat_id) errors.push('notify.badTelegram');
  return errors;
}

function buildChannels(s) {
  const channels = [];
  const ntfy = parseNtfy(s.ntfy_url);
  if (ntfy && !ntfy.error) {
    channels.push({
      name: 'ntfy',
      send: ({ title, message, click }) => post(`${ntfy.origin}/`, {
        topic: ntfy.topic, title, message, tags: ['gift'], ...(click && { click }),
      }, s.ntfy_token ? { Authorization: `Bearer ${s.ntfy_token}` } : {}),
    });
  }
  if (s.telegram_bot_token && s.telegram_chat_id) {
    channels.push({
      name: 'telegram',
      send: ({ title, message, click }) => post(
        `https://api.telegram.org/bot${s.telegram_bot_token}/sendMessage`,
        { chat_id: s.telegram_chat_id, text: [title, message, click].filter(Boolean).join('\n'), disable_web_page_preview: true },
      ),
    });
  }
  if (s.webhook_url && validWebhook(s.webhook_url)) {
    channels.push({
      name: 'webhook',
      // `content` → Discord, `text` → Slack; the rest is for custom integrations.
      send: ({ title, message, click, event, data }) => post(s.webhook_url, {
        content: `**${title}**\n${message}`,
        text: `*${title}*\n${message}`,
        event, title, message, url: click, ...data,
      }),
    });
  }
  return channels;
}

const eventSet = (s) => new Set(s.events.split(',').map((e) => e.trim().toLowerCase()).filter((e) => ALL_EVENTS.includes(e)));

/** For the admin page: current values (secrets reduced to "is set"), channels and problems. */
export function notifyStatus() {
  const s = notifySettings();
  return {
    values: {
      ntfy_url: s.ntfy_url,
      telegram_chat_id: s.telegram_chat_id,
      webhook_url: s.webhook_url,
      events: [...eventSet(s)],
      ntfy_token_set: !!s.ntfy_token,
      telegram_bot_token_set: !!s.telegram_bot_token,
    },
    channels: buildChannels(s).map((c) => c.name),
    problems: validateNotifySettings(s),
  };
}

/**
 * Save the admin form. Secret fields left empty keep their current value unless
 * the matching "clear_*" box is ticked. Returns { errors } (nothing saved on error).
 */
export function saveNotifySettings(body) {
  const current = notifySettings();
  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const next = {
    ntfy_url: clean(body.ntfy_url, 300),
    telegram_chat_id: clean(body.telegram_chat_id, 64),
    webhook_url: clean(body.webhook_url, 2000),
    events: ALL_EVENTS.filter((e) => body[`event_${e}`] === '1').join(','),
  };
  for (const key of SECRET_KEYS) {
    const given = clean(body[key], 500);
    next[key] = body[`clear_${key}`] === '1' ? '' : given || current[key];
  }
  const errors = validateNotifySettings(next);
  if (errors.length) return { errors, values: next };
  settings.setMany(Object.fromEntries(Object.entries(next).map(([k, v]) => [`notify.${k}`, v])));
  return { errors: [] };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function adminUrl(list) {
  const base = (env.BASE_URL || '').replace(/\/$/, '');
  return base && list ? `${base}/admin/lists/${list.id}` : undefined;
}

/** Returns a promise with per-channel results; callers normally don't await it. */
export function notify(event, { list, guest, item } = {}) {
  const s = notifySettings();
  const channels = buildChannels(s);
  if (!channels.length || (event !== 'test' && !eventSet(s).has(event))) return Promise.resolve([]);
  const t = makeT(config.lang);
  // Anonymous lists: never say who picked or gave up a gift.
  const hideName = !!list?.anonymous && (event === 'pick' || event === 'unpick');
  const key = hideName ? `notify.${event}.anon` : `notify.${event}`;
  const vars = {
    name: guest?.name ?? '',
    item: item?.title ?? '',
    price: item?.price ? ` (${item.price})` : '',
    list: list?.title ?? '',
  };
  const msg = {
    event,
    title: t(`${key}.title`, vars),
    message: t(`notify.${event}.message`, vars),
    click: adminUrl(list),
    data: { list: list?.title, guest: hideName ? undefined : guest?.name, item: item?.title, price: item?.price || undefined, item_url: item?.url || undefined },
  };
  return Promise.all(channels.map((c) =>
    c.send(msg).then(() => ({ channel: c.name, ok: true }), (err) => {
      console.warn(`notify via ${c.name} failed: ${err.message}`);
      return { channel: c.name, ok: false, error: err.message };
    })));
}

// Report invalid environment defaults once at startup (never fatal).
for (const key of validateNotifySettings(notifySettings())) {
  console.error(`notifications: invalid setting (${key}); that channel is disabled until fixed in the admin`);
}
