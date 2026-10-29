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
