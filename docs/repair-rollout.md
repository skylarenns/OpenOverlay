# Repair rollout

This is the production handoff for the repair branch. The source checkout at `/Users/skylarenns/Desktop/OpenOverlay` remains untouched. As of 2026-09-23, production frontend, gateway, and backend still report `6e45c4c7755b6d4f1ee4e605ecd780999ca7ff8f`. The SSH account is UID 1000 without passwordless sudo. No root unit, backup timer, immutable release, or frontend alias has been changed by this repair.

## 1. Review and reserve recovery space

- Review and merge the repair branch, then require the full Node 24 CI job on the merged commit. Record that 40-character SHA for both backend and frontend releases.
- On `shhh.skylarenns.com`, verify `/mnt/evenbiggerboi` is mounted and has space. The root filesystem had about 19 GiB free at the last read-only check, below the backup tool's 50 GiB reserve. Use `/mnt/evenbiggerboi/openoverlay-backups` as the backup root.
- Disable Vercel's automatic production-domain assignment while staging the frontend. The frontend deploy script uses `--skip-domain`, verifies the candidate, and promotes it after the backend is compatible.

## 2. Install and prove stable backups

From the reviewed release source on the host, a root-capable operator runs:

```bash
mountpoint -q /mnt/evenbiggerboi
OPENOVERLAY_BACKUP_ROOT=/mnt/evenbiggerboi/openoverlay-backups bash scripts/install-backup-runner.sh
systemctl status openoverlay-backup.timer --no-pager
```

The installer copies the backup program to `/usr/local/libexec/openoverlay`, writes the root-owned backup-root configuration, starts one complete snapshot, performs an isolated restore against the running release, and enables the timer only after both pass. The immutable deploy command reads the same configuration for predeploy snapshots, including when invoked through forced SSH without caller environment variables. Inspect `/var/lib/openoverlay/backup-status.json` and the newest snapshot manifest before proceeding.

## 3. Rehearse immutable activation with the current application

A root-capable operator runs `bash scripts/bootstrap-release-host.sh` from the reviewed source. This installs the immutable candidate unit and deployment entrypoint without replacing the active legacy unit or changing `/var/lib/openoverlay` ownership. The first repair commit changes recovery and deployment tooling without the stage application changes. It passed config, 283 unit/integration tests, and production builds in an isolated checkout. From a Git checkout containing that commit:

```bash
infra_sha=285077d2522cdf1b82dfdb6a147a4d69ed80d4ea
git archive --format=tar.gz "$infra_sha" > /var/tmp/openoverlay-infra.tar.gz
infra_sum="$(sha256sum /var/tmp/openoverlay-infra.tar.gz | cut -d' ' -f1)"
/usr/local/sbin/openoverlay-deploy bootstrap "$infra_sha" "$infra_sum" < /var/tmp/openoverlay-infra.tar.gz
```

The release manifest derives privacy epoch from the built backend's stage feature, so this baseline release remains at epoch 0. Verify frontend, gateway, backend, uploads, credentials, and runtime UID after activation.

Rehearse a deliberately unhealthy epoch-0 candidate before application changes. Confirm the legacy unit and previous frontend remain reachable after failed startup. The current branch has fixture coverage for failed backend startup and schema-compatible rollback; live activation remains a separate required check.

## 4. Promote compatibility, then the frontend

Build an archive from the reviewed repair commit and use `openoverlay-deploy deploy SHA CHECKSUM` after the gateway reports no active output or stage displays. It takes a verified predeploy snapshot, tests an isolated restore, and checks matching gateway/backend release identity. The first stage-privacy release marks a privacy cutover before startup; if it fails, recover forward from the verified snapshot. Never restart an epoch-0 backend after that marker exists.

Once backend `/health` advertises `features.stage` and `features.mutationReceipts`, run `bash scripts/deploy-frontend-vercel.sh` from the same clean `main` SHA. The script records the previous production deployment ID and build SHA, validates the staged frontend, and attempts an exact rollback with build verification if promotion fails. Confirm `npm run check:deployments` and private stage/public audience output after promotion.

Complete the physical OBS, projector, Safari, VoiceOver, phone, and tablet checks in [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md). Local browser tests do not establish those results.
