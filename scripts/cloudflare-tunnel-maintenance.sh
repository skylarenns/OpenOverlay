#!/usr/bin/env bash
set -euo pipefail

readonly DEDICATED_CONFIG="${OPENOVERLAY_TUNNEL_CONFIG:-/home/skylarenns/.cloudflared/openoverlay-api.yml}"
readonly UNIFIED_CONFIG="${OPENOVERLAY_UNIFIED_TUNNEL_CONFIG:-/etc/cloudflared/config.yml}"
readonly DEDICATED_SERVICE="cloudflared-openoverlay.service"
readonly FORBIDDEN_SERVICE="cloudflared-openoverlay-api.service"
readonly EXPECTED_VERSION="2026.7.3"
readonly HOSTNAMES=(openoverlayapi.skylarenns.com openoverlay-api.skylarenns.com)

fail() {
  printf 'cloudflare-tunnel-maintenance: %s\n' "$*" >&2
  exit 1
}

require_root() {
  (( EUID == 0 )) || fail "must run as root"
}

assert_overlay_inactive() {
  local status
  status="$(/usr/local/sbin/openoverlay-deploy status)"
  STATUS_JSON="$status" /usr/bin/node -e '
    const state=JSON.parse(process.env.STATUS_JSON);
    if (!state.gatewayHealthy || !state.activeChildHealthy) process.exit(1);
    if (Number(state.connections?.overlay) > 0 || Number(state.connections?.stage) > 0 || Number(state.inFlightMutations) > 0) process.exit(75);
  ' || {
    result=$?
    [[ "$result" -eq 75 ]] && fail "maintenance deferred by active output, stage display, or mutation"
    fail "gateway is unhealthy"
  }
}

validate_dedicated() {
  [[ -r "$DEDICATED_CONFIG" ]] || fail "dedicated tunnel config is unreadable"
  cloudflared tunnel --config "$DEDICATED_CONFIG" ingress validate
  local hostname rule
  for hostname in "${HOSTNAMES[@]}"; do
    rule="$(cloudflared tunnel --config "$DEDICATED_CONFIG" ingress rule "https://${hostname}/health")"
    grep -Fq 'service: http://127.0.0.1:8734' <<< "$rule" || fail "$hostname does not resolve to the canonical origin"
  done
  if systemctl list-unit-files "$FORBIDDEN_SERVICE" --no-legend 2>/dev/null | grep -q .; then
    fail "forbidden duplicate tunnel unit exists: $FORBIDDEN_SERVICE"
  fi
  systemctl is-active --quiet "$DEDICATED_SERVICE" || fail "$DEDICATED_SERVICE is not active"
}

audit() {
  validate_dedicated
  local first second connector_lines
  first="$(curl -fsS --connect-timeout 3 --max-time 10 "https://${HOSTNAMES[0]}/health")"
  second="$(curl -fsS --connect-timeout 3 --max-time 10 "https://${HOSTNAMES[1]}/health")"
  FIRST="$first" SECOND="$second" /usr/bin/node -e '
    const a=JSON.parse(process.env.FIRST); const b=JSON.parse(process.env.SECOND);
    if (!a.ok || !b.ok || !a.build?.commit || a.build.commit !== b.build?.commit) process.exit(1);
    console.log(JSON.stringify({ok:true, buildSha:a.build.commit}));
  ' || fail "API hostnames do not return the same healthy build"
  connector_lines="$(cloudflared tunnel info openoverlay-api)"
  printf '%s\n' "$connector_lines"
}

normalize() {
  require_root
  assert_overlay_inactive
  [[ -r "$DEDICATED_CONFIG" && -r "$UNIFIED_CONFIG" ]] || fail "tunnel configuration is unreadable"
  local dedicated_temporary temporary dedicated_directory temporary_directory dedicated_backup backup stamp hostname
  dedicated_directory="$(mktemp -d /home/skylarenns/.cloudflared/openoverlay-api.XXXXXXXX)"
  temporary_directory="$(mktemp -d /etc/cloudflared/config.openoverlay.XXXXXXXX)"
  chown skylarenns:skylarenns "$dedicated_directory"
  dedicated_temporary="$dedicated_directory/config.yml"
  temporary="$temporary_directory/config.yml"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dedicated_backup="${DEDICATED_CONFIG}.before-normalize-${stamp}"
  backup="/etc/cloudflared/config.yml.before-openoverlay-${stamp}"
  trap 'if [[ -f "${dedicated_temporary:-}" ]]; then mv -- "$dedicated_temporary" "${dedicated_temporary}.failed"; fi; if [[ -f "${temporary:-}" ]]; then mv -- "$temporary" "${temporary}.failed"; fi' EXIT
  /usr/bin/node /opt/openoverlay/current/scripts/ensure-cloudflare-dedicated-ingress.mjs "$DEDICATED_CONFIG" "$dedicated_temporary"
  chown skylarenns:skylarenns "$dedicated_temporary"
  chmod 0600 "$dedicated_temporary"
  runuser -u skylarenns -- cloudflared tunnel --config "$dedicated_temporary" ingress validate
  install -m 0600 -o skylarenns -g skylarenns "$DEDICATED_CONFIG" "$dedicated_backup"
  mv -- "$dedicated_temporary" "$DEDICATED_CONFIG"
  for hostname in "${HOSTNAMES[@]}"; do
    runuser -u skylarenns -- cloudflared tunnel route dns --overwrite-dns openoverlay-api "$hostname"
  done
  systemctl restart "$DEDICATED_SERVICE"
  validate_dedicated
  audit

  /usr/bin/node /opt/openoverlay/current/scripts/normalize-cloudflare-ingress.mjs "$UNIFIED_CONFIG" "$temporary"
  cloudflared tunnel --config "$temporary" ingress validate
  install -m 0600 -o root -g root "$UNIFIED_CONFIG" "$backup"
  chown --reference="$UNIFIED_CONFIG" "$temporary"
  chmod --reference="$UNIFIED_CONFIG" "$temporary"
  mv -- "$temporary" "$UNIFIED_CONFIG"
  systemctl reload-or-restart cloudflared.service
  audit
  rmdir "$dedicated_directory" "$temporary_directory"
  trap - EXIT
  printf 'Dedicated and unified tunnels normalized; recoverable backups: %s %s\n' "$dedicated_backup" "$backup"
}

upgrade() {
  require_root
  assert_overlay_inactive
  validate_dedicated
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y "cloudflared=${EXPECTED_VERSION}*"
  printf 'Package: cloudflared\nPin: version %s*\nPin-Priority: 1001\n' "$EXPECTED_VERSION" > /etc/apt/preferences.d/cloudflared
  [[ "$(cloudflared version | awk '{print $3}')" == "$EXPECTED_VERSION" ]] || fail "installed cloudflared version does not match $EXPECTED_VERSION"
  systemctl restart "$DEDICATED_SERVICE"
  audit
}

check_update() {
  require_root
  apt-get update -qq
  local installed candidate
  installed="$(dpkg-query -W -f='${Version}' cloudflared)"
  candidate="$(apt-cache madison cloudflared | awk 'NR==1 {print $3}')"
  printf '{"installed":"%s","candidate":"%s","updateAvailable":%s}\n' \
    "$installed" "$candidate" "$(dpkg --compare-versions "$candidate" gt "$installed" && printf true || printf false)"
}

case "${1:-}" in
  audit) audit ;;
  normalize) normalize ;;
  upgrade) upgrade ;;
  check-update) check_update ;;
  *) fail "usage: $0 audit|normalize|upgrade|check-update" ;;
esac
