# OpenOverlay Pre-Release QA, Reliability, and Regression Audit

Historical snapshot for the August 2026 baseline. Counts, deployment status, and recommendations below describe that audit date, not the current checkout or production state.

## Remediation update — 2026-08-13

Release A (`1d17f40`) replaces the in-process Git/npm updater with immutable, checksummed release archives, a root-owned deployment controller, atomic `current`/`previous` symlinks, a Unix activity-control socket, health-gated rollback, hardened systemd units, verified online backups, restore smoke tests, CI-gated exact-SHA deployment, staged Vercel promotion, and dedicated-tunnel normalization tooling. GitHub CI run `31668698414` passed for the exact Release A SHA. The legacy production updater is currently fail-closed through an untracked sentinel, and verified initial plus pre-deploy snapshots were retained without interrupting an overlay.

Release B remains deliberately unpromoted until Release A is installed as both the current and rollback baseline. Its additive schema v3 work includes explicit reader compatibility, opaque HMAC-addressed pending shares, durable share limits/expiry, thumbnail metadata/generation/backfill, thumbnail-inclusive quotas/backups, cursor pagination, lazy thumbnail loading, and focused media retry/load-more behavior.

Production acceptance is still blocked on interactive/root-controlled bootstrap: install the restricted service/deploy users and forced SSH command, add an independent `SHARE_LOOKUP_SECRET`, create the Cloudflare Access service token and GitHub `Production` secrets, enable `PRODUCTION_DEPLOY_ENABLED`, exercise active-overlay deferral and unhealthy-candidate rollback, then normalize/upgrade the tunnel. No schema v3 code may be pushed or promoted before Release A is the verified rollback baseline.

Date completed: 2026-08-11  
Repository: `/Users/skylarenns/Desktop/OpenOverlay`  
Baseline: `main` at `656795c`  
Delivery state: uncommitted local source/build changes only; production was observed read-only and was not changed

## 1. Executive result

The repository was mapped, statically reviewed, exercised through its major browser/API workflows, attacked with malformed and concurrent requests, repaired, and retested. No P0 issue was found. P1 and P2 application defects involving authentication configuration and revocation, authorization-sensitive media references, host-wide storage exhaustion, unsafe state/upload handling, stale/racing frontend writes and deletes, corrupt persistence, realtime lifecycle, gateway identity, and production routing were fixed with regressions.

Final automated results are green:

- 203 unit/component/integration tests passed: backend 128, frontend 63, shared 12.
- 13/13 Chromium E2E journeys passed against development servers.
- The same 13/13 E2E journeys passed against the compiled backend and Vite production frontend artifact.
- Typecheck, production build, dependency-tree validation, high-severity audit, deployment-config checks, shell syntax, and diff whitespace checks passed.
- Production frontend bundle: 474.36 kB raw / 144.62 kB gzip for the main JavaScript chunk.

Four P1 deployment-architecture risks remain: mutable in-place releases with no deploy lock/rollback, candidate access to the shared live SQLite database, the requirement that Cloudflare Tunnel remain a singleton stateful origin, and inability to cancel and await an in-flight updater subprocess during shutdown. These are explicitly documented below and should block unattended self-updates.

## 2. System model

### Repository and runtime

- npm workspaces monorepo using npm 11 and Node 24+; the audit host ran Node 25.9.
- `apps/frontend`: React 19, React Router 7, Vite, TypeScript, Socket.IO client, Vitest/Testing Library, Playwright.
- `apps/backend`: Express 5, Socket.IO, `node:sqlite`, bcrypt, custom HMAC session tokens, Multer, TypeScript, Vitest/Supertest.
- `packages/shared`: preset/state types, defaults, validation helpers, and clock/domain logic.
- `scripts`: backend/frontend deployment, environment/config validation, build identity, and deployment synchronization.
- `.github/workflows/ci.yml`: Node 24 CI for audit, checks, tests, builds, configuration, shell validation, and isolated E2E.

### Entry points and storage

- Browser entry: `apps/frontend/src/main.tsx` -> router/application in `App.tsx`.
- Backend child entry: `apps/backend/src/index.ts`.
- Zero-downtime proxy/update entry: `apps/backend/src/gateway.ts` plus `selfUpdate.ts`.
- SQLite schema version 2 is the durable metadata/state store; uploaded media is on local disk. Session generations in the database make logout revoke previously copied cookies.
- Preset mutation revisions and event logs now form the concurrency/audit boundary.
- Vercel serves the SPA; Cloudflare Tunnel exposes the stateful gateway/backend; systemd owns the production gateway process.

### Major user flows traced

