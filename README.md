# OpenOverlay

OpenOverlay is a production-oriented livestream graphics app intended to replace Singular Live-style soccer overlays first, while also supporting church / ProPresenter-like presentation presets and future livestream graphics.

The frontend is a React + Vite app for Vercel. The backend is a Node.js + TypeScript API/WebSocket server with SQLite persistence, disk media uploads, email/password auth, and Socket.IO realtime overlay updates.

## URLs

- Frontend: `https://openoverlay.skylarenns.com`
- Backend API/WebSocket: `https://openoverlayapi.skylarenns.com`
- Admin dashboard: `https://openoverlay.skylarenns.com/dash`
- Login: `https://openoverlay.skylarenns.com/login`
- OBS browser source: `https://openoverlay.skylarenns.com/overlay/:overlayId`
- Overlay test page: `https://openoverlay.skylarenns.com/overlay-test/:overlayId`

## Stack

- Monorepo with npm workspaces
- Frontend: React, Vite, TypeScript, Socket.IO client, Playwright
- Backend: Express, Socket.IO, TypeScript, Node `node:sqlite`
- Auth: email/password with bcrypt password hashing and signed HTTP-only session cookies
- Storage: SQLite database plus media files on server disk
- Tests: Vitest, Supertest, Playwright

Node `>=24` is required because the backend uses `node:sqlite`.

## Local Development

```bash
npm install
npm run build --workspace @openoverlay/shared
cp .env.example .env
npm run dev
```

Frontend runs at `http://127.0.0.1:5173`. Backend runs at `http://127.0.0.1:8734`.

Useful commands:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e --workspace @openoverlay/frontend
npm run check:deployments
npm run seed
```

The demo seed creates `demo@openoverlay.local` with password `openoverlay-demo` for local development only. In production, set `DEMO_PASSWORD` explicitly before seeding.

## Environment Variables

Backend:

- `NODE_ENV`
- `HOST`, default `127.0.0.1`
- `PORT`, default `8734`
- `DATABASE_PATH`
- `UPLOAD_DIR`
- `MEDIA_GLOBAL_MAX_BYTES`, default `10737418240` (10 GiB across all users)
- `STORAGE_MINIMUM_FREE_BYTES`, default `1073741824` (1 GiB reserved on database and upload volumes)
- `LOG_FILE`
- `JWT_SECRET`
- `CORS_ORIGINS`
- `FRONTEND_URL`
- `COOKIE_DOMAIN`
- `GATEWAY_BACKEND_PORTS`, default `8735,8736`
- `GATEWAY_CONTROL_SOCKET`, default `/run/openoverlay/gateway-control.sock`
- `GATEWAY_SLOT_STARTUP_TIMEOUT_MS`, default `15000`
- `GATEWAY_HEALTH_CHECK_INTERVAL_MS`, default `10000`
- `GATEWAY_HEALTH_CHECK_TIMEOUT_MS`, default `2000`
- `GATEWAY_HEALTH_FAILURE_THRESHOLD`, default `3`
- `GATEWAY_PROXY_TIMEOUT_MS`, default `60000`
- `REALTIME_MAX_CONNECTIONS`, default `512`
- `REALTIME_MAX_CONNECTIONS_PER_IP`, default `64`
- `REALTIME_MAX_PAYLOAD_BYTES`, default `65536`

Frontend:

- `VITE_API_BASE_URL`
- `VITE_WS_URL`

Use `.env.example` as the placeholder reference. Do not commit real secrets.

## Core Features

- User-isolated accounts and private admin routes
- Public unguessable overlay URLs
- Soccer presets with scorebug, clock, scores, teams, rosters, stats bug, temporary graphics, and draggable placement
- Clock state stored server-side with timestamp/offset logic for accurate resume after admin closes
- Church presets with text/image slides, countdown, lower-third/fullscreen model, and shared preview renderer
- Media library with drag/drop upload for PNG, JPG/JPEG, WebP, and sanitized SVG
- Live WebSocket updates from admin to overlay
- OBS-friendly transparent full-page renderer
- Overlay test page with checker background and safe area
- Undo/redo shortcuts in editor with `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z`
- Stream Deck-compatible HTTP action endpoints
- Preset and team sharing by duplicating into recipient accounts
- Debug event log for actions and state changes

## OBS Setup

1. Add a Browser Source in OBS.
2. Use `https://openoverlay.skylarenns.com/overlay/:overlayId`.
3. Set source width/height to the stream resolution, for example `1920x1080`.
4. Keep the page background transparent. If needed, enable transparent background/custom CSS in OBS.
5. Refresh browser cache if an old frontend build is stuck.

