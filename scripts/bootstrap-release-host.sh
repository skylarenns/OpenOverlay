#!/usr/bin/env bash
set -euo pipefail

(( EUID == 0 )) || { printf 'Run this bootstrap script as root.\n' >&2; exit 1; }
[[ -f scripts/openoverlay-deploy && -f apps/backend/systemd/Openoverlaybackend.service ]] || {
  printf 'Run from an OpenOverlay release checkout.\n' >&2
  exit 1
}

getent group openoverlay >/dev/null || groupadd --system openoverlay
id openoverlay >/dev/null 2>&1 || useradd --system --gid openoverlay --home-dir /nonexistent --shell /usr/sbin/nologin openoverlay
id deploy-openoverlay >/dev/null 2>&1 || useradd --system --gid openoverlay --create-home --home-dir /var/lib/deploy-openoverlay --shell /usr/sbin/nologin deploy-openoverlay

install -d -m 0750 -o root -g openoverlay /opt/openoverlay /opt/openoverlay/releases
if [[ ! -d /var/lib/openoverlay ]]; then install -d -m 0750 -o skylarenns -g openoverlay /var/lib/openoverlay; fi
if [[ ! -d /var/lib/openoverlay/uploads ]]; then install -d -m 0750 -o skylarenns -g openoverlay /var/lib/openoverlay/uploads; fi
if [[ ! -d /var/log/openoverlay ]]; then install -d -m 0750 -o skylarenns -g openoverlay /var/log/openoverlay; fi
if [[ -f /etc/openoverlaybackend.env ]]; then
  chown root:openoverlay /etc/openoverlaybackend.env
  chmod 0640 /etc/openoverlaybackend.env
fi
install -d -m 0700 -o root -g root /var/backups/openoverlay
install -m 0750 -o root -g root scripts/openoverlay-deploy /usr/local/sbin/openoverlay-deploy
install -d -m 0755 -o root -g root /etc/openoverlay
install -m 0644 -o root -g root apps/backend/systemd/Openoverlaybackend.service /etc/openoverlay/Openoverlaybackend.immutable.service
install -m 0644 -o root -g root apps/backend/systemd/openoverlay-cloudflared-version-check.service /etc/systemd/system/openoverlay-cloudflared-version-check.service
install -m 0644 -o root -g root apps/backend/systemd/openoverlay-cloudflared-version-check.timer /etc/systemd/system/openoverlay-cloudflared-version-check.timer

if [[ -n "${DEPLOY_PUBLIC_KEY:-}" ]]; then
  [[ "$DEPLOY_PUBLIC_KEY" =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh.com)[[:space:]]+[A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || {
    printf 'DEPLOY_PUBLIC_KEY must be an Ed25519 OpenSSH public key.\n' >&2
    exit 1
  }
  install -d -m 0700 -o deploy-openoverlay -g openoverlay /var/lib/deploy-openoverlay/.ssh
  AUTHORIZED_KEYS=/var/lib/deploy-openoverlay/.ssh/authorized_keys
  printf 'restrict,command="sudo -n /usr/local/sbin/openoverlay-deploy --forced" %s\n' "$DEPLOY_PUBLIC_KEY" > "$AUTHORIZED_KEYS"
  chown deploy-openoverlay:openoverlay "$AUTHORIZED_KEYS"
  chmod 0600 "$AUTHORIZED_KEYS"
fi

SUDOERS=/etc/sudoers.d/openoverlay-deploy
printf '%s\n' 'deploy-openoverlay ALL=(root) NOPASSWD: /usr/local/sbin/openoverlay-deploy --forced' > "$SUDOERS"
chmod 0440 "$SUDOERS"
visudo -cf "$SUDOERS"
systemctl daemon-reload
systemctl enable openoverlay-cloudflared-version-check.timer
printf 'Immutable candidate staged. Active backend unit and runtime data ownership remain unchanged. Install verified backups separately.\n'
