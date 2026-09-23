import type { IncomingMessage, Server as HttpServer } from "node:http";
import { isIP } from "node:net";
import cookie from "cookie";
import { Server, type Socket } from "socket.io";
import { type PresetRow } from "./db.js";
import type { PresetState } from "@openoverlay/shared";
import { verifySessionToken, sessionCookieName } from "./auth.js";
import { materializeState, publicOverlayState, readStoredPresetState } from "./state.js";
import type { AppContext } from "./types.js";
import { validStageKey } from "./stage.js";
import {
  OPENOVERLAY_API_VERSION,
  OPENOVERLAY_REALTIME_VERSION,
  OPENOVERLAY_SUPPORTED_API_VERSIONS,
  OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS
} from "@openoverlay/shared";

export interface RealtimeHub {
  io: Server;
  broadcastPreset(row: PresetRow): void;
  broadcastPresetDeleted(row: PresetRow): void;
  broadcastConnectionCount(row: PresetRow): void;
  disconnectUser(userId: string): void;
  disconnectStage(publicId: string): void;
  getOverlayClientCount(publicId: string): number;
  getConnectionCount(): number;
  getConnectionCountForIp(ip: string): number;
}

interface OverlayConnectionRequest {
  role: "overlay";
  overlayId: string;
  client: "overlay" | "preview";
  apiVersion?: string;
  realtimeVersion?: string;
}

interface AdminConnectionRequest {
  role: "admin";
  presetId: string;
  apiVersion?: string;
  realtimeVersion?: string;
}

interface StageConnectionRequest {
  role: "stage";
  overlayId: string;
  stageKey: string;
  apiVersion?: string;
  realtimeVersion?: string;
}

type RealtimeConnectionRequest = OverlayConnectionRequest | AdminConnectionRequest | StageConnectionRequest;

