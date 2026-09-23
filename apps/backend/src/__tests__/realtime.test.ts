import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import { createBackendApp, type BackendApp } from "../app.js";
import { createSessionToken } from "../auth.js";
import type { AppConfig } from "../config.js";
import { closeBackendServer } from "../lifecycle.js";
import { attachRealtime, type RealtimeHub } from "../realtime.js";
import { signup } from "./helpers.js";
import { createDefaultChurchState } from "@openoverlay/shared";

interface RealtimeTestServer {
  app: BackendApp;
  dir: string;
  hub: RealtimeHub;
  server: http.Server;
  url: string;
}

const servers: RealtimeTestServer[] = [];
const sockets: ClientSocket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  await Promise.all(servers.splice(0).map((testServer) => closeRealtimeTestServer(testServer)));
});

describe("realtime overlay clients", () => {
  it("separates public and stage payloads and disconnects a rotated stage", async () => {
    const testServer = await makeRealtimeTestServer();
    const agent = request.agent(testServer.app.app);
    await signup(agent, "stage-socket@example.com");
    const state = createDefaultChurchState("Service");
    state.slides[0].notes = "Stage secret";
    state.stageMessage = "Operator cue";
    state.elements.fullscreenSlide.visible = true;
    const created = await agent.post("/api/presets").send({ name: "Service", type: "church", state }).expect(201);
    const id = created.body.preset.id as string;
    const publicId = created.body.preset.publicId as string;
    const key = (await agent.get(`/api/presets/${id}/stage`).expect(200)).body.stageKey as string;

    const audience = connectOverlay(testServer.url, publicId, "overlay", undefined, false);
    const audienceReady = waitForSocketPayload<{ state: unknown }>(audience, "state:update");
    audience.connect();
    expect(JSON.stringify(await audienceReady)).not.toMatch(/Stage secret|Operator cue/);

    const stage = connectSocket(testServer.url, {
      transports: ["websocket"],
      reconnection: false,
      autoConnect: false,
      query: { role: "stage", overlayId: publicId },
      auth: { role: "stage", overlayId: publicId, stageKey: key }
    });
    sockets.push(stage);
    const stageReady = waitForSocketPayload<{ state: unknown }>(stage, "state:update");
    stage.connect();
    expect(JSON.stringify(await stageReady)).toMatch(/Stage secret|Operator cue/);
    expect(testServer.hub.getOverlayClientCount(publicId)).toBe(2);
    const disconnected = waitForSocket(stage, "disconnect");
    await agent.post(`/api/presets/${id}/stage/rotate`).expect(200);
    await disconnected;
    await waitForOverlayClientCount(testServer.hub, publicId, 1);
    expect(audience.connected).toBe(true);

    const stale = connectSocket(testServer.url, {
      transports: ["websocket"],
      reconnection: false,
      autoConnect: false,
      query: { role: "stage", overlayId: publicId },
      auth: { role: "stage", overlayId: publicId, stageKey: key }
    });
    sockets.push(stale);
    const rejected = waitForSocketPayload<{ error: string }>(stale, "error:message");
    stale.connect();
    await expect(rejected).resolves.toEqual({ error: "Stage not found" });
  });
  it("does not count preview clients as overlay clients", async () => {
    const testServer = await makeRealtimeTestServer();
    const agent = request.agent(testServer.app.app);
    await signup(agent, "owner@example.com");
    const created = await agent.post("/api/presets").send({ name: "Match", type: "soccer" }).expect(201);
    const publicId = created.body.preset.publicId as string;

    const previewSocket = connectOverlay(testServer.url, publicId, "preview");
    await waitForSocket(previewSocket, "connect");
    expect(testServer.hub.getOverlayClientCount(publicId)).toBe(0);

    const outputSocket = connectOverlay(testServer.url, publicId, "overlay");
    await waitForSocket(outputSocket, "connect");
    expect(testServer.hub.getOverlayClientCount(publicId)).toBe(1);

    const disconnectPromise = waitForSocket(outputSocket, "disconnect");
    outputSocket.disconnect();
    await disconnectPromise;
    await waitForOverlayClientCount(testServer.hub, publicId, 0);
  });

  it("accepts a bounded authenticated admin handshake", async () => {
    const testServer = await makeRealtimeTestServer();
    const agent = request.agent(testServer.app.app);
    const user = await signup(agent, "admin-socket@example.com");
    const created = await agent.post("/api/presets").send({ name: "Admin Match", type: "soccer" }).expect(201);
    const presetId = created.body.preset.id as string;
    const admin = connectSocket(testServer.url, {
      transports: ["websocket"],
      reconnection: false,
      autoConnect: false,
      query: { role: "admin", presetId },
      auth: { role: "admin", presetId, token: createSessionToken(user.id, "test-secret") }
    });
    sockets.push(admin);

    const update = waitForSocketPayload<{ id: string }>(admin, "preset:update");
    admin.connect();
    await expect(update).resolves.toMatchObject({ id: presetId });
  });

  it("broadcasts preset deletion to overlay and admin rooms before disconnecting them", async () => {
    const testServer = await makeRealtimeTestServer();
    const agent = request.agent(testServer.app.app);
    const user = await signup(agent, "delete-realtime@example.com");
    const created = await agent.post("/api/presets").send({ name: "Delete realtime", type: "soccer" }).expect(201);
    const presetId = created.body.preset.id as string;
    const publicId = created.body.preset.publicId as string;

    const overlay = connectOverlay(testServer.url, publicId, "overlay", undefined, false);
    const overlayReady = waitForSocketPayload<{ id: string }>(overlay, "state:update");
    overlay.connect();
    await expect(overlayReady).resolves.toMatchObject({ id: presetId });

    const admin = connectSocket(testServer.url, {
      transports: ["websocket"],
      reconnection: false,
      autoConnect: false,
      query: { role: "admin", presetId },
      auth: { role: "admin", presetId, token: createSessionToken(user.id, "test-secret") }
    });
    sockets.push(admin);
    const adminReady = waitForSocketPayload<{ id: string }>(admin, "preset:update");
    admin.connect();
    await expect(adminReady).resolves.toMatchObject({ id: presetId });

    const overlayDeleted = waitForSocketPayload<{ id: string; publicId: string; revision: number }>(overlay, "preset:deleted");
    const adminDeleted = waitForSocketPayload<{ id: string; publicId: string; revision: number }>(admin, "preset:deleted");
    const overlayDisconnected = waitForSocket(overlay, "disconnect");
    const adminDisconnected = waitForSocket(admin, "disconnect");
    await agent.delete(`/api/presets/${presetId}`).set("If-Match", '"1"').expect(200);

    const expected = { id: presetId, publicId, revision: 1 };
    await expect(overlayDeleted).resolves.toEqual(expected);
    await expect(adminDeleted).resolves.toEqual(expected);
    await Promise.all([overlayDisconnected, adminDisconnected]);
    await waitForOverlayClientCount(testServer.hub, publicId, 0);
  });

  it("disconnects authenticated admin sockets when logout revokes their session generation", async () => {
    const testServer = await makeRealtimeTestServer();
    const agent = request.agent(testServer.app.app);
    const user = await signup(agent, "logout-socket@example.com");
    const created = await agent.post("/api/presets").send({ name: "Logout socket", type: "soccer" }).expect(201);
    const presetId = created.body.preset.id as string;
    const capturedToken = createSessionToken(user.id, "test-secret");
    const admin = connectSocket(testServer.url, {
      transports: ["websocket"],
      reconnection: false,
      autoConnect: false,
      query: { role: "admin", presetId },
      auth: { role: "admin", presetId, token: capturedToken }
    });
    sockets.push(admin);
    const ready = waitForSocketPayload<{ id: string }>(admin, "preset:update");
    admin.connect();
    await expect(ready).resolves.toMatchObject({ id: presetId });

    const disconnected = waitForSocket(admin, "disconnect");
    await agent.post("/api/auth/logout").send({}).expect(200);
    await disconnected;
    expect(admin.connected).toBe(false);

    const replayed = connectSocket(testServer.url, {
      transports: ["websocket"],
      reconnection: false,
      autoConnect: false,
      query: { role: "admin", presetId },
      auth: { role: "admin", presetId, token: capturedToken }
    });
    sockets.push(replayed);
    const rejection = waitForSocketPayload<{ error: string }>(replayed, "error:message");
    const replayDisconnected = waitForSocket(replayed, "disconnect");
    replayed.connect();
    await expect(rejection).resolves.toEqual({ error: "Authentication required" });
    await replayDisconnected;
    expect(replayed.connected).toBe(false);
  });

  it("rejects malformed or conflicting connection parameters", async () => {
    const testServer = await makeRealtimeTestServer();
    const malformed = connectSocket(testServer.url, {
      transports: ["websocket"],
      reconnection: false,
      autoConnect: false,
      query: { role: "overlay", overlayId: "public-id", client: "preview" },
      auth: { role: "admin", overlayId: "public-id", client: "preview" }
    });
    sockets.push(malformed);

    const malformedError = waitForSocketError(malformed);
    malformed.connect();
    await expect(malformedError).resolves.toMatchObject({ message: "Invalid realtime connection parameters" });
    await waitForConnectionCount(testServer.hub, 0);
  });

  it("caps connections per IP and releases capacity after disconnect", async () => {
    const testServer = await makeRealtimeTestServer({
      realtimeMaxConnections: 10,
      realtimeMaxConnectionsPerIp: 2
    });
    const agent = request.agent(testServer.app.app);
    await signup(agent, "per-ip-owner@example.com");
    const created = await agent.post("/api/presets").send({ name: "Match", type: "soccer" }).expect(201);
    const publicId = created.body.preset.publicId as string;

    const first = connectOverlay(testServer.url, publicId, "preview");
    const second = connectOverlay(testServer.url, publicId, "preview");
    await Promise.all([waitForSocket(first, "connect"), waitForSocket(second, "connect")]);
    expect(testServer.hub.getConnectionCountForIp("127.0.0.1")).toBe(2);

    const rejected = connectOverlay(testServer.url, publicId, "preview", undefined, false);
    const rejectedError = waitForSocketError(rejected);
    rejected.connect();
    await rejectedError;
    expect(testServer.hub.getConnectionCount()).toBe(2);

    first.disconnect();
    await waitForConnectionCount(testServer.hub, 1);
    const replacement = connectOverlay(testServer.url, publicId, "preview");
    await waitForSocket(replacement, "connect");
    expect(testServer.hub.getConnectionCount()).toBe(2);
  });

  it("caps total connections even when forwarded client IPs differ", async () => {
    const testServer = await makeRealtimeTestServer({
      realtimeMaxConnections: 2,
      realtimeMaxConnectionsPerIp: 2
    });
    const agent = request.agent(testServer.app.app);
    await signup(agent, "total-owner@example.com");
    const created = await agent.post("/api/presets").send({ name: "Match", type: "soccer" }).expect(201);
    const publicId = created.body.preset.publicId as string;

    const first = connectOverlay(testServer.url, publicId, "preview", "203.0.113.1");
    const second = connectOverlay(testServer.url, publicId, "preview", "203.0.113.2");
    await Promise.all([waitForSocket(first, "connect"), waitForSocket(second, "connect")]);
    expect(testServer.hub.getConnectionCount()).toBe(2);

    const rejected = connectOverlay(testServer.url, publicId, "preview", "203.0.113.3", false);
    const rejectedError = waitForSocketError(rejected);
    rejected.connect();
    await rejectedError;
    expect(testServer.hub.getConnectionCountForIp("203.0.113.3")).toBe(0);
  });

  it("disconnects clients that exceed the inbound realtime payload limit", async () => {
    const testServer = await makeRealtimeTestServer({ realtimeMaxPayloadBytes: 128 });
    const agent = request.agent(testServer.app.app);
    await signup(agent, "payload-owner@example.com");
    const created = await agent.post("/api/presets").send({ name: "Match", type: "soccer" }).expect(201);
    const socket = connectOverlay(testServer.url, created.body.preset.publicId as string, "preview");
    await waitForSocket(socket, "connect");

    const disconnected = waitForSocket(socket, "disconnect");
    socket.emit("unexpected:large", "x".repeat(1_024));
    await disconnected;
    await waitForConnectionCount(testServer.hub, 0);
  });

  it("gracefully closes the HTTP server while an upgraded overlay socket is active", async () => {
    const testServer = await makeRealtimeTestServer();
    const agent = request.agent(testServer.app.app);
    await signup(agent, "shutdown-owner@example.com");
    const created = await agent.post("/api/presets").send({ name: "Shutdown Match", type: "soccer" }).expect(201);
    const socket = connectOverlay(testServer.url, created.body.preset.publicId as string, "overlay");
    await waitForSocket(socket, "connect");
    const disconnected = waitForSocket(socket, "disconnect");

    await expect(
      Promise.race([
        Promise.all([closeBackendServer(testServer.server, testServer.hub), disconnected]).then(() => undefined),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Backend shutdown remained blocked by an upgraded socket")), 1_000))
      ])
    ).resolves.toBeUndefined();
    expect(socket.connected).toBe(false);
    servers.splice(servers.indexOf(testServer), 1);
    testServer.app.close();
    fs.rmSync(testServer.dir, { recursive: true, force: true });
  });
});

