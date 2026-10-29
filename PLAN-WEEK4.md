# Week 4 plan: backups, Redis, Postgres, email alerts

> Drafted 2026-10-29. Builds on [PLAN-WEEK3.md](PLAN-WEEK3.md); product context in [CLAUDE.md](CLAUDE.md). Crons and alerts (listed under Week 4 in the MVP plan) were done in Week 3.

**Goal:** an app's data survives anything short of losing the bucket. SQLite is backed up correctly (consistent copy plus integrity check) to S3-compatible storage and can be restored in one click. Apps that need Redis or Postgres get them in one click, with credentials nobody else shares. Alerts can also go by email.

## Decisions (recommended 2026-10-29, change any of them)
1. **Backups go to S3-compatible storage only:** Cloudflare R2, Backblaze B2, AWS S3, Hetzner Object Storage, Wasabi, MinIO. No SFTP or local-only option in v1. Our own SigV4 client (node:crypto + fetch), no AWS SDK.
2. **Backups are encrypted on the server before upload** (AES-256-GCM in 1MB chunks) with a **recovery key** the panel shows once. The bucket provider can't read them. Without the key they can't be restored, so the UI makes you confirm that you saved it.
3. **Schedule:** daily at 03:00 server time, keep the last 14 per app, plus "Back up now". Backups are orchestrated by the panel (it holds the bucket credentials). If one fails or none succeeded for 26 hours, an alert fires.
4. **Redis: one small `redis-server` per app**, not a shared Redis with ACL users. Each app gets its own port on 127.0.0.1, password, 64MB memory cap and data in its own `data/redis/` (so it's in the app's backup). Clients don't need key prefixes, and nothing is shared. A few MB of RAM each.
5. **Postgres: one shared PostgreSQL server** (from apt), installed only when the first app asks, tuned for small boxes. Each app gets its own role and database, with `CONNECT` revoked from everyone else. Backups use `pg_dump`. **MySQL later**, when a marketplace app needs it (Ghost).
6. **Service credentials are made by the agent** and written to `/etc/layer/apps/<slug>/services.env` (root, 600), which the unit loads before the user's `app.env`. The app gets `REDIS_URL` / `DATABASE_URL`, and a user-set value with the same name wins.
7. **Every app gets `DATA_DIR=/srv/apps/<slug>/data`**, the one folder it can write that survives deploys. That's where SQLite files belong, and it's what backups copy.
8. **Email alerts over SMTP** (implicit TLS on 465 or STARTTLS on 587), as a fourth channel type. Works with Resend, Postmark, SES, Gmail app passwords. Hetzner blocks outgoing 25 and 465 on new accounts, so the form suggests 587. maillayer-lite integration comes with the marketplace.

## How a backup works
1. **Snapshot (agent, as the app user, in the app sandbox, no network):** a small Node script finds every SQLite file in `data/` by its header (not its extension), copies each one with SQLite's online backup API (safe while the app is writing, WAL included), runs `PRAGMA integrity_check` on the copy, and streams one `tar.gz` of `data/` to stdout. The live `-wal`/`-shm` files are left out and replaced by the checked copies. The agent points that stdout at a root-owned staging file, so the job never touches anything outside its sandbox.
2. **Postgres apps:** `pg_dump -Fc` of the app's database goes into the same staging folder.
3. **Upload (panel):** encrypt, upload (multipart for big files), record size and checksum, delete the staging file, prune old backups past the retention count.
4. **Restore (one click, type the app name):** download, decrypt and verify, stop the app, move the current `data/` to `data.before-restore-<time>` (kept until you delete it), unpack as the app user, `pg_restore` if there is a dump, start the app, health-check it.
5. **The panel itself** (its database and secret key) is backed up too, as a separate object, so a dead server can be rebuilt later. The "restore a whole server" flow comes with the migration assistant.