export function attachRealtime(server: HttpServer, ctx: AppContext): RealtimeHub {
  const overlayClients = new Map<string, Set<string>>();
  const connectionsByIp = new Map<string, number>();
  const lastLimitLogAt = new Map<"total" | "ip", number>();
  let connectionCount = 0;
  const io = new Server(server, {
    maxHttpBufferSize: ctx.config.realtimeMaxPayloadBytes,
    allowRequest(request, callback) {
      const ip = clientIp(request);
      const overTotalLimit = connectionCount >= ctx.config.realtimeMaxConnections;
      const overIpLimit = (connectionsByIp.get(ip) || 0) >= ctx.config.realtimeMaxConnectionsPerIp;
      if (overTotalLimit || overIpLimit) {
        logConnectionRejection(ctx, lastLimitLogAt, overTotalLimit ? "total" : "ip");
        callback("Realtime connection limit reached", false);
        return;
      }
      callback(null, true);
    },
    cors: {
      origin(origin, callback) {
        if (!origin || ctx.config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS origin not allowed"));
      },
      credentials: true
    }
  });

  const hub: RealtimeHub = {
    io,
    broadcastPreset(row) {
      const stored = readStoredPresetState(row);
      const state = materializeState(stored.state);
      if (stored.recovered) ctx.logger.warn("preset_state_recovered", { presetId: row.id, source: "realtime" });
      io.to(`overlay:${row.public_id}`).emit("state:update", publicPayload(row, state, stored.recovered));
      io.to(`stage:${row.public_id}`).emit("state:update", stagePayload(row, state, stored.recovered));
      io.to(`admin:${row.id}`).emit("preset:update", privatePayload(row, state, hub.getOverlayClientCount(row.public_id), stored.recovered));
    },
    broadcastPresetDeleted(row) {
      const payload = { id: row.id, publicId: row.public_id, revision: row.revision };
      io.to(`overlay:${row.public_id}`).emit("preset:deleted", payload);
      io.to(`stage:${row.public_id}`).emit("preset:deleted", payload);
      io.to(`admin:${row.id}`).emit("preset:deleted", payload);
      io.in(`overlay:${row.public_id}`).disconnectSockets(true);
      io.in(`stage:${row.public_id}`).disconnectSockets(true);
      io.in(`admin:${row.id}`).disconnectSockets(true);
    },
    broadcastConnectionCount(row) {
      io.to(`admin:${row.id}`).emit("overlay:clients", { presetId: row.id, publicId: row.public_id, count: hub.getOverlayClientCount(row.public_id) });
    },
    disconnectUser(userId) {
      io.in(`user:${userId}`).disconnectSockets(true);
    },
    disconnectStage(publicId) {
      io.in(`stage:${publicId}`).disconnectSockets(true);
    },
    getOverlayClientCount(publicId) {
      return overlayClients.get(publicId)?.size || 0;
    },
    getConnectionCount() {
      return connectionCount;
    },
    getConnectionCountForIp(ip) {
      return connectionsByIp.get(normalizeIp(ip)) || 0;
    }
  };

  // Count Engine.IO connections rather than only fully initialized Socket.IO
  // namespaces. This also bounds clients that open a transport and never send a
  // valid Socket.IO CONNECT packet.
  io.engine.on("connection", (connection) => {
    const ip = clientIp(connection.request);
    const ipCount = connectionsByIp.get(ip) || 0;
    if (connectionCount >= ctx.config.realtimeMaxConnections || ipCount >= ctx.config.realtimeMaxConnectionsPerIp) {
      logConnectionRejection(ctx, lastLimitLogAt, connectionCount >= ctx.config.realtimeMaxConnections ? "total" : "ip");
      connection.close(true);
      return;
    }

    connectionCount += 1;
    connectionsByIp.set(ip, ipCount + 1);
    let released = false;
    connection.once("close", () => {
      if (released) return;
      released = true;
      connectionCount = Math.max(0, connectionCount - 1);
      const remaining = (connectionsByIp.get(ip) || 1) - 1;
      if (remaining <= 0) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, remaining);
    });
  });

  io.use((socket, next) => {
    try {
      socket.data.realtimeRequest = parseRealtimeRequest(socket);
      next();
    } catch {
      next(new Error("Invalid realtime connection parameters"));
    }
  });

  io.on("connection", (socket) => {
    void handleSocket(socket, ctx, hub, overlayClients).catch((error: unknown) => {
      ctx.logger.error("realtime_connection_failed", { socketId: socket.id, error: error instanceof Error ? error.message : String(error) });
      if (socket.connected) socket.emit("error:message", { error: "Realtime connection failed" });
      socket.disconnect(true);
    });
  });

  return hub;
}

