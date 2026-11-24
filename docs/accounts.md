# Admin accounts

← [Back to the README](../README.md)

Each admin has their own account: a username and a password, no email needed. Guests never need an account.

## Adding an admin

Open *Admins → Create invite link* and send the link. It is valid for 48 hours and works once. The new admin picks their own username and password.

## Your profile

In *Profile* you change your name, username, password and birthday. Changing your password logs out your other devices. Your notifications are under *Notifications* (see [Notifications](notifications.md)).

## Forgotten passwords

Another admin opens *Admins* and creates a *New-password link* for that account.

If nobody can log in, run one of these on the server. Each prints a one-time link:

```sh
docker exec giftly node scripts/reset-password.js <username>   # a new password for an existing account
docker exec giftly node scripts/invite.js                      # a link to create a new admin account
```

## Two-factor authentication (optional)

1. In *Profile → Two-factor authentication*, scan the QR code with any authenticator app (Google Authenticator, Aegis, 1Password, Bitwarden…).
2. Confirm with a code.
3. Keep the 10 single-use recovery codes you're given somewhere safe.

From then on, logging in (and using a new-password link) asks for the 6-digit code. A code can't be used twice, and attempts are rate limited.

**Lost phone and recovery codes?** Another admin can turn that account's 2FA off in *Admins*, or run:

```sh
docker exec giftly node scripts/disable-2fa.js <username>
```

**Require it for everyone:** set `REQUIRE_2FA=true`. Admins without 2FA must set it up right after logging in, and nobody can turn it off.

## How accounts are stored

Passwords are hashed with scrypt. Sessions and links are random tokens, and only their hashes are stored. Logins are rate limited.
