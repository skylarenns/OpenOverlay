# Repair rollout

## Verified production state, 2026-09-23

- The original checkout at `/Users/skylarenns/Desktop/OpenOverlay` still has its 41 preexisting entries and was not used for releases. Draft PR #21 contains the repair branch.
- The stable backup runner is installed under `/usr/local/libexec/openoverlay`. Its daily timer is enabled and active. Snapshots use `/mnt/evenbiggerboi/openoverlay-backups`; the initial snapshot and isolated restore passed. Predeploy snapshots also passed verification. Operator status is `/var/lib/openoverlay/backup-status.json`.
- The immutable gateway/backend runs epoch-zero release `840f3751fa9994d6423d82eb46924494d46c8e8b` as `skylarenns:openoverlay`, using the existing `/var/lib/openoverlay` database and uploads. Its manifest records schema and reader version 3. The database passed `PRAGMA integrity_check`; no privacy cutover marker exists.
- Deliberate startup-failure release `1d464bce3fdf49b738d8e2f3132b91fe91ff2867` passed its build and isolated restore, failed gateway startup, and automatically rolled back to `840f375`. The predeploy snapshot `20260923T210015-044Z-predeploy-840f3751fa99` verifies after rollback. This rehearsal branch must never be merged or promoted as an application release.
- The public frontend remains at `6e45c4c7755b6d4f1ee4e605ecd780999ca7ff8f`. Vercel project `open-overlay-frontend` has `autoAssignCustomDomains=false`, verified through the project API, so a `main` push cannot assign its production custom domain ahead of backend compatibility. Git preview deployment remains enabled.

The transient frontend/backend commit mismatch is expected during this infrastructure rehearsal. Do not call the rollout complete until the final production identities agree.

## Complete the application cutover

1. Review and merge PR #21. Require the full clean Node 24 CI suite on the resulting `main` SHA. The local repair branch had a green full CI run at `a1be2502e55766c291bd3c39fdc7ecef717a8c8e`; any later source or documentation commit needs a new run.
2. Record the exact merged SHA and build a Git archive from it. Verify its SHA-256 and embedded Git commit before copying it to the host. The installed `/usr/local/sbin/openoverlay-deploy` checks both again.
3. Confirm `openoverlay-deploy status` reports a healthy gateway/child, zero overlay and stage displays, and zero in-flight mutations. The command takes a verified predeploy snapshot and tests an isolated restore before promotion. Deploy the backend archive as root:

   ```bash
   /usr/local/sbin/openoverlay-deploy deploy "$release_sha" "$archive_sha256" < "$archive_path"
   ```

4. Verify `/health` and `/_openoverlay/gateway` report the merged SHA and `features.stage`/`features.mutationReceipts`. The first stage release sets `/var/lib/openoverlay/privacy-cutover` before startup. From that point, never restart or roll back to an epoch-zero backend that exposes full church state. If startup fails, recover forward using the verified snapshot and a fixed stage-capable release.
5. From a clean `main` checkout at the same SHA, use Node 24 and run `VERCEL_TEAM=skylar-enns-projects bash scripts/deploy-frontend-vercel.sh`. It builds a production candidate with `--skip-domain`, checks routes, assets, headers, build identity, and backend compatibility, then promotes it. It records the prior deployment and attempts exact restoration if promotion fails. Keep automatic custom-domain assignment disabled for this controlled workflow.
6. Require `npm run check:deployments` to report the same SHA for the frontend, gateway, and backend. Test authenticated mutations, public audience HTTP/socket projection, stage-key access and revocation, and OBS-compatible output. Confirm backup timer and operator status again.

Physical OBS/projector output, Safari, VoiceOver, phone, tablet, and device checks in [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md) remain a separate acceptance gate. The browser suites do not prove those hardware results.

## Recovery rules

- The current immutable helper discovers the legacy gateway control socket during first activation and uses the immutable control socket afterward. It checks actual output sockets and in-flight mutations rather than treating the gateway's own health connection as an audience display.
- Every new release must export integer schema and reader versions in its manifest. The helper rejects a missing prior rollback contract before switching an epoch-zero service. It checks schema compatibility again after a failed startup.
- Verified snapshots and the original legacy unit backup are retained. Restore activation requires the backend to be stopped under the deployment lock; the normal deployment path uses isolated restore verification without touching live data.
