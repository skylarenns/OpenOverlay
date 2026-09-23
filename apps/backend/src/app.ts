import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import {
  createDefaultPresetState,
  defaultTeam,
  emptyTeam,
  normalizeImageCrop,
  normalizeTeam,
  openOverlayCompatibility,
  OPENOVERLAY_API_VERSION,
  OPENOVERLAY_SUPPORTED_API_VERSIONS,
  parseRoster,
  tryParseClockTime,
  setClockSeconds,
  type PresetState,
  type PresetType,
  type SoccerState,
  type TeamLibraryEntry,
  type TeamRecord
} from "@openoverlay/shared";
import {
  AuthRateLimiter,
  DUMMY_PASSWORD_HASH,
  RateLimitError,
  authenticatedUser,
  clearSessionCookie,
  generateActionKey,
  hashActionKey,
  hashPassword,
  requireAuth,
  serializeUser,
  setSessionCookie,
  validateEmail,
  validatePassword,
  verifyActionKey,
  verifyPassword,
  sessionCookieName
} from "./auth.js";
import { getBuildInfo } from "./buildInfo.js";
import { loadConfig, type AppConfig } from "./config.js";
import { Database, RevisionConflictError, parseTeam, type MediaRow, type PendingShareRow, type PresetRow, type TeamRow, type UserRow } from "./db.js";
import { createLogger } from "./logger.js";
import {
  PresetActionValidationError,
  PresetStateValidationError,
  applyAction,
  cloneStateForShare,
  ensurePresetState,
  isChurchState,
  isPresetAction,
  isSoccerState,
  materializeState,
  publicOverlayState,
  mergePresetState,
  readStoredPresetState,
  validatePresetActionPayload
} from "./state.js";
import type { AppContext } from "./types.js";
import { validStageKey } from "./stage.js";

export interface BackendApp {
  app: express.Express;
  ctx: AppContext;
  close(): void;
}

const MAX_MEDIA_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_JSON_REQUEST_BYTES = 2 * 1024 * 1024;
const DATABASE_WRITE_HEADROOM_BYTES = 8 * 1024 * 1024;
const MEDIA_RECONCILIATION_GRACE_MS = 24 * 60 * 60 * 1000;
const MEDIA_UPLOAD_STAGING_MARKER = ".uploading-";
const MANAGED_MEDIA_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_MEDIA_UPLOAD_BYTES,
    files: 1,
    fields: 0,
    parts: 2
  }
});

const allowedMimes = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const extensionByMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "image/webp": ".webp"
};
const MAX_CONCURRENT_MEDIA_UPLOADS = 4;
const MAX_PARALLEL_BACKEND_SLOTS = 2;
const MAX_MEDIA_ITEMS_PER_USER = 100;
const MAX_MEDIA_BYTES_PER_USER = 250 * 1024 * 1024;
const MAX_PRESETS_PER_USER = 100;
const MAX_TEAMS_PER_USER = 250;
const MEDIA_PAGE_SIZE = 24;
const MAX_MEDIA_PAGE_SIZE = 100;
const MAX_OUTSTANDING_SHARES = 100;
const MAX_DAILY_SHARE_REQUESTS = 20;

class UploadValidationError extends Error {}
class RequestValidationError extends Error {}
class PreconditionRequiredError extends Error {}
class CorsOriginError extends Error {}
class MediaReferencedError extends Error {}
class MediaQuotaError extends Error {}
class StorageCapacityError extends Error {}
class ResourceQuotaError extends Error {}
class SessionExpiredError extends Error {}
class IdempotencyConflictError extends Error {}

interface MutationReceiptRequest {
  ownerUserId: string;
  resourceId: string;
  operation: string;
  key: string;
  requestHash: string;
}

