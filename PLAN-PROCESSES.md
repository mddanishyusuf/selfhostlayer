# Processes: workers and one-off commands (asked 2026-11-03)

> A project runs one process today: its web server. Many apps need more. kagaz-api runs `worker.js` (a bull queue on Redis) beside `server.js`, which pm2 did on the old server through `ecosystem.config.js`. Apps also have scripts you run once by hand, like `yarn migrate:mongo`. **Processes** is a project page for both.

## What it does

1. **Workers.** On a project's **Processes** page, **Add a worker**: a name (`queue`) and a command (`node worker.js`), and a memory limit. Each worker:
   - runs from the live release, as the app's user, with its env vars, Redis, databases and `DATA_DIR`, and with `NODE_ENV=production`;
   - gets the same sandbox as the app;
   - restarts when it exits or crashes (2 s apart, at most 5 times a minute: then it stops and shows Failed);
   - is restarted by every deploy and rollback after the switch, so it always runs the code that's live;
   - logs to the journal: the project's **Logs** shows its lines next to the app's, under its own name.

   The page lists each worker with its status, memory, restarts and uptime, and **Restart**, **Stop** or **Start**, and **Delete**. Saving a worker with an existing name updates it.
2. **Run a command.** On the same page, a field for a command (`npm run migrate:mongo`, `node scripts/fix.js`), with the package.json scripts as one-click suggestions. **Run** starts it once and streams its output to the page. It's the same sandbox and env as a worker, in a job of its own (`layer-run-<slug>`), stopped after an hour or when you press **Stop**, or leave the page. One command per project at a time. The exit code shows when it ends, and the audit log keeps the command.

Commands begin with `node`, `npm` or `npx`, the same rule as start commands and cron jobs: they run on the project's Node version. Package scripts run as `npm run <script>`, whatever the package manager.

## How

- **Agent:**
  - `worker-unit.ts` renders `app-<slug>-worker-<name>.service`: the cron service's lines, `Type=simple`, `Restart=always`, `WorkingDirectory=/srv/apps/<slug>/current`, `TimeoutStopSec=30`.
  - Actions:
    - `worker.write` writes the unit and enables it, then restarts it once the app has a live release;
    - `worker.delete` stops and removes the unit;
    - `worker.control` takes `start`, `stop` or `restart`;
    - `worker.list` reports state, memory, restarts and when each started.
  - `app.run` runs one command through `systemd-run`, like builds, and streams its output.
  - Wiring: `app.delete` removes the workers; `layer repair` knows their units; `logs.tail` follows them too. Metrics leave them out, since they're compared with the app's own limit; the Processes page shows each worker's memory.
- **Panel:**
  - `project_workers` table; `lib/workers.ts`, mirroring `lib/crons.ts`.
  - `syncWorkers` runs after `syncCrons` in every deploy.
  - The **Processes** page sits in the project sidebar after Cron jobs, for GitHub projects with a Node runtime: static sites have no process, and sites and integrations have their own.
  - `POST /api/projects/<slug>/run` streams the output: it checks the session and the panel's origin, and the request's end stops the command.

## Not in v1

- More than one copy of a worker (pm2's `instances`).
- Restarting on a schedule (`cron_restart`).
- Workers for sites and integrations.

## Result (2026-11-03)

Built as planned, and tested on the dev VM:

- **`installer/test/processes-e2e.sh`** (28 checks, now in CI):
  - a worker runs as the app's user, with its env and `NODE_ENV=production`, in its sandbox (`/etc` is read-only), from the live release;
  - a deploy restarts it on the new release; stop, start and restart work, and it comes back after a `kill -9`;
  - a crashing worker stops after 5 tries and shows its exit code;
  - `app.run` streams its output and returns the exit code, refuses anything but `node`, `npm` or `npx`, and stops when its caller goes away;
  - `app.delete` removes the app's workers.
- **The browser tour** (`TOUR_DEPLOY=1`) adds a worker, finds it running and its lines on the Logs page, runs a command whose output streams back from the live release with the app's env, and deletes the worker.
- **Found on the way:**
  - The agent noticed a caller had gone only when it next wrote to it, so a silent command outlived the page. `app.run` now sends an empty chunk every 5 s, which callers skip.
  - systemd reports a worker that hit its restart limit as `Result=exit-code`, not `start-limit-hit`. The page reads the restart count instead.
