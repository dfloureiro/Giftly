<p align="center">
  <img src="public/icons/icon-192.png" alt="Giftly" width="96" height="96">
</p>

<h1 align="center">Giftly</h1>

Self-hosted gift lists for families and friends.

- You create a list in the admin and add gifts: links to any shop, or plain items without a link.
- You share the list's **secret link**. People open it, type their name, and pick what they'll give.
- A picked gift **disappears for everyone else**, so no two people buy the same thing.
- Gifts with a link show the **shop's product image and price** automatically. Prices are re-checked daily and are never typed by hand.
- **Several admins**, each with their own account, and optional **notifications** (ntfy, Telegram, Discord/Slack webhook) when someone picks a gift.
- The admin always shows everything: who picked what and when, and who joined.
- **Wishlists:** each admin keeps a personal wishlist; another admin can create a guest list from it (the owner never sees that list or what was reserved), or take an item with "I'll give it".
- **Gifts to give:** keep track of the gifts *you* give: people, birthdays, Christmas and other occasions, with a checklist per occasion, what each person got last year, shared or private entries per admin, and **reminders** when a gift is still missing.

<p align="center">
  <img src="docs/screenshots/guest-list.png" alt="A guest's view of a gift list: their own pick at the top, available gifts with images, prices and shop links below" width="720">
</p>

<p align="center">
  <img src="docs/screenshots/join-mobile.png" alt="Joining a list on a phone: only a name is needed" width="240">
  &nbsp;
  <img src="docs/screenshots/guest-mobile-dark.png" alt="The gift list on a phone in dark mode" width="240">
</p>

<details>
<summary><strong>Admin view</strong></summary>
<p align="center">
  <img src="docs/screenshots/admin-list.png" alt="Admin page of a list: share link, every gift with who reserved it and when, and edit/release/reorder/delete actions" width="720">
</p>
<p align="center">
  <img src="docs/screenshots/notifications.png" alt="Notification settings in your profile: which events to be notified about, and ntfy, Telegram and webhook channels" width="480">
</p>
<p align="center">
  <img src="docs/screenshots/admins.png" alt="Admins page: every admin account, new-password links, and invite links to add another admin" width="600">
</p>
</details>

<details>
<summary><strong>Wishlists</strong></summary>
<p align="center">
  <img src="docs/screenshots/wishlist-own.png" alt="Your own wishlist: items in order of preference, with no hint of what was reserved" width="480">
  &nbsp;
  <img src="docs/screenshots/wishlist-others.png" alt="Another admin's wishlist: available or already chosen items, I'll give it, and create a list from it" width="480">
</p>
<p align="center">
  <img src="docs/screenshots/wishlist-list.png" alt="A private guest list created from someone's wishlist, with linked items, hide here, and items reserved elsewhere" width="600">
</p>
</details>

<details>
<summary><strong>Gifts to give</strong></summary>
<p align="center">
  <img src="docs/screenshots/give-upcoming.png" alt="Upcoming occasions in the next 60 days: birthdays and Christmas, each with whether there is already a gift" width="240">
  &nbsp;
  <img src="docs/screenshots/give-checklist.png" alt="Christmas checklist on a phone: progress, total spent, each person's gifts with status, and what they got last year" width="240">
  &nbsp;
  <img src="docs/screenshots/give-person.png" alt="A person's page: next birthday and age, and their gift history by occasion" width="240">
</p>
</details>

Available in **Portuguese (pt-PT)** and **English**. The language follows the visitor's browser, and every page has a PT/EN switch.

Guests need no account and no email, and nothing is tracked. It is a single small container with a SQLite file, and the code has zero npm dependencies.

## Quick start

```sh
mkdir giftly && cd giftly
curl -O https://raw.githubusercontent.com/dfloureiro/giftly/main/compose.yaml
printf 'ADMIN_USERNAME=me\nADMIN_PASSWORD=%s\n' "$(openssl rand -base64 18)" > .env
cat .env                     # keep this password
docker compose up -d
```

Open <http://localhost:3000/admin>, log in with that username and password, and create your first list. They are only used to create the first account; afterwards you can remove them from `.env`.

