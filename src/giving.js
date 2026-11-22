// "Gifts to give": people, occasions and the gifts admins plan to give them.
//
// PRIVACY RULE (the only place it lives): a row is visible to user U when
//   visibility = 'shared'  OR  owner_id = U
// and a gift is only visible when ALL its people (joint gifts can have several) and its
// occasion, if any, are visible too.
// Every read in this module goes through `visible()` / `GIFT_VISIBLE`, including counts
// and totals, so private entries never leak into another admin's views.
import { db, tx } from './db.js';
import { config } from './config.js';

const now = () => Date.now();

/** SQL condition: row `alias` is visible to the user bound as $uid. */
const visible = (alias) => `(${alias}.visibility = 'shared' OR ${alias}.owner_id = $uid)`;
const GIFT_VISIBLE = `${visible('g')} AND ${visible('p')} AND (g.occasion_id IS NULL OR ${visible('o')})
  AND NOT EXISTS (SELECT 1 FROM gift_people gpv JOIN people pv ON pv.id = gpv.person_id
                  WHERE gpv.gift_id = g.id AND NOT ${visible('pv')})`;
/** SQL condition: the gift is (also) for person $pid. */
const FOR_PERSON = 'EXISTS (SELECT 1 FROM gift_people gpf WHERE gpf.gift_id = g.id AND gpf.person_id = $pid)';
const GIFT_FROM = `FROM gifts g JOIN people p ON p.id = g.person_id LEFT JOIN occasions o ON o.id = g.occasion_id`;

export const VISIBILITIES = ['shared', 'private'];
export const STATUSES = ['idea', 'bought', 'given'];
export const HAS_GIFT = ['bought', 'given']; // "already has a gift"

// ---------- dates ----------

/** Today as YYYY-MM-DD in the configured time zone. */
export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n) => String(n).padStart(2, '0');

/** The date of a birthday in a given year (29 Feb → 28 Feb in non-leap years). */
export function birthdayIn(year, month, day) {
  const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
  return `${year}-${pad(month)}-${pad(d)}`;
}

