---
name: giftly-security-review
description: Handle an outside security review or audit of Giftly (a list of findings or a fix plan). Verify each finding in the code, fix what is real with tests and mutation checks, push back with evidence where a proposal would hurt real deployments, and release. Use when the owner pastes a review, audit, pentest report or security plan.
---

# Handling a security review of Giftly

Reviews arrive as a list of findings, often with a proposed plan and versions. They are input, not orders: the reviewer describes the code from outside and is sometimes wrong, outdated, or proposes a fix that breaks real installs. Read `AGENTS.md` first (rules, privacy helpers, lessons learned).

## 1. Verify every finding in the code, before anything else

For each point, find the exact code (`file:line`) and decide:

- **Confirmed:** reproduce it, ideally with a failing test or a one-line demo. Example: running `isPrivateIp('::ffff:7f00:1')` in node showed `false`.
- **Partly true:** say which part holds.
- **Not real / already fixed:** show why (the guard, the test).

Look one step further than the report. The same pattern often exists elsewhere: a missing access check on one route → grep every route with an id. Real bugs were found this way that the reviewer missed. Also check what the reviewer can't see, such as runtime defaults (Node's `globalAgent` keeps connections alive) and platform quirks (BusyBox, distroless images).

## 2. Report back before coding

Give the owner, per point, the verdict with evidence and what you'd do. Be explicit where you **disagree** and why:

- Defaults that would silently break common setups (nginx, Cloudflare Tunnel, LAN access over http, Portainer) need the owner's decision. Offer the trade-off and a recommendation (AskUserQuestion), don't decide alone. Example: an empty `TRUSTED_PROXIES` meaning "no proxy" would put every guest behind one rate-limit bucket. The owner chose to keep "private peers".
- Prefer the smallest fix that closes the hole. A new column or table, or a heavyweight mechanism, only when a simpler one can't be made correct. Example: a compare-and-set on the existing image field instead of a new `image_version`.
- Don't re-open decisions already recorded in `AGENTS.md`.

## 3. Fix, with a test per protection

- Every fix gets a regression test that fails without it. Put it in the version's test file (`test/vXYZ.test.js`, `test/hardening*.test.js`). Use `test/install/run.sh` for `install.sh` and `test/backup/run.sh` for the backup scripts.
- Keep security rules in their single home (`LIST_VISIBLE`, `GIFT_VISIBLE`, `wishlists.*`, `canSeeImage`, `net.js`). Fix the rule; never patch around it in one caller.
- Tests that need local servers use the explicit hooks (`preview.__test`, `previewQueue.__test`, `NOTIFY_ALLOWED_HOSTS=127.0.0.1`). Never relax a guard for tests.
- Run the whole suite (`npm test`), plus the shell end-to-end tests if you touched `install.sh`, `compose.yaml` or `scripts/`.

## 4. Prove each test actually guards: mutation checks

For every protection you added or relied on, remove or weaken it and confirm a test fails:

```sh
tools/mutate.sh --name "images open to everyone" src/server.js \
  "if (IMAGE_FILE_RE.test(file) && canSeeImage(cookies, file)) {" "if (IMAGE_FILE_RE.test(file)) {" test/hardening.test.js
```

`CAUGHT` means it is guarded. `SURVIVED` means the test passes for the wrong reason: fix the test, then re-run. Mutate the **original bug** too (e.g. restore the pre-fix line): the test must catch exactly what the review described. When a bug needs two lines to come back (e.g. both sides on a shared agent), mutate both together, or the check proves nothing. For shell scripts, apply the edit to a copy and run `test/install/run.sh` or `test/backup/run.sh` there (see how they are written); never edit the real files to test.

## 5. Ship

- Summarise to the owner: per point, what was confirmed, fixed and tested, plus the mutation results, and anything found beyond the review.
- Release with `.claude/skills/giftly-release/SKILL.md`. The notes should open with a clear security section ("please update" when warranted), say what changed for whom, and include an **Upgrading** section. Never include exploit steps beyond what's needed to understand the fix.
- Add new lessons (bugs that could recur) to `AGENTS.md`.