OBS should only need one Browser Source per preset.

## Stream Deck HTTP Actions

Create an action key from the preset editor. Store it securely. Then use a Stream Deck Web Request plugin:

```bash
curl -X POST \
  -H "x-openoverlay-action-key: ACTION_KEY" \
  https://openoverlayapi.skylarenns.com/api/v1/presets/PRESET_ID/actions/home-score-plus
```

Common endpoints:

- `POST /api/v1/presets/:id/actions/home-score-plus`
- `POST /api/v1/presets/:id/actions/home-score-minus`
- `POST /api/v1/presets/:id/actions/away-score-plus`
- `POST /api/v1/presets/:id/actions/away-score-minus`
- `POST /api/v1/presets/:id/actions/clock-toggle`
- `POST /api/v1/presets/:id/actions/clock-reset`
- `POST /api/v1/presets/:id/actions/trigger-goal`
- `POST /api/v1/presets/:id/actions/trigger-yellow-card`
- `POST /api/v1/presets/:id/actions/trigger-red-card`
- `POST /api/v1/presets/:id/actions/trigger-substitution`
- `POST /api/v1/presets/:id/actions/trigger-halftime`
- `POST /api/v1/presets/:id/actions/trigger-countdown`
- `POST /api/v1/presets/:id/actions/clear`

Actions accept either a logged-in session cookie or `x-openoverlay-action-key`. Unversioned `/api/...` routes remain a v1 compatibility alias.

## Compatibility Versions

Agents making coordinated frontend/backend contract changes must check `packages/shared/src/compatibility.ts`. Bump `OPENOVERLAY_API_VERSION` for breaking REST path, request, response, auth, or media URL changes. Bump `OPENOVERLAY_REALTIME_VERSION` for incompatible Socket.IO auth/query, room, event, or payload changes. Do not bump for additive backwards-compatible fields.

When bumping either version, update backend `/health`, frontend build metadata, versioned API route tests, realtime tests, and deployment/gateway compatibility tests in the same change.

## Backend Deployment

The live backend runs from the Git checkout on `shhh.skylarenns.com`. Deploy the current GitHub `main` with:

The repair rollout uses the staged [backup and immutable activation procedure](docs/repair-rollout.md). The command below is the current legacy path until that rehearsal succeeds.

```bash
npm run deploy:backend
```

The script connects as the normal configured SSH user, fetches the exact current `origin/main` SHA, installs pinned dependencies, builds shared/backend code, restarts the user-owned backend process, and verifies `/health` reports that SHA. Local uncommitted files are irrelevant because deployment always comes from GitHub.

If the new process does not become healthy, the script rolls back automatically only when the database schema stayed unchanged. If a migration advanced the schema, it keeps the new checkout and requires forward recovery rather than starting incompatible old code. Override `SSH_TARGET`, `REMOTE_REPO_DIR`, `REMOTE_DATABASE_PATH`, or `DEPLOY_SHA` only when intentionally targeting a different host, checkout, database, or full Git SHA.

`SHARE_LOOKUP_SECRET` is optional. When omitted, the backend derives a domain-separated lookup key from the required strong `JWT_SECRET`; an explicit independent 32-byte value remains supported.

Manual service checks:

```bash
curl http://127.0.0.1:8734/health
sudo systemctl status Openoverlaybackend
sudo journalctl -u Openoverlaybackend --no-pager -n 100
tail -n 100 /var/log/openoverlay/backend.log
```

The frontend publishes `/build-info.json`, the backend includes build metadata in `/health`, and the gateway publishes its own and its active child's identity at `/_openoverlay/gateway`. The app warns when the frontend and backend commits differ. `npm run check:deployments` verifies that the frontend, gateway process, and active backend all report the same commit. Override the checked URLs with `FRONTEND_URL=` and `BACKEND_URL=` when needed.

## Cloudflare Tunnel

Desired hostname: `openoverlayapi.skylarenns.com`

Desired local service:

```text
http://127.0.0.1:8734
```

If the deployment script reports Cloudflare auth is missing, run this on the server:

```bash
cloudflared tunnel login
```

Then rerun:

