# 🎁 Giftly

Self-hosted gift lists for families and friends.

- You create a list in the admin and add gifts: links to any shop, or plain items without a link.
- You share the list's **secret link**. People open it, type their name, and pick what they'll give.
- A picked gift **disappears for everyone else**, so no two people buy the same thing.
- The admin always shows everything: who picked what and when, and who joined.

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
| `TRUST_PROXY` | `true` | Trust `CF-Connecting-IP` / `X-Forwarded-*`. Set to `false` if the app is exposed directly. |
| `COOKIE_SECURE` | `auto` | `auto` sets `Secure` cookies when the request came over HTTPS. |
| `SESSION_SECRET` | generated | Generated once and stored in `/data` if not set. |
| `PORT` | `3000` | |

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
- **Archive:** archive a list to close it without deleting anything.

## Backups

Everything lives in `/data/giftly.db` (SQLite, WAL mode). To back it up while running:

```sh
docker compose exec giftly node -e "new (require('node:sqlite').DatabaseSync)('/data/giftly.db').exec(\"VACUUM INTO '/data/backup.db'\")"
```

## Development

Requires Node.js 24+:

```sh
ADMIN_PASSWORD=dev-password npm run dev
```

## License

MIT
