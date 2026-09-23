import {
  OPENOVERLAY_API_VERSION,
  OPENOVERLAY_REALTIME_VERSION,
  openOverlayCompatibility,
  type PresetListItem,
  type PresetState,
  type PresetSummary,
  type PresetType,
  type TeamLibraryEntry
} from "@openoverlay/shared";

const DEFAULT_API_HOST =
  window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost" ? "http://127.0.0.1:8734" : window.location.origin;
const VERSIONED_API_PREFIX = `/api/${OPENOVERLAY_API_VERSION}`;
const API_REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;
const HEALTH_REQUEST_TIMEOUT_MS = 10_000;

export const API_BASE = import.meta.env.VITE_API_BASE_URL || DEFAULT_API_HOST;
export const WS_URL = import.meta.env.VITE_WS_URL || API_BASE.replace(/^http/, "ws");
export const FRONTEND_BUILD = {
  ...__OPENOVERLAY_BUILD_INFO__,
  requiredApiVersion: OPENOVERLAY_API_VERSION,
  requiredRealtimeVersion: OPENOVERLAY_REALTIME_VERSION,
  compatibility: openOverlayCompatibility()
};

export interface BuildInfo {
  version: string | null;
  commit: string | null;
  commitShort: string | null;
  requiredApiVersion?: string;
  requiredRealtimeVersion?: string;
}

export interface HealthResponse {
  ok: true;
  app: string;
  component?: string;
  time: string;
  build?: BuildInfo;
  compatibility?: ReturnType<typeof openOverlayCompatibility>;
}

export interface BackupStatus {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  overdue: boolean;
  failedSinceSuccess: boolean;
}

export interface User {
  id: string;
  email: string;
}

export interface MediaItem {
  id: string;
  publicId: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  createdAt: string;
  url: string;
  thumbnailUrl?: string;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
  thumbnailMimeType?: string | null;
  thumbnailSizeBytes?: number | null;
}

export interface ShareReceipt {
  ok: true;
  mediaReferencesRemoved: boolean;
  receiptId: string;
}

export interface PresetEvent {
  id: string;
  preset_id: string;
  owner_user_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface PresetDeletedEvent {
  id: string;
  publicId: string;
  revision: number;
}

const REALTIME_ERROR_MESSAGES = [
  "Realtime connection failed",
  "Incompatible OpenOverlay API or realtime version",
  "Overlay not found",
  "Stage not found",
  "Authentication required",
  "Preset not found"
] as const;

export interface RealtimeErrorMessage {
  error: (typeof REALTIME_ERROR_MESSAGES)[number];
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export const AUTH_EXPIRED_EVENT = "openoverlay:auth-expired";
let authGeneration = 0;
let serverSupportsMutationReceipts = false;
const pendingMutationKeys = new Map<string, string>();

async function receiptMutation<T>(path: string, options: RequestInit, parse: (body: unknown) => T): Promise<T> {
  const signature = `${path}\n${String(options.body ?? "")}\n${new Headers(options.headers).get("If-Match") ?? ""}`;
  const key = pendingMutationKeys.get(signature) ?? crypto.randomUUID();
  pendingMutationKeys.set(signature, key);
  if (pendingMutationKeys.size > 100) pendingMutationKeys.delete(pendingMutationKeys.keys().next().value!);
  const headers = new Headers(options.headers);
  headers.set("Idempotency-Key", key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = parse(await api<unknown>(path, { ...options, headers }));
      pendingMutationKeys.delete(signature);
      return result;
    } catch (error) {
      const ambiguous = (error instanceof ApiError && error.status === 0) || error instanceof TypeError;
      if (!ambiguous) pendingMutationKeys.delete(signature);
      if (!ambiguous || !serverSupportsMutationReceipts || attempt > 0) throw error;
    }
  }
  throw new Error("Mutation recovery failed");
}

function shouldBroadcastAuthExpiration(path: string): boolean {
  return path !== "/api/auth/me" && path !== "/api/auth/login" && path !== "/api/auth/signup";
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const requestAuthGeneration = authGeneration;
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body !== undefined) headers.set("Content-Type", "application/json");
  headers.set("X-OpenOverlay-Api-Version", OPENOVERLAY_API_VERSION);
  return withRequestTimeout(options.signal, API_REQUEST_TIMEOUT_MS, async (signal) => {
    const response = await fetch(`${API_BASE}${versionedApiPath(path)}`, {
      ...options,
      credentials: "include",
      headers,
      signal
    });
    // Authentication status remains authoritative even if an error body is
    // truncated, malformed, or stalls while being read.
    if (response.status === 401 && requestAuthGeneration === authGeneration && shouldBroadcastAuthExpiration(path) && typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    const responseText = response.status === 204 ? "" : await response.text();
    const isJson = response.headers.get("content-type")?.includes("application/json");
    let body: unknown = responseText;
    if (response.ok && response.status !== 204 && !responseText) {
      throw new ApiError(`Server returned an empty response (${response.status})`, response.status, undefined);
    }
    if (response.ok && responseText && !isJson) {
      throw new ApiError(`Server returned a non-JSON response (${response.status})`, response.status, responseText);
    }
    if (isJson && responseText) {
      try {
        body = JSON.parse(responseText) as unknown;
      } catch {
        throw new ApiError(`Server returned malformed JSON (${response.status})`, response.status, responseText);
      }
    } else if (!responseText) {
      body = undefined;
    }
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body && typeof body.error === "string" ? body.error : `Request failed: ${response.status}`;
      const error = new ApiError(message, response.status, body);
      throw error;
    }
    return body as T;
  });
}

