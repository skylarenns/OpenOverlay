import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => server.close());

describe("operator backup status", () => {
  it("requires authentication and fails visibly when no scheduled backup exists", async () => {
    await server.request.get("/api/v1/operations/backup").expect(401);
    await signup(server.agent, "backup-operator@example.com");
    const response = await server.agent.get("/api/v1/operations/backup").expect(200);
    expect(response.body.backup).toEqual({ lastSuccessAt: null, lastFailureAt: null, overdue: true, failedSinceSuccess: false });
  });

  it("reports success and later failure without exposing snapshot paths", async () => {
    await signup(server.agent, "backup-status@example.com");
    const lastSuccessAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(server.dir, "backup-status.json"),
      JSON.stringify({ lastSuccessAt, lastFailureAt: new Date().toISOString(), lastSuccessfulSnapshot: "/private/recovery", lastError: "disk full" })
    );
    const response = await server.agent.get("/api/v1/operations/backup").expect(200);
    expect(response.body.backup).toMatchObject({ lastSuccessAt, overdue: false, failedSinceSuccess: true });
    expect(JSON.stringify(response.body)).not.toContain("/private/recovery");
  });
});
