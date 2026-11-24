# Upgrading between major versions

← [Back to the README](../README.md)

Within a major version (5.x), updates are automatic: run the installer again, or `docker compose pull && docker compose up -d`. See [Installing](install.md#updating).

A new major version is never installed on its own. These notes cover moving to one.

Every change to the database works on a **copy** of your data (a new [data release](data.md)), so going back to the previous version always finds your old data untouched.

## 4.x → 5.0

4.x installs stay on `:4`, so you move on purpose:

- **Installer:** run it again. It now installs `:5`, after removing any `GIFTLY_TAG=4` from `.env`.
- **Compose:** set `GIFTLY_TAG=5` (or the image `ghcr.io/dfloureiro/giftly:5`), then `docker compose pull && docker compose up -d`.

What changes:

- The admin is reorganised. The old `/admin/give…` addresses are gone. **Guest links don't change.**
- Every gift that was still an "idea" moves into a wishlist of ideas for its person: shared ideas into the shared one, private ideas (and ideas for an admin) into the giver's private ideas.
- Gifts taken with "I'll give it" become *planned*.
- Each admin gets their own record in People.

## 3.x → 4

On its first start, Giftly 4 *copies* the old `data/giftly.db` and `data/images/` into its first [release](data.md). The old files stay where they are, untouched, so going back to 3.x still finds them. (If a 3.x runs on them again, the next Giftly 4 copies them again.)

Once you're happy with 4.x or later, you can delete `data/giftly.db*`, `data/images/`, `data/.session-secret` and any `data/pre-upgrade-*`, `data/pre-restore-*`, `data/failed-*` folders left by 3.x.

**Backups from Giftly 3.x can't be restored by Giftly 4 or later.** Take a new backup after updating.

## 1.x → 2.0

Keep `ADMIN_PASSWORD` set for the first start of 2.0 (optionally with `ADMIN_USERNAME`, default `admin`). Giftly creates that account and moves your notification settings to it. You can then remove `ADMIN_PASSWORD` and any `NOTIFY_*` variables.