async function handleSocket(socket: Socket, ctx: AppContext, hub: RealtimeHub, overlayClients: Map<string, Set<string>>): Promise<void> {
  const request = socket.data.realtimeRequest as RealtimeConnectionRequest | undefined;
  if (!request) {
    socket.disconnect(true);
    return;
  }
  const { apiVersion, realtimeVersion } = request;

  if (
    (apiVersion && !OPENOVERLAY_SUPPORTED_API_VERSIONS.includes(apiVersion as typeof OPENOVERLAY_API_VERSION)) ||
    (realtimeVersion && !OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS.includes(realtimeVersion as typeof OPENOVERLAY_REALTIME_VERSION))
  ) {
    socket.emit("error:message", { error: "Incompatible OpenOverlay API or realtime version" });
    socket.disconnect(true);
    return;
  }

  if (request.role === "overlay") {
    const row = ctx.db.getPresetByPublicId(request.overlayId);
    if (!row) {
      socket.emit("error:message", { error: "Overlay not found" });
      socket.disconnect(true);
      return;
    }
    await socket.join(`overlay:${row.public_id}`);
    const countsAsOverlayClient = request.client !== "preview";
    const set = overlayClients.get(row.public_id) || new Set<string>();
    if (countsAsOverlayClient) {
      set.add(socket.id);
      overlayClients.set(row.public_id, set);
      let released = false;
      socket.once("disconnect", () => {
        if (released) return;
        released = true;
        set.delete(socket.id);
        if (set.size === 0) overlayClients.delete(row.public_id);
        hub.broadcastConnectionCount(row);
      });
    }
    const stored = readStoredPresetState(row);
    socket.emit("state:update", publicPayload(row, materializeState(stored.state), stored.recovered));
    if (countsAsOverlayClient) {
      hub.broadcastConnectionCount(row);
    }
    return;
  }

  if (request.role === "stage") {
    const row = ctx.db.getPresetByPublicId(request.overlayId);
    if (!row || !validStageKey(row.stage_key, request.stageKey)) {
      socket.emit("error:message", { error: "Stage not found" });
      socket.disconnect(true);
      return;
    }
    await socket.join(`stage:${row.public_id}`);
    const current = ctx.db.getPresetByPublicId(request.overlayId);
    if (!socket.connected || !current || !validStageKey(current.stage_key, request.stageKey)) {
      socket.disconnect(true);
      return;
    }
    const set = overlayClients.get(row.public_id) || new Set<string>();
    set.add(socket.id);
    overlayClients.set(row.public_id, set);
    socket.once("disconnect", () => {
      set.delete(socket.id);
      if (set.size === 0) overlayClients.delete(row.public_id);
      hub.broadcastConnectionCount(row);
    });
    const stored = readStoredPresetState(current);
    socket.emit("state:update", stagePayload(current, materializeState(stored.state), stored.recovered));
    hub.broadcastConnectionCount(row);
    return;
  }

  if (request.role === "admin") {
    const user = authenticateSocket(socket, ctx);
    if (!user) {
      socket.emit("error:message", { error: "Authentication required" });
      socket.disconnect(true);
      return;
    }
    // Join the revocation room before yielding to any further async work. If
    // logout wins before the join, the generation recheck below rejects this
    // socket; if logout wins after the join, disconnectUser catches it.
    await socket.join(`user:${user.id}`);
    const currentUser = authenticateSocket(socket, ctx);
    if (!socket.connected || !currentUser || currentUser.id !== user.id) {
      if (socket.connected) socket.emit("error:message", { error: "Authentication required" });
      socket.disconnect(true);
      return;
    }
    const row = ctx.db.getPresetForUser(request.presetId, currentUser.id);
    if (!row) {
      socket.emit("error:message", { error: "Preset not found" });
      socket.disconnect(true);
      return;
    }
    await socket.join(`admin:${row.id}`);
    if (!socket.connected) return;
    let expiryTimer: NodeJS.Timeout | undefined;
    const scheduleExpiry = () => {
      const delay = Math.max(1, Math.min(currentUser.expiresAtMs - Date.now(), 2_147_483_647));
      expiryTimer = setTimeout(() => {
        if (!socket.connected) return;
        if (!authenticateSocket(socket, ctx)) {
          socket.emit("error:message", { error: "Authentication required" });
          socket.disconnect(true);
        } else scheduleExpiry();
      }, delay);
      expiryTimer.unref();
    };
    scheduleExpiry();
    socket.once("disconnect", () => clearTimeout(expiryTimer));
    const stored = readStoredPresetState(row);
    socket.emit("preset:update", privatePayload(row, materializeState(stored.state), hub.getOverlayClientCount(row.public_id), stored.recovered));
    socket.emit("overlay:clients", { presetId: row.id, publicId: row.public_id, count: hub.getOverlayClientCount(row.public_id) });
    return;
  }

  socket.disconnect(true);
}

function authenticateSocket(socket: Socket, ctx: AppContext) {
  const rawCookie = socket.request.headers.cookie || "";
  const cookies = cookie.parse(rawCookie);
  const handshakeToken = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : undefined;
  for (const token of [handshakeToken, cookies[sessionCookieName()]]) {
    const payload = verifySessionToken(token, ctx.config.jwtSecret);
    if (!payload) continue;
    const user = ctx.db.findUserById(payload.sub);
    if (user && user.session_version === payload.ver) return { id: user.id, email: user.email, expiresAtMs: payload.exp * 1000 };
  }
  return null;
}

