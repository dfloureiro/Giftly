// Notifications for admins: ntfy, Telegram and/or a generic webhook (Discord/Slack compatible).
//
// Each user has their own channels and chooses which events they want. A guest picking
// a gift notifies every user who enabled that event. Fire-and-forget: a failing channel
// is logged and never breaks the guest's request, and an invalid setting never stops the app.
import { config } from './config.js';
import { makeT } from './i18n.js';
import { db, settings, lists } from './db.js';
import { users } from './accounts.js';
import { postJson, isLocalNotifyHost } from './net.js';

const env = process.env;
const TIMEOUT_MS = 8000;

export const ALL_EVENTS = ['pick', 'unpick', 'join'];
const SECRET_KEYS = ['ntfy_token', 'telegram_bot_token'];

// Flat settings object <-> channel rows.
const CHANNEL_FIELDS = {
  ntfy: { ntfy_url: 'url', ntfy_token: 'token' },
  telegram: { telegram_bot_token: 'bot_token', telegram_chat_id: 'chat_id' },
  webhook: { webhook_url: 'url' },
};

/** A user's settings as one flat object (same shape as the profile form). */
export function userNotifySettings(userId) {
  const out = { ntfy_url: '', ntfy_token: '', telegram_bot_token: '', telegram_chat_id: '', webhook_url: '' };
  for (const row of db.prepare('SELECT type, config FROM notification_channels WHERE user_id = ? AND enabled = 1').all(userId)) {
    let cfg = {};
    try { cfg = JSON.parse(row.config); } catch { /* ignore broken row */ }
    for (const [flat, key] of Object.entries(CHANNEL_FIELDS[row.type] || {})) out[flat] = String(cfg[key] ?? '');
  }
  out.events = users.get(userId)?.notify_events ?? '';
  return out;
}

function storeUserNotifySettings(userId, s) {
  const upsert = db.prepare(`INSERT INTO notification_channels (user_id, type, config, enabled) VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id, type) DO UPDATE SET config = excluded.config, enabled = 1`);
  const remove = db.prepare('DELETE FROM notification_channels WHERE user_id = ? AND type = ?');
  for (const [type, fields] of Object.entries(CHANNEL_FIELDS)) {
    const cfg = Object.fromEntries(Object.entries(fields).map(([flat, key]) => [key, s[flat] || '']));
    const filled = type === 'ntfy' ? cfg.url : type === 'telegram' ? cfg.bot_token || cfg.chat_id : cfg.url;
    if (filled) upsert.run(userId, type, JSON.stringify(cfg));
    else remove.run(userId, type);
  }
  users.setNotifyEvents(userId, s.events);
}

/**
 * Settings from before accounts existed (global admin settings, else NOTIFY_* env vars).
 * Used once, to seed the first account; the global settings are then removed.
 */
export function takeLegacyNotifySettings() {
  const saved = settings.all('notify.');
  const fromEnv = {
    ntfy_url: env.NOTIFY_NTFY_URL, ntfy_token: env.NOTIFY_NTFY_TOKEN,
    telegram_bot_token: env.NOTIFY_TELEGRAM_BOT_TOKEN, telegram_chat_id: env.NOTIFY_TELEGRAM_CHAT_ID,
    webhook_url: env.NOTIFY_WEBHOOK_URL, events: env.NOTIFY_EVENTS,
  };
  const out = {};
  for (const [k, v] of Object.entries(fromEnv)) out[k] = String((k in saved ? saved[k] : v) ?? '').trim();
  out.events = (out.events || 'pick,unpick').split(',').map((e) => e.trim().toLowerCase()).filter((e) => ALL_EVENTS.includes(e)).join(',');
  db.prepare("DELETE FROM settings WHERE key LIKE 'notify.%'").run();
  return out;
}

