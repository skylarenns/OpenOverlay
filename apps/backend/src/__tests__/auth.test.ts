import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRateLimiter, createSessionToken, SESSION_TTL_SECONDS, verifySessionToken } from "../auth.js";
import { loadConfig } from "../config.js";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  vi.unstubAllEnvs();
  server.close();
});

describe("auth", () => {
  it("keeps session tokens and cookies valid for three months", async () => {
    expect(SESSION_TTL_SECONDS).toBe(90 * 24 * 60 * 60);

    const now = 1_700_000_000;
    const token = createSessionToken("user-1", "test-secret", now);
    expect(verifySessionToken(token, "test-secret", now + SESSION_TTL_SECONDS - 1)?.sub).toBe("user-1");
    expect(verifySessionToken(token, "test-secret", now)?.ver).toBe(1);
    expect(verifySessionToken(token, "test-secret", now + SESSION_TTL_SECONDS)).toBeNull();
    expect(verifySessionToken(token, "test-secret", now + SESSION_TTL_SECONDS + 1)).toBeNull();

    const response = await server.request.post("/api/auth/signup").send({ email: "cookie@example.com", password: "password123" }).expect(201);
    const setCookie = response.headers["set-cookie"];
    expect(Array.isArray(setCookie) ? setCookie.join(";") : setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it("signs up, returns the current user, logs out, and logs back in", async () => {
    const user = await signup(server.agent, "user@example.com");
    expect(user.email).toBe("user@example.com");

    const me = await server.agent.get("/api/auth/me").expect(200);
    expect(me.body.user.email).toBe("user@example.com");
    expect(me.headers["cache-control"]).toBe("no-store");

    await server.agent.post("/api/auth/logout").send({}).expect(200);
    await server.agent.get("/api/auth/me").expect(401);

    await server.agent.post("/api/auth/login").send({ email: "user@example.com", password: "password123" }).expect(200);
    await server.agent.get("/api/auth/me").expect(200);
  });

  it("revokes a captured session token on logout instead of only clearing the browser cookie", async () => {
    const signupResponse = await server.request.post("/api/auth/signup").send({ email: "revoke@example.com", password: "password123" }).expect(201);
    const setCookie = signupResponse.headers["set-cookie"] as unknown as string[];
    const capturedCookie = setCookie[0]!.split(";", 1)[0]!;

    await server.request.post("/api/auth/logout").set("Cookie", capturedCookie).send({}).expect(200);
    await server.request.get("/api/auth/me").set("Cookie", capturedCookie).expect(401);

    const login = await server.request.post("/api/auth/login").send({ email: "revoke@example.com", password: "password123" }).expect(200);
    const replacementCookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";", 1)[0]!;
    await server.request.get("/api/auth/me").set("Cookie", replacementCookie).expect(200);
  });

  it("rate-limits repeated failed login attempts", async () => {
    await signup(server.agent, "limit@example.com");
    for (let i = 0; i < 5; i += 1) {
      await server.request.post("/api/auth/login").send({ email: "limit@example.com", password: "wrong-password" }).expect(401);
    }
    await server.request.post("/api/auth/login").send({ email: "limit@example.com", password: "wrong-password" }).expect(429);
  });

  it("reserves login attempts before bcrypt so concurrent requests are bounded", async () => {
    await signup(server.agent, "parallel-limit@example.com");
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => server.request.post("/api/auth/login").send({ email: "parallel-limit@example.com", password: "wrong-password" }))
    );
    expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
  });

  it("rejects passwords beyond bcrypt's 72-byte boundary", async () => {
    await server.request
      .post("/api/auth/signup")
      .send({ email: "long-ascii@example.com", password: "a".repeat(73) })
      .expect(400);
    await server.request
      .post("/api/auth/signup")
      .send({ email: "long-unicode@example.com", password: "😀".repeat(19) })
      .expect(400);
  });

  it("maps concurrent duplicate signup to conflict instead of an internal error", async () => {
    const responses = await Promise.all([
      server.request.post("/api/auth/signup").send({ email: "race@example.com", password: "password123" }),
      server.request.post("/api/auth/signup").send({ email: "race@example.com", password: "password123" })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it("stops account-backed database growth when the host free-space reserve cannot be maintained", async () => {
    server.backend.ctx.config.storageMinimumFreeBytes = Number.MAX_SAFE_INTEGER;
    const response = await server.request.post("/api/auth/signup").send({ email: "disk-reserve@example.com", password: "password123" }).expect(507);

    expect(response.body.error).toMatch(/retain at least/);
    expect(server.backend.ctx.db.findUserByEmail("disk-reserve@example.com")).toBeUndefined();
  });

  it("prefers a valid bearer token over a stale cookie", async () => {
    const signupResponse = await server.request.post("/api/auth/signup").send({ email: "bearer@example.com", password: "password123" }).expect(201);
    const cookie = (signupResponse.headers["set-cookie"] as unknown as string[])[0];
    const token = cookie.split(";")[0].split("=")[1];
    await server.request.get("/api/auth/me").set("Cookie", "openoverlay_session=stale.invalid").set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("rejects cookie-authenticated state changes from disallowed origins", async () => {
    await signup(server.agent, "origin-check@example.com");

    const rejected = await server.agent.post("/api/teams").set("Origin", "https://evil.example").send({ fullName: "Evil FC", shortName: "Evil" }).expect(403);
    expect(rejected.headers["x-content-type-options"]).toBe("nosniff");

    await server.agent.post("/api/teams").set("Origin", "http://localhost:5173").send({ fullName: "Local FC", shortName: "Local" }).expect(201);
  });

  it("fails closed for invalid environments and weak production secrets", () => {
    expect(() => loadConfig({ env: "prod" as "production", jwtSecret: "x".repeat(32) })).toThrow(/Invalid NODE_ENV/);
    expect(() => loadConfig({ env: "production", jwtSecret: "short" })).toThrow(/at least 32 bytes/);
    expect(() => loadConfig({ env: "production", jwtSecret: "dev-only-openoverlay-session-secret-change-me" })).toThrow(/known development secret/);
    const derived = loadConfig({ env: "production", jwtSecret: "x".repeat(32) });
    expect(derived.shareLookupSecret).toHaveLength(64);
    expect(derived.shareLookupSecret).not.toBe(derived.jwtSecret);
    expect(loadConfig({ env: "production", jwtSecret: "x".repeat(32), shareLookupSecret: "y".repeat(32) }).shareLookupSecret).toBe("y".repeat(32));
  });

  it("fails closed for invalid network configuration", () => {
    expect(() => loadConfig({ port: 0 })).toThrow(/PORT must be an integer/);
    expect(() => loadConfig({ port: 65_536 })).toThrow(/PORT must be an integer/);
    expect(() => loadConfig({ gatewayBackendPorts: [8735, 8735] })).toThrow(/distinct ports/);
    expect(() => loadConfig({ gatewayBackendPorts: [8735] })).toThrow(/at least two/);
    expect(() => loadConfig({ port: 8735, gatewayBackendPorts: [8735, 8736] })).toThrow(/must not match any GATEWAY_BACKEND_PORTS/);
    vi.stubEnv("OPENOVERLAY_SLOT_ID", "test-slot");
    expect(loadConfig({ port: 8735, gatewayBackendPorts: [8735, 8736] }).port).toBe(8735);
    expect(() => loadConfig({ realtimeMaxConnections: 1.5 })).toThrow(/REALTIME_MAX_CONNECTIONS must be a positive integer/);
    expect(() => loadConfig({ mediaGlobalMaxBytes: 0 })).toThrow(/MEDIA_GLOBAL_MAX_BYTES must be a positive integer/);
    expect(() => loadConfig({ storageMinimumFreeBytes: -1 })).toThrow(/STORAGE_MINIMUM_FREE_BYTES must be a non-negative integer/);
    expect(() => loadConfig({ host: "" })).toThrow(/HOST must be a non-empty host/);
    expect(loadConfig({ gatewayControlSocket: "/tmp/openoverlay-test-control.sock" }).gatewayControlSocket).toBe("/tmp/openoverlay-test-control.sock");
    expect(() => loadConfig({ corsOrigins: ["https://example.com", "https://example.com"] })).toThrow(/duplicates/);
    expect(() => loadConfig({ corsOrigins: ["https://example.com/path"] })).toThrow(/valid HTTP/);
    expect(() => loadConfig({ frontendUrl: "javascript:alert(1)" })).toThrow(/valid HTTP/);
  });

  it("bounds authenticated writes and action-key traffic", () => {
    const writes = new AuthRateLimiter();
    for (let index = 0; index < 600; index += 1) writes.reserveWrite("user-1", "127.0.0.1", 1_000);
    expect(() => writes.reserveWrite("user-1", "127.0.0.1", 1_000)).toThrow(/Too many write requests/);

    const actions = new AuthRateLimiter();
    for (let index = 0; index < 600; index += 1) actions.reserveAction("preset-1", "127.0.0.2", 1_000);
    expect(() => actions.reserveAction("preset-1", "127.0.0.2", 1_000)).toThrow(/Too many action requests/);

    const reads = new AuthRateLimiter();
    for (let index = 0; index < 120; index += 1) reads.reserveSensitiveRead("user-1", "127.0.0.3", 1_000);
    expect(() => reads.reserveSensitiveRead("user-1", "127.0.0.3", 1_000)).toThrow(/Too many sensitive read requests/);
  });
});
