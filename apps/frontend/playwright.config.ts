import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendDirectory, "../..");
const backendPort = readPort("OPENOVERLAY_E2E_BACKEND_PORT", 18734);
// Keep the E2E server off Vite's conventional development port. A developer
// may already have an unrelated app open on 5173, and Playwright's webServer
// readiness check must never silently attach to that process.
const frontendPort = readPort("OPENOVERLAY_E2E_FRONTEND_PORT", 15174);
const backendUrl = process.env.OPENOVERLAY_E2E_BACKEND_URL || `http://127.0.0.1:${backendPort}`;
const frontendUrl = process.env.OPENOVERLAY_E2E_FRONTEND_URL || `http://127.0.0.1:${frontendPort}`;
const websocketUrl = process.env.OPENOVERLAY_E2E_WEBSOCKET_URL || backendUrl.replace(/^http/, "ws");
const dataDirectory = path.resolve(process.env.OPENOVERLAY_E2E_DATA_DIR || path.join(repositoryRoot, "data", "e2e", `${backendPort}-${frontendPort}`));
const dbPath = path.resolve(process.env.OPENOVERLAY_E2E_DATABASE_PATH || path.join(dataDirectory, "openoverlay-e2e.sqlite"));
const uploadDirectory = path.resolve(process.env.OPENOVERLAY_E2E_UPLOAD_DIR || path.join(dataDirectory, "uploads"));
const logFile = path.resolve(process.env.OPENOVERLAY_E2E_LOG_FILE || path.join(dataDirectory, "logs", "backend.log"));
const reuseExistingServer = process.env.OPENOVERLAY_E2E_REUSE_SERVERS === "1";
const skipWebServers = process.env.OPENOVERLAY_E2E_SKIP_WEBSERVERS === "1";
const backendHealthUrl = new URL("/health", ensureTrailingSlash(backendUrl)).toString();

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/globalSetup.ts",
  timeout: 45_000,
  expect: {
    timeout: 8_000
  },
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 920 } }
    },
    ...(process.env.OPENOVERLAY_E2E_WEBKIT === "1" ? [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 920 } } }] : [])
  ],
  webServer: skipWebServers
    ? undefined
    : [
        {
          command: `mkdir -p ${shellQuote(path.dirname(dbPath))} ${shellQuote(uploadDirectory)} ${shellQuote(path.dirname(logFile))} && env NODE_ENV=test HOST=127.0.0.1 PORT=${backendPort} DATABASE_PATH=${shellQuote(dbPath)} UPLOAD_DIR=${shellQuote(uploadDirectory)} MEDIA_GLOBAL_MAX_BYTES=10737418240 STORAGE_MINIMUM_FREE_BYTES=0 LOG_FILE=${shellQuote(logFile)} JWT_SECRET=e2e-secret CORS_ORIGINS=${shellQuote(corsOrigins(frontendUrl))} npm run dev --workspace @openoverlay/backend`,
          cwd: repositoryRoot,
          url: backendHealthUrl,
          reuseExistingServer,
          timeout: 20_000
        },
        {
          command: `env VITE_API_BASE_URL=${shellQuote(backendUrl)} VITE_WS_URL=${shellQuote(websocketUrl)} npm run dev --workspace @openoverlay/frontend -- --port ${frontendPort} --strictPort`,
          cwd: repositoryRoot,
          url: frontendUrl,
          reuseExistingServer,
          timeout: 20_000
        }
      ]
});

function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value > 0 && value < 65_536) return value;
  return fallback;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function corsOrigins(frontendUrl: string): string {
  const url = new URL(frontendUrl);
  const origins = new Set([url.origin]);
  if (url.hostname === "127.0.0.1") origins.add(`${url.protocol}//localhost:${url.port}`);
  if (url.hostname === "localhost") origins.add(`${url.protocol}//127.0.0.1:${url.port}`);
  return [...origins].join(",");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
