// Admin notifications: ntfy, Telegram and/or a generic webhook (Discord/Slack compatible).
// All optional, configured through environment variables. Fire-and-forget: a failing
// channel is logged and never breaks the guest's request.
import { config } from './config.js';
import { makeT } from './i18n.js';

const env = process.env;
const TIMEOUT_MS = 8000;

const channels = [];

// A bad notification setting must never stop the app: log it and skip that channel.
export const notifyProblems = [];
const invalid = (name, why) => {
  notifyProblems.push(`${name}: ${why}`);
  console.error(`notifications: ${name} disabled — ${why}`);
};

if (env.NOTIFY_NTFY_URL) {
  // https://ntfy.sh/my-secret-topic, https://my-ntfy.example/topic, or just "my-secret-topic" (→ ntfy.sh).
  // Published as JSON so titles can use any characters.
  const raw = env.NOTIFY_NTFY_URL.trim();
  let origin, topic;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      origin = u.origin;
      topic = u.pathname.replace(/^\/+|\/+$/g, '');
    } catch { /* reported below */ }
  } else {
    origin = 'https://ntfy.sh';
    topic = raw;
  }
  if (!origin || !/^[-_A-Za-z0-9]{1,64}$/.test(topic || '')) {
    invalid('ntfy', 'NOTIFY_NTFY_URL must be like https://ntfy.sh/<topic>, and the topic may only use letters, numbers, "-" and "_"');
  } else {
    channels.push({
      name: 'ntfy',
      send: ({ title, message, click }) => post(`${origin}/`, {
        topic, title, message, tags: ['gift'], ...(click && { click }),
      }, env.NOTIFY_NTFY_TOKEN ? { Authorization: `Bearer ${env.NOTIFY_NTFY_TOKEN}` } : {}),
    });
  }
}

if (env.NOTIFY_TELEGRAM_BOT_TOKEN && env.NOTIFY_TELEGRAM_CHAT_ID) {
  channels.push({
    name: 'telegram',
    send: ({ title, message, click }) => post(
      `https://api.telegram.org/bot${env.NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: env.NOTIFY_TELEGRAM_CHAT_ID, text: [title, message, click].filter(Boolean).join('\n'), disable_web_page_preview: true },
    ),
  });
}

let webhookOk = false;
try { webhookOk = !!env.NOTIFY_WEBHOOK_URL && /^https?:$/.test(new URL(env.NOTIFY_WEBHOOK_URL).protocol); } catch { /* below */ }
if (env.NOTIFY_WEBHOOK_URL && !webhookOk) invalid('webhook', 'NOTIFY_WEBHOOK_URL must be an http(s) URL');

if (webhookOk) {
  channels.push({
    name: 'webhook',
    // `content` → Discord, `text` → Slack; the rest is for custom integrations.
    send: ({ title, message, click, event, data }) => post(env.NOTIFY_WEBHOOK_URL, {
      content: `**${title}**\n${message}`,
      text: `*${title}*\n${message}`,
      event, title, message, url: click, ...data,
    }),
  });
}

const EVENTS = new Set(
  String(env.NOTIFY_EVENTS || 'pick,unpick').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

export const notifyChannels = () => channels.map((c) => c.name);

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
  if (!channels.length || (event !== 'test' && !EVENTS.has(event))) return Promise.resolve([]);
  const t = makeT(config.lang);
  const vars = {
    name: guest?.name ?? '',
    item: item?.title ?? '',
    price: item?.price ? ` (${item.price})` : '',
    list: list?.title ?? '',
  };
  const msg = {
    event,
    title: t(`notify.${event}.title`, vars),
    message: t(`notify.${event}.message`, vars),
    click: adminUrl(list),
    data: { list: list?.title, guest: guest?.name, item: item?.title, price: item?.price || undefined, item_url: item?.url || undefined },
  };
  return Promise.all(channels.map((c) =>
    c.send(msg).then(() => ({ channel: c.name, ok: true }), (err) => {
      console.warn(`notify via ${c.name} failed: ${err.message}`);
      return { channel: c.name, ok: false, error: err.message };
    })));
}
