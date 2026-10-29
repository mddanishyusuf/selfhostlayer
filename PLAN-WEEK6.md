# Week 6 plan: launch prep (outline)

> Drafted 2026-10-29 as an outline; detailed before Week 6 starts. Builds on [PLAN-WEEK5.md](PLAN-WEEK5.md); product context in [CLAUDE.md](CLAUDE.md).

**Goal (from the MVP plan):** landing page, docs, and the launch story: **move the 7 apps still on DigitalOcean (mvpstack-apps) onto Self Host Layer** and close that account. Plus the pieces of the original plan that a public launch can't ship without.

## Work
| # | Work | Why it's needed for launch |
|---|---|---|
| 1 | **Bring data in:** `layer import <app> <archive>` on the box and "Import data" in the panel (a `data/` archive, SQLite checked like a restore), plus a guide for copying SQLite safely from a pm2 box | The 7 apps have SQLite and uploads on the old server; today data only comes back from our own backups |
| 2 | **Panel and apps on your own domain:** Settings → Panel address (DNS checked first, like domains) and a wildcard domain for free app URLs | Office and school networks block `sslip.io` (seen on 2026-10-29); a real domain also looks right for a product |
| 3 | **Panel lockdown:** an IP allowlist or "Tailscale only" for the panel (a Caddy `remote_ip` match on the panel's site) | In the security plan: the panel is the highest-value target |
| 4 | **Updates and repair:** Settings → Version → Update (downloads a release, checks its checksum, runs the installer in a transient unit), and `layer repair` (re-applies units and Caddy files) | In the original plan; users can't SSH in for every update |
| 5 | **Idle budget in CI:** measure panel + agent + Caddy after install, fail above 200MB | The headline number against Coolify (172MB measured once, never checked since) |
| 6 | **Catalog distribution:** whatever Week 5's decision 7 picks (release tarballs or public repos) | Other people's servers can't fetch private repos |
| 7 | **Docs:** install, how it works, the raw commands behind each button, the security model and its limits, the manifest spec | Trust: "nothing hidden, no lock-in" needs to be written down |
| 8 | **Landing page** at selfhostlayer.com | Needs your input on copy and look |
| 9 | **Dogfood:** move the 7 apps, one at a time (build, copy data, check, switch DNS, verify) | The launch story; DNS changes are yours to make |

## Launch tasks (yours to decide)
- License: AGPL-3.0 core + CLA is the leading option (MIT for the manifest spec).
- Make the repo public, or publish releases somewhere public.
- Serve `get.selfhostlayer.com` from tagged releases.

## After launch (in the original plan, or left by the redesign)
- **Platform:** MySQL (when a catalog app needs it, e.g. Ghost), per-app CPU and memory history, Caddy access logs per app, an audit log page (the agent already writes `/var/log/layer/audit.jsonl`), per-app outbound network rules, the server migration assistant.
- **Panel:** firewall rule editing and unban, alert on/off switches, Account (change password, new recovery codes), Databases' Manage opening a page like Domains, real screenshots as an option.
- **Cross-app glue:** Analytics showing Piqo data for every project, analytics added to deploys automatically, one sign-in for catalog apps, shared SMTP settings.
- **Pro (paid):** multi-server, teams, preview deploys.
