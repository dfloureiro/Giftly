// Database migrations, indexed by PRAGMA user_version. Only ever APPEND to this array; never
// edit an old entry. A table rebuild needs { foreignKeysOff: true, sql }.
// Kept apart from db.js so a new data release can be migrated before the app opens it (release.js).

export const migrations = [
  `
  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL UNIQUE,
    epoch INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    UNIQUE (list_id, name)
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    reserved_guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    reserved_name TEXT,
    reserved_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX items_list ON items(list_id, position);
  CREATE INDEX guests_list ON guests(list_id);
  `,
  // v2: link previews
  `
  ALTER TABLE items ADD COLUMN image_file TEXT;
  ALTER TABLE items ADD COLUMN image_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE items ADD COLUMN preview_status TEXT NOT NULL DEFAULT '';
  `,
  // v3: prices come only from the shop link and are re-checked daily
  `
  ALTER TABLE items ADD COLUMN price_checked_at INTEGER;
  UPDATE items SET price = '' WHERE url = '';
  `,
  // v4: settings edited in the admin (notifications, ...)
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // v5: anonymous lists (the admin sees that a gift is reserved, not by whom)
  `
  ALTER TABLE lists ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;
  `,
  // v6: user accounts (replace the single ADMIN_PASSWORD), per-user notifications;
  // anonymous lists were dropped (all admins see who reserved what).
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    notify_events TEXT NOT NULL DEFAULT 'pick,unpick',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  -- Invites create a new account; with user_id set, the token is a password reset for that user.
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE notification_channels (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, type)
  );
  ALTER TABLE lists DROP COLUMN anonymous;
  `,
  // v7: "Gifts to give" — people, occasions (birthdays are virtual, from people.birthday_*)
  // and the gifts admins plan to give. Every row is 'shared' (all admins) or 'private' (owner only).
  `
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    birthday_month INTEGER,
    birthday_day INTEGER,
    birth_year INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    gives_christmas INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE occasions (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('christmas', 'custom')),
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE occasion_people (
    occasion_id INTEGER NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (occasion_id, person_id)
  );
  CREATE TABLE gifts (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    occasion_id INTEGER REFERENCES occasions(id) ON DELETE CASCADE, -- NULL: the person's birthday in \`year\`
    year INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'bought', 'given')),
    price_cents INTEGER,
    price_currency TEXT,
    price_source TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    image_file TEXT,
    image_source TEXT NOT NULL DEFAULT '',
    preview_status TEXT NOT NULL DEFAULT '',
    price_checked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX gifts_person ON gifts(person_id, year);
  CREATE INDEX gifts_occasion ON gifts(occasion_id);
  `,
  // v8: reminders. Each user picks how many days before (empty = off); every reminder is
  // sent at most once per (user, occasion, threshold).
  `
  ALTER TABLE users ADD COLUMN reminder_days TEXT NOT NULL DEFAULT '14,3';
  CREATE TABLE reminder_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    days_before INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key, days_before)
  );
  `,
  // v9: joint gifts — a gift can be for several people (e.g. a couple at Christmas).
  // gifts.person_id stays as the "main" person; gift_people lists everyone (main included).
  `
  CREATE TABLE gift_people (
    gift_id INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (gift_id, person_id)
  );
  CREATE INDEX gift_people_person ON gift_people(person_id);
  INSERT INTO gift_people (gift_id, person_id) SELECT id, person_id FROM gifts;
  `,
  // v10: admins can reserve a list gift on behalf of a guest. The reservation belongs to that
  // guest (by name, created if needed) so they see it in their picks; we remember which admin
  // made it. Older name-only reservations are linked to an existing guest with that name.
  `
  ALTER TABLE items ADD COLUMN reserved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  UPDATE items SET reserved_guest_id = (
    SELECT g.id FROM guests g WHERE g.list_id = items.list_id AND g.name = items.reserved_name
  ) WHERE reserved_guest_id IS NULL AND reserved_name IS NOT NULL;
  `,
  // v11: optional two-factor authentication (TOTP) per admin, with one-time recovery codes.
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending TEXT;
  ALTER TABLE users ADD COLUMN totp_last_counter INTEGER NOT NULL DEFAULT -1;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';
  `,
  // v12 (3.0): personal wishlists, lists created from them, list owners/privacy, reservations
  // shared across lists for the same wishlist item, and links to "gifts to give".
  `
  CREATE TABLE wishlists (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'admins' CHECK (visibility IN ('admins', 'private')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE wishlist_items (
    id INTEGER PRIMARY KEY,
    wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'received')),
    removed_reason TEXT CHECK (removed_reason IN ('bought', 'unwanted', 'received')),
    removed_at INTEGER,
    image_file TEXT,
    image_source TEXT NOT NULL DEFAULT '',
    preview_status TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT '',
    price_cents INTEGER,
    price_currency TEXT,
    price_checked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX wishlist_items_list ON wishlist_items(wishlist_id, status, position);

  ALTER TABLE lists ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE lists ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
  ALTER TABLE lists ADD COLUMN source_wishlist_id INTEGER REFERENCES wishlists(id) ON DELETE SET NULL;
  ALTER TABLE lists ADD COLUMN auto_add_new INTEGER NOT NULL DEFAULT 1;

  -- A list item can be linked to a wishlist item (its name/link/image/price follow the wishlist).
  ALTER TABLE items ADD COLUMN wishlist_item_id INTEGER REFERENCES wishlist_items(id) ON DELETE SET NULL;
  ALTER TABLE items ADD COLUMN wish_notes TEXT NOT NULL DEFAULT '';
  ALTER TABLE items ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;   -- hidden in this list only
  ALTER TABLE items ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;  -- new in the wishlist, waiting for approval
  CREATE INDEX items_wishlist ON items(wishlist_item_id);

  -- At most one reservation per wishlist item, across every list (or a "I'll give it" gift).
  CREATE TABLE wishlist_claims (
    wishlist_item_id INTEGER PRIMARY KEY REFERENCES wishlist_items(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    gift_id INTEGER REFERENCES gifts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  ALTER TABLE gifts ADD COLUMN wishlist_item_id INTEGER REFERENCES wishlist_items(id) ON DELETE SET NULL;
  ALTER TABLE people ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `,
  // v13 (3.1): per-admin favourite people; gift ideas copied into guest lists keep a trace
  // (gifts.list_item_id); lists made for an admin (from ideas for them) are never visible to them.
  `
  CREATE TABLE person_favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, person_id)
  );
  ALTER TABLE gifts ADD COLUMN list_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL;
  ALTER TABLE lists ADD COLUMN recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `,
  // v14 (3.2): wishlists for any person in "gifts to give" (not only admins). A wishlist belongs
  // to an admin (owner_id) OR to a person (person_id). Rebuilding the table needs foreign keys
  // off (SQLite's documented procedure), otherwise dropping it would cascade to its items.
  { foreignKeysOff: true, sql: `
  CREATE TABLE wishlists_new (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    person_id INTEGER UNIQUE REFERENCES people(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'admins' CHECK (visibility IN ('admins', 'private')),
    created_at INTEGER NOT NULL,
    CHECK ((owner_id IS NULL) != (person_id IS NULL))
  );
  INSERT INTO wishlists_new (id, owner_id, visibility, created_at) SELECT id, owner_id, visibility, created_at FROM wishlists;
  DROP TABLE wishlists;
  ALTER TABLE wishlists_new RENAME TO wishlists;
  ` },
  // v15 (3.3): a list can come from several wishlists (an admin's own + the ideas others keep for them).
  `
  CREATE TABLE list_sources (
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, wishlist_id)
  );
  CREATE INDEX list_sources_wishlist ON list_sources(wishlist_id);
  INSERT INTO list_sources (list_id, wishlist_id) SELECT id, source_wishlist_id FROM lists WHERE source_wishlist_id IS NOT NULL;
  `,
  // v16 (3.3.2): guest sessions use a random, never-reused token instead of the row id
  // (SQLite may reuse the id of a deleted guest, and every list starts at the same epoch).
  `
  ALTER TABLE guests ADD COLUMN token TEXT;
  UPDATE guests SET token = lower(hex(randomblob(16)));
  CREATE UNIQUE INDEX guests_token ON guests(token);
  `,
  // v17 (5.0): every admin has a person record (invisible to that admin); a wishlist is either an
  // admin's own ('own') or ideas kept for a person ('ideas', shared or private to one admin);
  // gift ideas leave the checklist for those wishlists (gifts are 'planned', 'bought' or 'given');
  // list items linked to another admin's wishlist can be edited in that list only (overrides).
  { foreignKeysOff: true, run: migrateTo5 },
  // v18 (5.3): a list can ask guests, when they pick a gift, whether they buy it themselves
  // ('guest') or want the list's managers to buy it for them ('us'). NULL: not answered.
  `
  ALTER TABLE lists ADD COLUMN ask_buyer INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN reserved_buyer TEXT CHECK (reserved_buyer IN ('guest', 'us'));
  `,
  // v19 (5.3): an admin marks a gift they were asked to buy ('us') as bought (and by whom).
  `
  ALTER TABLE items ADD COLUMN bought_at INTEGER;
  ALTER TABLE items ADD COLUMN bought_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `,
];