/** Next occurrence (today included) of a birthday: { date, year }. */
export function nextBirthday(month, day, from = today()) {
  const y = Number(from.slice(0, 4));
  const thisYear = birthdayIn(y, month, day);
  return thisYear >= from ? { date: thisYear, year: y } : { date: birthdayIn(y + 1, month, day), year: y + 1 };
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

// ---------- people ----------

export const people = {
  list(uid) {
    return db.prepare(`SELECT p.* FROM people p WHERE ${visible('p')} ORDER BY p.name COLLATE NOCASE`).all({ uid });
  },
  get(uid, id) {
    return db.prepare(`SELECT p.* FROM people p WHERE p.id = $id AND ${visible('p')}`).get({ uid, id }) ?? null;
  },
  create(uid, f) {
    return Number(db.prepare(`INSERT INTO people
      (name, birthday_month, birthday_day, birth_year, notes, gives_christmas, visibility, owner_id, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      f.name, f.birthday_month ?? null, f.birthday_day ?? null, f.birth_year ?? null, f.notes ?? '', f.gives_christmas ? 1 : 0,
      f.visibility ?? 'shared', uid, f.user_id ?? null, now(),
    ).lastInsertRowid);
  },
  /** Only the owner may change visibility (otherwise it is left as is). */
  update(uid, id, f) {
    const p = people.get(uid, id);
    if (!p) return false;
    const visibility = p.owner_id === uid ? f.visibility : p.visibility;
    db.prepare(`UPDATE people SET name = ?, birthday_month = ?, birthday_day = ?, birth_year = ?, notes = ?,
      gives_christmas = ?, visibility = ?, user_id = ? WHERE id = ?`).run(
      f.name, f.birthday_month ?? null, f.birthday_day ?? null, f.birth_year ?? null, f.notes ?? '', f.gives_christmas ? 1 : 0, visibility,
      f.user_id === undefined ? p.user_id : f.user_id, id,
    );
    return true;
  },
  delete(uid, id) {
    if (!people.get(uid, id)) return false;
    tx(() => {
      // Joint gifts whose main person this is move to another of their people (not deleted).
      for (const { gift_id } of db.prepare('SELECT gift_id FROM gift_people WHERE person_id = ?').all(id)) {
        const other = db.prepare('SELECT person_id FROM gift_people WHERE gift_id = ? AND person_id != ? LIMIT 1').get(gift_id, id);
        if (other) db.prepare('UPDATE gifts SET person_id = ? WHERE id = ? AND person_id = ?').run(other.person_id, gift_id, id);
      }
      db.prepare('DELETE FROM people WHERE id = ?').run(id);
    });
    return true;
  },
};

// ---------- occasions (Christmas / custom; birthdays are derived from people) ----------

export const occasions = {
  list(uid) {
    return db.prepare(`SELECT o.* FROM occasions o WHERE ${visible('o')} ORDER BY o.date DESC, o.id DESC`).all({ uid });
  },
  get(uid, id) {
    return db.prepare(`SELECT o.* FROM occasions o WHERE o.id = $id AND ${visible('o')}`).get({ uid, id }) ?? null;
  },
  create(uid, { type, name, date, visibility }, personIds = []) {
    return tx(() => {
      const id = Number(db.prepare('INSERT INTO occasions (type, name, date, visibility, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(type, name, date, visibility, uid, now()).lastInsertRowid);
      occasions.setParticipants(uid, id, personIds);
      return id;
    });
  },
  update(uid, id, { name, date, visibility }) {
    const o = occasions.get(uid, id);
    if (!o) return false;
    db.prepare('UPDATE occasions SET name = ?, date = ?, visibility = ? WHERE id = ?')
      .run(name, date, o.owner_id === uid ? visibility : o.visibility, id);
    return true;
  },
  delete(uid, id) {
    if (!occasions.get(uid, id)) return false;
    db.prepare('DELETE FROM occasions WHERE id = ?').run(id);
    return true;
  },
  /** Participants this user can see. */
  participants(uid, id) {
    return db.prepare(`SELECT p.* FROM occasion_people op JOIN people p ON p.id = op.person_id
      WHERE op.occasion_id = $id AND ${visible('p')} ORDER BY p.name COLLATE NOCASE`).all({ uid, id });
  },
  /**
   * Replace the participants *this user can see* with `personIds` (only visible people are
   * accepted). Participants hidden from this user (someone else's private people) are kept.
   */
  setParticipants(uid, id, personIds) {
    const allowed = new Set(people.list(uid).map((p) => p.id));
    const wanted = [...new Set(personIds.map(Number))].filter((pid) => allowed.has(pid));
    tx(() => {
      db.prepare(`DELETE FROM occasion_people WHERE occasion_id = $id
        AND person_id IN (SELECT p.id FROM people p WHERE ${visible('p')})`).run({ uid, id });
      const ins = db.prepare('INSERT OR IGNORE INTO occasion_people (occasion_id, person_id) VALUES (?, ?)');
      for (const pid of wanted) ins.run(id, pid);
    });
  },
  addParticipant(uid, id, personId) {
    if (!occasions.get(uid, id) || !people.get(uid, personId)) return false;
    db.prepare('INSERT OR IGNORE INTO occasion_people (occasion_id, person_id) VALUES (?, ?)').run(id, personId);
    return true;
  },
  removeParticipant(uid, id, personId) {
    if (!occasions.get(uid, id) || !people.get(uid, personId)) return false;
    db.prepare('DELETE FROM occasion_people WHERE occasion_id = ? AND person_id = ?').run(id, personId);
    return true;
  },
  /** The Christmas occasion of a year, if this user can see one. */
  christmasOf(uid, year) {
    return db.prepare(`SELECT o.* FROM occasions o WHERE o.type = 'christmas' AND substr(o.date, 1, 4) = $y AND ${visible('o')}
      ORDER BY o.id LIMIT 1`).get({ uid, y: String(year) }) ?? null;
  },
};

// ---------- gifts ----------

/** A gift for someone who is an admin (person linked to a user) is always private to its giver. */
function forAnAdmin(personIds) {
  const ids = personIds.map(Number).filter(Boolean);
  if (!ids.length) return false;
  return !!db.prepare(`SELECT 1 FROM people WHERE user_id IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`).get(...ids);
}

const GIFT_COLS = `g.*, p.name AS person_name, o.name AS occasion_name, o.type AS occasion_type, o.date AS occasion_date,
  (SELECT group_concat(gpn.person_id) FROM gift_people gpn WHERE gpn.gift_id = g.id) AS people_ids_csv,
  (SELECT wg.status FROM wishlist_items wg WHERE wg.id = g.wishlist_item_id) AS wish_status,
  (SELECT wg.removed_reason FROM wishlist_items wg WHERE wg.id = g.wishlist_item_id) AS wish_removed_reason`;

/** Add `people` ([{ id, name }], main person first) to gift rows. */
function withPeople(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const nameOf = db.prepare('SELECT id, name FROM people WHERE id = ?');
  for (const g of list) {
    if (!g) continue;
    const ids = String(g.people_ids_csv || g.person_id).split(',').map(Number);
    ids.sort((a, b) => (a === g.person_id ? -1 : b === g.person_id ? 1 : a - b));
    g.people = ids.map((id) => nameOf.get(id)).filter(Boolean);
    g.joint = g.people.length > 1;
  }
  return rows;
}

export const gifts = {
  get(uid, id) {
    return withPeople(db.prepare(`SELECT ${GIFT_COLS} ${GIFT_FROM} WHERE g.id = $id AND ${GIFT_VISIBLE}`).get({ uid, id }) ?? null);
  },
  /** For background jobs (images/prices): no user context, never shown to anyone directly. */
  raw: (id) => db.prepare('SELECT * FROM gifts WHERE id = ?').get(id),
  forPerson(uid, personId) {
    return withPeople(db.prepare(`SELECT ${GIFT_COLS} ${GIFT_FROM} WHERE ${FOR_PERSON} AND ${GIFT_VISIBLE}
      ORDER BY g.year DESC, COALESCE(o.date, '') DESC, g.id`).all({ uid, pid: personId }));
  },
  forOccasion(uid, occasionId) {
    return withPeople(db.prepare(`SELECT ${GIFT_COLS} ${GIFT_FROM} WHERE g.occasion_id = $oid AND ${GIFT_VISIBLE}
      ORDER BY g.id`).all({ uid, oid: occasionId }));
  },
  forBirthday(uid, personId, year) {
    return withPeople(db.prepare(`SELECT ${GIFT_COLS} ${GIFT_FROM} WHERE ${FOR_PERSON} AND g.occasion_id IS NULL AND g.year = $y
      AND ${GIFT_VISIBLE} ORDER BY g.id`).all({ uid, pid: personId, y: year }));
  },
  /** What a person got for the same kind of occasion the year before. */
  previous(uid, personId, { type, year }) {
    if (type === 'birthday') return gifts.forBirthday(uid, personId, year - 1);
    if (type !== 'christmas') return [];
    return withPeople(db.prepare(`SELECT ${GIFT_COLS} ${GIFT_FROM} WHERE ${FOR_PERSON} AND o.type = 'christmas'
      AND substr(o.date, 1, 4) = $y AND ${GIFT_VISIBLE} ORDER BY g.id`).all({ uid, pid: personId, y: String(year - 1) }));
  },
  /** `f.person_ids` (optional) adds co-recipients for a joint gift; `f.person_id` is the main one. */
  create(uid, f) {
    const t = now();
    if (forAnAdmin([f.person_id, ...(f.person_ids ?? [])])) f = { ...f, visibility: 'private' };
    return tx(() => {
      const id = Number(db.prepare(`INSERT INTO gifts
      (person_id, occasion_id, year, name, url, notes, status, price_cents, price_currency, price_source,
       visibility, owner_id, image_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      f.person_id, f.occasion_id ?? null, f.year, f.name, f.url ?? '', f.notes ?? '', f.status ?? 'idea',
      f.price_cents ?? null, f.price_cents != null ? f.price_currency : null, f.price_cents != null ? 'manual' : '',
      f.visibility ?? 'shared', uid, f.image_source ?? '', t, t,
    ).lastInsertRowid);
      gifts.setPeople(id, [f.person_id, ...(f.person_ids ?? [])]);
      return id;
    });
  },
  /** Replace who a gift is for (first id = main person). Ids must already be checked as visible. */
  setPeople(id, personIds) {
    const ids = [...new Set(personIds.map(Number).filter(Boolean))];
    if (!ids.length) return;
    tx(() => {
      db.prepare('DELETE FROM gift_people WHERE gift_id = ?').run(id);
      const ins = db.prepare('INSERT INTO gift_people (gift_id, person_id) VALUES (?, ?)');
      for (const pid of ids) ins.run(id, pid);
      db.prepare('UPDATE gifts SET person_id = ? WHERE id = ?').run(ids[0], id);
    });
  },
  /**
   * Edit a gift. Price rule: the shop's price (from the link) wins; a typed price is only
   * used when the link gave none. Changing the link drops a link price. Only the owner
   * may change visibility.
   */
  update(uid, id, f) {
    const g = gifts.get(uid, id);
    if (!g) return false;
    const linkChanged = f.url !== g.url;
    let { price_cents: cents, price_currency: cur, price_source: source } = g;
    if (linkChanged && source === 'link') { cents = null; cur = null; source = ''; }
    if (source !== 'link') {
      if (f.price_cents != null) { cents = f.price_cents; cur = f.price_currency; source = 'manual'; }
      else if (f.clear_price) { cents = null; cur = null; source = ''; }
    }
    const visibility = forAnAdmin(g.people.map((x) => x.id)) ? 'private' : (g.owner_id === uid ? f.visibility : g.visibility);
    db.prepare(`UPDATE gifts SET name = ?, url = ?, notes = ?, status = ?, visibility = ?, image_source = ?,
      price_cents = ?, price_currency = ?, price_source = ?,
      price_checked_at = CASE WHEN ? THEN NULL ELSE price_checked_at END, updated_at = ? WHERE id = ?`).run(
      f.name, f.url, f.notes, f.status, visibility, f.image_source ?? g.image_source,
      cents, cur, source, linkChanged ? 1 : 0, now(), id,
    );
    return true;
  },
  setStatus(uid, id, status) {
    if (!gifts.get(uid, id)) return false;
    db.prepare('UPDATE gifts SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return true;
  },
  delete(uid, id) {
    const g = gifts.get(uid, id);
    if (!g) return null;
    db.prepare('DELETE FROM gifts WHERE id = ?').run(id);
    return g;
  },
  // Used by the preview queue (images, link prices). Prices are frozen once a gift is bought/given.
  setPreview(id, fields) {
    const allowed = ['image_file', 'preview_status', 'name', 'price_checked_at'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length) {
      db.prepare(`UPDATE gifts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    }
    if (fields.link_price_cents != null) {
      db.prepare(`UPDATE gifts SET price_cents = ?, price_currency = ?, price_source = 'link'
        WHERE id = ? AND status = 'idea'`).run(fields.link_price_cents, fields.link_price_currency ?? null, id);
    }
  },
  pendingPreviews: () => db.prepare("SELECT id FROM gifts WHERE preview_status = 'pending'").all().map((r) => r.id),
  allImageFiles: () => db.prepare('SELECT image_file FROM gifts WHERE image_file IS NOT NULL').all().map((r) => r.image_file),
  /** Ideas with a link whose price is older than `olderThan` (prices of bought gifts are frozen). */
  stalePrices(olderThan, limit) {
    return db.prepare(`SELECT id FROM gifts WHERE url != '' AND status = 'idea' AND preview_status != 'pending'
      AND COALESCE(price_checked_at, 0) < ? ORDER BY COALESCE(price_checked_at, 0) LIMIT ?`).all(olderThan, limit).map((r) => r.id);
  },
};

// ---------- views built from the rules above ----------

/** Totals of bought/given gifts, per currency: [{ currency, cents }]. */
export function spent(giftRows) {
  const by = new Map();
  for (const g of giftRows) {
    if (!HAS_GIFT.includes(g.status) || g.price_cents == null) continue;
    const cur = g.price_currency || config.currency;
    by.set(cur, (by.get(cur) ?? 0) + g.price_cents);
  }
  return [...by].map(([currency, cents]) => ({ currency, cents }));
}

/** Checklist of an occasion: one row per visible participant, with their visible gifts. */
export function checklist(uid, occasion) {
  const year = Number(occasion.date.slice(0, 4));
  const all = gifts.forOccasion(uid, occasion.id);
  const rows = occasions.participants(uid, occasion.id).map((person) => {
    const mine = all.filter((g) => g.people.some((x) => x.id === person.id));
    return {
      person,
      gifts: mine,
      done: mine.some((g) => HAS_GIFT.includes(g.status)),
      previous: gifts.previous(uid, person.id, { type: occasion.type, year }),
    };
  });
  // Gifts for people who are no longer participants still count (and are listed).
  const ids = new Set(rows.map((r) => r.person.id));
  const orphans = all.filter((g) => !g.people.some((x) => ids.has(x.id)));
  return {
    rows,
    orphans,
    total: rows.length,
    done: rows.filter((r) => r.done).length,
    spent: spent(all),
  };
}

/**
 * Upcoming occasions for a user within `days`: birthdays of visible people (derived) and
 * visible Christmas/custom occasions. Each entry says whether it already has a gift.
 */
export function upcoming(uid, days = 60, from = today()) {
  const out = [];
  for (const p of people.list(uid)) {
    if (!p.birthday_month || !p.birthday_day) continue;
    const { date, year } = nextBirthday(p.birthday_month, p.birthday_day, from);
    const inDays = daysBetween(from, date);
    if (inDays > days) continue;
    const list = gifts.forBirthday(uid, p.id, year);
    out.push({
      kind: 'birthday', date, inDays, year, person: p,
      age: p.birth_year ? year - p.birth_year : null,
      gifts: list,
      done: list.some((g) => HAS_GIFT.includes(g.status)),
      ideas: list.length,
    });
  }
  const until = new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const occ = db.prepare(`SELECT o.* FROM occasions o WHERE o.date >= $from AND o.date <= $until AND ${visible('o')}`)
    .all({ uid, from, until });
  for (const o of occ) {
    const c = checklist(uid, o);
    out.push({ kind: 'occasion', date: o.date, inDays: daysBetween(from, o.date), occasion: o, total: c.total, doneCount: c.done, done: c.total > 0 && c.done === c.total });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** When an admin account is removed: their private entries go too; shared ones stay. */
export function deleteUserData(userId) {
  tx(() => {
    db.prepare("DELETE FROM gifts WHERE owner_id = ? AND visibility = 'private'").run(userId);
    db.prepare("DELETE FROM occasions WHERE owner_id = ? AND visibility = 'private'").run(userId);
    db.prepare("DELETE FROM people WHERE owner_id = ? AND visibility = 'private'").run(userId);
  });
}
