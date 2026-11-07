# Production domain migration — 2026-11-06

## Active architecture

| Component | Accepted configuration |
| --- | --- |
| Frontend | https://openoverlay.skylar.sh on Vercel project `prj_3mQpVOLWcMlzXz5TPLEn3bL1Al23` |
| Frontend API and realtime origin | https://cloud-api.skylar.sh and its secure WebSocket transport |
| Additional flat API aliases | openoverlay-api.skylar.sh and openoverlayapi.skylar.sh |
| Backend | Main platform API, loopback port 47834, source https://github.com/skylarenns/skylar.sh |
| Cloudflare tunnel | Existing Cloud API tunnel `e9d39914-907f-46ed-8e26-abffbb093285` |
| Legacy frontend | https://openoverlay.skylarenns.com on its previous deployment and legacy Cloud API origin |

The flat aliases avoid a paid certificate for the nested api.openoverlay.skylar.sh name. No nested replacement was activated. Product routes work under the platform namespace; obsolete standalone API/authentication routes do not become available by changing hosts. Old standalone API aliases were already orphaned before this migration and are not a verified compatibility contract.

The Cloud API tunnel retains its ordered peer-transfer rule to port 47844 before its general API rule to 47834. Do not consolidate these ports or reorder the path rule. Access protections, credentialed exact-origin CORS, CSRF and cookie boundaries remain in force.

## Frontend release provenance

Accepted deployment: `dpl_Gfg4Gm9nw8GAomkupZiidEgekcW5`.
Previous deployment retained for rollback: `dpl_2fXa1Kz2BN37FNJZycqnJtDC8VAD`.

The exact source commit for the previous production frontend was unavailable. The migration therefore used a deterministic domain-only transform of its verified artifact, preserving old chunks and changing only the required host selection and CSP origins. The legacy frontend alias was not moved. This is a documented source-reconciliation dependency, not evidence that this repository's main branch reproduces production.

Vercel's ignored-build command is `exit 0`. Keep automatic builds ignored until the original source is recovered or a separately tested replacement reproduces the required production behavior. Do not invoke the standalone backend/frontend deployment scripts against production.

## Acceptance and rollback

Five artifact checks and four isolated Chromium/WebKit real-backend authentication/socket tests passed. Eighteen public API TLS/CORS/security/socket checks passed. Public browser checks on old and new frontends verified rendering, anonymous API/authentication boundaries and no page errors. These do not claim a real owner's authenticated production editing session or an OBS hardware test.

For a frontend regression, reassign only the new frontend alias to the saved prior deployment and verify its API origin. Keep old deployments, assets and legacy host available. For tunnel rollback, restore the saved exact prior configuration only after confirming it will preserve Cloud API and peer-transfer routes; use a graceful drain. DNS rollback must use saved exact record IDs and before-state, never a wildcard deletion. Do not roll back the shared application database for a hostname issue.

The operational receipts and original bytes are retained in the migration workspace under `migration/openoverlay-completion/` and `migration/cloudflare/overlay-*-dns-created.json`. They contain no published secrets. Private backup/configuration material remains access restricted.

## Browser state and follow-up

Cookies and browser storage are origin scoped. Existing sessions remain on the legacy frontend/API pair; new-origin login is separate. Retain legacy routing until users have verified their replacements. The outstanding source-reconciliation task is to recover or replace the exact deployed frontend source before restoring Git-triggered production deployments.
