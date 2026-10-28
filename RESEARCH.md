# Market research: self-hosted "Vercel on your VPS"

Researched 2026-10-28. Figures come from blogs and vendor pages, so verify them before quoting publicly.

## 1. Docker-based self-hosted PaaS (the crowded lane)

| Tool | What it is | Notes |
|---|---|---|
| **Coolify** | The category leader. Open source (Apache-2.0), around 52k GitHub stars | 280+ one-click services. Idle overhead is about 500–700MB RAM and 5–6% CPU before any app runs. Cloud control plane costs $5/mo for 2 servers, plus $3 per extra server. v4 went stable in April 2026. |
| **Dokploy** | A fast-growing newcomer, around 26k stars | Built on Docker Swarm and Traefik. About 350MB idle, 2GB RAM minimum. Supports PR preview deploys. |
| **CapRover** | The oldest of these (2017) | Weak Docker Compose support, a dated UI, and development has slowed. 1GB minimum. |
| **Dokku** | A CLI "mini-Heroku" | Bash wrapped around Docker and buildpacks. Has no UI. |
| **Kamal** | From 37signals, CLI only | Docker deploys over SSH. Has no UI. |

**Takeaway:** a polished Docker PaaS with a big template store already exists, is free, and has 50k+ stars. Competing head-on as "another Coolify" would lose.

## 2. No-Docker server panels (the lane this idea is in)

| Tool | Model | Notes |
|---|---|---|
| **Laravel Forge** | SaaS control plane that SSHes into your box | $12–39/mo. PHP/Laravel first. |
| **Ploi** | SaaS | About $9–19/mo. PHP first. |
| **RunCloud** | SaaS | From about $8/mo. PHP first. |
| **Cleavr** | SaaS, priced per server | **Explicitly supports Node.js with PM2.** It's the closest commercial analogue. |
| **DeployWise** | Says it is free and open source | Node/Next.js, PM2 + Nginx + Let's Encrypt over SSH, GitHub webhooks. **It's the closest direct competitor.** I couldn't confirm its repo, stars or traction, so check it by hand. |
| **miniPaaS** | Small open-source CLI | Git deploy into PM2. You set up nginx yourself. |

**Takeaway:** the no-Docker panels are either paid SaaS control planes built around PHP (Forge, Ploi, RunCloud) or small and early (DeployWise, miniPaaS). Nobody owns **"self-installed panel + Node/PM2-native + app marketplace"**.

## 3. Self-hosted app stores (the marketplace half)

| Tool | Notes |
|---|---|
| **Cloudron** | A paid app store of 120+ apps with auto-updates, backups and SSO. Docker underneath. Pricing has changed several times (it was $8–15/mo). It shows people *pay* for "install and keep updated". |
| **YunoHost** *(from prior knowledge, not re-verified)* | Native Debian app packaging with no Docker. It's the proof that a native-install app catalog works, and also the warning: native packages are a lot of maintenance per app. |
| **Umbrel / CasaOS** *(from prior knowledge)* | Home-server app stores, Docker underneath. They're aimed at consumers, not people launching a business. |

**Takeaway:** existing app stores are generic ("Nextcloud, Gitea, Jellyfin"). None of them is a **"tools to run and grow a product"** store (analytics, link shortener, email marketing, post scheduling, blog, waitlist, status page, feedback).

## 4. Evidence from our own servers (October 2026)

- The CX23 (4GB, about €4/mo) runs **13 Node apps + Redis on pm2 + nginx** with about 2.2GB free. Coolify's idle overhead alone would take 15% of that box. Low overhead is a real, demonstrable benefit.
- The moves from DigitalOcean to Hetzner were all "copy code, `yarn build`, pm2, nginx vhost, certbot, copy SQLite + `-wal`, switch DNS, verify". It's repetitive and easy to script, which is exactly what this product would do.
- Pain points we actually hit: **no git credentials on the new box** (deploys needed a manual workaround), **builds filling the disk with yarn cache** (89%), **DNS switched before the app was ready** (Cloudflare 521), **Redis state that wasn't really ephemeral**, **a CDN caching an old asset after deploy**, and **certbot renewals failing on the old box**. Each one is a feature.

## Sources

- [Self-hosted PaaS comparison 2026 (DEV)](https://dev.to/_6638a39c349d7e9c85ee20/self-hosted-paas-comparison-2026-coolify-vs-dokploy-vs-caprover-vs-kamal-vs-dokku-m6e)
- [Coolify comparison page (vendor)](https://coolify.io/compare/coolify-vs-dokploy-vs-caprover-vs-dokku-vs-kamal)
- [Dokploy vs Coolify vs CapRover (MassiveGrid)](https://massivegrid.com/blog/dokploy-vs-coolify-vs-caprover)
- [Coolify alternatives (LumaDock)](https://lumadock.com/tutorials/coolify-alternatives)
- [Self-hosted PaaS research, Feb 2026](https://homelab-docs-cwy.pages.dev/plans/self-hosted-paas-research-2026-02-25)
- [Coolify vs Dokku vs CapRover 2026 (DEV)](https://dev.to/pickuma/coolify-vs-dokku-vs-caprover-self-host-paas-compared-in-2026-b0d)
- [Coolify pricing teardown 2026](https://dev.to/beton/coolify-pricing-teardown-2026-5675)
- [Coolify pricing explained (temps.sh)](https://temps.sh/blog/coolify-pricing-explained-2026)
- [DeployWise](https://deploywise.dev/), [launch post](https://deploywise.dev/blog/launch-announcement), [docs](https://deploywise.dev/docs)
- [miniPaaS](https://awesome.ecosyste.ms/projects/github.com%2Fmrvautin%2Fminipaas)
- [Cleavr (AlternativeTo)](https://alternativeto.net/software/cleaver/about)
- [RunCloud vs Forge (Toolradar)](https://toolradar.com/compare/runcloud-vs-laravel-forge), [Ploi alternatives](https://toolradar.com/alternatives/ploi)
- [Cloudron pricing (blog)](https://blog.cloudron.io/cloudron-pricing), [Cloudron free plan](https://blog.cloudron.io/announcing-a-free-plan)