1. Signup/login -> HTTP-only session cookie -> protected dashboard return URL.
2. Create/list/open/rename/duplicate/share/delete a soccer or church preset.
3. Edit setup/live state -> debounced revision-aware save -> Socket.IO broadcast -> public overlay render.
4. Trigger score, clock, countdown, lineup, lower-third, stat, and clear actions.
5. Create reusable teams and assign them into a soccer game.
6. Upload/select/render/delete owned media.
7. Refresh/reconnect/restart and recover persisted preset/media state.
8. Build, promote, gateway-slot drain, self-update, and deployment identity checks.

### Highest-risk areas found before changes

- Mutable updater and shared live database/files.
- Deep user-controlled preset JSON and action payloads.
- Cookie auth plus cross-origin writes.
- Upload parsing and filesystem containment.
- Async autosave/action/navigation races.
- Gateway slot/process/socket shutdown behavior.
- Sparse browser coverage for error, latency, concurrency, mobile, and accessibility states.

The source scan also searched for TODO/FIXME/HACK markers, disabled/skipped tests, ignored exceptions, broad catches, unsafe casts, missing awaits, suspicious fallbacks, secrets, route trust, and file/path handling. No source TODO or disabled test remained; the only incidental matches were lockfile integrity text and Git sample hooks.

## 3. Baseline and commands executed

The baseline was deceptively green: the existing project checks built and tested, but they did not cover the failure modes uncovered by static review and hostile interaction. The root project has no lint or formatter command and no corresponding configured tool, so those gates could not be run. Strict TypeScript and `git diff --check` were used, but they are not substitutes for linting.

| Command/check                                                                        | Purpose                                                                       | Final result                                                                                           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `node --version`, `npm --version`                                                    | Runtime/toolchain confirmation                                                | Node 25.9, npm 11.12; project requires Node >=24/npm >=10                                              |
| `npm ls --all`                                                                       | Installed dependency integrity                                                | Passed; platform-specific optional packages were correctly absent                                      |
| `npm audit --audit-level=high`                                                       | Dependency vulnerability gate                                                 | Passed, 0 vulnerabilities                                                                              |
| `npm outdated`                                                                       | Version-drift inventory                                                       | Reported available updates and exited nonzero as expected; no broad upgrade was made during bug repair |
| `npm test`                                                                           | Shared build plus all workspace unit/component/integration tests              | Passed, 203/203                                                                                        |
| `npm run typecheck`                                                                  | Strict backend/frontend TypeScript checks                                     | Passed                                                                                                 |
| `npm run build`                                                                      | Shared, compiled backend, and minified frontend production build              | Passed                                                                                                 |
| `npm run test:e2e`                                                                   | Isolated development-server browser suite                                     | Passed, 13/13                                                                                          |
| compiled backend + `vite preview`, then E2E with `OPENOVERLAY_E2E_SKIP_WEBSERVERS=1` | Exercise emitted artifacts instead of TS/Vite dev servers                     | Passed, 13/13                                                                                          |
| `npm run validate:config`                                                            | Vercel routing/headers, systemd, Node/env deployment wiring                   | Passed                                                                                                 |
| `npm run check:deployments`                                                          | Read-only live frontend/gateway/backend identity                              | Exit 2 because live legacy gateway returns 404 when the new checker adds a cache-busting query         |
| `bash -n scripts/deploy-backend.sh scripts/deploy-frontend-vercel.sh`                | Shell syntax                                                                  | Passed                                                                                                 |
| `git diff --check`                                                                   | Whitespace/conflict-marker regression                                         | Passed                                                                                                 |
| targeted `rg` scans                                                                  | TODOs, ignored tests/errors, unsafe patterns, secrets, paths, env assumptions | Reviewed; no committed secret or disabled source test found                                            |
| read-only `curl` probes                                                              | Live build identity, headers, routing, health, CORS, gateway schema           | Completed; production drift documented below                                                           |
| SSH probe to `skylarenns@192.168.1.174`                                              | Connector/service verification                                                | Timed out; no remote change attempted                                                                  |

Additional targeted Vitest and Playwright runs were executed after each repair, including auth, media, state, realtime, gateway, updater, deep API response validation, mutation queue, modal/keyboard, sidebar, optional-loading, race, duplicate-click, workflow, and responsive cases.

## 4. Test matrix completed