Or with plain Docker:

```sh
docker run -d --name giftly -p 3000:3000 \
  -e ADMIN_USERNAME=me -e ADMIN_PASSWORD=your-long-password \
  -v giftly-data:/data \
  ghcr.io/dfloureiro/giftly:latest
```

## Configuration

| Variable | Default | |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Username of the first account. Only used on the very first start. |
| `ADMIN_PASSWORD` | — | Password of the first account (at least 8 characters). Only used on the very first start, when there are no accounts yet; ignored afterwards (with a warning). |
| `APP_LANG` | `pt` | Fallback language (`pt` or `en`) when the browser asks for neither. |
| `SITE_TITLE` | `Giftly` | Name shown on the home page and in the browser tab. |
| `BASE_URL` | auto | Public URL used for the share link in the admin, e.g. `https://gifts.example.com`. |
| `TZ` | `Europe/Lisbon` | Time zone for dates in the admin. |
| `LINK_PREVIEWS` | `true` | Fetch product pages to show each gift's image and price. Set to `false` to turn it off. |
| `TRUST_PROXY` | `true` | Trust `CF-Connecting-IP` / `X-Forwarded-*`. Set to `false` if the app is exposed directly. |
| `COOKIE_SECURE` | `auto` | `auto` sets `Secure` cookies when the request came over HTTPS. |
| `SESSION_SECRET` | generated | Generated once and stored in `/data` if not set. |
| `REQUIRE_2FA` | `false` | Require two-factor authentication for every admin. |
| `CURRENCY` | `EUR` | Currency for prices typed by hand in *Gifts to give*. |
| `REMINDER_HOUR` | `9` | Hour of the day (0–23, in `TZ`) when daily reminders are sent. |
| `PORT` | `3000` | |

## Admin accounts

Each admin has their own account (username and password, no email needed).

- **Add an admin:** *Admins → Create invite link* and send the link. It is valid for 48 hours, works once, and the person picks their own username and password.
- **Profile:** change your name, username and password, and set up your notifications. Changing your password logs out your other devices.
- **Forgot a password:** another admin opens *Admins* and creates a *New-password link* for that account. If nobody can log in, run this on the server; it prints a one-time link:
  ```sh
  docker exec giftly node scripts/reset-password.js <username>
  docker exec giftly node scripts/invite.js          # or: a link to create a new admin account
  ```
- **Two-factor authentication (optional):** in *Profile → Two-factor authentication*, scan the QR code with any authenticator app (Google Authenticator, Aegis, 1Password, Bitwarden…) and confirm with a code. You get 10 single-use recovery codes. Logins then ask for the 6-digit code; a code can't be reused, and attempts are rate limited. New-password links also ask for the code. If someone loses their phone and recovery codes, another admin can turn their 2FA off in *Admins*, or run `docker exec giftly node scripts/disable-2fa.js <username>`.
- **Require 2FA for everyone:** set `REQUIRE_2FA=true`. Admins without 2FA can only set it up after logging in, and nobody can turn it off.
- Passwords are hashed with scrypt; sessions and links are random tokens and only their hashes are stored. Logins are rate limited.

**Upgrading from 1.x:** keep `ADMIN_PASSWORD` set for the first start of 2.0 (optionally with `ADMIN_USERNAME`, default `admin`). Giftly creates that account and moves your notification settings to it. You can then remove `ADMIN_PASSWORD` and any `NOTIFY_*` variables.

## Wishlists

Every admin has a personal wishlist (*Wishlist → Mine*): what they'd like to receive, in order of preference (↑/↓), with link, notes, and the shop's image and price, as for list gifts. Removing an item asks why: *I bought it*, *I don't want it any more*, or *I received it*.

