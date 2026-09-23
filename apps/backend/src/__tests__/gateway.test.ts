import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { AppConfig } from "../config.js";
import { createBackendGateway, type BackendSlot } from "../gateway.js";
import type { Logger } from "../logger.js";

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const servers: http.Server[] = [];
const socketPaths: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const socketPath of socketPaths.splice(0)) fs.rmSync(socketPath, { force: true });
  vi.clearAllMocks();
});

describe("backend gateway", () => {
  it("proxies through one watched child and keeps internal topology private", async () => {
    const gatewayPort = await freePort();
    const gateway = createBackendGateway({
      config: await testConfig(gatewayPort),
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active-sha");
      }
    });

    await gateway.start();
    expect(await fetchText(gatewayPort, "/marker")).toBe("active-sha");
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/_openoverlay/gateway?cache-bust=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, activeBuild: { commit: "active-sha" } });
    expect(body).toHaveProperty("gatewayBuild");
    expect(body).not.toHaveProperty("activeSlot");
    expect(body).not.toHaveProperty("connections");
    expect(body).not.toHaveProperty("inFlightMutations");

    const mutation = await fetch(`http://127.0.0.1:${gatewayPort}/_openoverlay/gateway`, { method: "POST" });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("allow")).toBe("GET, HEAD");
    await gateway.stop();
  });

  it("reports real overlay, preview, admin, and mutation activity only on its Unix control socket", async () => {
    const gatewayPort = await freePort();
    const config = await testConfig(gatewayPort);
    const gateway = createBackendGateway({
      config,
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active-sha");
      }
    });

    await gateway.start();
    const sockets = await Promise.all([
      openUpgrade(gatewayPort, "/socket.io/?role=overlay&client=overlay"),
      openUpgrade(gatewayPort, "/socket.io/?role=overlay&client=preview"),
      openUpgrade(gatewayPort, "/socket.io/?role=admin&presetId=abc"),
      openUpgrade(gatewayPort, "/socket.io/?client=other")
    ]);
    const request = http.request({ host: "127.0.0.1", port: gatewayPort, path: "/mutate-hang", method: "POST" });
    request.on("error", () => undefined);
    request.end("payload");

    await waitFor(async () => {
      const state = await controlStatus(config.gatewayControlSocket);
      expect(state.connections).toEqual({ overlay: 1, preview: 1, admin: 1, unknown: 1, total: 4 });
      expect(state.inFlightMutations).toBe(1);
      expect(state.activeChildHealthy).toBe(true);
      expect(state.gatewayHealthy).toBe(true);
    });

    request.destroy();
    for (const socket of sockets) socket.destroy();
    await waitFor(async () => {
      const state = await controlStatus(config.gatewayControlSocket);
      expect(state.connections.total).toBe(0);
      expect(state.inFlightMutations).toBe(0);
    });
    await gateway.stop();
    expect(fs.existsSync(config.gatewayControlSocket)).toBe(false);
  });

  it("requests a gateway process restart when the active backend exits", async () => {
    const gatewayPort = await freePort();
    const exitProcess = vi.fn();
    let activeChild: ChildProcess | undefined;
    const gateway = createBackendGateway({
      config: await testConfig(gatewayPort),
      logger,
      exitProcess,
      spawnBackend(slot, env) {
        activeChild = startFakeBackend(slot, env, "active");
        return activeChild;
      }
    });

    await gateway.start();
    activeChild?.emit("exit", 1, null);
    await waitFor(() => expect(exitProcess).toHaveBeenCalledWith(1));
    expect(logger.error).toHaveBeenCalledWith("gateway_active_slot_exited", expect.objectContaining({ slot: gateway.status().activeSlot?.id }));
  });

  it("restarts after repeated health failures", async () => {
    const gatewayPort = await freePort();
    const exitProcess = vi.fn();
    const config = await testConfig(gatewayPort);
    config.gatewayHealthCheckIntervalMs = 20;
    config.gatewayHealthCheckTimeoutMs = 20;
    config.gatewayHealthFailureThreshold = 2;
    let healthMode: HealthMode = true;
    const gateway = createBackendGateway({
      config,
      logger,
      exitProcess,
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active", () => healthMode);
      }
    });

    await gateway.start();
    healthMode = false;
    await waitFor(() => expect(exitProcess).toHaveBeenCalledWith(1));
    expect(logger.warn).toHaveBeenCalledWith("gateway_active_slot_health_failed", expect.objectContaining({ attempt: 2, threshold: 2 }));
  });

  it("bounds proxy lifetime and never appends JSON to a partial upstream response", async () => {
    const gatewayPort = await freePort();
    const config = await testConfig(gatewayPort);
    config.gatewayProxyTimeoutMs = 75;
    const gateway = createBackendGateway({
      config,
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active");
      }
    });

    await gateway.start();
    const timedOut = await fetch(`http://127.0.0.1:${gatewayPort}/hang`);
    expect(timedOut.status).toBe(504);
    await expect(timedOut.json()).resolves.toEqual({ error: "Backend slot timed out" });
    const partial = await fetchPartialResponse(gatewayPort, "/partial");
    expect(partial).toMatchObject({ status: 200, body: "partial", aborted: true });
    await gateway.stop();
  });

  it("fails closed when startup health hangs or does not report ok=true", async () => {
    const gatewayPort = await freePort();
    const hangingConfig = await testConfig(gatewayPort);
    hangingConfig.gatewaySlotStartupTimeoutMs = 100;
    const hangingGateway = createBackendGateway({
      config: hangingConfig,
      logger,
      exitProcess: vi.fn(),
      spawnBackend: startHangingHealthBackend
    });
    await expect(hangingGateway.start()).rejects.toThrow(/did not become healthy/);

    const unhealthyConfig = await testConfig(gatewayPort);
    unhealthyConfig.gatewaySlotStartupTimeoutMs = 2_000;
    const unhealthyGateway = createBackendGateway({
      config: unhealthyConfig,
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "unhealthy", false);
      }
    });
    await expect(unhealthyGateway.start()).rejects.toThrow(/ok=true/);
  });

  it("stops promptly even when an upgraded client is connected", async () => {
    const gatewayPort = await freePort();
    const gateway = createBackendGateway({
      config: await testConfig(gatewayPort),
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active");
      }
    });

    await gateway.start();
    const upgraded = await openUpgrade(gatewayPort, "/socket.io/?role=overlay&client=overlay");
    const upgradedClosed = new Promise<string>((resolve) => upgraded.once("close", () => resolve("closed")));
    const stopped = gateway.stop();
    await expect(Promise.race([stopped.then(() => "stopped"), delay(1_000).then(() => "timed-out")])).resolves.toBe("stopped");
    await expect(Promise.race([upgradedClosed, delay(1_000).then(() => "timed-out")])).resolves.toBe("closed");
  });
});

