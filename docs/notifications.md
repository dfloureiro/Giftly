# Notifications and reminders

← [Back to the README](../README.md)

Each admin sets up their own notifications under **Notifications** (in the account menu, top right).

## What you can be told about

- Someone picks a gift.
- Someone gives a gift up.
- Someone opens a list for the first time.
- **Reminders** for birthdays and occasions that still have no gift bought (see [below](#reminders)).

**Send test notification** sends a message only to you.

## Channels

You can set up one or more:

| Channel | What you need |
|---|---|
| [ntfy](https://ntfy.sh) (free phone app) | A topic such as `https://ntfy.sh/giftly-<random>` or just `giftly-<random>` (letters, numbers, `-` and `_` only). Add an access token for protected or self-hosted servers. |
| Telegram | A bot token (from @BotFather) and your chat ID (send your bot a message, then open `https://api.telegram.org/bot<token>/getUpdates`). |
| Discord / Slack / anything else | A webhook URL. It receives a JSON POST with `content` (Discord), `text` (Slack), plus `event`, `list`, `guest`, `item`, `price`, `item_url`, `buyer` (`guest` or `us`, on lists that [ask who buys](guide.md#who-buys-the-gift)) and `url`. |

Good to know:

- **On ntfy.sh, anyone who knows the topic name can read it.** Make it long and random, for example `giftly-` followed by the output of `openssl rand -hex 12`.
- Tokens are never shown back in the page. Leave the field empty to keep the current one, or tick *Clear* to remove it.
- With `BASE_URL` set, each message links to the list in the admin.
- Messages are in the `APP_LANG` language.
- A failing channel is logged and never affects guests.

## Reminders

Once a day (at `REMINDER_HOUR`, default 9:00 in `TZ`), each admin gets a message for every birthday or occasion that is coming up and still has no gift bought. For example:

> In 14 days: Ana's birthday. No gift bought yet (1 planned).
>
> In 3 days: Christmas 2026. 6 of 18 people still without a gift.

- Choose how many days before under **Notifications** (default 14 and 3). Leave it empty to turn reminders off.
- You can send today's reminders on demand, to check.
- Reminders only include what you can see: shared occasions remind everyone, private ones only their owner, and nobody is reminded of their own birthday.
- Each reminder is sent once. If the server was off on the exact day, it goes out on the next run.

## Servers on your own network

For safety, notifications are never sent to local or private addresses (`localhost`, `192.168.…`, `10.…`, and names that resolve to them), and redirects are not followed. That way a stolen admin account can't use Giftly to reach other services on your network.

If your ntfy or webhook server runs on your own network, allow it with `NOTIFY_ALLOWED_HOSTS`, e.g. `NOTIFY_ALLOWED_HOSTS=ntfy.lan,192.168.1.10`.