function versionedApiPath(path: string): string {
  return path.startsWith("/api/") ? `${VERSIONED_API_PREFIX}${path.slice("/api".length)}` : path;
}

export const authApi = {
  async signup(email: string, password: string) {
    const body = await api<unknown>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
    const user = expectEnvelope(body, "user", isUser);
    // Responses from requests made before this login cannot revoke it.
    authGeneration += 1;
    return { user };
  },
  async login(email: string, password: string) {
    const body = await api<unknown>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    const user = expectEnvelope(body, "user", isUser);
    // Responses from requests made before this login cannot revoke it.
    authGeneration += 1;
    return { user };
  },
  async logout() {
    const result = expectOk(await api<unknown>("/api/auth/logout", { method: "POST" }));
    pendingMutationKeys.clear();
    return result;
  },
  async me() {
    return { user: expectEnvelope(await api<unknown>("/api/auth/me"), "user", isUser) };
  }
};

export const presetApi = {
  async list(signal?: AbortSignal) {
    return { presets: expectArrayEnvelope(await api<unknown>("/api/presets", { signal }), "presets", isPresetListItem) };
  },
  async create(name: string, type: PresetType) {
    return { preset: expectEnvelope(await api<unknown>("/api/presets", { method: "POST", body: JSON.stringify({ name, type }) }), "preset", isPreset) };
  },
  async get(id: string, signal?: AbortSignal) {
    return { preset: expectEnvelope(await api<unknown>(`/api/presets/${id}`, { signal }), "preset", isPreset) };
  },
  async patch(id: string, input: { name?: string; state?: PresetState; statePatch?: Partial<PresetState>; expectedRevision?: number }) {
    return {
      preset: await receiptMutation(`/api/presets/${id}`, { method: "PATCH", body: JSON.stringify(input) }, (body) => expectEnvelope(body, "preset", isPreset))
    };
  },
  async remove(id: string, expectedRevision: number) {
    return expectOk(
      await api<unknown>(`/api/presets/${id}`, {
        method: "DELETE",
        headers: { "If-Match": `"${expectedRevision}"` }
      })
    );
  },
  async duplicate(id: string) {
    return { preset: expectEnvelope(await api<unknown>(`/api/presets/${id}/duplicate`, { method: "POST", body: JSON.stringify({}) }), "preset", isPreset) };
  },
  async share(id: string, email: string) {
    return expectShareReceipt(await api<unknown>(`/api/presets/${id}/share`, { method: "POST", body: JSON.stringify({ email }) }));
  },
  async actionKey(id: string) {
    const body = await api<unknown>(`/api/presets/${id}/action-key`, { method: "POST", body: JSON.stringify({}) });
    const actionKey = expectEnvelope(body, "actionKey", isNonEmptyString);
    const preset = isRecord(body) && body.preset !== undefined ? expectValue(body.preset, "preset", isPreset, body) : undefined;
    return { actionKey, preset };
  },
  async events(id: string) {
    return { events: expectArrayEnvelope(await api<unknown>(`/api/presets/${id}/events`), "events", isPresetEvent) };
  },
  async action(id: string, action: string, payload: Record<string, unknown> = {}, expectedRevision?: number) {
    const preset = await receiptMutation(
      `/api/presets/${id}/actions/${action}`,
      {
        method: "POST",
        body: JSON.stringify(expectedRevision === undefined ? payload : { ...payload, expectedRevision })
      },
      (body) => expectEnvelope(body, "preset", isPreset)
    );
    return { preset };
  }
};