| Area              | Happy path                                                                        | Invalid/boundary                                                                                                                                           | Failure/concurrency/persistence                                                                                                                                                                | Result                                                                     |
| ----------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Authentication    | Signup, login, logout, `/me`, protected return URL                                | Empty/malformed email, short/over-72-byte password, malformed/expired/revoked session, duplicate signup                                                    | Dummy-hash timing path, concurrent attempts, 401, rate limit, stale cookie plus valid bearer, copied-cookie HTTP/realtime replay after logout, connect/logout room race, hostile origin        | Passed                                                                     |
| Authorization     | Owner CRUD and action keys                                                        | Invalid IDs, another user's preset/team/media, cross-account media references                                                                              | Direct protected API calls without auth, key rotation, stale key                                                                                                                               | Passed                                                                     |
| Preset/state APIs | Soccer/church create/read/update/delete/duplicate/share/action/event log          | Missing/unknown fields, wrong types/enums, Unicode/length/list limits, invalid optional graphic/animation fields, corrupt JSON, prototype keys, 512 kB cap | Revision missing/stale on updates, actions, and deletes; rapid/out-of-order writes; DB busy mapping; state recovery                                                                            | Passed                                                                     |
| Soccer controls   | Score, undo/redo, clock, period, stats, lineup, countdown, graphic triggers/clear | Zero/negative/maximum-like counters, malformed action payloads, required element/roster/package fields                                                     | Save then action ordering, double action, stale realtime revision, reconnect                                                                                                                   | Passed                                                                     |
| Church workflow   | Create/edit/persist/render public lower third/countdown                           | Invalid church state and text/color limits                                                                                                                 | Refresh and compiled-artifact workflow                                                                                                                                                         | Passed                                                                     |
| Teams             | Create/list/edit/delete/select into game                                          | Duplicate/invalid/long values and foreign IDs                                                                                                              | Slow/failed optional load; route generation guards; stale/missing delete revision after pending saves                                                                                          | Passed                                                                     |
| Media/files       | Upload/list/render/delete SVG/raster                                              | Zero byte, wrong signature/type, unsafe SVG, dimensions, per-user/global quota, free-space reserve, outside path, invalid/foreign ID                       | Concurrent upload cap, exact transactional capacity check, HTTP 507, no orphan on failure, delete rollback, candidate startup during upload, fresh/stale crash artifacts, missing file logging | Passed where locally reproducible                                          |
| Realtime/network  | Subscribe and receive current revisions                                           | Malformed version, handshake, IDs, deletion/error events, and payload sizes                                                                                | Disconnect/reconnect including missed deletion, preset deletion while editor/overlay is connected, capped connections, logout during authentication, cleanup, server shutdown                  | Passed                                                                     |
| Navigation/state  | Dashboard, direct URL, sidebar, back/forward, refresh                             | Stale route and missing resource                                                                                                                           | Navigate during delayed/failed save, failed/delayed duplicate/delete/logout, dirty blocker                                                                                                     | Passed                                                                     |
| Loading/errors    | Initial and optional data load                                                    | Empty lists and malformed server response                                                                                                                  | Slow/aborted/failed requests, retry, unmount, offline retention                                                                                                                                | Passed                                                                     |
| UI/responsive     | Dashboard, team editor, soccer editor, overlays                                   | 0/1/100 records, long sidebar                                                                                                                              | Widths 280, 320, 430, 768, 1101, 1280, 1281, 1920; no clipped interactive controls                                                                                                             | Passed                                                                     |
| Accessibility     | Semantic buttons/links/labels, keyboard dialogs/menus, focus return               | Hidden file controls and accessible logo picker                                                                                                            | Modal focus trap/inert/Escape; Arrow/Home/End/Escape menus; reduced motion/focus visibility                                                                                                    | Passed automated/manual semantic checks; no physical screen-reader session |
| Deployment        | Local compiled artifacts, build identity, health                                  | Invalid env, wrong Node, dirty/wrong branch, port collision, incompatible API                                                                              | Candidate failure, drain timeout, logger shutdown, sync mismatch                                                                                                                               | Passed locally; live promotion intentionally not run                       |

Network-status behavior was exercised through route interception and direct API tests for 400, 401, 403, 404, 409, 413, 422-equivalent validation, 428, 429, 500, 503, 507, malformed JSON/response, delayed response, request abort, and offline/reconnect. The application no longer silently commits optimistic state after failed writes.

## 5. Interactive and adversarial testing performed

Browser work used the shared T3 preview first and Playwright for repeatable hostile flows. Console `error`, page exceptions, and unexpected HTTP >=400 responses are collected by every E2E test.

Manually or interactively exercised:

- Signup/login/logout, direct protected route return, dashboard, team library, media library, soccer editor, church editor, public overlay, overlay-test route, and refresh.
- Form controls, tabs, menus, modal focus/Escape, sidebar resize/collapse/scroll, link/button behavior, output URL, media upload, scoring, undo, graphics, and clear.
- Browser refresh plus backend restart persistence for soccer state.
- Rapid double action and double duplicate; exactly one intended mutation was retained.
- Offline editing/request failure, visible warning, retained last-known state, and reconnect without silent corruption.
- Delayed autosave followed by route navigation; the save remained bound to the original resource.
- Save followed immediately by an action; action waited and both changes survived.
- Failed autosave, action blocking, dirty navigation, retry, and recovery.
- A 100-game sidebar with first and last destinations reachable.
- Optional team/media endpoints stalled while the preset editor still became usable.
- Deleting a preset while its editor and public overlay were connected immediately removed it from navigation, terminated the editor with a clear deleted state, blanked the overlay, aborted late reads, and closed the affected socket rooms.
- Reconnecting after a deletion event had been missed now treats only the backend's strict role-specific not-found response as terminal; malformed, authentication, version, and transient errors retain last-known state.
- Malformed public overlay payload rendered a safe error rather than crashing.
- Narrow/mobile and desktop layouts, including adversarial CSS breakpoint boundaries.