export function createBackendApp(configOverrides: Partial<AppConfig> = {}): BackendApp {
  const config = loadConfig(configOverrides);
  const logger = createLogger(config.logFile);
  const db = new Database(config);
  const ctx: AppContext = { config, db, logger };
  reconcileMediaStorage(ctx);
  const mediaReconciliationTimer = setInterval(() => {
    try {
      reconcileMediaStorage(ctx);
    } catch (error) {
      logger.error("media_reconciliation_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }, MEDIA_RECONCILIATION_GRACE_MS);
  mediaReconciliationTimer.unref();
  const pendingShareTimer = setInterval(() => {
    try {
      db.expirePendingShares();
      for (const user of db.listUsers()) fulfillPendingShares(ctx, user);
    } catch (error) {
      logger.error("pending_share_fulfillment_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }, 60_000);
  pendingShareTimer.unref();
  const authRateLimiter = new AuthRateLimiter();
  let activeMediaUploads = 0;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new CorsOriginError("Origin not allowed"));
      },
      credentials: true
    })
  );
  app.use(express.json({ limit: MAX_JSON_REQUEST_BYTES }));
  // codeql[js/missing-token-validation] csrfOriginGuard rejects cross-origin and originless production cookie writes below.
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.ctx = ctx;
    next();
  });
  app.use(csrfOriginGuard(ctx));
  app.use((req, res, next) => {
    const requestPath = req.path;
    res.on("finish", () => {
      const successfulPublicRead =
        (req.method === "GET" || req.method === "HEAD") && res.statusCode < 400 && /^\/api(?:\/v1)?\/(?:overlay|media\/file)\//.test(requestPath);
      if (requestPath !== "/health" && !successfulPublicRead) {
        logger.info("http_request", { method: req.method, path: requestPath, status: res.statusCode });
      }
    });
    next();
  });

  app.get("/health", (_req, res) => {
    let databaseReady = false;
    try {
      databaseReady = db.healthCheck();
    } catch (error) {
      logger.error("health_database_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    if (!databaseReady) {
      res.status(503).json({ ok: false, app: "OpenOverlay", component: "backend", database: "unavailable" });
      return;
    }
    res.json({
      ok: true,
      app: "OpenOverlay",
      component: "backend",
      time: new Date().toISOString(),
      build: getBuildInfo(),
      compatibility: openOverlayCompatibility()
    });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    const requestedVersion = req.header("x-openoverlay-api-version");
    if (requestedVersion && !OPENOVERLAY_SUPPORTED_API_VERSIONS.includes(requestedVersion as typeof OPENOVERLAY_API_VERSION)) {
      res.status(426).json({ error: "Unsupported OpenOverlay API version", supported: OPENOVERLAY_SUPPORTED_API_VERSIONS });
      return;
    }
    next();
  });

  app.use("/api/v1", api);
  app.use("/api", api);

  api.post(
    "/auth/signup",
    asyncHandler(async (req, res) => {
      const body = requestBody(req);
      const email = validateEmail(body.email);
      const password = validatePassword(body.password);
      if (!email || !password) {
        res.status(400).json({ error: "Valid email and password of at least 8 characters are required" });
        return;
      }
      authRateLimiter.reserveSignup(req.ip || "unknown");
      assertStorageHeadroom(ctx, path.dirname(ctx.config.databasePath), DATABASE_WRITE_HEADROOM_BYTES);
      if (db.findUserByEmail(email)) {
        res.status(409).json({ error: "An account already exists for that email" });
        return;
      }
      const passwordHash = await hashPassword(password);
      let user;
      try {
        user = db.createUser(email, passwordHash);
      } catch (error) {
        if (isUniqueEmailError(error)) {
          res.status(409).json({ error: "An account already exists for that email" });
          return;
        }
        throw error;
      }
      setSessionCookie(res, ctx, user.id, user.session_version);
      fulfillPendingShares(ctx, user);
      res.status(201).json({ user: serializeUser({ id: user.id, email: user.email }) });
    })
  );

  api.post(
    "/auth/login",
    asyncHandler(async (req, res) => {
      const body = requestBody(req);
      const email = validateEmail(body.email);
      const password = validatePassword(body.password);
      if (!email || !password) {
        res.status(400).json({ error: "Valid email and password are required" });
        return;
      }
      const ip = req.ip || "unknown";
      authRateLimiter.reserveLogin(email, ip);
      const user = db.findUserByEmail(email);
      const passwordMatches = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
      if (!user || !passwordMatches) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }
      authRateLimiter.recordSuccessfulLogin(email, ip);
      setSessionCookie(res, ctx, user.id, user.session_version);
      res.json({ user: serializeUser({ id: user.id, email: user.email }) });
    })
  );

  api.post("/auth/logout", (req, res) => {
    const user = authenticatedUser(req, ctx);
    if (user) {
      db.revokeUserSessions(user.id);
      ctx.realtime?.disconnectUser(user.id);
    }
    clearSessionCookie(res, ctx);
    res.json({ ok: true });
  });

  api.get("/auth/me", requireAuth, (req, res) => {
    res.json({ user: serializeUser(req.user!) });
  });

  // codeql[js/missing-rate-limiting] reserveSensitiveRead bounds this authenticated file read by user and IP.
  api.get("/operations/backup", requireAuth, (req, res) => {
    authRateLimiter.reserveSensitiveRead(req.user!.id, req.ip || "unknown");
    const statusFile = path.join(path.dirname(ctx.config.databasePath), "backup-status.json");
    let recorded: Record<string, unknown> = {};
    try {
      recorded = JSON.parse(fs.readFileSync(statusFile, "utf8")) as Record<string, unknown>;
    } catch {
      // Missing or unreadable status is an overdue backup, not a healthy one.
    }
    const lastSuccessAt = typeof recorded.lastSuccessAt === "string" && Number.isFinite(Date.parse(recorded.lastSuccessAt)) ? recorded.lastSuccessAt : null;
    const lastFailureAt = typeof recorded.lastFailureAt === "string" && Number.isFinite(Date.parse(recorded.lastFailureAt)) ? recorded.lastFailureAt : null;
    res.json({
      backup: {
        lastSuccessAt,
        lastFailureAt,
        overdue: !lastSuccessAt || Date.now() - Date.parse(lastSuccessAt) > 36 * 60 * 60_000,
        failedSinceSuccess: Boolean(lastFailureAt && recorded.lastError)
      }
    });
  });

  api.use((req, _res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      next();
      return;
    }
    if (req.method !== "DELETE") {
      assertStorageHeadroom(ctx, path.dirname(ctx.config.databasePath), DATABASE_WRITE_HEADROOM_BYTES);
    }
    const user = authenticatedUser(req, ctx);
    if (user) authRateLimiter.reserveWrite(user.id, req.ip || "unknown");
    next();
  });

  api.get("/teams", requireAuth, (req, res) => {
    res.json({ teams: db.listTeamsForUser(req.user!.id).map((row) => serializeTeam(row)) });
  });

  api.post("/teams", requireAuth, (req, res) => {
    assertTeamQuota(ctx, req.user!.id);
    const body = requestBody(req);
    assertTeamInputTypes(body);
    const team = canonicalizeOwnedTeamMedia(ctx, req.user!.id, sanitizeTeamInput(body));
    const row = db.createTeam({ ownerUserId: req.user!.id, team });
    res.status(201).json({ team: serializeTeam(row) });
  });

  api.patch("/teams/:id", requireAuth, (req, res) => {
    const existing = db.getTeamForUser(routeParam(req, "id"), req.user!.id);
    if (!existing) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const current = serializeTeam(existing);
    const body = requestBody(req);
    assertTeamInputTypes(body);
    const expectedRevision = requiredExpectedRevisionFromRequest(req, body);
    const team = {
      ...canonicalizeOwnedTeamMedia(ctx, req.user!.id, sanitizeTeamInput(body, current)),
      id: current.id,
      revision: current.revision,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt
    };
    const updated = db.updateTeam({ id: current.id, ownerUserId: req.user!.id, team, expectedRevision });
    if (!updated) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    res.json({ team: serializeTeam(updated) });
  });

  api.delete("/teams/:id", requireAuth, (req, res) => {
    const id = routeParam(req, "id");
    if (!db.getTeamForUser(id, req.user!.id)) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const expectedRevision = requiredExpectedRevisionFromRequest(req, {});
    const deleted = db.deleteTeam(id, req.user!.id, expectedRevision);
    if (!deleted) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    res.json({ ok: true });
  });

  api.get("/presets", requireAuth, (req, res) => {
    res.json({
      presets: db.listPresetsForUser(req.user!.id).map((row) => serializePresetListItem(row, ctx))
    });
  });

  api.post("/presets", requireAuth, (req, res) => {
    assertPresetQuota(ctx, req.user!.id);
    const body = requestBody(req);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "Untitled";
    if (body.type !== undefined && body.type !== "soccer" && body.type !== "church" && body.type !== "custom") {
      throw new RequestValidationError("Invalid preset type");
    }
    const type: PresetType = body.type === "church" || body.type === "custom" ? body.type : "soccer";
    const state = canonicalizeOwnedPresetMedia(
      ctx,
      req.user!.id,
      ensurePresetState(type, name, Object.hasOwn(body, "state") ? (body.state as PresetState) : undefined)
    );
    const row = db.transaction(() => {
      const created = db.createPreset({ ownerUserId: req.user!.id, name, type, state });
      db.logEvent({ presetId: created.id, ownerUserId: req.user!.id, type: "preset.create", payload: { type } });
      return created;
    });
    res.status(201).json({ preset: serializePreset(row, ctx) });
  });

  api.get("/presets/:id", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    res.json({ preset: serializePreset(row, ctx) });
  });

  // codeql[js/missing-rate-limiting] reserveSensitiveRead bounds disclosure of the stage capability by user and IP.
  api.get("/presets/:id/stage", requireAuth, (req, res) => {
    authRateLimiter.reserveSensitiveRead(req.user!.id, req.ip || "unknown");
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) return void res.status(404).json({ error: "Preset not found" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ stageKey: row.stage_key, publicId: row.public_id });
  });

  // codeql[js/missing-rate-limiting] The API-wide write guard calls reserveWrite before this route.
  api.post("/presets/:id/stage/rotate", requireAuth, (req, res) => {
    const row = db.setStageKey(routeParam(req, "id"), req.user!.id, true);
    if (!row) return void res.status(404).json({ error: "Preset not found" });
    ctx.realtime?.disconnectStage(row.public_id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ stageKey: row.stage_key, publicId: row.public_id });
  });

  // codeql[js/missing-rate-limiting] The API-wide write guard calls reserveWrite before this route.
  api.delete("/presets/:id/stage", requireAuth, (req, res) => {
    const row = db.setStageKey(routeParam(req, "id"), req.user!.id, false);
    if (!row) return void res.status(404).json({ error: "Preset not found" });
    ctx.realtime?.disconnectStage(row.public_id);
    res.json({ ok: true });
  });

  api.patch("/presets/:id", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const body = requestBody(req);
    const receiptRequest = mutationReceiptRequest(req, row, "preset.patch", body);
    const priorReceipt = receiptRequest && db.getMutationReceipt(row.owner_user_id, row.id, receiptRequest.operation, receiptRequest.key);
    if (priorReceipt) {
      assertReceiptMatches(priorReceipt.request_hash, receiptRequest!.requestHash);
      res.json({ preset: serializePreset(db.getPresetForUser(row.id, row.owner_user_id)!, ctx), appliedRevision: priorReceipt.applied_revision });
      return;
    }
    const expectedRevision = requiredExpectedRevisionFromRequest(req, body);
    const existingState = materializeState(readStoredPresetState(row).state);
    const candidateState = Object.hasOwn(body, "state")
      ? ensurePresetState(row.type, row.name, body.state as PresetState)
      : Object.hasOwn(body, "statePatch")
        ? mergePresetState(existingState, body.statePatch as Partial<PresetState>)
        : existingState;
    const nextState = canonicalizeOwnedPresetMedia(ctx, req.user!.id, candidateState);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : undefined;
    const result = db.transaction(() => {
      const concurrentReceipt = receiptRequest && db.getMutationReceipt(row.owner_user_id, row.id, receiptRequest.operation, receiptRequest.key);
      if (concurrentReceipt) {
        assertReceiptMatches(concurrentReceipt.request_hash, receiptRequest!.requestHash);
        return { updated: db.getPresetForUser(row.id, row.owner_user_id), appliedRevision: concurrentReceipt.applied_revision, replay: true };
      }
      const changed = db.updatePreset({ id: row.id, ownerUserId: req.user!.id, name, state: nextState, expectedRevision });
      if (changed) db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "preset.update", payload: { nameChanged: Boolean(name) } });
      if (changed && receiptRequest) storeMutationReceipt(db, receiptRequest, changed.revision);
      return { updated: changed, appliedRevision: changed?.revision, replay: false };
    });
    if (!result.updated) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    if (!result.replay) ctx.realtime?.broadcastPreset(result.updated);
    res.json({ preset: serializePreset(result.updated, ctx), ...(receiptRequest ? { appliedRevision: result.appliedRevision } : {}) });
  });

  api.delete("/presets/:id", requireAuth, (req, res) => {
    const id = routeParam(req, "id");
    if (!db.getPresetForUser(id, req.user!.id)) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const expectedRevision = requiredExpectedRevisionFromRequest(req, {});
    const deleted = db.deletePreset(id, req.user!.id, expectedRevision);
    if (!deleted) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    ctx.realtime?.broadcastPresetDeleted(deleted);
    res.json({ ok: true });
  });

  api.post("/presets/:id/duplicate", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    assertPresetQuota(ctx, req.user!.id);
    const body = requestBody(req);
    const copyName = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : `${row.name} Copy`;
    const copiedState = canonicalizeOwnedPresetMedia(ctx, req.user!.id, cloneStateForShare(readStoredPresetState(row).state));
    const created = db.createPreset({
      ownerUserId: req.user!.id,
      name: copyName,
      type: row.type,
      state: copiedState
    });
    res.status(201).json({ preset: serializePreset(created, ctx) });
  });

  api.post("/presets/:id/share", requireAuth, (req, res) => {
    const body = requestBody(req);
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    const recipientEmail = validateEmail(body.email);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    if (!recipientEmail) {
      res.status(400).json({ error: "Recipient email is required" });
      return;
    }
    const sourceState = readStoredPresetState(row).state;
    const recipient = db.findUserByEmail(recipientEmail);
    const copied =
      recipient?.id === req.user!.id
        ? { state: canonicalizeOwnedPresetMedia(ctx, recipient.id, cloneStateForShare(sourceState)), removed: false }
        : cloneStateWithoutMediaReferences(sourceState);
    reserveDurableShare(ctx, req.user!.id);
    const snapshot = { name: row.name, type: row.type, state: copied.state };
    let receipt: PendingShareRow;
    db.transaction(() => {
      if (recipient) {
        assertPresetQuota(ctx, recipient.id);
        db.createPreset({ ownerUserId: recipient.id, ...snapshot });
      }
      receipt = db.createPendingShare({
        senderUserId: req.user!.id,
        recipientLookupHash: shareLookupHash(ctx, recipientEmail),
        resourceType: "preset",
        snapshot,
        mediaReferencesRemoved: copied.removed,
        recipientUserId: recipient?.id
      });
      db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "preset.share", payload: { receiptId: receipt.receipt_id } });
    });
    res.status(201).json({ ok: true, mediaReferencesRemoved: copied.removed, receiptId: receipt!.receipt_id });
  });

  api.post("/teams/:id/share", requireAuth, (req, res) => {
    const body = requestBody(req);
    const row = db.getTeamForUser(routeParam(req, "id"), req.user!.id);
    const recipientEmail = validateEmail(body.email);
    if (!row) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    if (!recipientEmail) {
      res.status(400).json({ error: "Recipient email is required" });
      return;
    }
    reserveDurableShare(ctx, req.user!.id);
    const source = serializeTeam(row);
    const {
      id: _id,
      revision: _revision,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      dataRecovered: _dataRecovered,
      logoMediaId: _logoMediaId,
      logoUrl: _logoUrl,
      ...snapshot
    } = source;
    const mediaReferencesRemoved = Boolean(source.logoMediaId || source.logoUrl);
    const recipient = db.findUserByEmail(recipientEmail);
    let receipt: PendingShareRow;
    db.transaction(() => {
      if (recipient) {
        assertTeamQuota(ctx, recipient.id);
        db.createTeam({ ownerUserId: recipient.id, team: snapshot });
      }
      receipt = db.createPendingShare({
        senderUserId: req.user!.id,
        recipientLookupHash: shareLookupHash(ctx, recipientEmail),
        resourceType: "team",
        snapshot,
        mediaReferencesRemoved,
        recipientUserId: recipient?.id
      });
    });
    res.status(201).json({ ok: true, mediaReferencesRemoved, receiptId: receipt!.receipt_id });
  });

  api.post("/presets/:id/share-team", requireAuth, (req, res) => {
    const body = requestBody(req);
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    const recipientEmail = validateEmail(body.email);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const state = readStoredPresetState(row).state;
    if (!recipientEmail || !isSoccerState(state)) {
      res.status(400).json({ error: "Recipient email and soccer preset are required" });
      return;
    }
    const recipient = db.findUserByEmail(recipientEmail);
    if (body.side !== undefined && body.side !== "home" && body.side !== "away") throw new RequestValidationError("Invalid team side");
    reserveDurableShare(ctx, req.user!.id);
    const side = body.side === "away" ? "away" : "home";
    const copiedState = createDefaultPresetState("soccer", `${state[side].shortName} Team`);
    let mediaReferencesRemoved = false;
    if (isSoccerState(copiedState)) {
      const sourceTeam = structuredClone(state[side]);
      if (recipient?.id === req.user!.id) {
        copiedState.home = canonicalizeOwnedTeamMedia(ctx, recipient.id, sourceTeam);
      } else {
        mediaReferencesRemoved = Boolean(sourceTeam.logoMediaId || sourceTeam.logoUrl);
        delete sourceTeam.logoMediaId;
        delete sourceTeam.logoUrl;
        copiedState.home = sourceTeam;
      }
    }
    const snapshot = { name: `${state[side].shortName} Team`, type: "soccer" as const, state: copiedState };
    let receipt: PendingShareRow;
    db.transaction(() => {
      if (recipient) {
        assertPresetQuota(ctx, recipient.id);
        db.createPreset({ ownerUserId: recipient.id, ...snapshot });
      }
      receipt = db.createPendingShare({
        senderUserId: req.user!.id,
        recipientLookupHash: shareLookupHash(ctx, recipientEmail),
        resourceType: "preset",
        snapshot,
        mediaReferencesRemoved,
        recipientUserId: recipient?.id
      });
    });
    res.status(201).json({ ok: true, mediaReferencesRemoved, receiptId: receipt!.receipt_id });
  });

  api.post("/presets/:id/action-key", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const actionKey = generateActionKey();
    const updated = db.transaction(() => {
      const changed = db.updatePreset({ id: row.id, ownerUserId: req.user!.id, actionKeyHash: hashActionKey(actionKey), expectedRevision: row.revision });
      if (changed) db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "preset.action-key.rotate", payload: {} });
      return changed;
    });
    if (updated) ctx.realtime?.broadcastPreset(updated);
    res.json({ actionKey, preset: updated ? serializePreset(updated, ctx) : undefined });
  });

  api.get("/presets/:id/events", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    res.json({ events: db.getEventLog(row.id, req.user!.id) });
  });

  api.get("/presets/:id/soccer", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const state = materializeState(readStoredPresetState(row).state);
    if (!isSoccerState(state)) {
      res.status(400).json({ error: "Preset is not a soccer preset" });
      return;
    }
    res.json({ state });
  });

  api.patch("/presets/:id/soccer", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const body = requestBody(req);
    const expectedRevision = requiredExpectedRevisionFromRequest(req, body);
    const state = materializeState(readStoredPresetState(row).state);
    if (!isSoccerState(state)) {
      res.status(400).json({ error: "Preset is not a soccer preset" });
      return;
    }
    let nextState = mergePresetState(state, (isRecord(body.statePatch) ? body.statePatch : presetMutationFields(body)) as Partial<PresetState>) as PresetState;
    if (isSoccerState(nextState) && Object.hasOwn(body, "clockTime")) {
      if (typeof body.clockTime !== "string") throw new RequestValidationError("clockTime must be seconds or M:SS");
      const clockSeconds = tryParseClockTime(body.clockTime);
      if (clockSeconds === null) throw new RequestValidationError("clockTime must be seconds or M:SS");
      nextState = { ...nextState, clock: setClockSeconds(nextState.clock, clockSeconds) };
    }
    nextState = canonicalizeOwnedPresetMedia(ctx, req.user!.id, nextState);
    const updated = db.transaction(() => {
      const changed = db.updatePreset({ id: row.id, ownerUserId: req.user!.id, state: nextState, expectedRevision });
      if (changed) db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "soccer.update", payload: {} });
      return changed;
    });
    if (!updated) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    ctx.realtime?.broadcastPreset(updated);
    res.json({ preset: serializePreset(updated, ctx) });
  });

  api.post(
    "/presets/:id/actions/:action",
    asyncHandler(async (req, res) => {
      const row = authorizePresetAction(req, ctx, routeParam(req, "id"));
      if (!row) {
        if (authenticatedUser(req, ctx)) res.status(404).json({ error: "Preset not found" });
        else res.status(401).json({ error: "Authentication or valid action key required" });
        return;
      }
      const action = routeParam(req, "action");
      if (!isPresetAction(action)) throw new PresetActionValidationError("Unknown preset action");
      const body = req.body === undefined ? {} : requestBody(req);
      const receiptRequest = mutationReceiptRequest(req, row, `action.${action}`, body);
      const priorReceipt = receiptRequest && db.getMutationReceipt(row.owner_user_id, row.id, receiptRequest.operation, receiptRequest.key);
      if (priorReceipt) {
        assertReceiptMatches(priorReceipt.request_hash, receiptRequest!.requestHash);
        res.json({ preset: serializePreset(db.getPresetForUser(row.id, row.owner_user_id)!, ctx), appliedRevision: priorReceipt.applied_revision });
        return;
      }
      authRateLimiter.reserveAction(row.id, req.ip || "unknown");
      const storedState = readStoredPresetState(row).state;
      const actionPayload = validatePresetActionPayload(storedState, action, actionPayloadFields(body));
      const state = applyAction(storedState, action, actionPayload);
      const expectedRevision = expectedRevisionFromRequest(req, body) ?? row.revision;
      const result = db.transaction(() => {
        const concurrentReceipt = receiptRequest && db.getMutationReceipt(row.owner_user_id, row.id, receiptRequest.operation, receiptRequest.key);
        if (concurrentReceipt) {
          assertReceiptMatches(concurrentReceipt.request_hash, receiptRequest!.requestHash);
          return { updated: db.getPresetForUser(row.id, row.owner_user_id), appliedRevision: concurrentReceipt.applied_revision, replay: true };
        }
        const changed = db.updatePreset({ id: row.id, ownerUserId: row.owner_user_id, state, expectedRevision });
        if (changed) db.logEvent({ presetId: row.id, ownerUserId: row.owner_user_id, type: `action.${action}`, payload: actionPayload });
        if (changed && receiptRequest) storeMutationReceipt(db, receiptRequest, changed.revision);
        return { updated: changed, appliedRevision: changed?.revision, replay: false };
      });
      if (!result.updated) {
        res.status(404).json({ error: "Preset not found" });
        return;
      }
      if (!result.replay) ctx.realtime?.broadcastPreset(result.updated);
      res.json({ preset: serializePreset(result.updated, ctx), ...(receiptRequest ? { appliedRevision: result.appliedRevision } : {}) });
    })
  );

  api.get("/overlay/:publicId", (req, res) => {
    const row = db.getPresetByPublicId(routeParam(req, "publicId"));
    if (!row) {
      res.status(404).json({ error: "Overlay not found" });
      return;
    }
    const stored = readStoredPresetState(row);
    const state = materializeState(stored.state);
    res.json({
      overlay: {
        serverTimeMs: Date.now(),
        id: row.id,
        publicId: row.public_id,
        name: row.name,
        type: row.type,
        revision: row.revision,
        stateRecovered: stored.recovered || undefined,
        state: publicOverlayState(state),
        updatedAt: row.updated_at
      }
    });
  });

  api.get("/stage/:publicId", (req, res) => {
    const row = db.getPresetByPublicId(routeParam(req, "publicId"));
    if (!row || !validStageKey(row.stage_key, req.header("X-OpenOverlay-Stage-Key"))) {
      res.status(404).json({ error: "Stage not found" });
      return;
    }
    const stored = readStoredPresetState(row);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      overlay: {
        serverTimeMs: Date.now(),
        id: row.id,
        publicId: row.public_id,
        name: row.name,
        type: row.type,
        revision: row.revision,
        stateRecovered: stored.recovered || undefined,
        state: materializeState(stored.state),
        updatedAt: row.updated_at
      }
    });
  });

  api.get("/media", requireAuth, (req, res) => {
    const limit = parseMediaLimit(req.query.limit);
    const cursor = parseMediaCursor(req.query.cursor);
    const rows = db.listMediaForUser(req.user!.id, limit + 1, cursor);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = hasMore ? page.at(-1) : undefined;
    res.json({ media: page.map((row) => serializeMedia(row)), nextCursor: last ? encodeMediaCursor(last) : null });
  });

  api.post(
    "/media",
    requireAuth,
    (req, _res, next) => {
      authRateLimiter.reserveUpload(req.user!.id, req.ip || "unknown");
      assertMediaQuota(ctx, req.user!.id);
      assertGlobalMediaCapacity(ctx, 0, MAX_MEDIA_UPLOAD_BYTES * MAX_CONCURRENT_MEDIA_UPLOADS * MAX_PARALLEL_BACKEND_SLOTS);
      next();
    },
    (_req, res, next) => {
      if (activeMediaUploads >= MAX_CONCURRENT_MEDIA_UPLOADS) {
        throw new RateLimitError("Too many uploads are already in progress", 1);
      }
      activeMediaUploads += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeMediaUploads = Math.max(0, activeMediaUploads - 1);
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    upload.single("file"),
    asyncHandler(async (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: "File is required" });
        return;
      }
      const media = await saveMediaUpload(ctx, req.user!.id, req.file, () => authenticatedUser(req, ctx)?.id === req.user!.id);
      res.status(201).json({ media: serializeMedia(media) });
    })
  );

  api.delete(
    "/media/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      const row = db.getMediaForUser(routeParam(req, "id"), req.user!.id);
      if (!row) {
        res.status(404).json({ error: "Media not found" });
        return;
      }
      await deleteMediaSafely(ctx, row);
      res.json({ ok: true });
    })
  );

  api.get("/media/file/:publicId", (req, res) => {
    const row = db.getMediaByPublicId(routeParam(req, "publicId"));
    if (!row || !isSafeMediaFile(row.path, ctx.config.uploadDir)) {
      res.status(404).send("Not found");
      return;
    }
    if (row.mime_type === "image/svg+xml") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    }
    res.setHeader("Content-Type", row.mime_type);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(row.path);
  });

  api.get("/media/thumbnail/:publicId", (req, res) => {
    const row = db.getMediaByPublicId(routeParam(req, "publicId"));
    if (!row?.thumbnail_path || !isSafeMediaFile(row.thumbnail_path, ctx.config.uploadDir)) {
      res.status(404).send("Not found");
      return;
    }
    res.setHeader("Content-Type", row.thumbnail_mime_type || "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(row.thumbnail_path);
  });

  api.use((_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    logger.error("request_error", { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof multer.MulterError) {
      res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.message });
      return;
    }
    if (
      error instanceof UploadValidationError ||
      error instanceof RequestValidationError ||
      error instanceof PresetStateValidationError ||
      error instanceof PresetActionValidationError
    ) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof PreconditionRequiredError) {
      res.status(428).json({ error: error.message });
      return;
    }
    if (error instanceof SessionExpiredError) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (error instanceof CorsOriginError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof RateLimitError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      res.status(429).json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds });
      return;
    }
    if (error instanceof RevisionConflictError) {
      res.status(409).json({ error: error.message, currentRevision: error.currentRevision });
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof MediaReferencedError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof MediaQuotaError) {
      res.status(413).json({ error: error.message });
      return;
    }
    if (error instanceof StorageCapacityError) {
      res.status(507).json({ error: error.message });
      return;
    }
    if (error instanceof ResourceQuotaError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (isBodyParserError(error)) {
      res
        .status(error.type === "entity.too.large" ? 413 : 400)
        .json({ error: error.type === "entity.too.large" ? "Request body is too large" : "Malformed JSON body" });
      return;
    }
    if (isSqliteBusyError(error)) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ error: "Database is busy; retry the request" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });

  return {
    app,
    ctx,
    close() {
      clearInterval(mediaReconciliationTimer);
      clearInterval(pendingShareTimer);
      db.close();
    }
  };
}

