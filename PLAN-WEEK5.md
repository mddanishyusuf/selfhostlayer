# Weeks 5–6 plan: launch prep

> Drafted 2026-10-29; Weeks 5 and 6 combined at the user's request. Builds on [PLAN-WEEK4.md](PLAN-WEEK4.md) and the redesign; product context in [CLAUDE.md](CLAUDE.md).

**Goal:** everything the original plan still needs before a public launch. You can move real apps (with their data) onto a box, run the panel on your own domain and lock it to yourself, update it with one click, and read what happened on the server. Proven by **moving the 7 apps still on DigitalOcean** (the launch story), with docs and a landing page.

**Changed 2026-10-29: the marketplace moves after launch.** Its apps will be built fresh for Self Host Layer, not taken from the existing Piqo or maillayer code. The manifest and the Integrations install flow get built together with the first of those apps.

## Decisions (recommended 2026-10-29, change any of them)
1. **Bringing data in reuses restore:** a `tar.gz` of a `data/` folder, uploaded in the panel or given to `layer import <app> <file>` on the box, goes through the same steps as a restore: SQLite files checked, the app stopped and started, the replaced data kept aside. A guide shows how to copy SQLite safely off a pm2 box (`.backup` or `VACUUM INTO`, never a raw copy of a live file).
2. **Your own domain, checked first:** Settings → Panel address takes a name like `panel.example.com`, shows the DNS record, checks public DNS (the same check as project domains), then switches. The old address redirects for a day, so you can't lock yourself out by mistake. A wildcard like `*.apps.example.com` can replace `sslip.io` for free app URLs. Office and school networks block `sslip.io` (seen 2026-10-29).
3. **Panel lockdown:** Settings → Access offers anyone (password + 2FA, today), only these IPs (your current IP filled in), or Tailscale only. It's a match in the panel's Caddy site, so blocked requests never reach the panel. `layer access reset` on the box undoes it.
4. **One-click updates:** Settings → Version shows "Update to vX" from a release feed. An allowlisted agent action downloads only from the configured release URL, checks the checksum and runs the installer in its own unit, then the page reloads. `layer update` does the same on the box. `layer repair` rewrites units, Caddy files and env files from the saved state and restarts what changed.
5. **Metrics without a new daemon:** the panel's monitor (already running every minute) samples each app's CPU, memory and disk, plus the box's. It keeps 24 hours at one-minute steps and 7 days hourly in SQLite. Small charts go on the project Overview and in the server popup.
6. **Request logs already exist:** Caddy writes `/var/log/caddy/<app>.log` for every app. Logs gets a "Requests" tab (time, status, method, path, duration, IP) read through the agent.
7. **MySQL from the original v1 list, as MariaDB** (in Ubuntu and Debian, lighter): one shared server installed on first use, a user and database per app, `mysqldump` in backups. The same pattern as Postgres.
8. **The audit log gets a page:** the agent already appends every privileged action to `/var/log/layer/audit.jsonl`. Settings → Activity shows it.
9. **Account basics:** change password, make new recovery codes, sign out other sessions.
10. **The idle budget is checked in CI:** after the install in CI, panel + agent + Caddy memory is measured, and the job fails above 200MB.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | Import data: panel upload and `layer import`; guide for pm2 boxes | VM e2e: a `data/` archive with SQLite is imported and served; a corrupt database is refused and nothing changes |
| **2** | Panel on your own domain (DNS check, switch, old address redirects); wildcard domain for app URLs | VM: move the panel to a test domain and back without losing access |
| **3** | Panel lockdown (IP allowlist, Tailscale only), `layer access reset` | VM: an allowlist without your IP blocks you; the reset brings you back |
| **4** | Updates: release feed, Update button, `layer update`, `layer repair` | VM: update from one build to the next from the UI; repair fixes a hand-edited unit and Caddy file |
| **5** | Metrics: sampling, storage, charts | An app under load shows its CPU and memory on the Overview |
| **6** | Requests tab, Activity (audit log) page, Account (password, recovery codes, sessions) | The tour sees its own requests and actions listed |
| **7** | MariaDB per app, `mysqldump` in backups | e2e like Postgres: an app on MySQL is backed up and restored |
| **8** | Idle budget in CI; docs (install, each panel page, security model and limits, the raw commands behind each button, moving from pm2) | CI fails above 200MB; every panel page has a docs section |
| **9** | Landing page at selfhostlayer.com, deployed by Self Host Layer itself | Live with HTTPS |
| **10** | Dogfood: move the 7 apps off DigitalOcean, one at a time (deploy, import data, check, switch DNS, verify) | All 7 serve from the new box; the DigitalOcean apps are stopped |

## Needs from you
1. **Day 2:** a name to test the panel address with (e.g. `panel.selfhostlayer.com`) and the DNS record for it.
2. **Day 9:** what the landing page should say and look like.
3. **Day 10:** SSH access to the DigitalOcean box and the DNS for the 7 apps' domains. DNS switches are yours to make.
4. **Before launch:** the license (AGPL-3.0 + CLA is the leading option), and a public place for releases. One-click updates and `get.selfhostlayer.com` need it; until then updates are tested on the VM.

