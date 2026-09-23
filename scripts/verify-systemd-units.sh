#!/usr/bin/env bash
set -euo pipefail

fixture="$(mktemp -d)"
node_binary="$(command -v node)"
[[ -x "$node_binary" ]] || { printf 'Node executable is unavailable for systemd validation.\n' >&2; exit 1; }
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/units" "$fixture/opt/openoverlay/release/apps/backend" "$fixture/opt/openoverlay/release/scripts" "$fixture/var/lib/openoverlay/uploads" \
  "$fixture/var/backups/openoverlay" "$fixture/var/log/openoverlay" "$fixture/run/openoverlay" \
  "$fixture/usr/local/libexec/openoverlay" "$fixture/etc"
ln -s release "$fixture/opt/openoverlay/current"
touch "$fixture/etc/openoverlaybackend.env"
cp scripts/openoverlay-backup-runner "$fixture/usr/local/libexec/openoverlay/backup-runner"
cp scripts/cloudflare-tunnel-maintenance.sh "$fixture/opt/openoverlay/release/scripts/cloudflare-tunnel-maintenance.sh"
chmod 0755 "$fixture/opt/openoverlay/release/scripts/cloudflare-tunnel-maintenance.sh"

for unit in apps/backend/systemd/*.service apps/backend/systemd/*.timer; do
  sed \
    -e "s@/opt/openoverlay/current@$fixture/opt/openoverlay/current@g" \
    -e "s@/var/lib/openoverlay@$fixture/var/lib/openoverlay@g" \
    -e "s@/var/backups/openoverlay@$fixture/var/backups/openoverlay@g" \
    -e "s@/var/log/openoverlay@$fixture/var/log/openoverlay@g" \
    -e "s@/run/openoverlay@$fixture/run/openoverlay@g" \
    -e "s@/usr/local/libexec/openoverlay@$fixture/usr/local/libexec/openoverlay@g" \
    -e "s@/usr/local/sbin/openoverlay-backup-runner@$fixture/usr/local/libexec/openoverlay/backup-runner@g" \
    -e "s@/etc/openoverlaybackend.env@$fixture/etc/openoverlaybackend.env@g" \
    -e "s@/usr/bin/node@$node_binary@g" \
    "$unit" > "$fixture/units/$(basename "$unit")"
done

SYSTEMD_UNIT_PATH="$fixture/units:/usr/lib/systemd/system:/lib/systemd/system" systemd-analyze verify "$fixture"/units/*.service "$fixture"/units/*.timer