async function makeRealtimeTestServer(overrides: Partial<AppConfig> = {}): Promise<RealtimeTestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-realtime-"));
  const app = createBackendApp({
    env: "test",
    databasePath: path.join(dir, "openoverlay.sqlite"),
    uploadDir: path.join(dir, "uploads"),
    logFile: path.join(dir, "backend.log"),
    jwtSecret: "test-secret",
    corsOrigins: ["http://localhost:5173"],
    ...overrides
  });
  const server = http.createServer(app.app);
  const hub = attachRealtime(server, app.ctx);
  app.ctx.realtime = hub;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const testServer = { app, dir, hub, server, url: `http://127.0.0.1:${address.port}` };
  servers.push(testServer);
  return testServer;
}

function connectOverlay(url: string, overlayId: string, client: "overlay" | "preview", forwardedIp?: string, autoConnect = true): ClientSocket {
  const socket = connectSocket(url, {
    transports: ["websocket"],
    reconnection: false,
    autoConnect,
    extraHeaders: forwardedIp ? { "x-forwarded-for": forwardedIp } : undefined,
    auth: { role: "overlay", overlayId, client },
    query: { role: "overlay", overlayId, client }
  });
  sockets.push(socket);
  return socket;
}

function waitForSocketError(socket: ClientSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for socket connect_error")), 1_000);
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      resolve(error);
    });
  });
}

function waitForSocketPayload<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for socket ${event}`)), 1_000);
    socket.once(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForSocket(socket: ClientSocket, event: "connect" | "disconnect"): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for socket ${event}`)), 1_000);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timeout);
      socket.off("connect_error", onError);
    }
    socket.once(event, () => {
      cleanup();
      resolve();
    });
    socket.once("connect_error", onError);
  });
}

async function waitForOverlayClientCount(hub: RealtimeHub, publicId: string, count: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (hub.getOverlayClientCount(publicId) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(hub.getOverlayClientCount(publicId)).toBe(count);
}

async function waitForConnectionCount(hub: RealtimeHub, count: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (hub.getConnectionCount() === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(hub.getConnectionCount()).toBe(count);
}

async function closeRealtimeTestServer(testServer: RealtimeTestServer): Promise<void> {
  await testServer.hub.io.close();
  await new Promise<void>((resolve) => testServer.server.close(() => resolve()));
  testServer.app.close();
  fs.rmSync(testServer.dir, { recursive: true, force: true });
}
