# Moving an app from a pm2 server

You have an app running under pm2 (or by hand) on another server, with its data in SQLite files and an uploads folder. This moves it to Self Host Layer without losing anything.

## 1. Deploy the app here first
Import it from GitHub as usual (New project), same branch. Its data lives in `DATA_DIR` (`/srv/apps/<app>/data`), the one folder the app can write that survives deploys.

- If your app reads `process.env.DATA_DIR`, there's nothing to change.
- If it reads its own variable (say `DB_PATH`), set it on the app's **Environment** page to a path inside the data folder, like `/srv/apps/<app>/data/app.db`.

## 2. Copy the databases safely on the old server
Never `cp` a database file while the app is running: you can get a half-written copy. Ask SQLite for a consistent one instead:

```sh
mkdir -p /tmp/export
sqlite3 /var/www/myapp/data/app.db ".backup '/tmp/export/app.db'"
```

(`apt install sqlite3` if the command is missing.) `VACUUM INTO '/tmp/export/app.db'` works too. Do this for every database, keeping the same folder layout as in the old data folder.

## 3. Add everything else, and pack it
Copy the rest of the data folder (uploads and so on), skipping the live database files:

```sh
rsync -a --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' /var/www/myapp/data/ /tmp/export/
tar -czf myapp-data.tar.gz -C /tmp/export .
```

An archive of the folder itself (`tar -czf myapp-data.tar.gz data`) works too: a single folder at the top counts as the data folder.

## 4. Import it
Either way, the result is the same:

- **In the panel:** open the app, go to **Backups → Import data**, choose the file and type the app's name to confirm.
- **On the new server:**
  ```sh
  scp myapp-data.tar.gz root@new-server:/root/
  ssh root@new-server layer import myapp /root/myapp-data.tar.gz
  ```

Before anything is replaced, the archive is unpacked and every SQLite database is checked (`PRAGMA integrity_check`). If one is damaged, nothing changes and you see which file failed. macOS litter (`._*`, `.DS_Store`) is dropped, and every file becomes readable by the app alone.

Then the app stops (its Redis too), the folders are swapped and everything starts again. The data that was there before is kept in `/srv/apps/<app>/data.before-restore-…` until the next import or restore.

Postgres isn't part of the archive: dump it on the old server with `pg_dump --format=custom` and load it with `pg_restore --no-owner` into the `DATABASE_URL` shown on the app's **Databases** page.

## 5. Switch traffic
1. Add the app's domain on its **Domains** page. It goes live only once public DNS points here, so nobody lands on a broken site.
2. Change the DNS record at your provider.
3. When traffic has moved, stop the old app: `pm2 stop myapp`.

If the old app took writes after your export, export and import once more after stopping it.