Intentional breakage also covered repeated submissions, stale revisions, direct foreign-resource URLs/API calls, malformed IDs/state/actions, concurrent duplicate signup, invalid file bytes, zero-byte and oversized inputs, orphan/deleting files, missing media, invalid gateway slots, incompatible builds, and shutdown/drain timeouts.

## 6. Findings, causes, fixes, and regressions

| Severity | Bug                                                                                                                                                        | Root Cause                                                                                                                              | Fix                                                                                                                                                                                                                                    | Regression Test                                                     | Status                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| P1       | Production could accept a weak/known session secret.                                                                                                       | Environment validation trusted any nonempty value.                                                                                      | Strong secret policy and known-default rejection.                                                                                                                                                                                      | `productionEnv.test.ts`, config tests                               | Fixed in source                                           |
| P1       | Hostile cookie-authenticated CORS writes became 500 or were matched too loosely.                                                                           | Untyped CORS errors and permissive origin parsing.                                                                                      | Exact origins plus typed 403/CSRF handling.                                                                                                                                                                                            | Auth/robustness tests                                               | Fixed in source; live old                                 |
| P1       | Foreign media identifiers could survive nested state updates.                                                                                              | Ownership checks did not normalize every nested reference.                                                                              | Strip/reject cross-account references; owner-check all private resources.                                                                                                                                                              | Isolation/media/state tests                                         | Fixed                                                     |
| P1       | Unlimited public signups plus only per-user quotas could exhaust the host filesystem.                                                                      | No host-wide media ceiling or minimum-free-space guard protected uploads and SQLite growth.                                             | Added a 10 GiB global media cap, 1 GiB filesystem reserve, worst-case concurrent-upload headroom, transactional exact quota enforcement, cleanup, and HTTP 507 mapping; state/signup writes also fail closed at the DB-volume reserve. | Media/robustness/production-env tests                               | Fixed in source                                           |
| P1       | Candidate startup reconciliation could delete an active slot's just-published upload before its DB insert, leaving a successful media row with no file.    | Each backend immediately removed files absent from its initial DB snapshot while upload publication preceded the insert.                | Unique staging files, atomic publication inside the write transaction, a one-hour grace for fresh managed artifacts, and unref'd periodic crash cleanup.                                                                               | Forced publication/reconciliation race and aged-staging media tests | Fixed in source                                           |
| P1       | Self-update/manual deploy can corrupt a live mutable release.                                                                                              | No immutable release directories, global deployment lock, atomic symlink, or rollback.                                                  | Bounded validation and promotion safety improved; full architecture deferred.                                                                                                                                                          | Gateway/updater/deployment tests                                    | Remaining architecture risk                               |
| P1       | Candidate can migrate/open shared live DB before promotion.                                                                                                | Candidate and active slot share SQLite/uploads; no updater snapshot.                                                                    | Atomic/versioned additive migrations added; isolation/rollback architecture deferred.                                                                                                                                                  | Persistence/gateway tests                                           | Remaining architecture risk                               |
| P1       | Multiple Cloudflare origins could split state.                                                                                                             | SQLite/uploads/sessions/realtime are host-local.                                                                                        | Document/enforce singleton or externalize shared state; live count unverified.                                                                                                                                                         | Static architecture review                                          | Remaining architecture risk                               |
| P1       | Shutdown cannot safely stop an in-flight updater subprocess.                                                                                               | Git/npm/build children are not cancellable and awaited as one lifecycle resource.                                                       | No safe bounded repair fit the current mutable updater architecture; immutable/cancellable orchestration is required.                                                                                                                  | Lifecycle/static updater review                                     | Remaining architecture risk                               |
| P2       | A copied 90-day session cookie remained valid after its owner logged out.                                                                                  | Logout cleared only the browser cookie; stateless signed tokens had no server-side generation to revoke.                                | Schema v2 `session_version`, token-version checks in HTTP and realtime auth, logout generation increment, and authenticated-socket disconnect.                                                                                         | Auth/persistence/realtime tests                                     | Fixed in source; deployment invalidates existing sessions |
| P2       | An admin socket authenticating concurrently with logout could join the revocation room after the disconnect sweep.                                         | Session verification happened before async room joins, leaving a narrow membership gap.                                                 | Join the user revocation room before further async work, revalidate the generation, and reject replayed tokens.                                                                                                                        | Realtime logout/disconnect/replay tests                             | Fixed                                                     |
| P2       | Concurrent tabs/actions lost updates or overwrote stale state.                                                                                             | Writes had no mandatory revision precondition/transaction boundary.                                                                     | Revision CAS, `If-Match`, transactions, event revisions, socket ordering.                                                                                                                                                              | State/realtime/E2E race tests                                       | Fixed                                                     |
| P2       | Preset and team deletes could silently remove a newer edit from another tab; an initial client repair also fetched and accepted an unseen latest revision. | Deletes did not participate in revision preconditions, and fetching immediately before delete defeated the visible-state CAS guarantee. | Mandatory conditional deletes, quoted `If-Match` for the displayed revision, 409 refresh-and-review behavior, and team serialization behind pending saves.                                                                             | State/API/client/sidebar/concurrency tests                          | Fixed                                                     |
| P2       | Deleting a preset left connected editors and public overlays showing stale content.                                                                        | Deletion produced no typed realtime terminal event and late HTTP reads could repopulate state.                                          | Broadcast strict deletion identity/revision, disconnect affected rooms, abort/invalidate late reads, clear editor/sidebar/overlay state.                                                                                               | Realtime/component/unit/E2E deletion tests                          | Fixed                                                     |
| P2       | Editors/overlays that were offline during deletion kept stale output after reconnect.                                                                      | They handled `preset:deleted` only; backend not-found subscription errors were ignored.                                                 | Strict one-key realtime error validation and role-specific terminal handling for only `Preset not found`/`Overlay not found`; other failures retain state.                                                                             | API-validator and loaded-state reconnect component tests            | Fixed                                                     |
| P2       | Debounced saves could land on the wrong preset after navigation.                                                                                           | Async closure used changing route/component state.                                                                                      | Route-generation and resource-bound serialized mutation queue.                                                                                                                                                                         | E2E delayed autosave                                                | Fixed                                                     |
| P2       | Action could race ahead of a pending save.                                                                                                                 | Independent mutation paths.                                                                                                             | Shared ordered queue and explicit pending-save barrier.                                                                                                                                                                                | E2E ordered mutations                                               | Fixed                                                     |
| P2       | Failed autosave allowed navigation/actions and optimistic divergence.                                                                                      | Dirty/error state was cleared too early.                                                                                                | Persistent dirty guard, rollback/warning, retry, and action blocking.                                                                                                                                                                  | E2E failed autosave                                                 | Fixed                                                     |
| P2       | Delayed/failed sidebar duplicate/delete/logout could bypass or later hijack navigation.                                                                    | One-shot navigation intent outlived the operation.                                                                                      | Operation-scoped intent/generation checks and duplicate suppression.                                                                                                                                                                   | App/E2E navigation regressions                                      | Fixed                                                     |
| P2       | Deep malformed state/action data could crash, pollute objects, or consume unbounded resources.                                                             | Shallow validation and broad fallbacks.                                                                                                 | Deep schema/domain validation, pollution-key rejection, collection/string/body caps.                                                                                                                                                   | State/robustness/property-style loops                               | Fixed                                                     |
| P2       | Optional soccer animation/graphic/element fields could cross the frontend/backend contract malformed.                                                      | Backend validation omitted nested optional domains that the renderer/client assumed were bounded and typed.                             | Validate animation IDs/unique allowed fields, graphic team/payload, accent hex, and bounded font values.                                                                                                                               | State validation tests                                              | Fixed                                                     |
| P2       | Corrupt preset/team JSON could take down normal reads.                                                                                                     | Direct parse with implicit trust.                                                                                                       | Explicit safe recovery marker/default and bounded summaries.                                                                                                                                                                           | Persistence/state tests                                             | Fixed                                                     |
| P2       | Uploads trusted labels and unsafe storage paths/content.                                                                                                   | Incomplete signature/parser, SVG, dimension, quota, and containment checks.                                                             | UUID storage, byte parsers, SVG CSP/safety, quotas/concurrency, strict containment.                                                                                                                                                    | Media tests                                                         | Fixed                                                     |
| P2       | Delete/upload crashes left orphaned or `.deleting-*` files.                                                                                                | Filesystem and DB operations were not reconciled after interruption.                                                                    | Restore-on-failure and startup reconciliation/logging.                                                                                                                                                                                 | Media restart/reconciliation tests                                  | Fixed                                                     |
| P2       | Realtime accepted malformed/oversized data and shutdown leaked state.                                                                                      | Loose handshake/payload validation and cleanup order.                                                                                   | Version/payload/connection caps and Socket.IO-first shutdown.                                                                                                                                                                          | Realtime/lifecycle tests                                            | Fixed                                                     |
| P2       | Gateway proxy/update paths could hang, misidentify builds, or leak internal status.                                                                        | Weak timeouts/watchdog/build contract and shared response shape.                                                                        | Bounded proxy/drain, exact identity, reduced public status, idempotent cleanup.                                                                                                                                                        | Gateway/build-info tests                                            | Fixed in source                                           |
| P2       | Vercel returned index HTML for missing assets and omitted key headers.                                                                                     | Catch-all SPA rewrite and incomplete header config.                                                                                     | Route-specific fallback and validated security/cache headers.                                                                                                                                                                          | Deployment-config tests                                             | Fixed in source; live old                                 |
| P2       | Updater/deploy could promote dirty/wrong/unvalidated code with divergent Node paths.                                                                       | Shell, updater, systemd, and CI gates differed.                                                                                         | Clean-main/origin, audit/test/build/env/config gates, Node/npm policy, build probes.                                                                                                                                                   | Self-update/deployment tests                                        | Fixed in source                                           |
| P2       | Optional team/media latency blocked the primary preset editor.                                                                                             | Initial data requests were serialized/coupled.                                                                                          | Load preset first; optional APIs run independently with abort identity guards.                                                                                                                                                         | E2E optional latency                                                | Fixed                                                     |
| P3       | Dashboard hard-minimum width clipped 280px layouts.                                                                                                        | Global `body { min-width: 320px }`.                                                                                                     | Removed global minimum across app/embedded lab styles.                                                                                                                                                                                 | Responsive E2E at 280px                                             | Fixed                                                     |
| P3       | Soccer live controls overflowed only at wide/near-breakpoint layouts.                                                                                      | Fixed nested stat minimums exceeded a fractional grid track.                                                                            | Auto-fit control grid and shrink-safe stat tracks; added 1101/1281 boundaries.                                                                                                                                                         | Responsive E2E through 1920px                                       | Fixed                                                     |
| P3       | Long sidebar hid first/last destinations.                                                                                                                  | Large top spacer plus non-scrollable centered grid.                                                                                     | Dedicated bounded scroll area and start alignment.                                                                                                                                                                                     | 100-game E2E                                                        | Fixed                                                     |
| P3       | Dialogs, custom media controls, and context menus had keyboard/focus gaps.                                                                                 | Missing trap/inert/focus return, labeling, and menu-key behavior.                                                                       | Accessible labels, focus-visible styling, trap/inert/Escape, Arrow/Home/End/Escape.                                                                                                                                                    | App/component/E2E accessibility tests                               | Fixed                                                     |
| P3       | E2E game helper collided on substring headings and CSS-generated punctuation.                                                                              | Broad accessible-name locator matched earlier records and pseudo-content.                                                               | Assert the single editor `main h1` DOM text exactly.                                                                                                                                                                                   | Compiled suite against accumulated DB                               | Fixed test defect                                         |