function parseRealtimeRequest(socket: Socket): RealtimeConnectionRequest {
  if (!isRecord(socket.handshake.auth)) throw new Error("Invalid auth payload");
  const role = stringParameter(socket, "role", 16);
  const overlayId = stringParameter(socket, "overlayId", 200);
  const presetId = stringParameter(socket, "presetId", 200);
  const client = stringParameter(socket, "client", 16);
  const apiVersion = stringParameter(socket, "apiVersion", 32);
  const realtimeVersion = stringParameter(socket, "realtimeVersion", 32);
  // The token is read separately by authenticateSocket, but validate its shape
  // here so non-string or oversized values never reach session verification.
  stringParameter(socket, "token", 4_096);
  if (Object.hasOwn(socket.handshake.query, "stageKey")) throw new Error("Stage key must be in socket authentication");
  const stageKey = stringParameter(socket, "stageKey", 128);

  if (role === "overlay" && overlayId && !presetId && (client === undefined || client === "overlay" || client === "preview")) {
    return { role, overlayId, client: client || "overlay", apiVersion, realtimeVersion };
  }
  if (role === "admin" && presetId && !overlayId && client === undefined) {
    return { role, presetId, apiVersion, realtimeVersion };
  }
  if (role === "stage" && overlayId && stageKey && !presetId && client === undefined) {
    return { role, overlayId, stageKey, apiVersion, realtimeVersion };
  }
  throw new Error("Invalid realtime connection shape");
}

function stringParameter(socket: Socket, key: string, maxLength: number): string | undefined {
  const queryHasKey = Object.hasOwn(socket.handshake.query, key);
  const auth = isRecord(socket.handshake.auth) ? socket.handshake.auth : {};
  const authHasKey = Object.hasOwn(auth, key);
  const queryValue = queryHasKey ? socket.handshake.query[key] : undefined;
  const authValue = authHasKey ? auth[key] : undefined;

  if ((queryHasKey && typeof queryValue !== "string") || (authHasKey && typeof authValue !== "string")) {
    throw new Error(`Invalid ${key}`);
  }
  if (queryHasKey && authHasKey && queryValue !== authValue) throw new Error(`Conflicting ${key}`);
  const value = (queryHasKey ? queryValue : authValue) as string | undefined;
  if (value === undefined) return undefined;
  if (!value || value !== value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function clientIp(request: IncomingMessage): string {
  const directIp = normalizeIp(request.socket.remoteAddress || "unknown");
  if (!isLoopback(directIp)) return directIp;

  const cloudflareIp = firstHeaderValue(request.headers["cf-connecting-ip"]);
  const forwardedIp = firstHeaderValue(request.headers["x-forwarded-for"])?.split(",", 1)[0]?.trim();
  for (const candidate of [cloudflareIp, forwardedIp]) {
    if (candidate && isIP(candidate)) return normalizeIp(candidate);
  }
  return directIp;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logConnectionRejection(ctx: AppContext, lastLogAt: Map<"total" | "ip", number>, scope: "total" | "ip"): void {
  const now = Date.now();
  if (now - (lastLogAt.get(scope) || 0) < 10_000) return;
  lastLogAt.set(scope, now);
  ctx.logger.warn("realtime_connection_rejected", { scope });
}

function publicPayload(row: PresetRow, state: unknown, recovered = false) {
  return {
    serverTimeMs: Date.now(),
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    type: row.type,
    revision: row.revision,
    stateRecovered: recovered || undefined,
    state: publicOverlayState(state as PresetState),
    updatedAt: row.updated_at
  };
}

function privatePayload(row: PresetRow, state: unknown, overlayClientCount: number, recovered = false) {
  return {
    ...publicPayload(row, state, recovered),
    state,
    overlayClientCount
  };
}

function stagePayload(row: PresetRow, state: PresetState, recovered = false) {
  return { ...publicPayload(row, state, recovered), state };
}
