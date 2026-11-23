# Giftly: notes for coding agents

Self-hosted gift lists (guest lists, wishlists, "gifts to give"). These are the project's rules and the lessons that cost real bugs. Read this before changing anything.

## Stack and layout

- Node.js 24, **zero npm dependencies**, ESM. `node:http`, `node:sqlite` (`DatabaseSync`, WAL). Server-rendered HTML through the escaping tagged template `h` (`src/views.js`); `raw()` only for markup you built yourself.
- `src/server.js` handles routing, guest pages, lists, accounts, images and startup. `src/db.js` holds migrations, lists, items and guests, and `LIST_VISIBLE`. `src/giving*.js` covers people, occasions, gifts and `GIFT_VISIBLE`, and `src/wishlist*.js` the wishlists. `src/net.js` has the address filter, `postJson` and the proxy trust. `src/preview.js` and `src/previewQueue.js` handle link previews and prices. `src/notify.js`, `src/reminders.js`, `src/i18n.js`.
- `install.sh` is the one-step installer. `scripts/` holds the admin scripts (run inside the container) and `backup.sh`/`restore.sh` (run on the host). `tools/screenshots/` regenerates the README images with **mock data only**.

## Rules that must hold

- **Privacy lives in one place per kind:** `LIST_VISIBLE` (db.js), `visible()`/`GIFT_VISIBLE` (giving.js), `wishlists.viewableByOther`/`canEdit` (wishlist.js), `canSeeImage` (server.js). Every page, count, notification and image goes through them; never write a second, slightly different check.
- **Hard rule:** an admin never sees what was reserved or bought for them. Lists containing items of their wishlists, and the "ideas for X" kept on their record, stay invisible to them.
- **Every admin route that takes an id must load the record through the visibility rule** (`loadList`, `loadItem`, `people.get(uid, …)`…) and answer 404 otherwise. Two routes once lacked this; grep for new ones.
- **Outgoing requests only through the guarded paths:** previews via `get()` in preview.js (`agent: false`, `safeLookup`, IP literals checked, total deadline), notifications via `postJson` in net.js (own agent, private hosts refused unless `NOTIFY_ALLOWED_HOSTS`, no redirects, body never surfaced). Never use `fetch` or the global agent for user-supplied URLs.
- **Strict CSP:** no inline `<script>` and no `style=""`. Use classes in `public/style.css`. Bump `?v=` for `style.css` **and** `app.js` in `src/views.js` whenever you change them (they are cached for a day).
- **Two languages:** every UI string has a `pt` (pt-PT) **and** an `en` entry in `src/i18n.js`, with no duplicate keys.
- **Migrations:** only append to the `migrations` array in db.js, never edit an old one. A table rebuild needs `{ foreignKeysOff: true, sql }`.
- **Secrets:** never commit `.env`, `cloudflared.env` or anything under `data/`. Installer and scripts write secrets with `umask 077` + `mktemp` in the same folder + `chmod 600` + `mv`.
- **Prices come from the shop link** (never typed for list items). Be honest with shops: keep the real User-Agent and don't try to get around bot protection.

## Testing

- `npm test` runs the Node tests (each file starts real servers on random ports). Installer and backup tests need Docker: `sh test/install/run.sh` and `sh test/backup/run.sh` (they also run in CI).
- **Mutation-check every protection:** break the guard on purpose (one line), confirm a test fails, then restore it. Most security fixes here came with that step, and it caught tests that passed for the wrong reason.
- Verify UI changes in a real browser (Playwright, as in `tools/screenshots/`), on both phone and desktop widths.
- Tests that need a local server for previews or notifications use the explicit test hooks (`preview.__test`, `previewQueue.__test`, `NOTIFY_ALLOWED_HOSTS=127.0.0.1`), never by loosening the guards.

## Lessons learned (each was a real bug)

- `new URL(...)` (or anything that can throw) inside an http response callback runs outside the promise: wrap it, or the process dies.
- `net.BlockList`: an IPv6 rule for `::ffff:0:0/96` also matches every plain IPv4 address. Normalize addresses (`normalizeAddress`) instead.
- The WHATWG URL parser turns `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`, and Node skips the `lookup` for IP literals. Check literals yourself.
- Node's `http.globalAgent` keeps connections alive by default, so pooled sockets skip DNS checks.
- An idle socket timeout isn't a deadline: a server can trickle bytes forever.
- Background jobs must compare-and-set what they overwrite (e.g. a late preview vs. a photo uploaded meanwhile).
- SQLite reuses the rowid of the deleted max row, so never put row ids in signed cookies (guests use random tokens).
- BusyBox `sha256sum` has no `--quiet`. `cloudflared` images have no shell (probe it from the giftly container). `env_file: {path, required: false}` needs Compose ≥ 2.24.
- In `set -e` shell, a final `[ … ] && …` that is false exits the script.
- Files a container writes into a bind mount aren't removable by the CI user; delete them from a container.
- Default security settings must not silently break common deployments (behind nginx or Cloudflare Tunnel). The owner decided that an empty `TRUSTED_PROXIES` means "private/local peers": keep it.

## Reviews and releases

- For outside security reviews: confirm every claim in the code first, fix what's real with a test and a mutation check, and argue with evidence when a proposal would hurt real deployments.
- Releases follow `.claude/skills/giftly-release/SKILL.md`. In short: CI green on `main` **before** tagging, then the tag, the release page, and a check that the image exists.