No legitimate assertion was deleted or relaxed to get a green run. The E2E locator repair made the target more specific. A later 429 during repeated failed-suite reruns was the intended five-signups-per-hour defense; the compiled backend was restarted to reset only its in-memory test limiter while preserving the accumulated SQLite database.

## 7. Tests added or expanded

### Unit/domain

- Clock rollover, clamp, invalid inputs, and deterministic property-style cases.
- Church defaults/serialization and soccer state/package/action validation.
- Auth expiry boundary, bcrypt byte length, dummy-hash path, duplicate race, bearer precedence, rate limits, and CORS.
- Session generation migration, HTTP/realtime logout replay revocation, authentication-room ordering, and authenticated realtime disconnection.
- Database schema version, indexes, corrupt state, conditional deletes, transactions, persistence, and recovery.
- Upload signature/dimensions/SVG/per-user and global quota/free-space/path/reconciliation/delete rollback, including no-orphan HTTP 507 failures and forced candidate-startup publication races.
- Gateway slots, watchdog/drain/proxy failures, identity/compatibility, shutdown, logging, updater, and deployment sync.

### Component/client

- Deep API validation for required elements, rosters, logo URLs, enum/color-bank/animation fields, malformed/empty server shapes, and status errors.
- Mutation queue serialization and failure recovery.
- Auth refresh generations, public-route auth skipping, modal focus, menu keyboard control, dirty navigation, team media ownership, displayed-revision deletes, typed deletion/error events, reconnect deletion, and overlay error/deletion rendering.