function authorizePresetAction(req: Request, ctx: AppContext, presetId: string): PresetRow | null {
  const row = ctx.db.getPresetById(presetId);
  if (!row) return null;
  if (authenticatedUser(req, ctx)?.id === row.owner_user_id) return row;
  const actionKey = req.header("x-openoverlay-action-key");
  return verifyActionKey(actionKey, row.action_key_hash) ? row : null;
}

function routeParam(req: Request, key: string): string {
  const value = req.params[key];
  return (Array.isArray(value) ? value[0] : value) || "";
}

function serializePreset(row: PresetRow, ctx: AppContext) {
  const stored = readStoredPresetState(row);
  if (stored.recovered) ctx.logger.warn("preset_state_recovered", { presetId: row.id, type: row.type });
  return {
    serverTimeMs: Date.now(),
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    type: row.type,
    revision: row.revision,
    updatedAt: row.updated_at,
    overlayClientCount: ctx.realtime?.getOverlayClientCount(row.public_id) || 0,
    stateRecovered: stored.recovered || undefined,
    state: materializeState(stored.state)
  };
}

function serializePresetListItem(row: PresetRow, ctx: AppContext) {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    type: row.type,
    revision: row.revision,
    updatedAt: row.updated_at,
    overlayClientCount: ctx.realtime?.getOverlayClientCount(row.public_id) || 0
  };
}