export const overlayApi = {
  async get(publicId: string, signal?: AbortSignal) {
    return { overlay: expectEnvelope(await api<unknown>(`/api/overlay/${publicId}`, { signal }), "overlay", isPreset) };
  },
  async getStage(publicId: string, stageKey: string, signal?: AbortSignal) {
    return {
      overlay: expectEnvelope(await api<unknown>(`/api/stage/${publicId}`, { signal, headers: { "X-OpenOverlay-Stage-Key": stageKey } }), "overlay", isPreset)
    };
  }
};

export const stageApi = {
  async getKey(presetId: string) {
    return api<{ stageKey: string | null; publicId: string }>(`/api/presets/${presetId}/stage`);
  },
  async rotate(presetId: string) {
    return api<{ stageKey: string; publicId: string }>(`/api/presets/${presetId}/stage/rotate`, { method: "POST" });
  },
  async revoke(presetId: string) {
    return api<{ ok: true }>(`/api/presets/${presetId}/stage`, { method: "DELETE" });
  }
};

export const statusApi = {
  async backup(signal?: AbortSignal): Promise<BackupStatus> {
    return (await api<{ backup: BackupStatus }>("/api/operations/backup", { signal })).backup;
  },
  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const health = await withRequestTimeout(signal, HEALTH_REQUEST_TIMEOUT_MS, async (requestSignal) => {
      const response = await fetch(`${API_BASE}/health`, {
        cache: "no-store",
        credentials: "include",
        signal: requestSignal
      });
      const responseText = await response.text();
      let body: unknown;
      try {
        body = responseText ? (JSON.parse(responseText) as unknown) : undefined;
      } catch {
        throw new ApiError(`Health check returned malformed JSON (${response.status})`, response.status, responseText);
      }
      if (!response.ok) {
        const message =
          typeof body === "object" && body && "error" in body && typeof body.error === "string" ? body.error : `Health check failed: ${response.status}`;
        throw new ApiError(message, response.status, body);
      }
      if (!body || typeof body !== "object") throw new ApiError("Health check returned an empty response", response.status, body);
      if (!("ok" in body) || body.ok !== true) throw new ApiError("Health check did not report ok=true", response.status, body);
      return body as HealthResponse;
    });
    serverSupportsMutationReceipts = health.compatibility?.features?.mutationReceipts === true;
    return health;
  }
};