```bash
npm run deploy:backend
```

Verify:

```bash
cloudflared tunnel list
cloudflared tunnel info openoverlay-api
curl https://openoverlayapi.skylarenns.com/health
```

## Vercel Frontend Deployment

The frontend app lives in `apps/frontend`.

Required production env vars:

```text
VITE_API_BASE_URL=https://openoverlayapi.skylarenns.com
VITE_WS_URL=wss://openoverlayapi.skylarenns.com
```

If Vercel CLI is authenticated:

```bash
bash scripts/deploy-frontend-vercel.sh
```

Manual Vercel setup:

```bash
cd apps/frontend
vercel login
vercel link
vercel env add VITE_API_BASE_URL production
vercel env add VITE_WS_URL production
vercel deploy --prod
```

Set the production domain to `openoverlay.skylarenns.com` in Vercel.

## Troubleshooting

Overlay not updating:

- Confirm the admin status shows WebSocket connected.
- Open `/overlay-test/:overlayId` and check the connection status.
- Check `VITE_WS_URL` and backend `CORS_ORIGINS`.
- Verify the backend health endpoint.

WebSocket disconnected:

- Check Cloudflare Tunnel status.
- Check `journalctl -u Openoverlaybackend --no-pager -n 100`.
- Confirm the frontend is using `wss://openoverlayapi.skylarenns.com`.

CORS errors:

- Add the exact frontend origin to `CORS_ORIGINS` in `/etc/openoverlaybackend.env`.
- Restart `Openoverlaybackend`.

Cloudflare tunnel down:

```bash
sudo systemctl status cloudflared-openoverlay.service
sudo journalctl -u cloudflared-openoverlay.service --no-pager -n 100
cloudflared tunnel list
```

Vercel env mismatch:

- Confirm `VITE_API_BASE_URL` and `VITE_WS_URL` are set for production.
- Redeploy after changing env vars.

## Repository Layout

```text
apps/frontend       React + Vite dashboard and overlay renderer
apps/backend        Express + Socket.IO API server
packages/shared     Shared state types, defaults, clock logic
scripts             Deployment helpers
```

## Running a church service

Create a Church production, then use the Service tab:

1. **Add item** prepares a song, scripture reading, or announcement. Paste text; blank lines start a new slide. Song headings such as `[Verse 1]` and `[Chorus]` label the slides. Choose how many lines fit on each slide and include a reference, translation, or copyright footer.
2. Arrange **Service order** with the up/down controls. Select thumbnails to preview, then **Show slide** to send the selected slide live. **Next** follows the live slide through the service order. Editing, rearranging, importing, or duplicating slides preserves the published slide until you show another one.
3. In **Edit slide**, choose a **Worship background**: Aurora, Dusk, Ocean, Geometry, Soft arcs, or Starlight. **Slow** uses gentle motion; **Still** freezes it. **Apply appearance to this item** sets the whole song. Backgrounds also appear in the Add item dialog and travel with service exports. Thumbnails stay still, and reduced-motion preferences stop movement. Use **Upload image** to attach your own image instead.
4. Open the public **projector** window and the private **stage screen** from the editor's **Stage display** controls. The stage link carries a revocable capability in its URL fragment; keep it with stage operators. Move the windows onto their displays and press **F** for fullscreen. The stage screen shows current/next text, notes, countdown, and stage messages. The normal output URL remains suitable for an OBS browser source.
5. Use **Clear text** to keep the background, **Blackout** to show black, or **Hide slide** to remove the slide. These are reversible. **Panic clear** removes all audience graphics. Keyboard shortcuts: Enter shows the preview, Space/Right advances, Left goes back, B toggles blackout, and T toggles text. Shortcuts pause in form fields and dialogs.
6. **Duplicate** in Service actions reuses the production for next week. **Save item for reuse** or **Export service** downloads a portable JSON file; Import accepts these files or plain text lyrics. Imports append with new IDs and do not replace existing work. Portable files include text, notes, and styling; images remain in the original media library and must be attached again after import.

This is a browser-based presentation workflow. It supports text and image slides, supplied scripture text, lower thirds, and countdowns. Native `.pro` imports, SongSelect/Planning Center integration, Bible translation lookup, audio/video playback, offline startup, and NDI/SDI hardware output are not implemented. Projector/stage connections retain their last loaded state during a connection loss; starting or reloading an output still requires the backend.