function serializeMedia(row: MediaRow) {
  return {
    id: row.id,
    publicId: row.public_id,
    filename: row.filename,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    url: `/api/v1/media/file/${row.public_id}`,
    thumbnailUrl: row.thumbnail_path ? `/api/v1/media/thumbnail/${row.public_id}` : undefined,
    thumbnailWidth: row.thumbnail_width,
    thumbnailHeight: row.thumbnail_height,
    thumbnailMimeType: row.thumbnail_mime_type,
    thumbnailSizeBytes: row.thumbnail_size_bytes
  };
}

function parseMediaLimit(value: unknown): number {
  if (value === undefined) return MEDIA_PAGE_SIZE;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new RequestValidationError("Media limit must be an integer");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEDIA_PAGE_SIZE)
    throw new RequestValidationError(`Media limit must be from 1 to ${MAX_MEDIA_PAGE_SIZE}`);
  return limit;
}

function parseMediaCursor(value: unknown): { createdAt: string; id: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512) throw new RequestValidationError("Invalid media cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new RequestValidationError("Invalid media cursor");
  }
}

function encodeMediaCursor(row: MediaRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

function serializeTeam(row: TeamRow): TeamLibraryEntry {
  let stored: TeamLibraryEntry;
  let dataRecovered = false;
  try {
    stored = parseTeam(row);
    if (!isRecord(stored)) throw new Error("Stored team is not an object");
  } catch {
    stored = defaultTeam("home") as TeamLibraryEntry;
    dataRecovered = true;
  }
  const sanitized = sanitizeTeamInput(stored as unknown as Record<string, unknown>);
  const normalized = normalizeTeam(sanitized);
  return { ...normalized, id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, dataRecovered: dataRecovered || undefined };
}

function sanitizeTeamInput(
  body: Record<string, unknown>,
  fallback = { ...emptyTeam("home"), shortName: "", abbreviation: "" }
): Omit<TeamLibraryEntry, "id" | "revision" | "createdAt" | "updatedAt"> {
  const fullName = requiredStringField(body.fullName ?? body.name, fallback.fullName || "New Team").slice(0, 120);
  const shortName = stringField(body.shortName, fallback.shortName || fullName).slice(0, 48);
  const rosterText = capRosterText(rawStringField(body.rosterText, fallback.rosterText).slice(0, 10_000));
  return {
    fullName,
    shortName,
    abbreviation: stringField(body.abbreviation, fallback.abbreviation || shortName.slice(0, 3))
      .toUpperCase()
      .slice(0, 5),
    logoMediaId: Object.hasOwn(body, "logoMediaId") ? optionalStringField(body.logoMediaId) : fallback.logoMediaId,
    logoUrl: Object.hasOwn(body, "logoUrl") ? optionalStringField(body.logoUrl) : fallback.logoUrl,
    imageCrop: normalizeImageCrop(isRecord(body.imageCrop) ? body.imageCrop : fallback.imageCrop),
    primaryColor: colorField(body.primaryColor, fallback.primaryColor),
    secondaryColor: colorField(body.secondaryColor, fallback.secondaryColor),
    rosterText,
    roster: parseRoster(rosterText),
    coach: stringField(body.coach, fallback.coach).slice(0, 120),
    schoolName: stringField(body.schoolName, fallback.schoolName).slice(0, 120),
    record: sanitizeRecord(body.record, fallback.record)
  };
}

function assertTeamInputTypes(body: Record<string, unknown>): void {
  for (const field of ["fullName", "name", "shortName", "abbreviation", "rosterText", "coach", "schoolName", "primaryColor", "secondaryColor"] as const) {
    if (Object.hasOwn(body, field) && typeof body[field] !== "string") throw new RequestValidationError(`${field} must be a string`);
  }
  for (const field of ["logoMediaId", "logoUrl"] as const) {
    if (Object.hasOwn(body, field) && body[field] !== null && typeof body[field] !== "string")
      throw new RequestValidationError(`${field} must be a string or null`);
  }
  if (Object.hasOwn(body, "imageCrop") && !isRecord(body.imageCrop)) throw new RequestValidationError("imageCrop must be an object");
  if (Object.hasOwn(body, "record") && !isRecord(body.record)) throw new RequestValidationError("record must be an object");
}

type PersistableTeam = Omit<TeamLibraryEntry, "id" | "revision" | "createdAt" | "updatedAt">;

interface MutableMediaReference {
  id?: string;
  url?: string;
  path: string;
  clear(): void;
  setCanonical(id: string, url: string): void;
}

function canonicalizeOwnedTeamMedia(ctx: AppContext, ownerUserId: string, team: PersistableTeam): PersistableTeam {
  const next = structuredClone(team);
  canonicalizeOwnedMediaReferences(ctx, ownerUserId, [
    {
      id: next.logoMediaId,
      url: next.logoUrl,
      path: "team.logo",
      clear() {
        delete next.logoMediaId;
        delete next.logoUrl;
      },
      setCanonical(id, url) {
        next.logoMediaId = id;
        next.logoUrl = url;
      }
    }
  ]);
  return next;
}

function canonicalizeOwnedPresetMedia(ctx: AppContext, ownerUserId: string, state: PresetState): PresetState {
  const next = cloneStateForShare(state);
  const references: MutableMediaReference[] = [];
  if (isSoccerState(next)) {
    for (const [side, team] of [
      ["home", next.home],
      ["away", next.away]
    ] as const) {
      references.push({
        id: team.logoMediaId,
        url: team.logoUrl,
        path: `state.${side}.logo`,
        clear() {
          delete team.logoMediaId;
          delete team.logoUrl;
        },
        setCanonical(id, url) {
          team.logoMediaId = id;
          team.logoUrl = url;
        }
      });
    }
  } else if (isChurchState(next)) {
    (next.onAirSlide ? [...next.slides, next.onAirSlide] : next.slides).forEach((slide, index) => {
      references.push({
        id: slide.mediaId,
        url: slide.mediaUrl,
        path: `state.slides[${index}].media`,
        clear() {
          delete slide.mediaId;
          delete slide.mediaUrl;
        },
        setCanonical(id, url) {
          slide.mediaId = id;
          slide.mediaUrl = url;
        }
      });
    });
  }
  canonicalizeOwnedMediaReferences(ctx, ownerUserId, references);
  return next;
}

function canonicalizeOwnedMediaReferences(ctx: AppContext, ownerUserId: string, references: MutableMediaReference[]): void {
  for (const reference of references) {
    if ((reference.id === undefined || !reference.id.trim()) && (reference.url === undefined || !reference.url.trim())) {
      reference.clear();
      reference.id = undefined;
      reference.url = undefined;
      continue;
    }
    if (reference.id !== undefined && (!reference.id || reference.id.length > 200)) {
      throw new RequestValidationError(`${reference.path} media ID is invalid`);
    }
    if (reference.url !== undefined && (!reference.url || reference.url.length > 2_048)) {
      throw new RequestValidationError(`${reference.path} media URL is invalid`);
    }
    if (reference.id === undefined && reference.url !== undefined) {
      throw new RequestValidationError(`${reference.path} URL requires an owned media ID`);
    }
  }

  const rows = ctx.db.getMediaForUserByIds(
    references.flatMap((reference) => (reference.id === undefined ? [] : [reference.id])),
    ownerUserId
  );
  const mediaById = new Map(rows.map((row) => [row.id, row]));
  for (const reference of references) {
    if (reference.id === undefined) continue;
    const row = mediaById.get(reference.id);
    if (!row || !fs.existsSync(row.path)) throw new RequestValidationError(`${reference.path} references unavailable media`);
    const canonicalUrl = `/api/v1/media/file/${row.public_id}`;
    const legacyUrl = `/api/media/file/${row.public_id}`;
    if (reference.url !== undefined && reference.url !== canonicalUrl && reference.url !== legacyUrl) {
      throw new RequestValidationError(`${reference.path} URL does not match its media ID`);
    }
    reference.setCanonical(row.id, canonicalUrl);
  }
}

function cloneStateWithoutMediaReferences(state: PresetState): { state: PresetState; removed: boolean } {
  const next = cloneStateForShare(state);
  let removed = false;
  if (isSoccerState(next)) {
    for (const team of [next.home, next.away]) {
      removed = Boolean(team.logoMediaId || team.logoUrl) || removed;
      delete team.logoMediaId;
      delete team.logoUrl;
    }
  } else if (isChurchState(next)) {
    for (const slide of next.onAirSlide ? [...next.slides, next.onAirSlide] : next.slides) {
      removed = Boolean(slide.mediaId || slide.mediaUrl) || removed;
      delete slide.mediaId;
      delete slide.mediaUrl;
    }
  }
  return { state: next, removed };
}

function capRosterText(value: string): string {
  const lines = value.split(/\r?\n/);
  const retained: string[] = [];
  let rosterEntries = 0;
  for (const line of lines) {
    if (line.trim()) {
      if (rosterEntries >= 250) break;
      rosterEntries += 1;
    }
    retained.push(line);
  }
  return retained.join("\n");
}

function sanitizeRecord(input: unknown, fallback?: TeamRecord): TeamRecord {
  const record = isRecord(input) ? input : {};
  return {
    wins: numberField(record.wins, fallback?.wins ?? 0),
    losses: numberField(record.losses, fallback?.losses ?? 0),
    draws: numberField(record.draws, fallback?.draws ?? 0)
  };
}

function stringField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed;
}

