// Daily reminders for "Gifts to give".
//
// Once a day (at REMINDER_HOUR, in TZ) each admin gets a message for every upcoming
// birthday or occasion that still lacks a gift, `reminder_days` before it (default 14 and 3).
// Everything is computed per user with the same visibility rule as the rest of the module,
// so shared occasions remind every admin and private ones only their owner.
//
// Thresholds work as windows: with "14,3", a birthday 13 days away that never got its
// 14-day reminder (e.g. the server was down) still gets it today. reminder_log makes sure
// each (user, occasion, threshold) is sent at most once, and that a failed send is retried
// on the next hourly run.
import { config } from './config.js';
import { db } from './db.js';
import { users } from './accounts.js';
import { people, occasions, gifts, checklist, nextBirthday, daysBetween, today, HAS_GIFT } from './giving.js';
import { notifyUser, userChannels } from './notify.js';
import { makeT } from './i18n.js';

const MAX_DAYS = 90;

/** "14, 3" → [3, 14]; invalid parts are dropped. Empty means reminders are off. */
export function parseReminderDays(text) {
  const out = new Set();
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    if (!part) continue;
    const n = Number(part);
    if (Number.isInteger(n) && n >= 0 && n <= MAX_DAYS) out.add(n);
  }
  return [...out].sort((a, b) => a - b).slice(0, 6);
}

/** Smallest threshold that `left` days fall under (3 for 0–3, 14 for 4–14…), or null. */
export function thresholdFor(days, left) {
  return days.find((d) => left <= d) ?? null;
}

/** What should be reminded to `user` on `on` (YYYY-MM-DD), before checking the log. */
export function dueReminders(user, on = today()) {
  const days = parseReminderDays(user.reminder_days);
  if (!days.length) return [];
  const uid = user.id;
  const out = [];

  for (const p of people.list(uid)) {
    if (!p.birthday_month || !p.birthday_day) continue;
    const { date, year } = nextBirthday(p.birthday_month, p.birthday_day, on);
    const left = daysBetween(on, date);
    const threshold = thresholdFor(days, left);
    if (threshold == null) continue;
    const list = gifts.forBirthday(uid, p.id, year);
    if (list.some((g) => HAS_GIFT.includes(g.status))) continue; // already has a gift
    out.push({ key: `birthday:${p.id}:${year}`, threshold, kind: 'birthday', left, date, person: p, planned: list.length });
  }

  for (const o of occasions.list(uid)) {
    if (o.date < on) continue;
    const left = daysBetween(on, o.date);
    const threshold = thresholdFor(days, left);
    if (threshold == null) continue;
    const c = checklist(uid, o);
    const missing = c.total - c.done;
    if (!c.total || !missing) continue;
    out.push({ key: `occasion:${o.id}`, threshold, kind: 'occasion', left, date: o.date, occasion: o, missing, total: c.total });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const alreadySent = (uid, r) => !!db.prepare('SELECT 1 FROM reminder_log WHERE user_id = ? AND key = ? AND days_before = ?')
  .get(uid, r.key, r.threshold);
const markSent = (uid, r) => db.prepare('INSERT OR IGNORE INTO reminder_log (user_id, key, days_before, sent_at) VALUES (?, ?, ?, ?)')
  .run(uid, r.key, r.threshold, Date.now());

function message(r) {
  const t = makeT(config.lang);
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  const when = r.left === 0 ? t('remind.today') : r.left === 1 ? t('remind.tomorrow') : t('remind.inDays', { n: r.left });
  if (r.kind === 'birthday') {
    return {
      event: 'reminder',
      title: t('remind.birthdayTitle', { when, name: r.person.name }),
      message: r.planned ? t('remind.birthdayPlanned', { n: r.planned }) : t('remind.birthdayNoGift'),
      click: base ? `${base}/admin/people/${r.person.id}` : undefined,
      data: { person: r.person.name, date: r.date, days_left: r.left },
    };
  }
  return {
    event: 'reminder',
    title: t('remind.occasionTitle', { when, name: r.occasion.name }),
    message: t('remind.occasionMissing', { missing: r.missing, total: r.total }),
    click: base ? `${base}/admin/occasions/${r.occasion.id}` : undefined,
    data: { occasion: r.occasion.name, date: r.date, days_left: r.left, missing: r.missing },
  };
}

/**
 * Send one user's due reminders. With `ignoreLog` (the profile's test button) everything
 * due today is sent again and nothing is recorded. Returns the number of messages sent.
 */
export async function remindUser(user, { on = today(), ignoreLog = false } = {}) {
  if (!userChannels(user.id).length) return 0;
  let sent = 0;
  for (const r of dueReminders(user, on)) {
    if (!ignoreLog && alreadySent(user.id, r)) continue;
    const results = await notifyUser(user.id, message(r));
    // Recorded only if it reached at least one channel; otherwise retried on the next run.
    if (results.some((x) => x.ok)) {
      sent++;
      if (!ignoreLog) markSent(user.id, r);
    }
  }
  return sent;
}

function localNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

let running = false;

/**
 * Runs every hour from REMINDER_HOUR on. Nothing marks the day as "done": each run sends
 * what is due and not yet in reminder_log, which only records a reminder once at least one
 * channel accepted it. So a restart or a failing channel is simply retried an hour later,
 * and nothing is ever sent twice.
 */
export async function runReminders({ now = new Date(), force = false } = {}) {
  const { date, hour } = localNow(now);
  if (!force && hour < config.reminderHour) return null;
  if (running) return null;
  running = true;
  let total = 0;
  try {
  // Every user in parallel: a slow or failing channel of one never delays anyone else.
  const everyone = users.all();
  const results = await Promise.allSettled(everyone.map((user) => remindUser(user, { on: date })));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') total += r.value;
    else console.warn(`reminders for user ${everyone[i].id} failed: ${r.reason?.message}`);
  });
  } finally { running = false; }
  if (total) console.log(`reminders: sent ${total} message(s) for ${date}`);
  return total;
}

export function startReminders() {
  const tick = () => runReminders().catch((err) => console.warn(`reminders: ${err.message}`));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 3600_000).unref();
}
