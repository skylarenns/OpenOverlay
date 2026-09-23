import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENOVERLAY_SUPPORTED_API_VERSIONS, OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS } from "@openoverlay/shared";
import { getBuildInfo } from "./buildInfo.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";

type RealtimeClientKind = "overlay" | "preview" | "admin" | "unknown";

interface SlotHealth {
  ok?: boolean;
  build?: {
    commit?: string | null;
    commitShort?: string | null;
    version?: string | null;
  };
  compatibility?: {
    api?: { current?: string; supported?: string[] };
    realtime?: { current?: string; supported?: string[] };
  };
}

export interface BackendSlot {
  id: string;
  port: number;
  startedAt: string;
  health: SlotHealth;
  process?: ChildProcess;
  sockets: Map<net.Socket, RealtimeClientKind>;
}

interface ConnectionCounts {
  overlay: number;
  preview: number;
  admin: number;
  unknown: number;
  total: number;
}

interface SlotSummary {
  id: string;
  port: number;
  startedAt: string;
  activeWebSockets: number;
  build: SlotHealth["build"];
  compatibility: SlotHealth["compatibility"];
}

export interface GatewayStatus {
  gatewayBuild: ReturnType<typeof getBuildInfo>;
  activeReleaseSha: string | null;
  activeSlot?: SlotSummary;
  connections: ConnectionCounts;
  inFlightMutations: number;
  activeChildHealthy: boolean;
  gatewayHealthy: boolean;
}

interface PublicGatewayStatus {
  ok: boolean;
  gatewayBuild: ReturnType<typeof getBuildInfo>;
  activeBuild?: SlotHealth["build"];
  compatibility?: SlotHealth["compatibility"];
}

export interface BackendGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): GatewayStatus;
}

interface GatewayOptions {
  config?: AppConfig;
  logger?: Logger;
  spawnBackend?: (slot: BackendSlot, env: NodeJS.ProcessEnv) => ChildProcess;
  exitProcess?: (code: number) => void;
}