export const teamApi = {
  async list(signal?: AbortSignal) {
    return { teams: expectArrayEnvelope(await api<unknown>("/api/teams", { signal }), "teams", isTeam) };
  },
  async create(input: Partial<TeamLibraryEntry>) {
    return { team: expectEnvelope(await api<unknown>("/api/teams", { method: "POST", body: JSON.stringify(input) }), "team", isTeam) };
  },
  async patch(id: string, input: Partial<TeamLibraryEntry>) {
    const body = await api<unknown>(`/api/teams/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...input, expectedRevision: input.revision })
    });
    return { team: expectEnvelope(body, "team", isTeam) };
  },
  async remove(id: string, expectedRevision: number) {
    return expectOk(
      await api<unknown>(`/api/teams/${id}`, {
        method: "DELETE",
        headers: { "If-Match": `"${expectedRevision}"` }
      })
    );
  },
  async share(id: string, email: string) {
    return expectShareReceipt(await api<unknown>(`/api/teams/${id}/share`, { method: "POST", body: JSON.stringify({ email }) }));
  }
};

export const mediaApi = {
  async list(signal?: AbortSignal, cursor?: string) {
    const query = new URLSearchParams({ limit: "24" });
    if (cursor) query.set("cursor", cursor);
    const body = await api<unknown>(`/api/media?${query}`, { signal });
    return {
      media: expectArrayEnvelope(body, "media", isMedia),
      nextCursor: isRecord(body) && (body.nextCursor === null || typeof body.nextCursor === "string") ? body.nextCursor : null
    };
  },
  async upload(file: File, callerSignal?: AbortSignal): Promise<{ media: MediaItem }> {
    const data = new FormData();
    data.append("file", file);
    return withRequestTimeout(callerSignal, UPLOAD_REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${API_BASE}${versionedApiPath("/api/media")}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "X-OpenOverlay-Api-Version": OPENOVERLAY_API_VERSION
        },
        body: data,
        signal
      });
      const responseText = await response.text();
      let body: unknown;
      try {
        body = responseText ? (JSON.parse(responseText) as unknown) : undefined;
      } catch {
        throw new ApiError(`Upload returned malformed JSON (${response.status})`, response.status, responseText);
      }
      if (!response.ok) {
        const message = typeof body === "object" && body && "error" in body && typeof body.error === "string" ? body.error : "Upload failed";
        throw new ApiError(message, response.status, body);
      }
      if (!body || typeof body !== "object" || !("media" in body)) {
        throw new ApiError("Upload response did not include media", response.status, body);
      }
      return { media: expectEnvelope(body, "media", isMedia) };
    });
  },
  async remove(id: string, signal?: AbortSignal) {
    return expectOk(await api<unknown>(`/api/media/${id}`, { method: "DELETE", signal }));
  },
  mediaUrl(url: string) {
    return url.startsWith("http") ? url : `${API_BASE}${url}`;
  }
};

function expectEnvelope<T>(body: unknown, key: string, validator: (value: unknown) => value is T): T {
  if (!isRecord(body) || !(key in body)) throw invalidResponse(`Server response did not include a valid ${key}`, body);
  return expectValue(body[key], key, validator, body);
}

function expectArrayEnvelope<T>(body: unknown, key: string, validator: (value: unknown) => value is T): T[] {
  const values = expectEnvelope(body, key, Array.isArray);
  if (!values.every(validator)) throw invalidResponse(`Server response included an invalid ${key} item`, body);
  return values;
}

function expectValue<T>(value: unknown, key: string, validator: (value: unknown) => value is T, body: unknown): T {
  if (!validator(value)) throw invalidResponse(`Server response did not include a valid ${key}`, body);
  return value;
}

function expectOk(body: unknown): { ok: true } {
  if (!isRecord(body) || body.ok !== true) throw invalidResponse("Server response did not confirm the operation", body);
  return { ok: true };
}

function expectShareReceipt(body: unknown): ShareReceipt {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 3 ||
    body.ok !== true ||
    typeof body.mediaReferencesRemoved !== "boolean" ||
    !isNonEmptyString(body.receiptId)
  ) {
    throw invalidResponse("Server response did not confirm the share operation", body);
  }
  return { ok: true, mediaReferencesRemoved: body.mediaReferencesRemoved, receiptId: body.receiptId };
}

function invalidResponse(message: string, body: unknown): ApiError {
  return new ApiError(message, 0, body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUser(value: unknown): value is User {
  return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.email);
}

export function isPreset(value: unknown): value is PresetSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.publicId) &&
    typeof value.name === "string" &&
    (value.type === "soccer" || value.type === "church" || value.type === "custom") &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    typeof value.updatedAt === "string" &&
    (value.overlayClientCount === undefined || isNonNegativeInteger(value.overlayClientCount)) &&
    (value.stateRecovered === undefined || typeof value.stateRecovered === "boolean") &&
    (value.serverTimeMs === undefined || (isFiniteNumber(value.serverTimeMs) && value.serverTimeMs > 0)) &&
    isPresetState(value.state, value.type)
  );
}

export function isPresetDeletedEvent(value: unknown): value is PresetDeletedEvent {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.publicId) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1
  );
}

export function isRealtimeErrorMessage(value: unknown): value is RealtimeErrorMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.error === "string" &&
    REALTIME_ERROR_MESSAGES.includes(value.error as RealtimeErrorMessage["error"])
  );
}

function isPresetListItem(value: unknown): value is PresetListItem {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.publicId) &&
    typeof value.name === "string" &&
    (value.type === "soccer" || value.type === "church" || value.type === "custom") &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    typeof value.updatedAt === "string" &&
    (value.overlayClientCount === undefined || isNonNegativeInteger(value.overlayClientCount)) &&
    value.state === undefined
  );
}

function isPresetState(value: unknown, type: PresetType): value is PresetState {
  if (!isRecord(value) || !Array.isArray(value.activeGraphics) || !value.activeGraphics.every(isActiveGraphic)) return false;
  if (type === "soccer") {
    const elements = value.elements;
    if (
      !isTeamState(value.home) ||
      !isTeamState(value.away) ||
      !isPair(value.score) ||
      !isRecord(value.stats) ||
      !isPair(value.stats.shots) ||
      !isPair(value.stats.fouls) ||
      !isPair(value.stats.cards) ||
      !isSoccerClock(value.clock) ||
      !isGlobalStyle(value.style) ||
      !isRecord(elements) ||
      !isOverlayElement(elements.scorebug) ||
      !isOverlayElement(elements.statBug) ||
      !isOverlayElement(elements.sponsorBug) ||
      !isOverlayElement(elements.lowerThird) ||
      !isOverlayElement(elements.countdown) ||
      !isOverlayElement(elements.fullscreen) ||
      !isSoccerPackage(value.soccerPackage)
    )
      return false;
    return typeof value.gameTitle === "string" && typeof value.productionName === "string" && typeof value.scheduledAt === "string";
  }
  if (type === "church") {
    return (
      typeof value.serviceTitle === "string" &&
      Array.isArray(value.sections) &&
      value.sections.every((item) => typeof item === "string") &&
      Array.isArray(value.slides) &&
      value.slides.every(isChurchSlide) &&
      isGlobalStyle(value.style) &&
      isRecord(value.elements) &&
      isOverlayElement(value.elements.lowerThird) &&
      isOverlayElement(value.elements.countdown) &&
      isOverlayElement(value.elements.fullscreenSlide) &&
      (value.selectedSlideId === undefined || typeof value.selectedSlideId === "string")
    );
  }
  return typeof value.title === "string" && isGlobalStyle(value.style) && Array.isArray(value.elements) && value.elements.every(isOverlayElement);
}

function isTeamState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.fullName === "string" &&
    typeof value.shortName === "string" &&
    typeof value.abbreviation === "string" &&
    typeof value.primaryColor === "string" &&
    typeof value.secondaryColor === "string" &&
    (value.logoMediaId === undefined || typeof value.logoMediaId === "string") &&
    (value.logoUrl === undefined || typeof value.logoUrl === "string") &&
    typeof value.rosterText === "string" &&
    Array.isArray(value.roster) &&
    value.roster.every(isRosterEntry) &&
    typeof value.coach === "string" &&
    typeof value.schoolName === "string" &&
    isRecord(value.record) &&
    isFiniteNumber(value.record.wins) &&
    isFiniteNumber(value.record.losses) &&
    isFiniteNumber(value.record.draws) &&
    isRecord(value.imageCrop) &&
    isFiniteNumber(value.imageCrop.x) &&
    isFiniteNumber(value.imageCrop.y) &&
    isFiniteNumber(value.imageCrop.zoom)
  );
}

function isRosterEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.line === "string" &&
    typeof value.name === "string" &&
    typeof value.starter === "boolean" &&
    (value.number === undefined || typeof value.number === "string") &&
    (value.position === undefined || typeof value.position === "string")
  );
}

function isSoccerClock(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.mode === "up" || value.mode === "down") &&
    typeof value.running === "boolean" &&
    isFiniteNumber(value.baseSeconds) &&
    (value.startedAtMs === null || isFiniteNumber(value.startedAtMs)) &&
    isFiniteNumber(value.resetSeconds) &&
    typeof value.stopAtEnabled === "boolean" &&
    isFiniteNumber(value.stopAtSeconds) &&
    typeof value.showStoppage === "boolean" &&
    isFiniteNumber(value.stoppageMinutes) &&
    typeof value.periodLabel === "string"
  );
}

function isSoccerPackage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isSoccerOverlayPackage(value.overlayPackage) ||
    !isRecord(value.colorBanks) ||
    !isColorBank(value.colorBanks.rounded, ["ink", "muted", "line", "gold", "maroon", "wine", "ivory", "sky", "blue", "red"]) ||
    !isColorBank(value.colorBanks.classic, ["bg", "soft", "ink", "muted", "faint", "red", "rule", "panelGray"]) ||
    (value.textAnimation !== undefined && !isSoccerTextAnimation(value.textAnimation)) ||
    (value.activeOverlay !== null && !isSoccerLabOverlay(value.activeOverlay)) ||
    !isSoccerLabOverlay(value.selectedOverlay) ||
    !isOneOf(value.surface, ["pitch", "checker", "studio"]) ||
    typeof value.packageBackground !== "boolean" ||
    !isFiniteNumber(value.packageBackgroundOpacity) ||
    !isOneOf(value.scorebugLayout, ["horizontal", "vertical"]) ||
    !isFiniteNumber(value.scorebugWidth) ||
    !isOneOf(value.lowerResultState, ["HALF", "FINAL"]) ||
    typeof value.oneLineText !== "string" ||
    !isPositionPreset(value.oneLinePosition) ||
    typeof value.twoLineTextA !== "string" ||
    typeof value.twoLineTextB !== "string" ||
    !isPositionPreset(value.twoLinePosition) ||
    (value.lineupTeam !== "home" && value.lineupTeam !== "away") ||
    !isNonNegativeInteger(value.lineupPage) ||
    !isRecord(value.countdown)
  )
    return false;
  const countdown = value.countdown;
  return (
    isFiniteNumber(countdown.seconds) &&
    isFiniteNumber(countdown.resetSeconds) &&
    typeof countdown.running === "boolean" &&
    (countdown.startedAtMs === null || isFiniteNumber(countdown.startedAtMs)) &&
    isOneOf(countdown.mode, ["full", "small"]) &&
    isPositionPreset(countdown.position) &&
    typeof countdown.label === "string"
  );
}

function isSoccerOverlayPackage(value: unknown): boolean {
  return isOneOf(value, ["rounded", "classic"]);
}

function isSoccerLabOverlay(value: unknown): boolean {
  return isOneOf(value, ["full-matchup", "lower-matchup", "lower-result", "lineup-panel", "scorebug", "countdown-timer", "one-line-text", "two-line-text"]);
}

function isSoccerTextAnimation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.id) &&
    Array.isArray(value.fields) &&
    value.fields.every((field) =>
      isOneOf(field, [
        "event-title",
        "production-name",
        "home-name",
        "away-name",
        "home-abbrev",
        "away-abbrev",
        "home-record",
        "away-record",
        "home-logo",
        "away-logo",
        "home-score",
        "away-score",
        "lineup-title",
        "lineup-logo",
        "lineup-rows",
        "one-line",
        "two-line-a",
        "two-line-b"
      ])
    )
  );
}

function isColorBank(value: unknown, requiredKeys: readonly string[]): boolean {
  return isRecord(value) && requiredKeys.every((key) => typeof value[key] === "string") && Object.values(value).every((color) => typeof color === "string");
}

function isGlobalStyle(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.font === "string" &&
    typeof value.accentColor === "string" &&
    isOneOf(value.backgroundMode, ["transparent", "solid", "checker"]) &&
    typeof value.backgroundColor === "string" &&
    isStyleVariant(value.theme) &&
    isOneOf(value.animation, ["subtle", "standard", "flashy"])
  );
}

function isOverlayElement(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.visible === "boolean" &&
    isStyleVariant(value.variant) &&
    (value.accentColor === undefined || typeof value.accentColor === "string") &&
    (value.font === undefined || typeof value.font === "string") &&
    isPlacement(value.placement)
  );
}

function isPlacement(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isFiniteNumber(value.scale) &&
    isPositionPreset(value.preset)
  );
}

function isActiveGraphic(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isOneOf(value.kind, [
      "goal",
      "yellow-card",
      "red-card",
      "substitution",
      "injury",
      "halftime",
      "matchup-full",
      "matchup-lower",
      "lineups",
      "sponsor",
      "lower-third",
      "countdown",
      "fullscreen",
      "blank",
      "team",
      "both-teams",
      "church-slide",
      "church-lower-third"
    ]) &&
    typeof value.title === "string" &&
    (value.subtitle === undefined || typeof value.subtitle === "string") &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.team === undefined || isOneOf(value.team, ["home", "away", "both", "none"])) &&
    isStyleVariant(value.variant) &&
    isPlacement(value.placement) &&
    isFiniteNumber(value.startedAtMs) &&
    isFiniteNumber(value.durationMs) &&
    (value.expiresAtMs === null || isFiniteNumber(value.expiresAtMs)) &&
    (value.payload === undefined || isRecord(value.payload))
  );
}

function isChurchSlide(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.title === "string" &&
    (value.type === "text" || value.type === "image") &&
    typeof value.text === "string" &&
    typeof value.section === "string" &&
    (value.mediaId === undefined || typeof value.mediaId === "string") &&
    (value.mediaUrl === undefined || typeof value.mediaUrl === "string") &&
    typeof value.backgroundColor === "string" &&
    typeof value.textColor === "string" &&
    isStyleVariant(value.variant)
  );
}

function isPositionPreset(value: unknown): boolean {
  return isOneOf(value, ["top-center", "top-left", "top-right", "bottom-center", "bottom-left", "bottom-right", "custom"]);
}

function isStyleVariant(value: unknown): boolean {
  return isOneOf(value, ["clean", "glass", "stripe", "broadcast", "neon"]);
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isPair(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.home) && isFiniteNumber(value.away);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isTeam(value: unknown): value is TeamLibraryEntry {
  return (
    isRecord(value) &&
    isTeamState(value) &&
    isNonEmptyString(value.id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.dataRecovered === undefined || typeof value.dataRecovered === "boolean")
  );
}

function isMedia(value: unknown): value is MediaItem {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.publicId) &&
    isNonEmptyString(value.filename) &&
    typeof value.originalFilename === "string" &&
    typeof value.mimeType === "string" &&
    isFiniteNumber(value.sizeBytes) &&
    (value.width === null || isFiniteNumber(value.width)) &&
    (value.height === null || isFiniteNumber(value.height)) &&
    typeof value.createdAt === "string" &&
    isNonEmptyString(value.url) &&
    (value.thumbnailUrl === undefined || isNonEmptyString(value.thumbnailUrl))
  );
}

function isPresetEvent(value: unknown): value is PresetEvent {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.preset_id) &&
    isNonEmptyString(value.owner_user_id) &&
    typeof value.type === "string" &&
    typeof value.payload_json === "string" &&
    typeof value.created_at === "string"
  );
}

async function withRequestTimeout<T>(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutController = new AbortController();
  const timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutController.signal]) : timeoutController.signal;
  try {
    return await operation(signal);
  } catch (error) {
    if (timeoutController.signal.aborted && !callerSignal?.aborted) {
      throw new ApiError(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`, 0, undefined);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