## Day by day
| Day | Work | Done when |
|---|---|---|
| **1** | `DATA_DIR`; agent `backup.snapshot` / `backup.restore` / `backup.discard`, binary stdout to a staging file | e2e: snapshot while an app writes SQLite in WAL mode passes the integrity check; restore brings the data back |
| **2** | S3 client (SigV4, multipart, list, delete), encryption format, fake S3 for tests, destination settings with "Test connection", recovery key | Signing matches AWS's published examples; upload/download round trip against the fake S3, then a real bucket |
| **3** | Backup runs: schedule, retention, history, Back up now, restore UI, panel backup, backup alerts | VM tour: back up, break the data, restore, the app serves the old data |
| **4** | Redis per app: agent `service.install` / `service.add` / `service.remove`, `services.env`, Storage tab | An example app counts visits in Redis; password works, another app's password doesn't |
| **5** | Postgres: install and tune, role + database per app, `pg_dump` in backups, restore | An example app on Postgres is backed up and restored |
| **6** | Email channel (SMTP), VPS run-through, docs | All of the above on the real VPS with a real bucket |

**Needs from the user (Day 2–3, optional):** an S3-compatible bucket and an access key for the VPS test. Cloudflare R2's free tier (10GB) is enough. Until then everything is tested against a local fake S3.

## Day 1 result (2026-10-29)
**Done when "a snapshot taken while an app writes SQLite in WAL mode passes the integrity check, and restore brings the data back": passed** in the VM (`installer/test/backup-e2e.sh`, 21 checks). A writer inserted about 10,000 rows a second during the snapshot. The copy opened on its own with integrity `ok`, and restore rolled the live database back to exactly the snapshot's row count.

- **`backup.snapshot`** runs `SNAPSHOT_JOB` (agent/src/jobs.ts) with the runtime Node as the app user, offline, at low priority, under the build lock. It finds SQLite files by header, copies them with `node:sqlite`'s `backup()`, checks them, and streams a `tar.gz` to stdout. The agent points that stdout at `/var/lib/layer-staging/<slug>-<time>-<rand>.tar.gz` (root:layer 640, folder 750; the app can't even list it). Snapshots nobody collected are cleared after a day.
- **The archive looks like the folder:** live databases and their `-wal`/`-shm`/`-journal` files are excluded, and the checked copies are renamed back to the same paths (`--transform`). So a downloaded backup is just `data/`.
- **`backup.restore`** only reads a plain file owned by the panel user from `/var/lib/layer/restore/` (opened with `O_NOFOLLOW`; symlinks and root-owned files are refused). It stops the running colors, unpacks next to `data/` as the app user (a broken archive changes nothing), swaps the folders, keeps the replaced one as `data.before-restore-<time>` (only the latest), and starts the app again even if the restore failed.
- **`backup.discard`** removes a staged file after upload.
- **Every app and cron gets `DATA_DIR`**, and the units load `services.env` (for Day 4–5) before the user's `app.env`.