Other admins (*Wishlist → Others'*) can:
- **Create a guest list from it:** choose the items. They stay **linked**, so when the owner edits an item the list follows, and new wishlist items join the list automatically (or wait for approval, per list). You can still add the list's own gifts, add notes, or hide a linked item in just that list.
- **Take an item with "I'll give it":** it is reserved in every list and becomes a private gift in *Gifts to give* for the chosen occasion. From a checklist, *Pick from their wishlist* does the same.

**The surprise is protected:**
- The owner **never** sees what was reserved: their wishlist page is byte-for-byte the same either way, and removing a reserved item gives exactly the same answer as removing any other.
- A list made from someone's wishlist is **never visible to them**, even if shared with the other admins, and its notifications never reach them. This rule is enforced by the app and tested, so you can't create a list from your own wishlist.
- A wishlist item can only be reserved **once across every list** (and "I'll give it"); simultaneous attempts are safe.
- If the owner removes an item someone already reserved, that guest keeps it in their picks with a note ("they already bought it — don't buy it"), and the list's organiser (or the admin giving it) is notified.
- When a list is archived, or a gift from the wishlist is marked *given*, the item leaves the owner's active wishlist (as received).

Lists also have an owner and can be **private** (only you) or **shared** (all admins). Lists from before 3.0 stay shared.

## Gifts to give

A separate part of the admin (*Gifts to give*) to plan the gifts **you** give, not tied to the public lists.

- **People:** name, birthday (day and month, year optional for ages), notes, and whether you give them a Christmas gift.
- **Occasions:** birthdays appear on their own every year, from each person's date. *Create Christmas YYYY* creates that year's Christmas with everyone marked for Christmas, and you can add or remove people just for that year. Marking someone for Christmas later also adds them to this year's Christmas if it already exists. Custom occasions (christenings, weddings…) have a name, a date and participants.
- **Favourites and search:** star the people you give to most (favourites are per admin and come first), and search people (name or notes) and occasions as you type.
- **Duplicate an occasion** for the next year, with the same people (gifts aren't copied).
- **Ideas → guest lists:** put a gift idea on a guest list, or create a guest list from a person's ideas (e.g. so the grandparents can pick from them). The ideas are copied, and each one then shows which list it is on and whether someone reserved it. Lists made from ideas for someone who is an admin are never visible to that admin.
- **Checklist per occasion**, made for the phone: "12 of 18 people already have a gift", total spent, each person's gifts (idea → bought → given), what they got the year before, and a filter for people still without a gift.
- **Upcoming:** the next 60 days, with "has a gift / ideas / no gift yet" for each occasion.
- **Joint gifts:** a gift can be for several people, for example one Christmas gift for a couple. It counts as a gift for each of them, shows in each one's history, and enters the total spent once. Their birthday gifts stay individual.
- **Gifts** can have a link, notes, an image (read from the link or uploaded) and a price. The price comes from the shop's page when it shows one, and is kept up to date while the gift is still an idea. It freezes once the gift is bought, so totals reflect what you paid. When the shop shows no price, you type it. `CURRENCY` (default `EUR`) is used for typed prices.
- **Shared or private:** every person, occasion and gift is *shared* (all admins see it) or *private* (only whoever created it). A private gift for a shared person, for example a surprise for the other admin, stays hidden from them everywhere, including progress and totals. A joint gift is only shown to someone who can see every person it is for. Only the creator can change who sees an entry. Removing an admin deletes their private entries and keeps the shared ones.

**Reminders:** once a day (at `REMINDER_HOUR`, default 9:00 in `TZ`) each admin gets a message on their own notification channels for every birthday or occasion that is coming up and still has no gift bought, for example *"In 14 days: Ana's birthday. No gift bought yet (2 ideas noted)."* or *"In 3 days: Christmas 2026. 6 of 18 people still without a gift."*. Each admin chooses how many days before in their **Profile** (default 14 and 3; empty turns reminders off) and can send today's reminders on demand to check. Reminders only include what that admin can see, so shared occasions remind everyone and private ones only their owner. Each reminder is sent once; if the server was off on the exact day, it goes out on the next run.

The privacy is enforced by the app; whoever has access to the server or the `/data` volume can read the database.

## Notifications

Each admin sets up their own notifications under **Profile → Notifications**: which events (someone picks a gift, gives one up, or opens a list for the first time) and one or more channels. **Send test notification** sends only to you.

| Channel | What you need |
|---|---|
| [ntfy](https://ntfy.sh) (free phone app) | A topic such as `https://ntfy.sh/giftly-<random>` or just `giftly-<random>` (letters, numbers, `-` and `_` only). Add an access token for protected or self-hosted servers. |
| Telegram | A bot token (from @BotFather) and your chat ID (send your bot a message, then open `https://api.telegram.org/bot<token>/getUpdates`). |
| Discord / Slack / anything else | A webhook URL. It receives a JSON POST with `content` (Discord), `text` (Slack), plus `event`, `list`, `guest`, `item`, `price`, `item_url` and `url`. |

Tokens are never shown back in the page: leave the field empty to keep the current one, or tick *Clear* to remove it. With `BASE_URL` set, each message links to the list in the admin. Messages use `APP_LANG`. A failing channel is logged and never affects guests.

On ntfy.sh, anyone who knows the topic name can read it, so make it long and random (for example `giftly-` followed by `openssl rand -hex 12`).

## Exposing it with Cloudflare Tunnel

If your domain is on Cloudflare, you don't need to open any ports:

1. In Cloudflare go to **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*), and copy the token.
2. Add a **public hostname**, e.g. `gifts.example.com`, with service `http://giftly:3000`.
3. Put the token in `.env` as `TUNNEL_TOKEN=...` and set `BASE_URL=https://gifts.example.com`.
4. Run `docker compose --profile tunnel up -d`.

Optionally, protect `/admin` with a Cloudflare Access policy for extra safety.

## How it works

- **Access:** every list has an unguessable link (`/l/<22 random characters>`). Anyone with the link can join. Use *Generate new link* in the admin to revoke the old one, which also logs out everyone who joined.
- **Identity:** a guest is identified by their name within a list (not case-sensitive). Typing the same name on another device shows the same picks. This is intentionally simple and built for trust between family and friends, not for strangers.
- **Order:** drag gifts by their handle (⋮⋮) to reorder a list or your wishlist, with the mouse or a finger. The ↑/↓ buttons remain as a fallback without JavaScript.
- **Picks:** picks are atomic, so if two people click at the same moment, only one gets the gift. Guests can give up their own picks. In the admin you can release any gift.
- **Reserving on someone's behalf:** use *Reserve* on a gift and type a name (or pick a guest who already joined), for someone who told you in person. The reservation belongs to that guest: when they open the list with that name, they see it in their picks ("Reserved for you by …") and can give it up. The other admins are notified.
- **Images:** when you add a link, the server fetches the page in the background, reads its Open Graph, Twitter card, JSON-LD or microdata product image (with Amazon-specific fallbacks), and **stores a copy of the image** in `/data/images`. Guests never load anything from the shops. Some shops block automated requests (e.g. Akamai-protected ones); in that case, **upload a photo** (resized in the browser) or paste an image link. An image is only ever replaced by another image.
- **Prices:** prices only come from the shop link (`product:price`, JSON-LD offers, microdata, Amazon page data) and there is no price field. Available gifts are re-checked once a day, and the last known price is kept if a check fails. Gifts without a link, or from shops that block us, show no price. Requests to private and internal addresses are refused, and only JPEG, PNG, WebP, GIF and AVIF up to 5 MB are accepted.
- **Archive:** archive a list to close it without deleting anything.

## Backups

Everything lives in `/data`: `giftly.db` (SQLite, WAL mode) and `images/`. To back it up while running:

```sh
docker compose exec giftly node -e "new (require('node:sqlite').DatabaseSync)('/data/giftly.db').exec(\"VACUUM INTO '/data/backup.db'\")"
```

## Development

Requires Node.js 24+:

```sh
ADMIN_USERNAME=dev ADMIN_PASSWORD=dev-password npm run dev
npm test        # end-to-end tests against a real server + parser unit tests
```

To regenerate the README screenshots with mock data (needs podman or docker): `tools/screenshots/run.sh`.

CI runs the tests on every push and pull request, and only builds the image if they pass. The image is also rebuilt every week, so `latest` gets Node and Alpine security fixes even without code changes. Dependabot proposes updates to the GitHub Actions and the base image.

## License

[GPL-3.0](LICENSE)

## Support

If Giftly is useful to you, you can support its development:

<a href="https://liberapay.com/dfloureiro/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a>
