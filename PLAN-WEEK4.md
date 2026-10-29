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