function requiredStringField(value: unknown, fallback: string): string {
  return stringField(value, fallback) || fallback;
}

function rawStringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function colorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function numberField(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) ? Math.min(1_000_000, Math.max(0, number)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function csrfOriginGuard(ctx: AppContext) {
  const stateChangingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!stateChangingMethods.has(req.method)) {
      next();
      return;
    }

    const usesSessionCookie = Boolean(req.cookies?.[sessionCookieName()]);
    const hasValidHeaderAuth = Boolean(authenticatedUser(req, ctx, true));
    const origin = req.header("origin");
    if (usesSessionCookie && !hasValidHeaderAuth) {
      const refererOrigin = parseHeaderOrigin(req.header("referer"));
      const requestOrigin = origin && origin !== "null" ? origin : refererOrigin;
      if (requestOrigin && !ctx.config.corsOrigins.includes(requestOrigin)) {
        res.status(403).json({ error: "Origin not allowed" });
        return;
      }
      if (!requestOrigin && ctx.config.env === "production") {
        res.status(403).json({ error: "Origin or Referer header required for cookie-authenticated changes" });
        return;
      }
    }

    next();
  };
}

async function saveMediaUpload(ctx: AppContext, ownerUserId: string, file: Express.Multer.File, sessionStillValid: () => boolean): Promise<MediaRow> {
  if (!allowedMimes.has(file.mimetype)) {
    throw new UploadValidationError("Unsupported image type");
  }

  const extension = extensionByMime[file.mimetype];
  let width: number | null = null;
  let height: number | null = null;

  if (file.mimetype === "image/svg+xml") {
    validateSvg(file.buffer);
  } else {
    const detected = detectRasterImage(file.buffer);
    if (!detected || detected.mimeType !== file.mimetype) throw new UploadValidationError("Image content does not match its declared type");
    width = detected.width;
    height = detected.height;
    if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384 || width * height > 40_000_000) {
      throw new UploadValidationError("Image dimensions are unsupported");
    }
  }

  const normalizedBase = path
    .basename(file.originalname, path.extname(file.originalname))
    .replace(/[^a-z0-9_-]+/gi, "-")
    .slice(0, 80);
  let first = 0;
  let last = normalizedBase.length;
  while (normalizedBase[first] === "-") first += 1;
  while (normalizedBase[last - 1] === "-") last -= 1;
  const safeBase = normalizedBase.slice(first, last);
  const filename = `${randomUUID()}-${safeBase || "upload"}${extension}`;
  const filePath = path.join(ctx.config.uploadDir, filename);
  const stagingPath = `${filePath}${MEDIA_UPLOAD_STAGING_MARKER}${randomUUID()}`;
  const thumbnailPath = path.join(ctx.config.uploadDir, `${randomUUID()}-${safeBase || "upload"}-thumbnail.webp`);
  const thumbnailStagingPath = `${thumbnailPath}${MEDIA_UPLOAD_STAGING_MARKER}${randomUUID()}`;
  let thumbnail: { width: number; height: number; size: number } | undefined;
  let published = false;
  let thumbnailPublished = false;
  try {
    assertGlobalMediaCapacity(ctx, file.size, file.size);
    await fs.promises.mkdir(ctx.config.uploadDir, { recursive: true });
    await fs.promises.writeFile(stagingPath, file.buffer, { mode: 0o640, flag: "wx" });
    if (file.mimetype !== "image/svg+xml") {
      try {
        const thumbnailInfo = await sharp(file.buffer, { limitInputPixels: 40_000_000, failOn: "error" })
          .rotate()
          .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82, effort: 4 })
          .toFile(thumbnailStagingPath);
        thumbnail = { width: thumbnailInfo.width, height: thumbnailInfo.height, size: thumbnailInfo.size };
      } catch (error) {
        await fs.promises.rm(thumbnailStagingPath, { force: true });
        ctx.logger.warn("media_thumbnail_generation_deferred", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return ctx.db.transaction(() => {
      if (!sessionStillValid()) throw new SessionExpiredError("Authentication required");
      const totalSize = file.size + (thumbnail?.size || 0);
      assertMediaQuota(ctx, ownerUserId, totalSize);
      // BEGIN IMMEDIATE serializes this exact global quota check with inserts
      // from another backend slot sharing the same database and upload store.
      assertGlobalMediaCapacity(ctx, totalSize, 0);
      // Publish only after the exact quota checks pass. The rename is atomic
      // within the upload directory, and reconciliation gives newly published
      // managed files a grace window so a candidate slot with an older database
      // snapshot cannot unlink this file before the row below is committed.
      fs.renameSync(stagingPath, filePath);
      published = true;
      if (thumbnail) {
        fs.renameSync(thumbnailStagingPath, thumbnailPath);
        thumbnailPublished = true;
      }
      return ctx.db.createMedia({
        ownerUserId,
        filename,
        originalFilename: path.basename(file.originalname).slice(0, 255),
        mimeType: file.mimetype,
        width,
        height,
        sizeBytes: file.size,
        filePath,
        thumbnailPath: thumbnail ? thumbnailPath : null,
        thumbnailWidth: thumbnail?.width,
        thumbnailHeight: thumbnail?.height,
        thumbnailMimeType: thumbnail ? "image/webp" : null,
        thumbnailSizeBytes: thumbnail?.size
      });
    });
  } catch (error) {
    const cleanupPaths = [stagingPath, thumbnailStagingPath, ...(published ? [filePath] : []), ...(thumbnailPublished ? [thumbnailPath] : [])];
    await Promise.all(
      cleanupPaths.map(async (cleanupPath) => {
        await fs.promises.rm(cleanupPath, { force: true }).catch((cleanupError: unknown) => {
          ctx.logger.error("upload_cleanup_failed", {
            filePath: cleanupPath,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        });
      })
    );
    if (error instanceof StorageCapacityError) throw error;
    if (isStorageExhaustionError(error)) throw new StorageCapacityError("Media storage does not have enough capacity for this upload");
    throw error;
  }
}

function assertMediaQuota(ctx: AppContext, ownerUserId: string, additionalBytes = 0): void {
  const usage = ctx.db.getMediaUsageForUser(ownerUserId);
  if (usage.itemCount >= MAX_MEDIA_ITEMS_PER_USER || usage.sizeBytes + additionalBytes > MAX_MEDIA_BYTES_PER_USER) {
    throw new MediaQuotaError(`Media library limit reached (${MAX_MEDIA_ITEMS_PER_USER} items or ${Math.round(MAX_MEDIA_BYTES_PER_USER / 1024 / 1024)} MB)`);
  }
}

function assertGlobalMediaCapacity(ctx: AppContext, additionalBytes: number, diskReservationBytes: number): void {
  const usage = ctx.db.getGlobalMediaUsage();
  if (usage.sizeBytes >= ctx.config.mediaGlobalMaxBytes || usage.sizeBytes + additionalBytes > ctx.config.mediaGlobalMaxBytes) {
    throw new StorageCapacityError(`Global media storage limit reached (${Math.round(ctx.config.mediaGlobalMaxBytes / 1024 / 1024)} MB)`);
  }

  assertStorageHeadroom(ctx, ctx.config.uploadDir, diskReservationBytes);
}

function assertStorageHeadroom(ctx: AppContext, directory: string, reservationBytes: number): void {
  try {
    const stats = fs.statfsSync(directory, { bigint: true });
    const availableBytes = stats.bavail * stats.bsize;
    const requiredBytes = BigInt(ctx.config.storageMinimumFreeBytes) + BigInt(reservationBytes);
    if (availableBytes < requiredBytes) {
      throw new StorageCapacityError(`Storage must retain at least ${Math.round(ctx.config.storageMinimumFreeBytes / 1024 / 1024)} MB free`);
    }
  } catch (error) {
    if (error instanceof StorageCapacityError) throw error;
    throw new StorageCapacityError("Storage capacity could not be verified");
  }
}

function assertPresetQuota(ctx: AppContext, ownerUserId: string): void {
  if (ctx.db.countPresetsForUser(ownerUserId) >= MAX_PRESETS_PER_USER) {
    throw new ResourceQuotaError(`Game limit reached (${MAX_PRESETS_PER_USER})`);
  }
}

function assertTeamQuota(ctx: AppContext, ownerUserId: string): void {
  if (ctx.db.countTeamsForUser(ownerUserId) >= MAX_TEAMS_PER_USER) {
    throw new ResourceQuotaError(`Team limit reached (${MAX_TEAMS_PER_USER})`);
  }
}

function reserveDurableShare(ctx: AppContext, senderUserId: string): void {
  ctx.db.expirePendingShares();
  if (ctx.db.countOutstandingShares(senderUserId) >= MAX_OUTSTANDING_SHARES) {
    throw new ResourceQuotaError(`Pending share limit reached (${MAX_OUTSTANDING_SHARES})`);
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (ctx.db.countRecentShareRequests(senderUserId, since) >= MAX_DAILY_SHARE_REQUESTS) {
    throw new RateLimitError(`Share request limit reached (${MAX_DAILY_SHARE_REQUESTS} per day)`, 60 * 60);
  }
}

function shareLookupHash(ctx: AppContext, normalizedEmail: string): string {
  return createHmac("sha256", ctx.config.shareLookupSecret).update(normalizedEmail.toLowerCase()).digest("hex");
}

function fulfillPendingShares(ctx: AppContext, user: UserRow): void {
  const pending = ctx.db.listPendingSharesForHash(shareLookupHash(ctx, user.email));
  for (const share of pending) {
    try {
      ctx.db.transaction(() => {
        if (share.resource_type === "preset") {
          assertPresetQuota(ctx, user.id);
          const snapshot = JSON.parse(share.snapshot_json) as { name: string; type: PresetType; state: PresetState };
          dbSafeCreatePreset(ctx, user.id, snapshot);
        } else {
          assertTeamQuota(ctx, user.id);
          const snapshot = JSON.parse(share.snapshot_json) as Omit<TeamLibraryEntry, "id" | "revision" | "createdAt" | "updatedAt">;
          ctx.db.createTeam({ ownerUserId: user.id, team: snapshot });
        }
        ctx.db.fulfillPendingShare(share.id, user.id);
      });
    } catch (error) {
      ctx.logger.error("pending_share_fulfillment_item_failed", { receiptId: share.receipt_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function dbSafeCreatePreset(ctx: AppContext, ownerUserId: string, snapshot: { name: string; type: PresetType; state: PresetState }): void {
  const state = ensurePresetState(snapshot.type, snapshot.name, snapshot.state);
  ctx.db.createPreset({ ownerUserId, name: snapshot.name.slice(0, 120), type: snapshot.type, state });
}

function validateSvg(buffer: Buffer): void {
  if (buffer.includes(0)) throw new UploadValidationError("Invalid SVG encoding");
  const svg = buffer.toString("utf8").replace(/^\uFEFF/, "");
  let offset = 0;
  const skipWhitespace = () => {
    while (offset < svg.length && /\s/.test(svg[offset])) offset += 1;
  };
  skipWhitespace();
  if (svg.slice(offset, offset + 5).toLowerCase() === "<?xml") {
    const end = svg.indexOf(">", offset + 5);
    if (end < 0) throw new UploadValidationError("Invalid SVG");
    offset = end + 1;
    skipWhitespace();
  }
  while (svg.startsWith("<!--", offset)) {
    const end = svg.indexOf("-->", offset + 4);
    if (end < 0) throw new UploadValidationError("Invalid SVG");
    offset = end + 3;
    skipWhitespace();
  }
  if (svg.slice(offset, offset + 4).toLowerCase() !== "<svg" || !/\s|>/.test(svg[offset + 4] || "")) {
    throw new UploadValidationError("Invalid SVG");
  }
  if (
    /(<!doctype|<!entity|<script|javascript:|on\w+\s*=|<foreignObject|<(?:iframe|object|embed|audio|video)\b|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/))/i.test(
      svg
    )
  ) {
    throw new UploadValidationError("SVG contains unsafe content");
  }
}

interface RasterImageInfo {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

function detectRasterImage(buffer: Buffer): RasterImageInfo | null {
  if (isStructurallyValidPng(buffer)) {
    return { mimeType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  const jpeg = readJpegDimensions(buffer);
  if (jpeg) return { mimeType: "image/jpeg", ...jpeg };
  const webp = readWebpDimensions(buffer);
  if (webp) return { mimeType: "image/webp", ...webp };
  return null;
}

function isStructurallyValidPng(buffer: Buffer): boolean {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") return false;
  let offset = 8;
  let sawHeader = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > 10 * 1024 * 1024 || offset + length + 12 > buffer.length) return false;
    const kind = buffer.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader) {
      if (kind !== "IHDR" || length !== 13) return false;
      sawHeader = true;
    }
    offset += length + 12;
    if (kind === "IEND") return length === 0 && offset === buffer.length;
  }
  return false;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 25 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) return null;
  const kind = buffer.toString("ascii", 12, 16);
  const chunkLength = buffer.readUInt32LE(16);
  if (20 + chunkLength > buffer.length) return null;
  if (kind === "VP8X" && chunkLength >= 10 && buffer.length > 30) {
    return { width: 1 + readUInt24LE(buffer, 24), height: 1 + readUInt24LE(buffer, 27) };
  }
  if (kind === "VP8L" && chunkLength >= 5 && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return { width: 1 + b1 + ((b2 & 0x3f) << 8), height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10) };
  }
  if (kind === "VP8 " && chunkLength >= 10 && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

async function deleteMediaSafely(ctx: AppContext, row: MediaRow): Promise<void> {
  const uploadRoot = `${path.resolve(ctx.config.uploadDir)}${path.sep}`;
  if (!path.resolve(row.path).startsWith(uploadRoot)) throw new Error("Refusing to delete media outside the upload directory");
  const sourcePaths = [row.path, ...(row.thumbnail_path ? [row.thumbnail_path] : [])];
  for (const sourcePath of sourcePaths) {
    if (!path.resolve(sourcePath).startsWith(uploadRoot)) throw new Error("Refusing to delete media outside the upload directory");
  }
  const quarantines: Array<{ original: string; tombstone: string }> = [];
  for (const sourcePath of sourcePaths) {
    const tombstone = `${sourcePath}.deleting-${randomUUID()}`;
    try {
      await fs.promises.rename(sourcePath, tombstone);
      quarantines.push({ original: sourcePath, tombstone });
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
  }
  try {
    ctx.db.transaction(() => {
      if (ctx.db.isMediaReferenced(row)) throw new MediaReferencedError("Media is still referenced by a preset or team");
      const deleted = ctx.db.deleteMedia(row.id, row.owner_user_id);
      if (!deleted) throw new RequestValidationError("Media was already deleted");
    });
  } catch (error) {
    if (quarantines.length > 0) {
      try {
        for (const quarantine of quarantines) await fs.promises.rename(quarantine.tombstone, quarantine.original);
      } catch (restoreError) {
        ctx.logger.error("media_restore_failed", {
          path: row.path,
          quarantinePaths: quarantines.map((item) => item.tombstone),
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          originalError: error instanceof Error ? error.message : String(error)
        });
        throw new Error("Media deletion failed and its file could not be restored", { cause: restoreError });
      }
    }
    throw error;
  }
  // Successful deletes intentionally retain their tombstones for 24 hours so
  // an online database snapshot can still resolve bytes for a row it captured.
}

export function reconcileMediaStorage(ctx: AppContext): void {
  const uploadRoot = path.resolve(ctx.config.uploadDir);
  const reconcileStartedAt = Date.now();
  fs.mkdirSync(uploadRoot, { recursive: true, mode: 0o750 });
  const storedPaths = new Set<string>();
  const protectedMissingPaths = new Set<string>();
  for (const storedPath of ctx.db.listMediaPaths()) {
    const filePath = path.resolve(storedPath);
    if (isPathInsideDirectory(filePath, uploadRoot)) storedPaths.add(filePath);
    else ctx.logger.error("media_path_outside_upload_root", { path: filePath });
  }

  for (const entry of fs.readdirSync(uploadRoot, { withFileTypes: true })) {
    const filePath = path.join(uploadRoot, entry.name);
    if (!entry.isFile()) {
      ctx.logger.warn("media_storage_unexpected_entry", { path: filePath });
      continue;
    }
    // Uploads and deletes can still be in flight in the active backend while a
    // blue-green candidate starts against the same storage. Never mutate a
    // recently-created app-managed artifact: its database row may be about to
    // commit, or the deleting quarantine may be about to disappear. Artifacts
    // left by a crash are reclaimed once they are older than the grace window.
    const deletingMarker = filePath.lastIndexOf(".deleting-");
    if (isFreshManagedMediaArtifact(filePath, reconcileStartedAt)) {
      if (deletingMarker >= 0) protectedMissingPaths.add(filePath.slice(0, deletingMarker));
      continue;
    }
    if (deletingMarker >= 0) {
      const originalPath = filePath.slice(0, deletingMarker);
      if (storedPaths.has(originalPath) && !fs.existsSync(originalPath)) {
        fs.renameSync(filePath, originalPath);
        ctx.logger.warn("media_quarantine_restored", { path: originalPath });
      } else {
        fs.rmSync(filePath, { force: true });
        ctx.logger.warn("media_quarantine_removed", { path: filePath });
      }
      continue;
    }
    if (!storedPaths.has(filePath)) {
      fs.rmSync(filePath, { force: true });
      ctx.logger.warn("orphan_media_removed", { path: filePath });
    }
  }

  for (const filePath of storedPaths) {
    if (!protectedMissingPaths.has(filePath) && !fs.existsSync(filePath)) ctx.logger.error("media_file_missing", { path: filePath });
  }
}

function isFreshManagedMediaArtifact(filePath: string, nowMs: number): boolean {
  if (!MANAGED_MEDIA_FILENAME.test(path.basename(filePath))) return false;
  try {
    const ageMs = nowMs - fs.statSync(filePath).mtimeMs;
    return ageMs < MEDIA_RECONCILIATION_GRACE_MS;
  } catch {
    // A concurrent upload/delete may already have atomically moved or removed
    // the path. Treat that as non-actionable reconciliation work.
    return true;
  }
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const root = `${path.resolve(directory)}${path.sep}`;
  return path.resolve(filePath).startsWith(root);
}

function isSafeMediaFile(filePath: string, directory: string): boolean {
  if (!isPathInsideDirectory(filePath, directory)) return false;
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
    const realRoot = `${fs.realpathSync(directory)}${path.sep}`;
    return fs.realpathSync(filePath).startsWith(realRoot);
  } catch {
    return false;
  }
}

function actionPayloadFields(body: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...body };
  delete payload.expectedRevision;
  return payload;
}

function mutationReceiptRequest(req: Request, row: PresetRow, operation: string, body: Record<string, unknown>): MutationReceiptRequest | null {
  const key = req.header("Idempotency-Key");
  if (key === undefined) return null;
  if (!/^[A-Za-z0-9._~-]{8,128}$/.test(key)) throw new RequestValidationError("Invalid Idempotency-Key");
  return {
    ownerUserId: row.owner_user_id,
    resourceId: row.id,
    operation,
    key,
    requestHash: createHash("sha256")
      .update(JSON.stringify([body, req.header("If-Match") ?? null]))
      .digest("hex")
  };
}

function assertReceiptMatches(expected: string, actual: string): void {
  if (expected !== actual) throw new IdempotencyConflictError("Idempotency-Key was already used with a different request");
}

function storeMutationReceipt(db: Database, request: MutationReceiptRequest, appliedRevision: number): void {
  db.recordMutationReceipt({
    owner_user_id: request.ownerUserId,
    resource_id: request.resourceId,
    operation: request.operation,
    idempotency_key: request.key,
    request_hash: request.requestHash,
    applied_revision: appliedRevision
  });
}

function requestBody(req: Request): Record<string, unknown> {
  if (!isRecord(req.body)) throw new RequestValidationError("A JSON object body is required");
  return req.body;
}

function expectedRevisionFromRequest(req: Request, body: Record<string, unknown>): number | undefined {
  const raw = Object.hasOwn(body, "expectedRevision") ? body.expectedRevision : req.header("if-match")?.replace(/^W\//, "").replace(/^"|"$/g, "");
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RequestValidationError("expectedRevision must be a positive integer");
  return parsed;
}

function requiredExpectedRevisionFromRequest(req: Request, body: Record<string, unknown>): number {
  const expectedRevision = expectedRevisionFromRequest(req, body);
  if (expectedRevision === undefined) {
    throw new PreconditionRequiredError("expectedRevision or If-Match is required for mutations");
  }
  return expectedRevision;
}

function presetMutationFields(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body };
  delete copy.expectedRevision;
  delete copy.clockTime;
  return copy;
}

function parseHeaderOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function isUniqueEmailError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed:\s*users\.email/i.test(error.message);
}

function isBodyParserError(error: unknown): error is { type: string } {
  if (typeof error !== "object" || error === null || !("type" in error)) return false;
  return (error as { type?: unknown }).type === "entity.parse.failed" || (error as { type?: unknown }).type === "entity.too.large";
}

function isSqliteBusyError(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isStorageExhaustionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (error as { code?: unknown }).code === "ENOSPC" || (error as { code?: unknown }).code === "EDQUOT";
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}
