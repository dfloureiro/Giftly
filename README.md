# 🎁 Giftly

Self-hosted gift lists for families and friends.

- You create a list in the admin and add gifts: links to any shop, or plain items without a link.
- You share the list's **secret link**. People open it, type their name, and pick what they'll give.
- A picked gift **disappears for everyone else**, so no two people buy the same thing.
- Gifts with a link show the **shop's product image and price** automatically. Prices are re-checked daily and are never typed by hand.
- Optional **notifications** (ntfy, Telegram, Discord/Slack webhook) when someone picks a gift.
- The admin always shows everything: who picked what and when, and who joined.

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
</details>

Available in **Portuguese (pt-PT)** and **English**. The language follows the visitor's browser, and every page has a PT/EN switch.

No accounts, no email, no tracking. It is a single small container with a SQLite file, and the code has zero npm dependencies.

## Quick start

```sh
mkdir giftly && cd giftly
curl -O https://raw.githubusercontent.com/dfloureiro/giftly/main/compose.yaml
echo "ADMIN_PASSWORD=$(openssl rand -base64 18)" > .env
cat .env                     # keep this password
docker compose up -d
```

Open <http://localhost:3000/admin>, log in, and create your first list.

Or with plain Docker:

```sh
docker run -d --name giftly -p 3000:3000 \
  -e ADMIN_PASSWORD=your-long-password \
  -v giftly-data:/data \
  ghcr.io/dfloureiro/giftly:latest
```

## Configuration

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | — | **Required**, at least 8 characters. Changing it logs out admin sessions. |
| `APP_LANG` | `pt` | Fallback language (`pt` or `en`) when the browser asks for neither. |
| `SITE_TITLE` | `Giftly` | Name shown on the home page and in the browser tab. |
| `BASE_URL` | auto | Public URL used for the share link in the admin, e.g. `https://gifts.example.com`. |
| `TZ` | `Europe/Lisbon` | Time zone for dates in the admin. |
| `LINK_PREVIEWS` | `true` | Fetch product pages to show each gift's image and price. Set to `false` to turn it off. |
| `TRUST_PROXY` | `true` | Trust `CF-Connecting-IP` / `X-Forwarded-*`. Set to `false` if the app is exposed directly. |
| `COOKIE_SECURE` | `auto` | `auto` sets `Secure` cookies when the request came over HTTPS. |
| `SESSION_SECRET` | generated | Generated once and stored in `/data` if not set. |
| `PORT` | `3000` | |

## Notifications

You can get a message when someone picks or gives up a gift. Set one or more of these:

| Channel | Variables |
|---|---|
| [ntfy](https://ntfy.sh) (free phone app) | `NOTIFY_NTFY_URL=https://ntfy.sh/<long-random-topic>` (optional: `NOTIFY_NTFY_TOKEN` for protected/self-hosted servers) |
| Telegram | `NOTIFY_TELEGRAM_BOT_TOKEN` (from @BotFather) and `NOTIFY_TELEGRAM_CHAT_ID` (send your bot a message, then open `https://api.telegram.org/bot<token>/getUpdates`) |
| Discord / Slack / anything else | `NOTIFY_WEBHOOK_URL`: receives a JSON POST with `content` (Discord), `text` (Slack), plus `event`, `list`, `guest`, `item`, `price`, `item_url`, `url` |

`NOTIFY_EVENTS` chooses what triggers a message: `pick,unpick` (default), and you can add `join` (someone opened a list for the first time). Messages use `APP_LANG`. With `BASE_URL` set, each message links to the list in the admin. Use **Send test notification** in the admin to check your setup.

On ntfy.sh, anyone who knows the topic name can read it, so make the topic long and random (for example `giftly-` followed by `openssl rand -hex 12`).

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
- **Picks:** picks are atomic, so if two people click at the same moment, only one gets the gift. Guests can give up their own picks. In the admin you can release any gift, or mark one as reserved by name for someone who told you in person.
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
ADMIN_PASSWORD=dev-password npm run dev
```

## License

[GPL-3.0](LICENSE)