## After launch
- **Marketplace:** apps built fresh for Self Host Layer (analytics, email, scheduler, …), with the manifest (`layer.yaml`) and the Integrations install flow.
- **Platform:** server-to-server migration assistant, per-app outbound network rules, MongoDB, AppArmor/Landlock.
- **Panel:** firewall rule editing and unban, alert on/off switches, Databases' Manage opening a page like Domains, real screenshots as an option.
- **Pro (paid):** multi-server, teams, preview deploys.

## Day 1 result (2026-10-29)
**Done when "a `data/` archive with SQLite is imported and served; a corrupt database is refused and nothing changes": passed.** `installer/test/import-e2e.sh` (28 checks) passes in the VM, repeatedly. The browser tour uploads an archive in the panel, and the example app then counts the 42 imported visits (61 tour checks in all).

- **`data.import`** (agent) only reads a file the panel user owns in `/var/lib/layer/restore`, with the same checks as restore, and tells gzip from plain tar by the first bytes.
- **`IMPORT_JOB`** runs as the app user, offline, in its sandbox, while the app keeps running:
  - it unpacks into `data.importing-<id>` and drops macOS litter (`._*`, `.DS_Store`, `__MACOSX`);
  - it makes every file the app's alone (600, folders 700);
  - an archive holding a single folder counts as that folder;
  - every SQLite file (found by its header) must open, replay its `-wal` and pass `integrity_check` (a stale `-shm` is deleted first); the WAL is then folded in.
- **The swap:** only after the checks pass does the agent stop the app and its Redis, swap the folders, and start Redis, then the app. The replaced data is kept as `data.before-restore-<id>` (only the latest).
- **Refused, with nothing changed:** damaged databases, files that aren't archives, empty archives, and members reaching outside the folder (`../`). Nothing is written outside the import folder.
- **Panel:** Backups → Import data streams the upload to disk (up to 20GB) after checking free space and the request's Origin. You confirm by typing the app's name, then see upload progress and the result.
- **CLI:** `layer import <app> <file>` on the box copies the file into the panel's restore folder and calls the same action.
- **Guide:** [docs/moving-from-pm2.md](docs/moving-from-pm2.md).
- **Bugs found on the way:**
  - The kept folder's name had one-second resolution. Two restores or imports in the same second collided, and the failed swap left a half-imported folder behind. Each run now gets a unique suffix, and the work folder is always removed.
  - Restore (Week 4) never restarted the app's Redis. Redis kept writing into the folder that was moved aside and never loaded the restored `dump.rdb`. Restore and import now stop Redis after the app, make sure `data/redis` exists, and start Redis before the app.
  - The browser tour could hang forever when headless Chrome stopped answering a screenshot (macOS throttles background apps). Every DevTools call now fails after 60 seconds, and Chrome runs with background throttling off.

## Day 2 result (2026-10-29)
**Done when "move the panel to a test domain and back without losing access": passed.** In the VM tour the panel moves from `192-168-252-7.sslip.io` to `panel2.internal`: the old address redirects (path kept) and you sign in on the new one, then it moves back. The app URLs go to `*.apps2.internal` and back too. `installer/test/address-e2e.sh` checks it through Caddy, and a re-run of the installer without `--domain` keeps a moved address.

- **The agent owns the panel's Caddy site.**
  - `panel.site` writes `_panel.caddy` from `/etc/layer/config.json`, and the installer now calls it instead of writing the file itself. So an update never undoes an address set in the panel.
  - `config.json` keeps `panelPending`, `panelAliases` and `internalTls` across re-runs.
- **Moving takes two steps, so a certificate that won't issue can't lock you out:**
  - Settings → Panel address checks public DNS (skipped on test boxes, which use Caddy's local CA), then serves the panel on both addresses.
  - It waits up to 90 seconds for the new certificate (a real TLS handshake through Caddy), and only then makes the old address redirect. Without a certificate, nothing else changes.
  - The GitHub App's webhook URL moves along (`PATCH /app/hook/config`), because webhook deliveries don't follow redirects.
  - Each address has its own sign-in.
- **Apps domain:** a wildcard record is checked on a random name. Then `apps.domain` changes `config.json`, every project's free URL moves, the old URL becomes a redirect, and live sites are re-pointed. Moving back drops the redirects in the way.
- **Backups stay together:** the bucket folder is now pinned (`backup_settings.server_folder`), by the first backup or right before the panel moves.

## Day 3 result (2026-10-29)
**Done when "an allowlist without your IP blocks you; the reset brings you back": passed.** `installer/test/access-e2e.sh` (13 checks) runs in the VM, and the tour locks the panel to the browser's own address, then opens it again.

- **`panel.access`** writes an `@outside { not remote_ip …; not path /api/github/webhook }` match with a plain 403 into the panel's site.
  - Blocked requests stop at Caddy. Caddy's `remote_ip` is the real peer, so a forged header doesn't help.
  - GitHub's webhook still gets through: it's signed, and blocking it would stop deploys on push.
- **Settings → Access:** anyone, only these addresses (yours filled in), or Tailscale only (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). A list that leaves out the address you're using is refused (`lib/ip.ts` matches IPv4/IPv6 ranges).
- **`layer access`** shows the list, and **`layer access reset`** lets everyone reach the sign-in page again. That's the way back over SSH.
