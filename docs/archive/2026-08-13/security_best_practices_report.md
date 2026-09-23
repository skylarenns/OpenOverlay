# OpenOverlay Security Best-Practices Review

Historical snapshot for the August 2026 baseline. Findings and rollout status below describe that audit date, not the current checkout or production state.

## Remediation update — 2026-08-13

The mutable in-process updater has been removed in Release A (`1d17f40`). Replacement controls include exact-SHA/checksum archive validation, traversal/link rejection, bounded input, a global deployment lock, immutable root-owned releases, a non-login service account, systemd filesystem/kernel/device hardening, activity-aware promotion refusal, isolated copied-database preflight, verified backup/restore, and automatic backend/Vercel rollback wiring. The public production workflow is fail-closed until environment-scoped secrets and an explicit enablement variable are installed interactively.

Release B removes recipient enumeration by returning the same opaque receipt contract for present and absent accounts, storing only an HMAC of normalized recipient email, expiring/capping/rate-limiting durable pending shares, stripping media/action secrets from snapshots, and exposing no receipt-resolution endpoint. It also adds bounded Sharp thumbnail generation, validated opaque cursors, and thumbnail-inclusive storage accounting. Release B must not reach production until Release A is the established rollback reader for additive schema v3.

Date: 2026-08-11  
Audited baseline: `656795c` on `main`  
Result status: local source and build artifacts only; nothing in this review was deployed

## Executive summary

No P0 vulnerability was found. The audit did find several release-blocking or high-impact weaknesses in authentication configuration and revocation, cross-origin request handling, host-wide storage exhaustion, untrusted state and upload validation, destructive-write concurrency, deployment identity, and the mutable self-update architecture. The bounded application-level issues were repaired and covered by automated tests. Four P1 deployment-architecture risks remain and should be resolved before enabling unattended production updates.

The live deployment is still the old `656795c` build. Read-only probes on 2026-08-11 confirmed that it still returns a soft-404 HTML response for missing assets and maps a hostile CORS preflight to HTTP 500. Those live observations do not reflect the source fixes in this worktree.

## Scope and threat surface

Reviewed surfaces included:

- Express 5 REST API, Socket.IO handshake/events, gateway proxy, and updater control path.
- HMAC-signed HTTP-only session cookies, login/signup/logout, API-version enforcement, CSRF/CORS behavior, and per-resource ownership.
- SQLite schema/migrations, state serialization, revision checks, event retention, and recovery behavior.
- Multer uploads, SVG/raster validation, media serving/deletion, path containment, quotas, and startup reconciliation.
- React API client and public overlay data validation.
- Vercel routing/headers, Cloudflare Tunnel assumptions, systemd configuration, deploy scripts, environment validation, and build identity.
- Dependency tree and committed-secret patterns in the worktree and Git history.

## Findings

