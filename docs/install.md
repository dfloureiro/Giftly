# Installing and configuring Giftly

← [Back to the README](../README.md)

- [One-step installer](#one-step-installer)
- [Docker Compose by hand](#docker-compose-by-hand)
- [Plain Docker](#plain-docker)
- [Which version you get](#which-version-you-get)
- [Configuration](#configuration)
- [Putting it online with Cloudflare Tunnel](#putting-it-online-with-cloudflare-tunnel)
- [Protecting the login page](#protecting-the-login-page)

## One-step installer

Works on any machine with Docker (a NAS, a Raspberry Pi, a server). It needs Docker Compose 2.24 or newer.

```sh
curl -fsSL https://raw.githubusercontent.com/dfloureiro/Giftly/main/install.sh -o install.sh && sh install.sh
```

The installer:

1. asks for your domain and a [Cloudflare Tunnel](#putting-it-online-with-cloudflare-tunnel) token (both optional),
2. creates a strong admin password,
3. starts Giftly and shows you how to log in.

Without a tunnel, Giftly is only reachable from that machine, at <http://localhost:3000/login>. Files come from the latest release, and you can read [the script](../install.sh) before running it.

### Updating

Run the installer again. What it does:

- It never changes your `.env` or `cloudflared.env`.
- It manages `compose.yaml` itself and rewrites it on every update. Put your own changes in `compose.override.yaml`. (If you had edited `compose.yaml`, your version is kept next to it as `compose.yaml.local-<date>`.)
- Images are named **by digest**: the exact image, not a tag that can move.
- An update only counts as successful when Giftly serves your data (not just answers), and the tunnel is connected if you use one.
- If it fails, it puts back your settings, the exact previous images and the [data release](data.md) they served, checks that they work again, and tells you why.
- A failed download changes nothing.

## Docker Compose by hand

```sh
mkdir giftly && cd giftly
curl -O https://raw.githubusercontent.com/dfloureiro/Giftly/main/compose.yaml
printf 'ADMIN_USERNAME=me\nADMIN_PASSWORD=%s\n' "$(openssl rand -base64 18)" > .env
cat .env                     # keep this password
docker compose up -d
```

Open <http://localhost:3000/login>, log in with that username and password, and create your first list.

The username and password are only used to create the first account. Afterwards you can remove them from `.env`.

To update: `docker compose pull && docker compose up -d`. In Portainer: *Update the stack* with *Re-pull image*.

## Plain Docker

```sh
docker run -d --name giftly -p 127.0.0.1:3000:3000 \
  -e ADMIN_USERNAME=me -e ADMIN_PASSWORD=your-long-password \
  -v giftly-data:/data \
  ghcr.io/dfloureiro/giftly:latest
```

## Which version you get

The image follows `ghcr.io/dfloureiro/giftly:5`: fixes and new features within 5.x, never a breaking 6.0. To stay on an exact version, set `GIFTLY_TAG=5.0.0` in `.env`.

Moving between major versions is always on purpose. See [Upgrading](upgrading.md).

## Configuration

Set these in `.env` (or with `-e` for plain Docker). All are optional.

### The basics

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Username of the first account. Only used on the very first start. |
| `ADMIN_PASSWORD` | — | Password of the first account (at least 8 characters). Only used on the very first start, when there are no accounts yet; ignored afterwards (with a warning). |
| `BASE_URL` | auto | Public address, e.g. `https://gifts.example.com`. Used in share, invite and new-password links and in notifications. **Set it** whenever Giftly is reachable from the internet. Without it, invite and new-password links can only be created on the machine running Giftly (`http://localhost`). |
| `SITE_TITLE` | `Giftly` | Name shown on the home page and in the browser tab. |
| `APP_LANG` | `pt` | Fallback language (`pt` or `en`) when the browser asks for neither. Also the language of notifications. |
| `TZ` | `Europe/Lisbon` | Time zone for dates and reminders. |
| `CURRENCY` | `EUR` | Currency for prices typed by hand in *Gifts to give*. |
| `REMINDER_HOUR` | `9` | Hour of the day (0–23, in `TZ`) when daily reminders are sent. |
| `PORT` | `3000` | |

### Security and networking

| Variable | Default | What it does |
|---|---|---|
| `REQUIRE_2FA` | `false` | Require two-factor authentication for every admin. See [Accounts](accounts.md). |
| `LINK_PREVIEWS` | `true` | Fetch product pages to show each gift's image and price. `false` turns it off. |
| `TRUST_PROXY` | `true` | Trust `CF-Connecting-IP` / `X-Forwarded-*` from a reverse proxy or Cloudflare Tunnel. They are only believed when the connection comes from a private or local address (the proxy next to Giftly), never from the internet. `false` never trusts them. |
| `TRUSTED_PROXIES` | — | Only these proxies may set those headers, as IPs or CIDR ranges, e.g. `172.18.0.0/16`. Empty means any private or local peer. |
| `NOTIFY_ALLOWED_HOSTS` | — | Notification servers on your own network that Giftly may send to, e.g. `ntfy.lan,192.168.1.10`. Local and private addresses are refused otherwise. See [Notifications](notifications.md). |
| `COOKIE_SECURE` | `auto` | `auto` sets `Secure` cookies when the request came over HTTPS. |
| `SESSION_SECRET` | generated | Generated once and stored in `/data` if not set. |

## Putting it online with Cloudflare Tunnel

If your domain is on Cloudflare, you don't need to open ports, set up a reverse proxy or get certificates:

1. In Cloudflare, open **Zero Trust → Networks → Tunnels**, create a tunnel (type *Cloudflared*) and copy its token.
2. Add a **public hostname** to the tunnel, e.g. `gifts.example.com`, with service `http://giftly:3000`.
3. Run the [one-step installer](#one-step-installer) and paste the domain and token when asked.

By hand instead: put `TUNNEL_TOKEN=...` in `cloudflared.env` (Giftly itself never sees it), `BASE_URL=https://gifts.example.com` in `.env`, and run `docker compose --profile tunnel up -d`.

## Protecting the login page

Admins log in at `/login` (the two-factor step is `/login/2fa`). Every other admin page needs a session and sends you to `/login` without one, and back afterwards.

So you can put just the login behind a Cloudflare challenge without touching the guest links (`/l/…`) or the rest of the admin. For example, a WAF custom rule *URI Path starts with `/login`* → *Managed Challenge*. For more, protect `/login` and `/admin` with a Cloudflare Access policy.
