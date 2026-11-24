<p align="center">
  <img src="public/icons/icon-192.png" alt="Giftly" width="96" height="96">
</p>

<h1 align="center">Giftly</h1>

<p align="center"><strong>Gift lists for family and friends, on your own server.</strong><br>
No more two aunts buying the same toaster.</p>

## How it works

1. **Make a list** and add gifts: links to any shop, or plain items. Giftly shows each shop's photo and price on its own.
2. **Share the list's secret link** with family and friends.
3. **Guests open it, type their name and pick a gift.** No account, no email, no app.
4. **A picked gift disappears for everyone else**, so nobody buys the same thing twice. You see who picked what.
5. **Optional, per list:** guests say who buys the gift (they do, or they'd like you to, and you mark it once bought), see what others already reserved, and reserve on behalf of someone else.

## What else it does

- 🎁 **Wishlists.** Keep your own wishlist, and ideas for the people you give to. Turn either into a guest list in a couple of taps.
- 🤫 **Keeps the surprise.** You never see what was reserved, planned or bought for you, even as an admin.
- 📅 **Gifts you give.** Birthdays, Christmas and other occasions, with a checklist per occasion, what everyone got last year, and how much you spent.
- 🔔 **Notifications and reminders** on your phone (ntfy, Telegram, Discord, Slack) when someone picks a gift, or when a birthday is coming and there's still no gift.
- 👥 **Several admins**, each with their own account, and entries that are shared or private.
- 🌍 **Portuguese and English**, following each visitor's browser.
- 🪶 **Small and private.** One container and one SQLite file, no tracking, zero npm dependencies.

## See it

Made for the phone first. This is how guests and admins see it:

<p align="center">
  <img src="docs/screenshots/guest-flow.gif" alt="A guest opens the list link on a phone, types their name, scrolls to a plant and taps “I'll buy it”; it moves to their picks" width="240">
  &nbsp;
  <img src="docs/screenshots/guest-list.png" alt="A guest's view of a gift list on a phone: their own pick at the top (they asked the hosts to buy it), available gifts with images, prices and shop links below" width="240">
  &nbsp;
  <img src="docs/screenshots/guest-mobile-dark.png" alt="The gift list on a phone in dark mode" width="240">
</p>

<details>
<summary><strong>Occasions and people</strong></summary>
<p align="center">
  <img src="docs/screenshots/give-upcoming.png" alt="Occasions, the home page: the next 60 days as cards, Christmas pinned on top, each with how many gifts are missing" width="240">
  &nbsp;
  <img src="docs/screenshots/give-checklist.png" alt="Christmas checklist on a phone: progress, total spent, each person's gifts with status, and what they got last year" width="240">
  &nbsp;
  <img src="docs/screenshots/give-person.png" alt="A person's page: next birthday and age, their wishlist, upcoming occasions and gift history" width="240">
</p>
</details>

<details>
<summary><strong>Lists and wishlists</strong></summary>
<p align="center">
  <img src="docs/screenshots/admin-list.png" alt="Admin page of a list on a phone: every gift with who reserved it and who buys it, mark as bought, and add, edit, release and reorder actions" width="240">
  &nbsp;
  <img src="docs/screenshots/wishlist-own.png" alt="Your own wishlist: items in order of preference, with no hint of what was reserved" width="240">
  &nbsp;
  <img src="docs/screenshots/wishlist-others.png" alt="Another admin's wishlist on their page: available or already chosen items, I'll give it, and create a list from it" width="240">
</p>
<p align="center">
  <img src="docs/screenshots/wishlist-list.png" alt="A private guest list created from someone's wishlist, with linked items, hide here, and items reserved elsewhere" width="240">
  &nbsp;
  <img src="docs/screenshots/join-mobile.png" alt="Joining a list on a phone: only a name is needed" width="240">
</p>
</details>

<details>
<summary><strong>Settings</strong></summary>
<p align="center">
  <img src="docs/screenshots/notifications.png" alt="Notifications: which events to be notified about, ntfy, Telegram and webhook channels, and reminders" width="240">
  &nbsp;
  <img src="docs/screenshots/admins.png" alt="Admins page: every admin account, new-password links, and invite links to add another admin" width="240">
</p>
</details>

## Quick start

On any machine with Docker (a NAS, a Raspberry Pi, a server):

```sh
curl -fsSL https://raw.githubusercontent.com/dfloureiro/Giftly/main/install.sh -o install.sh && sh install.sh
```

It asks for your domain and a [Cloudflare Tunnel](docs/install.md#putting-it-online-with-cloudflare-tunnel) token (both optional), creates a strong admin password, starts Giftly and tells you how to log in. **To update, run it again.**

Prefer Docker Compose, Portainer or plain `docker run`? See [Installing](docs/install.md).

## Configuration

Everything is optional. The one most people need is `BASE_URL`, the public address (e.g. `https://gifts.example.com`), as soon as Giftly is reachable from the internet. Others set the language, time zone, currency and reminder time.

All settings are in [Installing → Configuration](docs/install.md#configuration).

## Documentation

| | |
|---|---|
| [Using Giftly](docs/guide.md) | Lists and guests, wishlists, keeping the surprise, occasions and gifts to give |
| [Installing and configuring](docs/install.md) | Installer, Compose, Docker, all settings, Cloudflare Tunnel |
| [Admin accounts](docs/accounts.md) | Adding admins, forgotten passwords, two-factor authentication |
| [Notifications and reminders](docs/notifications.md) | ntfy, Telegram, webhooks, daily reminders |
| [Your data](docs/data.md) | Backups, restore, rolling back |
| [Upgrading](docs/upgrading.md) | Moving between major versions (4 → 5 and older) |

## Your data

Everything lives in the `data/` folder next to `compose.yaml`. Upgrades and restores always work on a copy, so the data you had before is never changed, and you can go back to it. Take regular backups with `backup.sh` and keep a copy on another machine: see [Your data](docs/data.md) (including *Rolling back by hand*).

## Development

Requires Node.js 24+:

```sh
ADMIN_USERNAME=dev ADMIN_PASSWORD=dev-password npm run dev
npm test        # end-to-end tests against a real server + parser unit tests
```

Rules and lessons for contributors are in [AGENTS.md](AGENTS.md). To regenerate the README screenshots with mock data (needs podman or docker): `tools/screenshots/run.sh`.

CI runs the tests on every push and pull request, and only builds the image if they pass. The image is rebuilt every week, so it gets Node and Alpine security fixes even without code changes.

## License

[GPL-3.0](LICENSE)

## Support

If Giftly is useful to you, you can support its development:

<a href="https://liberapay.com/dfloureiro/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a>