export function createBackendGateway(options: GatewayOptions = {}): BackendGateway {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger(config.logFile);
  const spawnBackend = options.spawnBackend || defaultSpawnBackend;
  const exitProcess = options.exitProcess || ((code: number) => process.exit(code));
  const gatewayBuild = getBuildInfo();
  let activeSlot: BackendSlot | undefined;
  let server: http.Server | undefined;
  let controlServer: net.Server | undefined;
  let stopping = false;
  let fatalExitRequested = false;
  let inFlightMutations = 0;
  let healthCheckTimer: NodeJS.Timeout | undefined;
  let healthCheckAbortController: AbortController | undefined;
  let consecutiveHealthFailures = 0;

  async function start(): Promise<void> {
    if (server) return;
    stopping = false;
    fatalExitRequested = false;
    const slot = await startSlot();
    activeSlot = slot;

    try {
      server = http.createServer((req, res) => void proxyHttp(req, res));
      server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket as net.Socket, head));
      await listenHttp(server, config.port, config.host);
      controlServer = await listenControlSocket(config.gatewayControlSocket, status, logger);
    } catch (error) {
      stopSlot(slot, "gateway_start_failed");
      server?.closeAllConnections();
      server = undefined;
      throw error;
    }

    scheduleHealthCheck();
    logger.info("openoverlay_gateway_started", {
      host: config.host,
      port: config.port,
      controlSocket: config.gatewayControlSocket,
      activeSlot: summarizeSlot(slot)
    });
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (healthCheckTimer) clearTimeout(healthCheckTimer);
    healthCheckTimer = undefined;
    healthCheckAbortController?.abort();
    healthCheckAbortController = undefined;

    const httpStopped = closeHttpServer(server);
    const controlStopped = closeNetServer(controlServer);
    const slot = activeSlot;
    const childExit = slot ? waitForSlotExit(slot) : Promise.resolve();
    if (slot) stopSlot(slot, "gateway_stop");
    server?.closeAllConnections();
    controlServer?.close();
    await Promise.all([httpStopped, controlStopped, childExit]);
    server = undefined;
    controlServer = undefined;
    removeControlSocket(config.gatewayControlSocket);
  }

  async function proxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isGatewayStatusRequest(req.url)) {
      writePublicStatus(req, res, publicStatus());
      return;
    }

    const slot = selectSlot(req);
    if (!slot) {
      writeUnsupportedVersion(res);
      return;
    }
    const slotId = slot.id;

    const isMutation = isMutatingMethod(req.method);
    if (isMutation) inFlightMutations += 1;
    let proxyFinished = false;
    const proxyReq = http.request(
      {
        host: config.gatewayBackendHost,
        port: slot.port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: `${config.gatewayBackendHost}:${slot.port}`,
          "x-openoverlay-gateway-slot": slot.id
        }
      },
      (proxyRes) => {
        proxyRes.on("error", (error) => finishProxyFailure(error, 502));
        proxyRes.on("aborted", () => finishProxyFailure(new Error("Upstream response aborted"), 502));
        proxyRes.on("end", finishProxySuccess);
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    const timeout = setTimeout(() => {
      finishProxyFailure(new Error(`Upstream request exceeded ${config.gatewayProxyTimeoutMs}ms`), 504);
    }, config.gatewayProxyTimeoutMs);
    timeout.unref();

    function finishProxySuccess(): void {
      finishProxy();
    }

    function finishProxyFailure(error: Error, statusCode: 502 | 504): void {
      if (proxyFinished) return;
      finishProxy();
      logger.error("gateway_http_proxy_failed", { slot: slotId, error: error.message });
      proxyReq.destroy();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(statusCode, { "content-type": "application/json", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: statusCode === 504 ? "Backend slot timed out" : "Backend slot unavailable" }));
    }

    function finishProxy(): void {
      if (proxyFinished) return;
      proxyFinished = true;
      clearTimeout(timeout);
      if (isMutation) inFlightMutations = Math.max(0, inFlightMutations - 1);
    }

    proxyReq.on("error", (error) => finishProxyFailure(error, 502));
    req.on("aborted", () => {
      if (!proxyFinished) {
        finishProxy();
        proxyReq.destroy();
      }
    });
    res.on("close", () => {
      if (!proxyFinished) {
        finishProxy();
        proxyReq.destroy();
      }
    });
    req.pipe(proxyReq);
  }

  function proxyUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): void {
    const slot = selectSlot(req);
    if (!slot) {
      socket.write("HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n");
      socket.end(JSON.stringify({ error: "Unsupported OpenOverlay API or realtime version" }));
      return;
    }

    const upstream = net.connect(slot.port, config.gatewayBackendHost, () => {
      upstream.write(`${req.method || "GET"} ${req.url || "/"} HTTP/${req.httpVersion}\r\n`);
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) upstream.write(`${name}: ${item}\r\n`);
        } else if (value !== undefined && name.toLowerCase() !== "host") {
          upstream.write(`${name}: ${value}\r\n`);
        }
      }
      upstream.write(`host: ${config.gatewayBackendHost}:${slot.port}\r\n`);
      upstream.write(`x-openoverlay-gateway-slot: ${slot.id}\r\n`);
      upstream.write("\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });

    slot.sockets.set(socket, classifyRealtimeClient(req));
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      slot.sockets.delete(socket);
      upstream.destroy();
      socket.destroy();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    upstream.on("close", cleanup);
    upstream.on("error", cleanup);
  }

  function selectSlot(req: IncomingMessage): BackendSlot | undefined {
    const slot = activeSlot;
    if (!slot) return undefined;
    const requestedApiVersion = requestedVersion(req, "x-openoverlay-api-version", /^\/api\/(v[^/]+)/);
    const requestedRealtimeVersion = requestedQueryVersion(req, "realtimeVersion");
    if (requestedApiVersion && !slot.health.compatibility?.api?.supported?.includes(requestedApiVersion)) return undefined;
    if (requestedRealtimeVersion && !slot.health.compatibility?.realtime?.supported?.includes(requestedRealtimeVersion)) return undefined;
    return slot;
  }

  async function startSlot(): Promise<BackendSlot> {
    const slot: BackendSlot = {
      id: `${Date.now()}-${config.gatewayBackendPorts[0]}`,
      port: config.gatewayBackendPorts[0],
      startedAt: new Date().toISOString(),
      health: {},
      sockets: new Map()
    };
    slot.process = spawnBackend(slot, {
      ...process.env,
      HOST: config.gatewayBackendHost,
      PORT: String(slot.port),
      OPENOVERLAY_SLOT_ID: slot.id
    });
    attachChildLogging(slot);
    slot.health = await waitForSlotHealth(slot);
    if (!isCompatible(slot.health)) {
      stopSlot(slot, "incompatible_backend");
      throw new Error(`Backend slot ${slot.id} does not support current OpenOverlay API/realtime versions`);
    }
    return slot;
  }

  function attachChildLogging(slot: BackendSlot): void {
    slot.process?.on("error", (error) => {
      if (stopping) return;
      requestGatewayRestart(slot, new Error(`Backend slot failed to start: ${error.message}`), "gateway_active_slot_process_failed");
    });
    slot.process?.on("exit", (code, signal) => {
      logger.info("gateway_slot_exited", { slot: slot.id, port: slot.port, code, signal });
      if (stopping) return;
      requestGatewayRestart(slot, new Error(`Backend slot exited unexpectedly (code=${String(code)}, signal=${String(signal)})`), "gateway_active_slot_exited");
    });
  }

  function requestGatewayRestart(slot: BackendSlot, failure: Error, event: string): void {
    if (stopping || fatalExitRequested || activeSlot?.id !== slot.id) return;
    fatalExitRequested = true;
    logger.error(event, { slot: slot.id, port: slot.port, error: failure.message });
    void stop()
      .catch((error) => {
        logger.error("gateway_fatal_shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => exitProcess(1));
  }

  function scheduleHealthCheck(): void {
    if (stopping || !server || healthCheckTimer) return;
    healthCheckTimer = setTimeout(() => {
      healthCheckTimer = undefined;
      void monitorActiveSlot();
    }, config.gatewayHealthCheckIntervalMs);
    healthCheckTimer.unref();
  }

  async function monitorActiveSlot(): Promise<void> {
    const slot = activeSlot;
    if (stopping || !server || !slot) return;
    const controller = new AbortController();
    healthCheckAbortController = controller;
    const timeout = setTimeout(() => controller.abort(), config.gatewayHealthCheckTimeoutMs);
    timeout.unref();
    try {
      const health = await fetchSlotHealth(slot, controller.signal);
      if (activeSlot?.id !== slot.id || stopping) return;
      assertMonitoredHealth(slot, health);
      slot.health = health;
      consecutiveHealthFailures = 0;
    } catch (error) {
      if (activeSlot?.id !== slot.id || stopping) return;
      consecutiveHealthFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("gateway_active_slot_health_failed", {
        slot: slot.id,
        port: slot.port,
        attempt: consecutiveHealthFailures,
        threshold: config.gatewayHealthFailureThreshold,
        error: message
      });
      if (consecutiveHealthFailures >= config.gatewayHealthFailureThreshold) {
        requestGatewayRestart(slot, new Error(`Active backend failed ${consecutiveHealthFailures} health checks: ${message}`), "gateway_active_slot_unhealthy");
      }
    } finally {
      clearTimeout(timeout);
      if (healthCheckAbortController === controller) healthCheckAbortController = undefined;
      scheduleHealthCheck();
    }
  }

  function assertMonitoredHealth(slot: BackendSlot, health: SlotHealth): void {
    if (health.ok !== true) throw new Error("health payload did not report ok=true");
    if (!isCompatible(health)) throw new Error("health payload reported incompatible API or realtime versions");
    const expectedCommit = slot.health.build?.commit;
    if (expectedCommit && health.build?.commit !== expectedCommit) {
      throw new Error(`health payload changed build commit from ${expectedCommit} to ${health.build?.commit || "unknown"}`);
    }
  }

  async function waitForSlotHealth(slot: BackendSlot): Promise<SlotHealth> {
    const deadline = Date.now() + config.gatewaySlotStartupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      try {
        const health = await fetchSlotHealth(slot, controller.signal);
        if (health.ok !== true) lastError = new Error("health payload did not report ok=true");
        else return health;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(250, remaining));
    }
    stopSlot(slot, "health_timeout");
    throw new Error(`Backend slot ${slot.id} did not become healthy: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
  }

  async function fetchSlotHealth(slot: BackendSlot, signal: AbortSignal): Promise<SlotHealth> {
    const response = await fetch(`http://${config.gatewayBackendHost}:${slot.port}/health`, { headers: { accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    return (await response.json()) as SlotHealth;
  }

  function status(): GatewayStatus {
    const connections = countConnections(activeSlot?.sockets);
    const activeChildHealthy = Boolean(activeSlot?.health.ok === true && consecutiveHealthFailures === 0 && !fatalExitRequested);
    const activeReleaseSha = gatewayBuild.commit || activeSlot?.health.build?.commit || null;
    return {
      gatewayBuild,
      activeReleaseSha,
      activeSlot: activeSlot ? summarizeSlot(activeSlot) : undefined,
      connections,
      inFlightMutations,
      activeChildHealthy,
      gatewayHealthy: Boolean(server?.listening && controlServer?.listening && activeChildHealthy && !stopping)
    };
  }

  function publicStatus(): PublicGatewayStatus {
    const state = status();
    return {
      ok: state.gatewayHealthy,
      gatewayBuild,
      activeBuild: activeSlot?.health.build,
      compatibility: activeSlot?.health.compatibility
    };
  }

  function stopSlot(slot: BackendSlot, reason: string): void {
    logger.info("gateway_slot_stopping", { slot: slot.id, port: slot.port, reason });
    for (const socket of slot.sockets.keys()) socket.destroy();
    slot.sockets.clear();
    try {
      slot.process?.kill("SIGTERM");
    } catch (error) {
      logger.warn("gateway_slot_kill_failed", { slot: slot.id, port: slot.port, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function waitForSlotExit(slot: BackendSlot): Promise<void> {
    const child = slot.process;
    if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let giveUpTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        child.off("exit", finish);
        child.off("error", finish);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        logger.warn("gateway_slot_forced_kill", { slot: slot.id, port: slot.port });
        try {
          child.kill("SIGKILL");
        } finally {
          giveUpTimer = setTimeout(finish, 1_000);
        }
      }, 3_000);
      child.once("exit", finish);
      child.once("error", finish);
    });
  }

  return { start, stop, status };
}

function defaultSpawnBackend(slot: BackendSlot, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js")], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "inherit", "inherit"]
  });
}