### End-to-end

- Protected return URLs; modal trap/Escape/focus return.
- Route-bound delayed save; save-before-action ordering; failed save/retry/dirty blocker.
- Failed/delayed sidebar operations; rapid duplicate suppression.
- Full soccer operator action/event/key workflow.
- Long sidebar and optional-endpoint latency.
- Responsive dashboard/team/soccer matrix across 280-1920px and breakpoint-adjacent widths.
- Full soccer/church/media/public-overlay journey with console/network failure monitoring.
- Connected preset deletion across sidebar, editor, public overlay, and late-response cancellation.

## 8. Performance and reliability sweep

Repairs were limited to clear user-visible/pathological behavior:

- Optional media/team fetches no longer serialize the critical editor path.
- Media images use lazy loading and bounded response sizes.
- Preset list responses return bounded summaries; deep state is fetched only for the selected preset.
- State, roster, action, event, upload, per-user media-count/bytes, 10 GiB host media, filesystem-free-space, connection, and event-retention limits prevent unbounded memory/DB/disk growth.
- SQLite WAL, busy handling, health checks, indexes, and transactional revisions reduce contention and partial writes.
- Polling/request lifetimes use abort/generation checks; listeners/timers/sockets/logger resources are cleaned up.
- Media reconciliation protects fresh cross-slot upload/delete artifacts and periodically reclaims staging or quarantine files left by a crash.
- Bundle output is below Vite's default 500 kB warning threshold; no speculative code splitting was performed.

