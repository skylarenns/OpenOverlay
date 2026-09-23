#!/usr/bin/env bash
set -euo pipefail

(( EUID == 0 )) || { printf 'Run backup installation as root.\n' >&2; exit 1; }
[[ -f scripts/openoverlay-backup.mjs && -f scripts/openoverlay-restore-stage.mjs && -f scripts/openoverlay-restore-identity.mjs ]] || {
  printf 'Run from an OpenOverlay release checkout.\n' >&2
  exit 1
}
backup_root="${OPENOVERLAY_BACKUP_ROOT:-/var/backups/openoverlay}"
[[ "$backup_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || { printf 'OPENOVERLAY_BACKUP_ROOT must be an absolute plain path.\n' >&2; exit 1; }

install -d -m 0755 -o root -g root /usr/local/libexec/openoverlay
install -m 0644 -o root -g root scripts/openoverlay-backup.mjs scripts/openoverlay-restore-stage.mjs scripts/openoverlay-restore-identity.mjs /usr/local/libexec/openoverlay/
install -m 0755 -o root -g root scripts/openoverlay-backup-runner /usr/local/sbin/openoverlay-backup-runner
sed "s@/var/backups/openoverlay@$backup_root@g" apps/backend/systemd/openoverlay-backup.service > /etc/systemd/system/openoverlay-backup.service
chmod 0644 /etc/systemd/system/openoverlay-backup.service
printf 'OPENOVERLAY_BACKUP_ROOT=%s\n' "$backup_root" > /etc/openoverlay-backup.env
chmod 0644 /etc/openoverlay-backup.env
install -m 0644 -o root -g root apps/backend/systemd/openoverlay-backup.timer /etc/systemd/system/openoverlay-backup.timer
install -d -m 0700 -o root -g root "$backup_root"
systemctl daemon-reload

# A complete snapshot and isolated backend/media restore must work before the
# daily schedule can start. This does not change the running backend.
systemctl start openoverlay-backup.service
status="$(/usr/bin/node /usr/local/libexec/openoverlay/openoverlay-backup.mjs status \
  --status-file /var/lib/openoverlay/backup-status.json)"
snapshot="$(STATUS_JSON="$status" /usr/bin/node -e '
  const status = JSON.parse(process.env.STATUS_JSON);
  if (status.overdue || status.failedSinceSuccess || !status.lastSuccessfulSnapshot) process.exit(1);
  process.stdout.write(status.lastSuccessfulSnapshot);
')"
working_directory="$(systemctl show -p WorkingDirectory --value Openoverlaybackend.service)"
release="$(cd "$working_directory/../.." && pwd -P)"
/usr/bin/node /usr/local/libexec/openoverlay/openoverlay-backup.mjs restore-verify --snapshot "$snapshot" --release "$release"
systemctl enable --now openoverlay-backup.timer
printf 'Backup timer enabled after verified snapshot and isolated restore: %s\n' "$snapshot"
