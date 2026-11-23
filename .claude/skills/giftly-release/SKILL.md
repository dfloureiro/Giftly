---
name: giftly-release
description: Release a new Giftly version (bump, docs, CI on main, tag, GitHub release page, image check). Use when asked to publish, release or tag a version of Giftly.
---

# Releasing Giftly

Only release when the owner asked for it. A release is public: images are pulled by every install that follows `:3`.

1. **Everything green locally:** `npm test`. If you touched `install.sh`, `compose.yaml` or `scripts/backup.sh`/`restore.sh`, run `sh test/install/run.sh` and/or `sh test/backup/run.sh` (they need Docker), plus `shellcheck -s sh` on changed shell scripts.
2. **Version and docs:** bump `version` in `package.json` (semver: features → minor, fixes → patch; never a breaking change within a major, because installs follow `:3`). Update the README for anything user-visible. If the UI changed, regenerate the screenshots with `tools/screenshots/run.sh` (mock data only).
3. **Commit and push to `main`**, then **wait for CI on main**: jobs `test`, `installer`, `backup` and `build` must all succeed (`gh run list`, `gh run view <id> --json jobs`). Don't tag before this: a tag on a red commit has no image.
4. **Tag:** `git tag -a vX.Y.Z -m "Giftly X.Y.Z"` and `git push origin vX.Y.Z`. Wait for the tag's CI run.
5. **Release page:** `gh release create vX.Y.Z --title "Giftly X.Y.Z" --notes-file notes.md --latest`. Notes are for people running Giftly: what changed for them, a clear security note if relevant, and an **Upgrading** section (installer users / Portainer and Compose users).
6. **Check the image exists** for `X.Y.Z`, `X.Y` and `X` on ghcr.io/dfloureiro/giftly (anonymous token from `https://ghcr.io/token?scope=repository:dfloureiro/giftly:pull`, then `HEAD /v2/dfloureiro/giftly/manifests/<tag>`).
7. **If CI fails after tagging:** fix it on `main` first. Move a tag (delete and recreate) only if it never produced an image or a release page, and only with the owner's OK. Otherwise release the next patch version.

`install.sh` recognises untouched official `compose.yaml` files by hash. When a release changes `compose.yaml`, add the hash of the **previous** official version to `OFFICIAL` in `install.sh`:

```sh
for c in $(git log --format=%H -- compose.yaml); do git show "$c:compose.yaml" | sha256sum | cut -c1-64; done | sort -u
```
