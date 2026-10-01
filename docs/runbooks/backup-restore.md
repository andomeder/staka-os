# Backup restore runbook

Restoring the org server database from an encrypted backup. The procedure
below reflects an actual executed restore, not a dry plan.

Last executed: 2026-09-22, from backup `staka-pg-20260922T013134Z.sql.gpg`.

## Background

- Backups are produced by `packages/org-server/scripts/backup-db.sh` as
  GPG-encrypted `pg_dump` output (`staka-pg-<timestamp>.sql.gpg`). A
  plaintext dump never touches disk.
- The backup GPG private key never lives on the VPS; the restore needs the
  operator keyring.
- The dump is taken with `--no-owner --no-acl`, so database **roles and
  grants are not in the backup** (see step 5).

## Procedure

Run from an operator machine with the backup private key installed. The
target below is a scratch container; never restore into the running prod
database unless you accept destroying its current contents.

1. Fetch the latest encrypted dump from the VPS:

       scp cloudsurfer-server-hetzner:~/staka-org-server/backups/staka-pg-*.sql.gpg .

2. Verify decryption before touching a database (no SQL written):

       GNUPGHOME=~/Documents/keys/staka-org-backup/gnupg \
         packages/org-server/scripts/restore-db.sh --input staka-pg-<ts>.sql.gpg

3. Start a scratch Postgres matching the prod image (18-alpine), on a
   distinct project name, port and throwaway storage:

       docker run -d --name staka-restore-drill \
         -e POSTGRES_USER=staka -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=staka \
         -p 127.0.0.1:35432:5432 postgres:18-alpine

4. Restore the dump (measured: 0.3 s for the current data size; expect
   minutes at thousands of machines):

       PGPASSWORD=drill psql -h 127.0.0.1 -p 35432 -U staka -d staka \
         -v ON_ERROR_STOP=1 -f staka-pg.sql

5. Re-create the application roles and re-apply grants. Because the dump
   excludes ACLs, the restored schema starts with zero grants. Apply the
   role and GRANT block from `db/migrations/0000_init.sql` (roles
   `staka_app` / `staka_admin` plus their table grants), setting the
   passwords from the prod secrets store, then re-run the follow-up grant
   migration `db/migrations/0002_app_rebind_grants.sql`. The drizzle
   migrations journal is part of the restored data, so the normal
   migration runner will consider everything applied and will NOT do this
   for you.

6. Verify row counts against the prod values (read-only on prod):

       psql ... -t -c "SELECT count(*) FROM machines;"
       # compare against: docker exec <prod-postgres> psql -U staka -d staka -t -c ...

   2026-09-22 run: machines 1, users 2, activation_codes 2, usage_logs 8,
   admin_audit_log 6 - identical to prod after restore.

7. Boot the org server against the scratch database and confirm the admin
   dashboard loads, then destroy the container:

       docker rm -f staka-restore-drill

## Failure modes found by the 2026-09-22 drill

1. **Backup timer silently failing (found 2026-09-22, fixed by hand).**
   The daily backup systemd *user* service failed with
   `permission denied` on the docker socket from 2026-07-22 to 2026-09-22:
   the long-running user manager predates the operator's docker group
   membership and a user unit cannot change group credentials. Manual
   SSH-session runs work. Permanent fix (requires one command with sudo):
   restart the user manager, `sudo systemctl restart user@1000.service`,
   or move the backup unit to system scope. Alerting on the backup
   service state is worth adding.
2. **Roles and grants are absent from a restored database** (step 5).
   Without re-applying them, the org server starts but every
   machine-scoped request fails on permission errors.
3. `restore-db.sh --apply` targets the prod compose project by default;
   the drill used `docker run` directly instead. Keep it that way unless
   the script gains an explicit `--compose-file` target for scratch
   restores.