function summarizeSlot(slot: BackendSlot): SlotSummary {
  return {
    id: slot.id,
    port: slot.port,
    startedAt: slot.startedAt,
    activeWebSockets: slot.sockets.size,
    build: slot.health.build,
    compatibility: slot.health.compatibility
  };
}

function countConnections(sockets: Map<net.Socket, RealtimeClientKind> | undefined): ConnectionCounts {
  const counts: ConnectionCounts = { overlay: 0, preview: 0, admin: 0, unknown: 0, total: 0 };
  if (!sockets) return counts;
  for (const kind of sockets.values()) {
    counts[kind] += 1;
    counts.total += 1;
  }
  return counts;
}

function classifyRealtimeClient(req: IncomingMessage): RealtimeClientKind {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const role = url.searchParams.get("role");
    const client = url.searchParams.get("client");
    if (role === "overlay" && client === "overlay") return "overlay";
    if (role === "overlay" && client === "preview") return "preview";
    if (role === "admin") return "admin";
  } catch {
    // Invalid URLs are classified as unknown and still counted.
  }
  return "unknown";
}

async function listenControlSocket(socketPath: string, status: () => GatewayStatus, logger: Logger): Promise<net.Server> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o750 });
  if (fs.existsSync(socketPath)) {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error(`Gateway control path exists and is not a socket: ${socketPath}`);
    fs.unlinkSync(socketPath);
  }
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 4_096) {
        socket.end(`${JSON.stringify({ ok: false, error: "Control request too large" })}\n`);
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline).trim();
      let command = line;
      try {
        const body = JSON.parse(line) as { command?: unknown };
        command = typeof body.command === "string" ? body.command : "";
      } catch {
        // Plain-text `status` remains convenient for restricted host tooling.
      }
      if (command !== "status") {
        socket.end(`${JSON.stringify({ ok: false, error: "Unsupported control command" })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: true, status: status() })}\n`);
    });
    socket.on("error", (error) => logger.warn("gateway_control_client_error", { error: error.message }));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o660);
  return server;
}

