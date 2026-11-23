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
];

export const SCHEMA_VERSION = migrations.length;

/** Bring a database up to SCHEMA_VERSION (each step in its own transaction). */
export function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let v = version; v < migrations.length; v++) {
    const m = typeof migrations[v] === 'string' ? { sql: migrations[v] } : migrations[v];
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF'); // can't change inside a transaction
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
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