| ID     | Severity | Finding                                                                                                                                                      | Root cause                                                                                                         | Remediation and evidence                                                                                                                                                                                                                       | Status                                                 |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| SEC-01 | P1       | A weak or well-known production session secret could be accepted.                                                                                            | Configuration only required a value and did not reject development defaults.                                       | Production validation now requires a sufficiently long secret, rejects known development/test values, and keeps secrets out of diagnostic output. Covered by production-env/config tests.                                                      | Fixed in source                                        |
| SEC-02 | P1       | Cookie-authenticated writes could fail open or become HTTP 500 on hostile origins.                                                                           | CORS errors were not a typed application error and origin matching was not consistently exact.                     | Exact origin allowlisting, duplicate-origin rejection, cookie-domain normalization, and typed HTTP 403 handling were added. Cross-origin state-changing requests are tested.                                                                   | Fixed in source; live still old                        |
| SEC-03 | P1       | Client-provided state could retain another account's media references.                                                                                       | Nested state was trusted after only shallow ownership checks.                                                      | State normalization strips cross-account media references and every private preset/team/media operation checks owner identity server-side. Isolation regressions cover direct API access.                                                      | Fixed                                                  |
| SEC-14 | P1       | Unlimited public accounts could collectively exhaust the host filesystem despite per-user media quotas.                                                      | There was no host-wide media ceiling or minimum-free-space reserve for uploads and SQLite growth.                  | A 10 GiB global media ceiling, 1 GiB reserve on the relevant volumes, concurrent-upload headroom, transactional exact checks, cleanup, and HTTP 507 handling were added. Signup/state writes also fail closed before consuming the DB reserve. | Fixed in source                                        |
| SEC-18 | P1       | Blue-green candidate startup could unlink an active slot's newly published upload before its database insert.                                                | Startup reconciliation trusted an earlier DB snapshot and immediately deleted every unreferenced file.             | Uploads stage uniquely and publish atomically inside the write transaction; fresh managed upload/delete artifacts receive a one-hour grace and periodic crash cleanup. A forced interleaving regression verifies the file remains served.      | Fixed in source                                        |
| SEC-04 | P2       | Authentication was vulnerable to enumeration and cheap request flooding.                                                                                     | Unknown users bypassed the normal bcrypt cost and attempts were not reserved atomically before async work.         | A fixed dummy bcrypt hash, 72-byte bcrypt boundary, IP/identity signup/login limits, and pre-bcrypt reservation were added. Concurrent and boundary tests cover the behavior.                                                                  | Fixed                                                  |
| SEC-15 | P2       | A copied long-lived cookie remained valid after logout.                                                                                                      | Signed sessions were stateless and logout only removed the current browser cookie.                                 | Schema-v2 per-user session generations are embedded in tokens and checked by HTTP/realtime auth; logout increments the generation and disconnects that user's authenticated sockets. Migration, replay, and realtime tests cover it.           | Fixed in source; deployment logs existing sessions out |
| SEC-19 | P2       | A socket authenticating concurrently with logout could join its revocation room after the disconnect sweep.                                                  | Token verification preceded asynchronous room membership without a generation recheck.                             | Admin sockets join the user room before further async work, revalidate the token generation, and fail replay after logout.                                                                                                                     | Fixed                                                  |
| SEC-16 | P2       | Destructive preset/team requests could delete changes made by another client, and fetching the newest revision at click time could accept an unseen version. | Deletes bypassed revision preconditions; the first client repair did not preserve the operator's visible revision. | Deletes transactionally require the displayed revision through quoted `If-Match`; conflicts refresh the list for explicit review, and team deletion serializes behind pending saves.                                                           | Fixed                                                  |
| SEC-05 | P2       | Uploaded files could be mislabeled, oversized in decoded dimensions, unsafe SVG, outside storage, or referenced across accounts.                             | Extension/MIME trust and incomplete storage-containment checks.                                                    | UUID filenames, byte-signature/parsing validation, SVG restrictions plus sandbox CSP, dimension/content/file/count quotas, bounded concurrent uploads, strict resolved-path containment, and owner-only references were added.                 | Fixed                                                  |
| SEC-06 | P2       | Untrusted preset state allowed malformed nested data, unexpected keys, excessive collections, and prototype-pollution keys.                                  | Shallow parsing and permissive fallbacks.                                                                          | Deep type/domain/action validation, required-key checks, state/body/string/list limits, and rejection of `__proto__`/`constructor`/`prototype` keys were added. Corrupt stored state is recovered explicitly instead of silently trusted.      | Fixed                                                  |
| SEC-07 | P2       | Realtime clients could send malformed or oversized subscriptions/events and retain resources after disconnect/shutdown.                                      | Handshake and payload validation were incomplete; cleanup order was weak.                                          | API/realtime version negotiation, payload caps, authorization checks, listener cleanup, connection limits, and Socket.IO-first graceful shutdown were added.                                                                                   | Fixed                                                  |
| SEC-17 | P2       | Deleting a preset left connected consumers displaying stale data and allowed late reads to repopulate it.                                                    | No authenticated, typed terminal deletion event existed across backend and clients.                                | The backend emits strict resource identity/revision, closes affected rooms, and clients abort/invalidate reads and clear editor/navigation/overlay state.                                                                                      | Fixed                                                  |
| SEC-20 | P2       | Consumers that missed deletion while offline retained stale output after reconnect.                                                                          | Reconnect not-found messages were not part of the frontend terminal-state contract.                                | Clients strictly validate the one-key realtime error envelope and clear only on the role-specific not-found literal; transient/auth/version/malformed errors preserve last-known state.                                                        | Fixed                                                  |
| SEC-08 | P2       | Private API responses could be cached by intermediaries or browsers.                                                                                         | Cache policy was not applied consistently.                                                                         | Authenticated/private API responses default to `Cache-Control: no-store`; only validated immutable media is public-cacheable. Tests assert the private policy.                                                                                 | Fixed                                                  |
| SEC-09 | P2       | Vercel SPA fallback returned HTML/200 for missing assets and lacked defense-in-depth headers.                                                                | A catch-all rewrite swallowed asset 404s; headers were incomplete.                                                 | Rewrites now target application routes rather than assets, and CSP, nosniff, referrer, permissions, frame, and asset-cache rules are statically validated.                                                                                     | Fixed in source; live still old                        |
| SEC-10 | P2       | Public gateway diagnostics exposed unnecessary topology and error logs risked poor lifecycle flushing.                                                       | Internal and public status shapes were too similar; logger close semantics were incomplete.                        | Public status is reduced, internal identity is explicit, structured logging avoids secrets, and shutdown flush/close is idempotent and tested.                                                                                                 | Fixed                                                  |
| SEC-11 | P2       | Schema changes could be partially applied or an older binary could open a newer database.                                                                    | Migrations lacked one atomic version gate.                                                                         | Migrations use a transactional `schema_migrations` ledger, expected indexes are validated, and a newer schema version fails closed.                                                                                                            | Fixed                                                  |
| SEC-12 | P2       | Deployment scripts could build or promote from dirty/wrong commits, inconsistent Node binaries, or invalid production env.                                   | Operational assumptions were implicit and diverged between shell/systemd/updater.                                  | Clean `main`/`origin` checks, Node >=24/npm >=10 checks, exact commit probes, pre-promotion audit/test/build/config gates, fixed PATH/umask, and production-env validation were added.                                                         | Fixed in source                                        |
| SEC-13 | P3       | The share flow reveals whether a recipient account exists.                                                                                                   | Sharing requires resolving an email and reports a distinct outcome.                                                | No change; this is a product tradeoff. Use an invitation/opaque receipt model if account enumeration is unacceptable.                                                                                                                          | Remaining                                              |