## Day 2–6 result (2026-10-29)
**Week 4 done.** The VM browser tour passes end to end: deploy → visits in SQLite → connect storage → save the recovery key → Back up now → more visits → Restore (5 visits → 3) → Back up everything (the panel too) → Add Redis (the app counts visits in it) → Add Postgres → the next backup includes a `pg_dump`. The e2e suites pass in the VM (`backup-e2e.sh`, `redis-e2e.sh` 20 checks, `postgres-e2e.sh` 21 checks), and `backup-e2e.sh` also passes on the Ubuntu 26.04 VPS. Deployed to the VPS (272MB RAM used, the user's app untouched). Nothing is installed there until someone clicks Add Redis/Postgres.

**Backups (Days 2–3)**
- **S3 client** (`panel/lib/backup/s3.ts`): SigV4 matches AWS's published examples. It does put/get/delete, paginated ListObjectsV2, and multipart uploads in 16MB parts (aborted on failure). Path-style URLs; queries are encoded by hand so they match what's signed. `panel/scripts/fake-s3.ts` verifies every signature and body hash and pages listings two at a time.
- **Encryption** (`crypt.ts`): `LAYERBK1` + salt, a per-file key from HKDF(recovery key, salt), AES-256-GCM over 1MB chunks with the chunk counter in the nonce and a last-chunk flag in the AAD. A wrong key, a flipped byte and a cut at a chunk boundary are all rejected (tested). Recovery keys look like `lbk1-<43 chars>`.
- **Settings → Backups:** pick a provider (R2, B2, AWS S3, Hetzner, other). "Connect" only saves after a test object is written, read, listed and deleted. The recovery key is shown until you tick "I saved it", and backups stay off until then. Schedule (hour, keep N), recent backups, "Back up everything now".
- **Runs** (`runner.ts`): one at a time (queue on `globalThis`). The agent stages a snapshot, the panel streams it through encryption into a multipart upload, records size and contents, discards the staged file, and prunes past the retention count. Objects go to `<folder>/<panel host>/<app>/<time>-<id>.tar.gz.enc`. The panel's own backup is `panel.db` (a consistent `node:sqlite` copy) plus `secret.key`, written with a small JS tar writer: the panel's sandbox can't run GNU tar on 26.04.
- **Restore:** type the app name. The panel downloads, decrypts and verifies the whole file into `/var/lib/layer/restore/` before the agent touches anything.
- **Alerts:** `backup:<app>` on a failed backup, `backup-overdue:<app>` after 26 hours without a successful one. The daily run starts from the monitor at the chosen hour. Backups that were running when the panel restarted are marked as interrupted.
- **Bug fixed on the way:** the agent dropped any connection quiet for 5 minutes, even mid-action. A silent snapshot of a big folder would have been cut off. Now only idle connections time out.

**Redis (Day 4)**
- `service.install redis` (apt in its own transient unit, because the agent's `/usr` is read-only; it falls back to `valkey-server`) masks the package's shared instance.
- `redis.add` gives each app its own `layer-redis-<slug>.service` on a port from 6400–6999 on 127.0.0.1. It has its own password and memory cap (`noeviction`) and runs as the app's user in the same sandbox, writing only `data/redis` (so `dump.rdb` is in the app's backups).
- **The config reaches Redis on stdin** (`StandardInput=file:`, `redis-server -`). `redis.conf` stays root 600, and not even the app's user can read it. The first try failed because app users can't traverse `/etc/layer`; this is the better design anyway.
- Checked: another app's password is refused, unauthenticated access gets NOAUTH, `CONFIG SET dir` is refused, it listens on 127.0.0.1 only, and data survives a restart.

**Postgres (Day 5)**
- `service.install postgres` installs it (16 on 24.04) with `conf.d/layer.conf` set for small boxes: 127.0.0.1 only, SCRAM, 50 connections, shared_buffers RAM/16.
- `postgres.add` creates the role and database `app_<slug>` (connection limit 20), revokes `CONNECT` from PUBLIC, and checks the new credentials over TCP. Another app's role can't connect, and app roles aren't superusers.
- **Backups:** the snapshot job gets `DATABASE_URL` from `services.env` and a sandbox opened to localhost only (`IPAddressAllow=localhost`). It runs `pg_dump` with the app's own role, and the dump travels inside the same archive as `.layer-postgres.dump`. Restore runs `pg_restore --clean --single-transaction` the same way, then deletes the dump from `data/`.
- `postgres.remove` and `app.delete` keep a final `pg_dump` in `/var/lib/layer-agent/archive` (root 600) unless told not to. The dump streams through a file descriptor, never through memory.
- **Databases page:** SQLite files (from the last backup), Postgres and Redis cards with status, size, and masked connection URLs (Reveal, Copy). Add and Remove (type the app name) trigger a zero-downtime restart on the live build so the app gets the new URL.

**Email alerts (Day 6)**
- Our own SMTP client (`panel/lib/alerts/smtp.ts`): implicit TLS (465) or STARTTLS (587), AUTH PLAIN or LOGIN, base64 UTF-8 body, RFC 2047 subjects, dot-stuffing. Tested against a fake SMTP server. Plain SMTP is only allowed to a relay on the same machine.
- The alert channel table was rebuilt to allow `email`.

**Also:**
- `scripts/dev-vm.sh fresh` gives a new panel and setup token without reinstalling, and syncs the VM clock, which drifts while the Mac sleeps and breaks TOTP.
- The example Next.js app counts visits in SQLite (`/api/visits`) and Redis (`/api/redis`).
- CI now runs the three new e2e suites and the backups, Redis and Postgres tour sections, with the fake S3 on the runner.

**Needs from the user (optional):**
- A real bucket (Cloudflare R2's free tier is enough), to connect under Backups on the VPS panel.
- An SMTP sender (for example Resend) for email alerts.