async function testConfig(port: number): Promise<AppConfig> {
  const workerPort = await freePort();
  const sparePort = await freePort();
  const controlSocket = `/tmp/oo-gateway-${process.pid}-${port}.sock`;
  socketPaths.push(controlSocket);
  return {
    env: "test",
    host: "127.0.0.1",
    port,
    databasePath: "/tmp/openoverlay-gateway.sqlite",
    uploadDir: "/tmp/openoverlay-gateway-uploads",
    mediaGlobalMaxBytes: 10 * 1024 * 1024 * 1024,
    storageMinimumFreeBytes: 0,
    logFile: "/tmp/openoverlay-gateway.log",
    jwtSecret: "secret",
    shareLookupSecret: "share-secret",
    corsOrigins: [],
    frontendUrl: "http://localhost:5173",
    gatewayBackendHost: "127.0.0.1",
    gatewayBackendPorts: [workerPort, sparePort],
    gatewayControlSocket: controlSocket,
    gatewaySlotStartupTimeoutMs: 5_000,
    gatewayHealthCheckIntervalMs: 10_000,
    gatewayHealthCheckTimeoutMs: 2_000,
    gatewayHealthFailureThreshold: 3,
    gatewayProxyTimeoutMs: 60_000,
    realtimeMaxConnections: 512,
    realtimeMaxConnectionsPerIp: 64,
    realtimeMaxPayloadBytes: 64 * 1024
  };
}

type HealthMode = boolean | "hang";

function startFakeBackend(_slot: BackendSlot, env: NodeJS.ProcessEnv, marker: string, healthMode: HealthMode | (() => HealthMode) = true): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  (child as ChildProcess & { killed: boolean }).killed = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const current = typeof healthMode === "function" ? healthMode() : healthMode;
      if (current === "hang") return;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: current,
          build: { commit: marker, commitShort: marker, version: "0.1.0" },
          compatibility: {
            api: { current: "v1", supported: ["v1"] },
            realtime: { current: "v1", supported: ["v1"] }
          }
        })
      );
      return;
    }
    if (req.url === "/hang" || req.url === "/mutate-hang") return;
    if (req.url === "/partial") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      return;
    }
    if (req.url === "/marker") {
      res.end(marker);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n");
    socket.on("end", () => socket.destroy());
  });
  child.kill = (() => {
    if ((child as ChildProcess & { killed: boolean }).killed) return true;
    (child as ChildProcess & { killed: boolean }).killed = true;
    server.close();
    child.emit("exit", 0, null);
    return true;
  }) as ChildProcess["kill"];
  server.listen(Number(env.PORT), env.HOST || "127.0.0.1");
  servers.push(server);
  return child;
}

function startHangingHealthBackend(_slot: BackendSlot, env: NodeJS.ProcessEnv): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  (child as ChildProcess & { killed: boolean }).killed = false;
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.statusCode = 404;
      res.end();
    }
  });
  child.kill = (() => {
    if ((child as ChildProcess & { killed: boolean }).killed) return true;
    (child as ChildProcess & { killed: boolean }).killed = true;
    server.close();
    child.emit("exit", 0, null);
    return true;
  }) as ChildProcess["kill"];
  server.listen(Number(env.PORT), env.HOST || "127.0.0.1");
  servers.push(server);
  return child;
}

async function controlStatus(socketPath: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("status\n"));
    socket.on("data", (chunk) => {
      body += chunk;
    });
    socket.on("end", () => {
      try {
        resolve((JSON.parse(body) as { status: Record<string, any> }).status);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

async function fetchText(port: number, requestPath: string): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}${requestPath}`)).text();
}

function fetchPartialResponse(port: number, requestPath: string): Promise<{ status: number; body: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}${requestPath}`, (response) => {
      let body = "";
      let settled = false;
      const finish = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode || 0, body, aborted });
      };
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("aborted", () => finish(true));
      response.on("error", () => finish(true));
      response.on("end", () => finish(false));
    });
    request.on("error", reject);
  });
}

function openUpgrade(port: number, requestPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: test\r\n\r\n`);
    });
    socket.once("data", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 1_500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