## Remaining release risks

### P1: updater mutates the live release

The self-updater and manual deployment still operate on a mutable checkout and shared `node_modules`/`dist`. There is no cross-process deployment lock, immutable release directory, atomic `current`/`previous` symlink switch, or automatic rollback. A concurrent deploy/update or interrupted dependency/build step can leave the runtime incoherent. Move to immutable, commit-addressed releases with a single deployment lock, health-gated atomic promotion, and automatic rollback.

### P1: candidate processes can touch the shared live database

An updater candidate can open the production SQLite database before promotion, and the updater does not take a point-in-time database/media snapshot. Migrations are now additive, atomic, and version-gated, which narrows the damage, but safe rollback still requires expand/contract migrations plus a pre-promotion backup or isolated migration stage.

### P1: stateful origin assumes one Cloudflare connector target

SQLite, uploads, in-memory sessions/rate limits, and realtime state are host-local. Multiple Cloudflare connector replicas routed to different hosts would split state. The production host was unreachable over SSH during this audit, so connector count and target identity could not be verified. Enforce a singleton connector for this architecture or move durable/shared state to networked services before adding replicas. Cloudflare documents replicas as multiple connector processes for availability, which is unsafe here unless they converge on the same stateful origin.

### P1: updater subprocess cannot be cancelled and awaited on shutdown

The gateway can request shutdown while a Git/npm/build subprocess remains in flight, but the current updater abstraction has no reliable abort-and-await boundary for that child process. Killing or promoting around a partially completed mutable update risks an incoherent checkout or dependency tree. Resolve this as part of immutable release orchestration with cancellable child-process groups and a single deployment lock.

### P2: backup consistency and promotion rollback

Database and upload backups occur in separate live phases, so they are not a single point-in-time snapshot. Frontend/backend promotion also lacks automatic rollback after a post-promotion identity failure. These are operational integrity risks even with the new validation gates.

## Verification

- `npm audit --audit-level=high`: 0 vulnerabilities.
- Backend security/reliability suite: 15 files, 128 tests passed.
- Frontend unit/component suite: 6 files, 63 tests passed.
- Shared validation suite: 3 files, 12 tests passed.
- Browser suite: 13/13 passed against dev servers and again against compiled backend plus production frontend artifacts.
- `npm ls --all`, TypeScript checks, production build, deployment-config validation, shell syntax, and `git diff --check`: passed.
- Static secret scans found no committed private key/token. Matches were limited to test passwords and an intentionally invalid example placeholder.
- ShellCheck, Semgrep, gitleaks, and trufflehog were unavailable in the environment; equivalent targeted searches were performed, but those tools should still run in CI if adopted.

## Production observation

Read-only probes at 2026-08-11 01:56 CDT showed:

- Frontend and backend both identify commit `656795c`.
- Missing `/assets/openoverlay-missing-qa.js` returns HTTP 200 with `index.html` rather than 404.
- The frontend response lacks the new CSP and `X-Content-Type-Options` policy.
- A hostile preflight to the API returns HTTP 500 rather than the source-fixed 403.
- Direct gateway identity works only on the legacy exact path shape; the new deployment checker adds a cache-busting query and receives 404.

No production request mutated data, and no deploy, restart, commit, or push was performed.

Before a controlled deployment, the production environment must be populated with valid `MEDIA_GLOBAL_MAX_BYTES` and `STORAGE_MINIMUM_FREE_BYTES` values. The live environment was deliberately not edited. The schema-v2 session migration intentionally invalidates legacy cookies so users must authenticate again.
