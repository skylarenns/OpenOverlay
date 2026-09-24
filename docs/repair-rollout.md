# Repair rollout

## Verified production state, 2026-09-23

- The original checkout at `/Users/skylarenns/Desktop/OpenOverlay` still has its 41 preexisting entries and was not used for releases. PR #21 and the control-socket correction in PR #22 are merged.
- The stable backup runner is installed under `/usr/local/libexec/openoverlay`. The daily timer is enabled and active. Snapshots use `/mnt/evenbiggerboi/openoverlay-backups`; both the initial and predeploy snapshots passed isolated restore. Operator status at `/var/lib/openoverlay/backup-status.json` reports a successful backup, no failure, and no overdue condition.
- The immutable gateway/backend runs `528010fc6324d15423713a77f478911f933d9beb` as `skylarenns:openoverlay`, using the existing database and uploads under `/var/lib/openoverlay`. The database is schema 5 with `PRAGMA integrity_check=ok`; both existing presets have stage keys. The privacy cutover marker exists. Never start an epoch-zero backend against this database again.
- The frontend custom domain, gateway, and backend all report `528010f`; `npm run check:deployments` passed. `/health` advertises `features.stage` and `features.mutationReceipts`. Vercel project `open-overlay-frontend` retains `autoAssignCustomDomains=false`, so promotion remains an explicit step.
- Production public and stage HTTP/socket requests were checked against an existing soccer preset: public and valid stage requests succeeded; missing/invalid stage keys failed closed. Production currently has no church preset. Church draft redaction, stage-key rotation, and socket revocation passed integration tests but still need a live church workflow check with an authorized operator account.
- The clean Node 24 CI run for PR #22 and merged `main` passed 172 backend, 118 frontend, and 15 shared tests, build/config/lint/format/type checks, 34 Chromium scenarios, security checks, and Linux systemd verification. Three WebKit operator workflows passed separately. No physical device result is claimed.

The first frontend deploy built a verified candidate but stopped before promotion because Vercel CLI 55 forwarded `--scope` to curl. A one-time guarded run checked the candidate routes, assets, security headers, build identity, backend compatibility, and prior deployment, then promoted it. PR #23 repairs the source deployment script and ignores Vercel-generated local files. Require its full CI before merging.

## Remaining acceptance

1. With an authorized operator session, verify production church audience and stage outputs, stage rotation/revocation, and authenticated mutations. Existing soccer production was checked without changing presets.
2. Confirm OBS/projector output and operator workflows on physical Safari, phone, tablet, keyboard, reduced-motion, light/dark, and 720p–4K devices in [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md). Browser automation does not prove hardware output.
3. Keep automatic custom-domain assignment disabled. Future frontend releases use a clean `main` checkout and `VERCEL_TEAM=skylar-enns-projects bash scripts/deploy-frontend-vercel.sh`; verify matching identities and backup status after each promotion.

The deliberate startup-failure release `1d464bce3fdf49b738d8e2f3132b91fe91ff2867` rolled back to healthy epoch-zero release `840f3751fa9994d6423d82eb46924494d46c8e8b` before privacy cutover. Its rehearsal branch must never be merged or promoted as an application release.

## Recovery rules

- The current immutable helper discovers the legacy gateway control socket during first activation and uses the immutable control socket afterward. It checks actual output sockets and in-flight mutations rather than treating the gateway's own health connection as an audience display.
- Every new release must export integer schema and reader versions in its manifest. The helper rejects a missing prior rollback contract before switching an epoch-zero service. It checks schema compatibility again after a failed startup.
- Verified snapshots and the original legacy unit backup are retained. Restore activation requires the backend to be stopped under the deployment lock; the normal deployment path uses isolated restore verification without touching live data.
