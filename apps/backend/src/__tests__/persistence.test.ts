import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createBackendApp } from "../app.js";
import { CURRENT_READER_VERSION, CURRENT_SCHEMA_VERSION } from "../db.js";

describe("persistence", () => {
  it("keeps overlay state after backend restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-persist-"));
    const config = {
      env: "test" as const,
      databasePath: path.join(dir, "db.sqlite"),
      uploadDir: path.join(dir, "uploads"),
      logFile: path.join(dir, "backend.log"),
      jwtSecret: "test-secret",
      corsOrigins: ["http://localhost:5173"]
    };

    const first = createBackendApp(config);
    expect(first.ctx.db.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(CURRENT_SCHEMA_VERSION);
    const agent = request.agent(first.app);
    await agent.post("/api/auth/signup").send({ email: "persist@example.com", password: "password123" }).expect(201);
    const created = await agent.post("/api/presets").send({ name: "Persistent Match", type: "soccer" }).expect(201);
    await agent.post(`/api/presets/${created.body.preset.id}/actions/home-score-plus`).send({}).expect(200);
    first.close();

    const second = createBackendApp(config);
    try {
      const overlay = await request(second.app).get(`/api/overlay/${created.body.preset.publicId}`).expect(200);
      expect(overlay.body.overlay.state.score.home).toBe(1);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open a database created by a newer runtime", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-future-schema-"));
    const config = {
      env: "test" as const,
      databasePath: path.join(dir, "db.sqlite"),
      uploadDir: path.join(dir, "uploads"),
      logFile: path.join(dir, "backend.log"),
      jwtSecret: "test-secret",
      corsOrigins: ["http://localhost:5173"]
    };
    const first = createBackendApp(config);
    first.close();
    const database = new DatabaseSync(config.databasePath);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
    database.close();

    try {
      expect(() => createBackendApp(config)).toThrow(/newer than supported/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens an additive newer schema only when it explicitly supports this reader", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-compatible-schema-"));
    const config = {
      env: "test" as const,
      databasePath: path.join(dir, "db.sqlite"),
      uploadDir: path.join(dir, "uploads"),
      logFile: path.join(dir, "backend.log"),
      jwtSecret: "test-secret",
      corsOrigins: ["http://localhost:5173"]
    };
    const first = createBackendApp(config);
    first.close();
    const database = new DatabaseSync(config.databasePath);
    database
      .prepare("INSERT INTO schema_compatibility VALUES (?, ?, ?, ?)")
      .run(CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION + 1, CURRENT_READER_VERSION, new Date().toISOString());
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
    database.close();

    const compatible = createBackendApp(config);
    try {
      expect(compatible.ctx.db.healthCheck()).toBe(true);
    } finally {
      compatible.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates version-one users with a revocable session generation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-session-migration-"));
    const config = {
      env: "test" as const,
      databasePath: path.join(dir, "db.sqlite"),
      uploadDir: path.join(dir, "uploads"),
      logFile: path.join(dir, "backend.log"),
      jwtSecret: "test-secret",
      corsOrigins: ["http://localhost:5173"]
    };
    const first = createBackendApp(config);
    const agent = request.agent(first.app);
    const signup = await agent.post("/api/auth/signup").send({ email: "legacy@example.com", password: "password123" }).expect(201);
    first.close();

    const legacyDatabase = new DatabaseSync(config.databasePath);
    legacyDatabase.exec("DELETE FROM schema_migrations WHERE version = 2");
    legacyDatabase.exec("ALTER TABLE users DROP COLUMN session_version");
    legacyDatabase.close();

    const migrated = createBackendApp(config);
    try {
      expect(migrated.ctx.db.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrated.ctx.db.findUserById(signup.body.user.id)?.session_version).toBe(1);
    } finally {
      migrated.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