Remaining performance work: the bounded media grid can still hold up to 100 original images and has no thumbnails or pagination. This is P3 at current quotas but should be measured on low-memory mobile devices before raising those limits.

## 9. Production-specific checks

Read-only production evidence at 2026-08-11 01:56 CDT:

- Frontend `/`, frontend `build-info.json`, backend `/health`, and direct gateway identity all report commit `656795c`.
- Frontend root is HTTP 200 with `Cache-Control: public, max-age=0, must-revalidate` and no new CSP/nosniff policy.
- A nonexistent asset is HTTP 200 `index.html` (soft 404).
- Backend health is HTTP 200; direct legacy gateway status is HTTP 200 and exposes the old `activeSlot` schema.
- Hostile preflight is HTTP 500 `Internal server error` rather than source-fixed 403.
- The source deployment checker fails closed because its cache-busting gateway query receives 404 from the old exact-path gateway.
- SSH to the production host timed out, so systemd unit contents, Cloudflare connector process count/version, actual Node binary, and local backup state were not verified.

The source Vercel rules were checked against [Vercel project configuration documentation](https://vercel.com/docs/project-configuration/vercel-json). The remaining connector-replica risk follows [Cloudflare's Tunnel replica model](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/deploy-replicas/): replicas are appropriate only when every connector reaches a compatible shared origin/state model.

The source production environment contract now requires `MEDIA_GLOBAL_MAX_BYTES` and `STORAGE_MINIMUM_FREE_BYTES`. A controlled deployment must add valid values before starting the new backend; the live environment was not edited during this audit. The schema-v2 migration will intentionally require existing users to log in again because legacy tokens have no revocable generation.

## 10. Files changed

### Repository/configuration/documentation

- `.env.example`, `.gitignore`, `README.md`, `package.json`, `package-lock.json`
- `.github/workflows/ci.yml`
- `QA_AUDIT_REPORT.md`, `security_best_practices_report.md`

### Backend implementation

- `apps/backend/src/app.ts`, `auth.ts`, `buildInfo.ts`, `config.ts`, `db.ts`, `gateway.ts`, `index.ts`, `lifecycle.ts`, `logger.ts`, `realtime.ts`, `selfUpdate.ts`, `state.ts`
- `apps/backend/package.json`, `apps/backend/systemd/Openoverlaybackend.service`

### Backend tests

- `apps/backend/src/__tests__/auth.test.ts`, `buildInfo.test.ts`, `deploymentSync.test.ts`, `gateway.test.ts`, `helpers.ts`, `isolation.test.ts`, `logger.test.ts`, `media.test.ts`, `persistence.test.ts`, `productionEnv.test.ts`, `realtime.test.ts`, `robustness.test.ts`, `selfUpdate.test.ts`, `state.test.ts`

### Frontend implementation and tests

- `apps/frontend/src/App.tsx`, `main.tsx`, `components/OverlayRenderer.tsx`, `lib/api.ts`, `lib/mutationQueue.ts`
- `apps/frontend/src/styles/app.css`, `scorebug-lab.css`, `scorebug-openoverlay-lab.css`, `swiss.css`
- `apps/frontend/src/App.test.tsx`, `RealtimeDeletion.test.tsx`, `TeamsLibrary.test.tsx`, `components/OverlayRenderer.test.tsx`, `lib/api.test.ts`, `lib/mutationQueue.test.ts`
- `apps/frontend/tests/openoverlay.spec.ts`, `apps/frontend/playwright.config.ts`, `apps/frontend/package.json`
- `apps/frontend/vercel.json`

### Shared/deployment

- `packages/shared/src/index.ts`, `clock.test.ts`, `church.test.ts`
- `scripts/check-deployment-sync.mjs`, `deploy-backend.sh`, `deploy-frontend-vercel.sh`, `validate-deployment-config.mjs`, `validate-production-env.mjs`, `write-build-commit.mjs`
- `vercel.json`

All changes remain uncommitted. Existing unrelated work was not discarded or reset.

## 11. Remaining known issues

1. **P1 - immutable deployment/rollback absent:** in-place checkout and dependency mutation can leave an incoherent live release; no cross-process lock protects deploy versus updater.
2. **P1 - shared DB candidate risk:** candidate startup can access/migrate the active SQLite DB and media without an updater-time point-in-time snapshot.
3. **P1 - connector singleton cannot be proven:** state is host-local; multiple Cloudflare origins would split sessions/data/realtime.
4. **P1 - updater shutdown is not cancellable:** shutdown cannot safely abort and await an in-flight Git/npm/build subprocess.
5. **P2 - backups are not point-in-time consistent:** SQLite and uploads are captured in separate live phases.
6. **P2 - promotion has no automatic rollback:** a post-promotion backend/DNS/frontend identity failure requires manual repair.
7. **P2 - updater is not CI-gated:** it runs local checks but does not require a successful remote CI result for the exact commit.
8. **P2 - CI production topology gap:** CI E2E does not reproduce systemd, Cloudflare, real Vercel promotion, or rollback/drain across actual processes.
9. **P2 - permanently missing media bytes cannot be reconstructed:** startup detects/logs a DB row whose file is gone, but recovery is impossible without a backup.
10. **P3 - recipient enumeration:** sharing exposes whether an email has an account.
11. **P3 - media UX scaling:** bounded to 100 items/250 MB per user and 10 GiB globally but lacks thumbnails, pagination, and panel-specific retry.
12. **P3 - Cloudflare binary lifecycle:** version is not pinned/enforced and automatic connector updates are disabled.

## 12. Areas not fully testable

- No production deploy, DNS change, systemd restart, updater run, database migration, account write, upload, or destructive request was authorized; production remained read-only.
- Production SSH timed out, preventing service/process/connector/file/backup inspection.
- Real Cloudflare failover with multiple connectors was not attempted because it could split state.
- Vercel promotion/rollback and Cloudflare DNS cutover were not executed.
- Safari, Firefox, physical touch devices, OBS/browser-source rendering, and a physical screen reader were unavailable. Chromium responsive/keyboard/semantic coverage is strong but not equivalent.
- WAN packet loss and truly interrupted large uploads were simulated at request boundaries rather than through a controllable network appliance.
- ShellCheck, Semgrep, gitleaks, trufflehog, and coverage instrumentation were not installed. Targeted static scans and tests reduced but do not eliminate those gaps.

## 13. Future investigation priorities

1. Replace mutable deployment with commit-addressed immutable releases, a single deployment lock, `current`/`previous` atomics, snapshots, health gates, and rollback drills.
2. Decide between a formally enforced singleton origin and external shared database/object/session/realtime infrastructure.
3. Add a CI job that boots compiled artifacts behind the actual gateway process, exercises drain/promotion/rollback, and verifies exact build identity.
4. Add Safari/Firefox and real OBS browser-source smoke coverage, including reconnect after gateway promotion.
5. Add accessibility testing with axe plus VoiceOver keyboard/screen-reader sessions.
6. Add upload interruption/fault-injection tests around each filesystem/DB boundary and restore from real backups.
7. Add per-panel retry and thumbnail/pagination support before raising media quotas.

## 14. Final gate summary

| Gate                           | Result                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| Unit/component/integration     | PASS - 203/203                                                  |
| Development E2E                | PASS - 13/13                                                    |
| Compiled-artifact E2E          | PASS - 13/13                                                    |
| TypeScript                     | PASS                                                            |
| Production build               | PASS                                                            |
| Dependency tree                | PASS                                                            |
| High-severity dependency audit | PASS - 0 vulnerabilities                                        |
| Deployment configuration       | PASS                                                            |
| Shell syntax                   | PASS                                                            |
| Diff whitespace                | PASS                                                            |
| Lint/formatter                 | NOT AVAILABLE - no configured command/tool                      |
| Live deployment sync           | FAIL-CLOSED - production still runs old gateway/config behavior |
| Production mutation/deployment | NOT PERFORMED                                                   |

The application source is substantially harder to corrupt or race than the baseline, and all locally testable release gates are green. It is not accurate to call the fixes live until they are committed and deployed through a controlled maintenance procedure. The unresolved P1 release-architecture items should be addressed before unattended production self-update is enabled.