/** Shop-style price text for an idea that had a price (as 3.2 did). */
function priceText(cents, currency) {
  if (cents == null) return '';
  const lang = String(process.env.APP_LANG || 'pt').toLowerCase().startsWith('en') ? 'en-GB' : 'pt-PT';
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency: currency || process.env.CURRENCY || 'EUR' }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

function migrateTo5(db) {
  const t = Date.now();
  db.exec(`
  ALTER TABLE users ADD COLUMN birthday_month INTEGER;
  ALTER TABLE users ADD COLUMN birthday_day INTEGER;
  ALTER TABLE users ADD COLUMN birth_year INTEGER;

  CREATE TABLE wishlists_new (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('own', 'ideas')),
    -- own: the admin (their person is people.user_id); ideas: NULL = shared, else private to that admin
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,  -- ideas only
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    created_at INTEGER NOT NULL,
    CHECK (kind != 'own' OR (owner_id IS NOT NULL AND person_id IS NULL)),
    CHECK (kind != 'ideas' OR (person_id IS NOT NULL AND (owner_id IS NOT NULL) = (visibility = 'private')))
  );
  INSERT INTO wishlists_new (id, kind, owner_id, person_id, visibility, created_at)
    SELECT id, 'own', owner_id, NULL, CASE visibility WHEN 'private' THEN 'private' ELSE 'shared' END, created_at
    FROM wishlists WHERE owner_id IS NOT NULL;
  INSERT INTO wishlists_new (id, kind, owner_id, person_id, visibility, created_at)
    SELECT id, 'ideas', NULL, person_id, 'shared', created_at FROM wishlists WHERE person_id IS NOT NULL;
  DROP TABLE wishlists;
  ALTER TABLE wishlists_new RENAME TO wishlists;
  CREATE UNIQUE INDEX wishlists_own ON wishlists(owner_id) WHERE kind = 'own';
  CREATE UNIQUE INDEX wishlists_ideas ON wishlists(person_id, COALESCE(owner_id, 0)) WHERE kind = 'ideas';

  CREATE TABLE list_item_overrides (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    -- NULL = follows the wishlist. image = 1: this list keeps its own picture (upload, image link or none).
    title TEXT, url TEXT, notes TEXT, image INTEGER NOT NULL DEFAULT 0, image_source TEXT,
    -- What the wishlist had when each field was changed here ("the wishlist changed" when it differs).
    base_title TEXT, base_url TEXT, base_notes TEXT, base_image TEXT,
    updated_at INTEGER NOT NULL
  );
  `);

  // Every admin gets a shared person (the other admins' record of them), unless an unlinked person
  // with the same name exists: the app asks whether it is the same one instead of linking it alone.
  db.prepare(`INSERT INTO people (name, visibility, owner_id, user_id, created_at)
    SELECT u.name, 'shared', NULL, u.id, ? FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM people p WHERE p.user_id IS NULL AND p.name = u.name COLLATE NOCASE)`).run(t);

  // Gift ideas move to the ideas wishlist of their (main) person: the shared one, or the giver's
  // private one for private ideas. "I'll give it" gifts (from a wishlist) are kept as 'planned'.
  const ideas = db.prepare("SELECT * FROM gifts WHERE status = 'idea' AND wishlist_item_id IS NULL ORDER BY person_id, id").all();
  const findList = db.prepare("SELECT id FROM wishlists WHERE kind = 'ideas' AND person_id = ? AND COALESCE(owner_id, 0) = ?");
  const newList = db.prepare("INSERT INTO wishlists (kind, owner_id, person_id, visibility, created_at) VALUES ('ideas', ?, ?, ?, ?)");
  const nextPos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM wishlist_items WHERE wishlist_id = ?');
  const insertItem = db.prepare(`INSERT INTO wishlist_items (wishlist_id, title, url, notes, position, image_file, image_source,
      price, price_cents, price_currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const g of ideas) {
    const owner = g.visibility === 'private' && g.owner_id != null ? g.owner_id : null;
    let w = findList.get(g.person_id, owner ?? 0)?.id;
    if (!w) w = Number(newList.run(owner, g.person_id, owner ? 'private' : 'shared', t).lastInsertRowid);
    const wiId = Number(insertItem.run(w, g.name, g.url, g.notes, nextPos.get(w).p, g.image_file, g.image_source,
      priceText(g.price_cents, g.price_currency), g.price_cents, g.price_cents != null ? g.price_currency : null, g.created_at, t).lastInsertRowid);
    if (g.list_item_id) {
      db.prepare('UPDATE items SET wishlist_item_id = ? WHERE id = ? AND wishlist_item_id IS NULL').run(wiId, g.list_item_id);
      const it = db.prepare('SELECT reserved_name FROM items WHERE id = ? AND wishlist_item_id = ?').get(g.list_item_id, wiId);
      if (it?.reserved_name) {
        db.prepare('INSERT OR IGNORE INTO wishlist_claims (wishlist_item_id, item_id, created_at) VALUES (?, ?, ?)').run(wiId, g.list_item_id, t);
      }
    }
    // Foreign keys are off here: remove what would have cascaded.
    db.prepare('DELETE FROM gift_people WHERE gift_id = ?').run(g.id);
    db.prepare('DELETE FROM wishlist_claims WHERE gift_id = ?').run(g.id);
    db.prepare('DELETE FROM gifts WHERE id = ?').run(g.id);
  }

  db.exec(`
  CREATE TABLE gifts_new (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    occasion_id INTEGER REFERENCES occasions(id) ON DELETE CASCADE, -- NULL: the person's birthday in \`year\`
    year INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'bought', 'given')),
    price_cents INTEGER,
    price_currency TEXT,
    price_source TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    image_file TEXT,
    image_source TEXT NOT NULL DEFAULT '',
    preview_status TEXT NOT NULL DEFAULT '',
    price_checked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    wishlist_item_id INTEGER REFERENCES wishlist_items(id) ON DELETE SET NULL,
    list_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL
  );
  INSERT INTO gifts_new (id, person_id, occasion_id, year, name, url, notes, status, price_cents, price_currency, price_source,
      visibility, owner_id, image_file, image_source, preview_status, price_checked_at, created_at, updated_at, wishlist_item_id, list_item_id)
    SELECT id, person_id, occasion_id, year, name, url, notes, CASE status WHEN 'idea' THEN 'planned' ELSE status END,
      price_cents, price_currency, price_source, visibility, owner_id, image_file, image_source, preview_status, price_checked_at,
      created_at, updated_at, wishlist_item_id, list_item_id FROM gifts;
  DROP TABLE gifts;
  ALTER TABLE gifts_new RENAME TO gifts;
  CREATE INDEX gifts_person ON gifts(person_id, year);
  CREATE INDEX gifts_occasion ON gifts(occasion_id);
  DELETE FROM settings WHERE key = 'migrations.ideas_to_wishlists';
  `);
}

export const SCHEMA_VERSION = migrations.length;

/** Bring a database up to SCHEMA_VERSION (each step in its own transaction). */
export function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let v = version; v < migrations.length; v++) {
    const m = typeof migrations[v] === 'string' ? { sql: migrations[v] } : migrations[v];
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF'); // can't change inside a transaction
    db.exec('BEGIN');
    try {
      if (m.run) m.run(db); // a step that needs code (still one transaction)
      else db.exec(m.sql);
      if (m.foreignKeysOff) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`migration ${v + 1} broke foreign keys: ${JSON.stringify(broken.slice(0, 3))}`);
      }
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}