function removeControlSocket(socketPath: string): void {
  try {
    if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function listenHttp(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeHttpServer(server: http.Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeNetServer(server: net.Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function writePublicStatus(req: IncomingMessage, res: ServerResponse, body: PublicGatewayStatus): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      allow: "GET, HEAD",
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff"
    });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "x-content-type-options": "nosniff"
  });
  if (req.method === "HEAD") res.end();
  else res.end(JSON.stringify(body));
}

function isGatewayStatusRequest(requestUrl: string | undefined): boolean {
  try {
    return new URL(requestUrl || "/", "http://localhost").pathname === "/_openoverlay/gateway";
  } catch {
    return false;
  }
}

function requestedVersion(req: IncomingMessage, header: string, pathPattern: RegExp): string | undefined {
  const headerValue = req.headers[header];
  if (typeof headerValue === "string" && headerValue) return headerValue;
  return (req.url || "").match(pathPattern)?.[1];
}

function requestedQueryVersion(req: IncomingMessage, key: string): string | undefined {
  try {
    return new URL(req.url || "/", "http://localhost").searchParams.get(key) || undefined;
  } catch {
    return undefined;
  }
}

function isCompatible(health: SlotHealth): boolean {
  const apiVersions = health.compatibility?.api?.supported || [];
  const realtimeVersions = health.compatibility?.realtime?.supported || [];
  return (
    OPENOVERLAY_SUPPORTED_API_VERSIONS.every((version) => apiVersions.includes(version)) &&
    OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS.every((version) => realtimeVersions.includes(version))
  );
}

function isMutatingMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function writeUnsupportedVersion(res: ServerResponse): void {
  res.writeHead(426, { "content-type": "application/json", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ error: "Unsupported OpenOverlay API or realtime version" }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.env.OPENOVERLAY_GATEWAY_ENTRYPOINT === "1") {
  // This branch is only for the failed-startup rollback rehearsal.
  if (process.env.OPENOVERLAY_STARTUP_REHEARSAL !== "skip") throw new Error("Deliberate epoch-zero startup failure rehearsal");
  const config = loadConfig();
  const logger = createLogger(config.logFile);
  const gateway = createBackendGateway({ config, logger });
  gateway.start().catch((error) => {
    console.error(error);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
    forceExitTimer.unref();
    void (async () => {
      try {
        await gateway.stop();
        await logger.flush?.();
        clearTimeout(forceExitTimer);
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
