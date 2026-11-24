# Your data: backups, restore and rollback

← [Back to the README](../README.md)

- [Where your data lives](#where-your-data-lives)
- [Backups](#backups)
- [Restoring a backup](#restoring-a-backup)
- [Rolling back by hand](#rolling-back-by-hand)

## Where your data lives

Everything Giftly keeps is in `/data` (the `data/` folder next to `compose.yaml`), organised in **releases**:

```
data/
  current -> releases/2026-11-23T15-00-00-000Z      the release Giftly serves
  releases/
    2026-11-23T15-00-00-000Z/   giftly.db, images/, .session-secret, manifest.json
    2026-11-20T09-00-00-000Z/   …
```

The idea: **data Giftly might need to go back to is never changed.**

- Restoring a backup or upgrading the database creates a **new release**. Switching to it is a single atomic step (the `current` link).
- Each release has a `manifest.json`: the Giftly version, the database schema, where it came from (`initial`, `upgrade`, `restore`), its parent release, and a fingerprint of its data. Giftly refuses to serve a release that doesn't match its fingerprint the first time it opens it.
- **Upgrades:** when a new Giftly needs a newer database schema, it copies the current release (photos are hard links, so they take no extra space), upgrades **the copy**, and only then switches `current` to it. If that fails, it doesn't start, and `current` still points to the untouched previous release. This works the same with the installer, plain Compose or `docker run`.
- **Retention:** the newest 3 releases are kept, plus the current one and its parent. Older ones are removed when Giftly starts.

The privacy rules are enforced by the app. Whoever has access to the server or the `/data` folder can read the database.

## Backups

`backup.sh` saves the current release (database, photos and fingerprint) into one file, **outside** the data folder, while Giftly keeps running:

```sh
cd giftly                                   # the folder with compose.yaml
curl -fsSLO https://raw.githubusercontent.com/dfloureiro/Giftly/main/scripts/backup.sh
curl -fsSLO https://raw.githubusercontent.com/dfloureiro/Giftly/main/scripts/restore.sh
sh backup.sh --keep 14                      # → backups/giftly-backup-<date>.tar.gz (newest 14 kept)
```

Not using Compose (e.g. Portainer)? Add `GIFTLY_CONTAINER=<container name>`. `BACKUP_DIR` chooses where the file goes.

**Every day, with cron** (`crontab -e`):

```
30 3 * * * cd /home/me/giftly && sh backup.sh --keep 14 >> backups/backup.log 2>&1
```

Good to know:

- **Copy backups to another machine too.** A backup on the same disk is lost with that disk. For example `rsync -a backups/ nas:/backups/giftly/`, [restic](https://restic.net), or a synced folder.
- **The file is sensitive:** it contains password hashes and two-factor secrets. It's written as private (`600`). Keep it that way, and encrypt it if it leaves your machines.
- **Session secret:** left out by default, so a restore on the same machine keeps the one in use and nobody is signed out. `--include-secrets` brings it along (useful on a new machine, where guests and admins would otherwise sign in again), which makes the file more sensitive.
- **Only complete backups are written.** A backup holds exactly the photos its database uses. If a photo is replaced while it runs, it tries again from a fresh snapshot. If it still can't complete, it says which photos are missing, exits with an error (so cron notices), writes nothing and doesn't prune older backups. `--allow-missing-images` writes it anyway and lists the missing photos.
- Backups from Giftly 3.x can't be restored by Giftly 4 or later.

## Restoring a backup

On the same machine, or a new one after installing Giftly there:

```sh
sh restore.sh backups/giftly-backup-20261123-033000.tar.gz
```

What happens:

1. **Check, while Giftly keeps running.** The backup is unpacked into a **new release** and checked: only the expected files, every checksum, not from a newer Giftly, the database itself, every photo it uses, and the fingerprint. A backup that fails any check is refused before Giftly is stopped, and nothing changes. (`--allow-missing-images` accepts one with missing photos.)
2. **Switch.** Giftly is stopped, `current` points to the new release, and Giftly starts. The restore only succeeds if Giftly then **serves that release**. An older backup is upgraded into a new release automatically.
3. **Or switch back.** If not, `current` goes back to the previous release, Giftly starts again and it checks that it serves it. The restore still exits with an error and tells you where the failed release is (kept for you to inspect).

The previous release is never modified. A Giftly that was stopped before the restore stays stopped: the switch is done, and Giftly checks the release when it starts.

## Rolling back by hand

Stop Giftly, point `current` at the release you want, put the previous image back, and start it:

```sh
docker compose stop giftly
docker compose run --rm --no-deps --entrypoint node giftly scripts/release.js list     # * = current
docker compose run --rm --no-deps --entrypoint node giftly scripts/release.js switch 2026-11-20T09-00-00-000Z
# installer users: the previous compose.yaml (with its image digests) is in .giftly-backup/<date>/
docker compose up -d
```
