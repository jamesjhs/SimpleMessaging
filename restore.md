# Restoring TLS after rebuilding the server

Use the repository for the application code and the saved application folder for its data and configuration. Keep an untouched copy of the saved folder throughout recovery.

## What to preserve

| Saved item | Contents |
| --- | --- |
| `.env` | Database encryption key, SMTP credentials, public URL, port, Turnstile and VAPID keys |
| `data/tls.db` | Accounts, password hashes, messages, admin settings and preferences |
| `data/tls.db-wal` and `data/tls.db-shm`, if present | SQLite sidecars; preserve these with the matching database |
| `uploads/` | Message images, videos and other attachments |
| `public/pwa-icon-*.png` and `public/favicon-32.png` | Custom app icons |

If the old `.env` specifies a different `DB_PATH`, use that database location. Database exports do not include media, icons or configuration.

Service definitions, reverse-proxy configuration and HTTPS certificates may have lived outside the saved project folder and need restoring separately.

## 1. Stop the app and protect both installations

Stop every process or container that opens the database, including development watchers. Disable automatic restarts during recovery. The CLI's `--server-stopped` option is your acknowledgement; it does not stop or detect running processes.

Back up the new installation's data and configuration before replacing anything. Preserve its database and sidecars together. Keep recovery files private and outside `public/`.

If the saved folder was copied while the old app was running, the copy may be inconsistent. Preserve everything available; validation is required before using it.

## 2. Restore configuration and install dependencies

Copy the saved `.env`, including this hidden file, into the new project. Compare it with the current `.env.example` for added options.

- Keep the original `DB_ENCRYPTION_KEY` exactly. A new key cannot decrypt the old database, and an admin password reset cannot recover a lost encryption key.
- Retain the old VAPID keys for web push.
- Adjust `DB_PATH`, `APP_URL`, `PORT`, SMTP and proxy settings as needed for the rebuilt server.
- Check service and shell environment variables too: they take precedence over `.env`.
- Changing `ADMIN_PASSWORD` only affects initial account creation; it does not reset an existing admin account.

Install dependencies in the new project rather than copying the old `node_modules`:

```text
npm ci --include=dev --include=optional
npm run check:platform
```

Use a supported Node.js runtime as described in [README.md](README.md). On Linux ARM32 Raspberry Pi, use Node.js 22 and also run:

```text
npm run check:platform -- --raspberry-pi
```

Run maintenance commands from the project directory with the same database environment and working directory as the service. Do not start the HTTP server yet.

## 3. Prepare a standalone database backup

If you already have a database export created by the admin panel or maintenance CLI, proceed to step 4.

If you only have the saved application folder:

1. Make a separate working copy of the saved database directory, including the matching `tls.db-wal` and `tls.db-shm` files if present. Keep their original names together. Never mix sidecars from the new database with the saved database.
2. Use the new project's maintenance CLI to export from this working copy. Temporarily set `DB_PATH` to the working copy's database using a shell environment variable. The encryption key must still be the original key.
3. Export to a new, private destination filename. Export checkpoints WAL data into a standalone encrypted database and then validates the result. It can modify the working copy, which is why the original must remain untouched.

PowerShell example; replace all paths first, and create the private destination directory beforehand:

```powershell
# Run from the new project directory. App remains stopped.
$previousDbPath = $env:DB_PATH
try {
    $env:DB_PATH = 'C:\Restore\working-data\tls.db'
    npm run database -- export 'C:\Restore\tls-backup.db'
    if ($LASTEXITCODE -ne 0) { throw 'Database export failed; stop recovery here.' }
} finally {
    if ($null -eq $previousDbPath) {
        Remove-Item Env:DB_PATH -ErrorAction SilentlyContinue
    } else {
        $env:DB_PATH = $previousDbPath
    }
}
```

Bash equivalent:

```bash
DB_PATH=/secure/restore/working-data/tls.db npm run database -- export /secure/restore/tls-backup.db
```

Do not proceed if export or validation fails. A wrong key, damaged database or incompatible schema needs investigation. Older backups may need migration in an isolated installation, starting with the matching application release. Do not experiment on the only saved copy.

## 4. Validate and restore the database

Ensure `DB_PATH` now points to the intended database in the new installation, not the recovery working copy. Relative paths resolve from the current working directory. Create the target parent directory if it does not exist; for the default layout this is `data/`.

With every app process still stopped, run validation, inspect its output, and only then run restore.

PowerShell examples:

```powershell
npm run database -- validate 'C:\Restore\tls-backup.db'
if ($LASTEXITCODE -ne 0) { throw 'Validation failed; do not restore.' }
npm run database -- restore 'C:\Restore\tls-backup.db' --server-stopped
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; do not start the app.' }
```

Bash examples:

```bash
npm run database -- validate /secure/restore/tls-backup.db &&
  npm run database -- restore /secure/restore/tls-backup.db --server-stopped
```

Check that restore succeeds before continuing. This replaces all database records. When a current database exists, the tool retains a recovery copy beside it named `<DB_PATH>.before-restore-<time>-<uuid>`.

The tool refuses to overwrite an existing pending restore. If one exists, inspect it and follow [Technical Manual section 16](TECHNICAL_MANUAL.md#16-database-export-restore-and-admin-recovery) before proceeding. It also refuses replacement if the existing target database cannot be safely backed up. Preserve that database and its sidecars in secure quarantine before attempting recovery against an absent target.

## 5. Restore attachments, icons and server setup

Copy the saved `uploads/` contents into the new app's `uploads/`. Copy custom `public/pwa-icon-*.png` files and `public/favicon-32.png` to the new `public/`. Keep the repository's current HTML, JavaScript, CSS and other application assets.

These locations assume `npm start`. If the service runs `dist/server.js`, media and public assets are relative to that module: `dist/uploads/` and `dist/public/`. Check the actual service command before copying.

Restore the service definition, startup command, working directory, reverse proxy, HTTPS certificates and any required firewall configuration. Ensure the service account can read `.env` and icons and can write the database directory and uploads. Protect secrets and database backups from public access.

## 6. Start and verify

Start the app through its normal service manager, or use `npm start` for a foreground run. Inspect startup logs and check `/readyz` on the configured port, for example `http://127.0.0.1:3333/readyz`.

Sign in with an account and password from the restored database, then verify:

- Accounts, admin settings and preferences.
- Recent messages, reports and view-once state.
- Images, videos and other attachments.
- SMTP/2FA, public HTTPS access and custom icons.

Maintenance restore clears sessions, OTP tokens and push subscriptions. Users must sign in again and register push notifications again. If admin credentials are unavailable, use the offline admin recovery procedure in [Technical Manual section 16.7](TECHNICAL_MANUAL.md#167-admin-account-reset).

Keep the original saved folder and recovery copies until the restored installation is verified. To roll back, stop the app, validate and restore the desired recovery database using the same maintenance commands, and restore its matching media and configuration.