/** Seed a (new) user's notification settings, ignoring invalid channels. */
export function seedUserNotifySettings(userId, s) {
  const clean = { ...s };
  for (const key of validateNotifySettings(clean)) {
    if (key === 'notify.badNtfy') clean.ntfy_url = '';
    if (key === 'notify.badWebhook') clean.webhook_url = '';
    if (key === 'notify.badTelegram') { clean.telegram_bot_token = ''; clean.telegram_chat_id = ''; }
    console.error(`notifications: ignored an invalid old setting (${key}); fix it in the profile`);
  }
  storeUserNotifySettings(userId, clean);
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
  // Servers on your own network only when the operator allowed them (NOTIFY_ALLOWED_HOSTS).
  const ntfy = s.ntfy_url && parseNtfy(s.ntfy_url);
  const local = (raw) => { try { return isLocalNotifyHost(new URL(raw).hostname); } catch { return false; } };
  if ((ntfy && !ntfy.error && local(ntfy.origin)) || (s.webhook_url && validWebhook(s.webhook_url) && local(s.webhook_url))) {
    errors.push('notify.privateHost');
  }
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
        topic: ntfy.topic, title, message, tags: ['gift'], ...(click && { click }), ...(iconUrl() && { icon: iconUrl() }),
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
        username: 'Giftly',
        ...(iconUrl() && { avatar_url: iconUrl(), icon_url: iconUrl() }),
        content: `**${title}**\n${message}`,
        text: `*${title}*\n${message}`,
        event, title, message, url: click, ...data,
      }),
    });
  }
  return channels;
}

const eventSet = (s) => new Set(s.events.split(',').map((e) => e.trim().toLowerCase()).filter((e) => ALL_EVENTS.includes(e)));

/** For the profile page: current values (secrets reduced to "is set"), channels and problems. */
export function notifyStatus(userId) {
  const s = userNotifySettings(userId);
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
 * Save the profile form. Secret fields left empty keep their current value unless
 * the matching "clear_*" box is ticked. Returns { errors } (nothing saved on error).
 */
export function saveNotifySettings(userId, body) {
  const current = userNotifySettings(userId);
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
  storeUserNotifySettings(userId, next);
  return { errors: [] };
}

const post = (url, body, headers = {}) => postJson(url, body, headers, { timeout: TIMEOUT_MS });

const iconUrl = () => {
  const base = (env.BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/icon-192.png` : undefined;
};

function adminUrl(list) {
  const base = (env.BASE_URL || '').replace(/\/$/, '');
  return base && list ? `${base}/admin/lists/${list.id}` : undefined;
}

function message(event, { list, guest, item, byUser }) {
  const t = makeT(config.lang);
  const vars = {
    admin: byUser?.name ?? '',
    name: guest?.name ?? '',
    item: item?.title ?? '',
    price: item?.price ? ` (${item.price})` : '',
    list: list?.title ?? '',
  };
  return {
    event,
    // An admin reserving on someone's behalf: "Diogo reserved a gift for Ana".
    title: t(byUser && event === 'pick' ? 'notify.pickByAdmin.title' : `notify.${event}.title`, vars),
    message: t(`notify.${event}.message`, vars),
    click: adminUrl(list),
    data: { reserved_by_admin: byUser?.name, list: list?.title, guest: guest?.name, item: item?.title, price: item?.price || undefined, item_url: item?.url || undefined },
  };
}

/** Channels a user has set up (names), e.g. to tell them to configure one first. */
export const userChannels = (userId) => buildChannels(userNotifySettings(userId)).map((c) => c.name);

/** Send a ready-made message ({ event, title, message, click?, data? }) to one user. */
export const notifyUser = (userId, msg) => sendToUser(userId, { data: {}, ...msg });

function sendToUser(userId, msg) {
  const channels = buildChannels(userNotifySettings(userId));
  return Promise.all(channels.map((c) =>
    c.send(msg).then(() => ({ user: userId, channel: c.name, ok: true }), (err) => {
      console.warn(`notify user ${userId} via ${c.name} failed: ${err.message}`);
      return { user: userId, channel: c.name, ok: false, error: err.message };
    })));
}

/**
 * Notify every user who enabled `event` (or only `onlyUserId`, e.g. a test message).
 * Returns a promise with per-channel results; callers normally don't await it.
 */
export async function notify(event, data = {}, { onlyUserId, exceptUserId } = {}) {
  const msg = message(event, data);
  // List events only reach admins who can see that list (private lists, lists made from
  // someone's wishlist: never their owner).
  const targets = onlyUserId
    ? [onlyUserId]
    : users.all().filter((u) => u.id !== exceptUserId && eventSet({ events: u.notify_events }).has(event)
        && (!data.list || lists.canSee(u.id, data.list.id))).map((u) => u.id);
  return (await Promise.all(targets.map((id) => sendToUser(id, msg)))).flat();
}
