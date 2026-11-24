# Giftly: notes for coding agents

Self-hosted gift lists (guest lists, wishlists, "gifts to give"). These are the project's rules and the lessons that cost real bugs. Read this before changing anything.

## Stack and layout

- Node.js 24, **zero npm dependencies**, ESM. `node:http`, `node:sqlite` (`DatabaseSync`, WAL). Server-rendered HTML through the escaping tagged template `h` (`src/views.js`); `raw()` only for markup you built yourself.
- `src/server.js` handles routing, guest pages, lists, accounts, images, `/login` and startup. `src/db.js` holds lists, items and guests, `LIST_VISIBLE` and `PERSON_VISIBLE`; `src/migrations.js` the migrations (a step can be SQL or `run(db)`). `src/release.js` the data releases (`/data/current -> releases/<name>/`: one-time copy from 3.x, check at first open, upgrade into a new release, atomic switch, retention); `src/archive.js` the backup tar format. `src/giving*.js` covers people (and each admin's record), occasions, gifts, `OCCASION_VISIBLE` and `GIFT_VISIBLE`, and `src/wishlist*.js` the wishlists (`own` / `ideas`, shared or private) and the list-item overrides. `src/net.js` has the address filter, `postJson` and the proxy trust. `src/preview.js` and `src/previewQueue.js` handle link previews and prices. `src/notify.js`, `src/reminders.js`, `src/i18n.js`.
- Admin URLs (5.0): `/login`, `/admin/occasions` (home), `/admin/people`, `/admin/lists`, `/admin/wishlist`, plus `/admin/profile`, `/admin/notifications`, `/admin/users` in the account menu. Guest links `/l/<token>` never change and never ask for a login.
- `install.sh` is the one-step installer (images pinned by digest). `scripts/` holds the admin scripts run inside the container (`backup.js`, `restore.js`, `release.js`, `served.js`, accounts) and the host wrappers `backup.sh`/`restore.sh`. `tools/screenshots/` regenerates the README images with **mock data only**.

## Rules that must hold

- **Privacy lives in one place per kind:** `LIST_VISIBLE` and `PERSON_VISIBLE` (db.js), `visible()`/`OCCASION_VISIBLE`/`GIFT_VISIBLE` (giving.js), `wishlists.canView`/`viewableByOther`/`canEdit` (wishlist.js), `canSeeImage` (server.js). Every page, count, notification and image goes through them; never write a second, slightly different check.
- **Hard rule:** an admin never sees what was reserved, planned or bought for them. Their own record in People (`people.user_id`), with its gifts, ideas, occasions only about them, totals and reminders, is invisible to them even when shared; so are lists with items of their wishlist or of the ideas for them. Private ideas are only ever seen by their admin, and a list with them never by anyone else.
- A list's edit of an item from someone's **own** wishlist goes to `list_item_overrides`, never to the wishlist; their pages and answers must not change. Ideas are edited in the wishlist itself.
- **Every admin route that takes an id must load the record through the visibility rule** (`loadList`, `loadItem`, `people.get(uid, …)`…) and answer 404 otherwise. Two routes once lacked this; grep for new ones.
- **Outgoing requests only through the guarded paths:** previews via `get()` in preview.js (`agent: false`, `safeLookup`, IP literals checked, total deadline), notifications via `postJson` in net.js (own agent, private hosts refused unless `NOTIFY_ALLOWED_HOSTS`, no redirects, body never surfaced). Never use `fetch` or the global agent for user-supplied URLs.
- **Strict CSP:** no inline `<script>` and no `style=""`. Use classes in `public/style.css`. Bump `?v=` for `style.css` **and** `app.js` in `src/views.js` whenever you change them (they are cached for a day).
- **Two languages:** every UI string has a `pt` (pt-PT) **and** an `en` entry in `src/i18n.js`, with no duplicate keys.
- **Migrations:** only append to the `migrations` array in `src/migrations.js`, never edit an old one. A table rebuild needs `{ foreignKeysOff: true, sql }`. Migrations only ever run on a new release (`release.js`) or an empty one, never on data someone may need to go back to.
- **Data releases:** restore, upgrade and rollback create a new release and switch `current`; they never modify, move or delete the release they may need to return to. Nothing but `release.js` decides where the data is (`config.dataDir` is the resolved release). Success means Giftly *serves* the expected release (`scripts/served.js --expect`), never just `/healthz`.
- **Secrets:** never commit `.env`, `cloudflared.env` or anything under `data/`. Installer and scripts write secrets with `umask 077` + `mktemp` in the same folder + `chmod 600` + `mv`.
- **Prices come from the shop link** (never typed for list items). Be honest with shops: keep the real User-Agent and don't try to get around bot protection.

## Testing

- `npm test` runs the Node tests (each file starts real servers on random ports). Installer and backup tests need Docker and build the image from the checkout (served by a local registry): `sh test/install/run.sh` and `sh test/backup/run.sh` (they also run in CI). Without Docker: run them in `docker:dind` under podman (`podman run -d --privileged -e DOCKER_TLS_CERTDIR= -v $PWD:/repo docker:dind`, then `apk add curl nodejs` inside).
- **Mutation-check every protection** with `tools/mutate.sh FILE FROM TO TEST...`. It breaks the guard in a temporary copy and must report `CAUGHT`. `SURVIVED` means the test passes for the wrong reason. Make the mutation remove the *guard*, not crash the code (a `ReferenceError` "catches" anything). A `CAUGHT (timed out)` usually means a failing assertion left a server running: make the test fail cleanly. For shell scripts, apply the edit to a copy of the repository and run its Docker suite there.
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
- A failed 3.x → 4 update rolled back to 3.x left `current` pointing at the failed attempt's copy, so the next 4 would have served stale data. Going back to a version without releases removes the `current` link (`release.js detach`), and a changed flat `giftly.db` is copied again.
- A changed `/data` mount (an override) makes a healthy Giftly serve an empty database. The installer compares the `/data` mount before and after, and requires the expected release to be served.
- The session secret signs guest cookies and CSRF tokens, not admin sessions: "the admin is still signed in" proves nothing about it. Compare the secret itself.
- A truncated gzip fails before the tar reader's own end-of-archive check runs: test each layer with an input only it can catch.
- A form must not carry state that other people change. The item edit form used to resubmit "Reserved by", so a page opened before a guest picked freed the pick when saved. Reservations change only through explicit actions that send what the page showed (`expect`, `views.reservationKey`), and the server refuses if it changed.
- A backup must be checked against its own snapshot: copying "whatever is in `images/`" after `VACUUM INTO` can miss a photo deleted in between. Copy exactly the snapshot's references and compare before publishing.
- `docker compose pull` moves the tag, so a "rollback" that only restores files restarts the new image. Name images by digest (`repo@sha256:…`); then even `pull_policy: always` returns the same image.
- Moving or overwriting live data to restore or roll back kept producing new edge cases (journals, partial moves). 4.0 replaced all of it with data releases that are never modified once left, and one atomic symlink switch: keep it that way.
- Default security settings must not silently break common deployments (behind nginx or Cloudflare Tunnel). The owner decided that an empty `TRUSTED_PROXIES` means "private/local peers": keep it.

## Reviews and releases

- For outside security reviews: confirm every claim in the code first, fix what's real with a test and a mutation check, and argue with evidence when a proposal would hurt real deployments.
- Outside reviews follow `.claude/skills/giftly-security-review/SKILL.md`.
- Releases follow `.claude/skills/giftly-release/SKILL.md`. In short: CI green on `main` **before** tagging, then the tag, the release page, and a check that the image exists.
