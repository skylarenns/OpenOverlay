import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultChurchState } from "@openoverlay/shared";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  server.close();
});

describe("preset integrity and API resilience", () => {
  it("keeps drafts and notes off public output while stage requires a rotatable key", async () => {
    await signup(server.agent, "stage-boundary@example.com");
    const state = createDefaultChurchState("Private service");
    state.slides = [
      { ...state.slides[0], id: "draft", text: "Unpublished draft", notes: "Private cue" },
      { ...state.slides[0], id: "live", text: "Published slide", notes: "Stage only" }
    ];
    state.selectedSlideId = "draft";
    state.onAirSlide = structuredClone(state.slides[1]);
    state.stageMessage = "Stage message secret";
    state.elements.fullscreenSlide.visible = true;
    const created = await server.agent.post("/api/presets").send({ name: "Private service", type: "church", state }).expect(201);
    const id = created.body.preset.id as string;
    const publicId = created.body.preset.publicId as string;
    const publicResponse = await server.request.get(`/api/v1/overlay/${publicId}`).expect(200);
    expect(JSON.stringify(publicResponse.body)).not.toMatch(/Unpublished draft|Private cue|Stage only|Stage message secret/);
    expect(publicResponse.body.overlay.state.slides).toHaveLength(1);
    expect(publicResponse.body.overlay.state.slides[0].text).toBe("Published slide");
    await server.request.get(`/api/v1/stage/${publicId}`).expect(404);
    const first = await server.agent.get(`/api/v1/presets/${id}/stage`).expect(200);
    const key = first.body.stageKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stage = await server.request.get(`/api/v1/stage/${publicId}`).set("X-OpenOverlay-Stage-Key", key).expect(200);
    expect(stage.body.overlay.state.stageMessage).toBe("Stage message secret");
    expect(stage.body.overlay.state.slides).toHaveLength(2);
    const rotated = await server.agent.post(`/api/v1/presets/${id}/stage/rotate`).expect(200);
    expect(rotated.body.stageKey).not.toBe(key);
    await server.request.get(`/api/v1/stage/${publicId}`).set("X-OpenOverlay-Stage-Key", key).expect(404);
    await server.request.get(`/api/v1/stage/${publicId}`).set("X-OpenOverlay-Stage-Key", rotated.body.stageKey).expect(200);
    await server.agent.delete(`/api/v1/presets/${id}/stage`).expect(200);
    await server.request.get(`/api/v1/stage/${publicId}`).set("X-OpenOverlay-Stage-Key", rotated.body.stageKey).expect(404);
  });
  it("rejects incomplete explicit states before persistence", async () => {
    await signup(server.agent, "state-create@example.com");
    await server.agent.post("/api/presets").send({ name: "Broken", type: "soccer", state: {} }).expect(400);
    const list = await server.agent.get("/api/presets").expect(200);
    expect(list.body.presets).toHaveLength(0);
  });

  it("accepts payload-free actions and rejects invalid team fields and share sides", async () => {
    await signup(server.agent, "action-validation@example.com");
    const preset = await server.agent.post("/api/presets").send({ name: "Match", type: "soccer" }).expect(201);
    const id = preset.body.preset.id as string;
    const action = await server.agent.post(`/api/v1/presets/${id}/actions/home-score-plus`).expect(200);
    expect(action.body.preset.state.score.home).toBe(1);
    await server.agent.post("/api/teams").send({ fullName: 123 }).expect(400);
    const team = await server.agent.post("/api/teams").send({ fullName: "Home" }).expect(201);
    await server.agent.patch(`/api/teams/${team.body.team.id}`).send({ coach: false, expectedRevision: 1 }).expect(400);
    await server.agent.post(`/api/presets/${id}/share-team`).send({ email: "recipient@example.com", side: "invalid" }).expect(400);
  });

  it("recovers lost mutation responses without applying an action twice", async () => {
    await signup(server.agent, "receipt-recovery@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Receipt", type: "soccer" }).expect(201);
    const id = created.body.preset.id as string;
    const actionPath = `/api/v1/presets/${id}/actions/home-score-plus`;
    const first = await server.agent.post(actionPath).set("Idempotency-Key", "score-event-0001").send({ expectedRevision: 1 }).expect(200);
    expect(first.body.appliedRevision).toBe(2);
    const later = await server.agent.post(actionPath).send({ expectedRevision: 2 }).expect(200);
    expect(later.body.preset.state.score.home).toBe(2);
    const replay = await server.agent.post(actionPath).set("Idempotency-Key", "score-event-0001").send({ expectedRevision: 1 }).expect(200);
    expect(replay.body.appliedRevision).toBe(2);
    expect(replay.body.preset.revision).toBe(3);
    expect(replay.body.preset.state.score.home).toBe(2);
    await server.agent.post(actionPath).set("Idempotency-Key", "score-event-0001").send({ expectedRevision: 3 }).expect(409);

    const patch = await server.agent
      .patch(`/api/v1/presets/${id}`)
      .set("Idempotency-Key", "patch-event-0001")
      .send({ expectedRevision: 3, name: "Renamed" })
      .expect(200);
    expect(patch.body.appliedRevision).toBe(4);
    const patchReplay = await server.agent
      .patch(`/api/v1/presets/${id}`)
      .set("Idempotency-Key", "patch-event-0001")
      .send({ expectedRevision: 3, name: "Renamed" })
      .expect(200);
    expect(patchReplay.body.preset.revision).toBe(4);
    expect(patchReplay.body.appliedRevision).toBe(4);
  });

  it("recovers corrupt stored rows without taking down list or overlay reads", async () => {
    await signup(server.agent, "state-recovery@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Recover", type: "soccer" }).expect(201);
    server.backend.ctx.db.run("UPDATE presets SET state_json = ? WHERE id = ?", ["{}", created.body.preset.id]);

    const list = await server.agent.get("/api/presets").expect(200);
    expect(list.body.presets[0].state).toBeUndefined();
    expect(list.body.presets[0].stateRecovered).toBeUndefined();
    const detail = await server.agent.get(`/api/presets/${created.body.preset.id}`).expect(200);
    expect(detail.body.preset.stateRecovered).toBe(true);
    expect(detail.body.preset.state.activeGraphics).toEqual([]);
    const overlay = await server.request.get(`/api/overlay/${created.body.preset.publicId}`).expect(200);
    expect(overlay.body.overlay.stateRecovered).toBe(true);
  });

  it("keeps preset list responses bounded by omitting full state", async () => {
    await signup(server.agent, "bounded-list@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Large state", type: "soccer" }).expect(201);
    const padded = { ...created.body.preset.state, futureSafeField: "x".repeat(400_000) };
    server.backend.ctx.db.run("UPDATE presets SET state_json = ? WHERE id = ?", [JSON.stringify(padded), created.body.preset.id]);

    const list = await server.agent.get("/api/presets").expect(200);
    expect(list.body.presets[0].state).toBeUndefined();
    expect(JSON.stringify(list.body).length).toBeLessThan(2_000);
  });

  it("does not flood the file log with successful public overlay reads", async () => {
    await signup(server.agent, "public-log@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Public", type: "soccer" }).expect(201);
    await server.request.get(`/api/v1/overlay/${created.body.preset.publicId}`).expect(200);
    await server.request.get("/api/v1/overlay/missing-public-log-id").expect(404);
    await server.backend.ctx.logger.flush?.();

    const contents = fs.readFileSync(path.join(server.dir, "backend.log"), "utf8");
    expect(contents).not.toContain(`/api/v1/overlay/${created.body.preset.publicId}`);
    expect(contents).toContain("/api/v1/overlay/missing-public-log-id");
  });

  it("isolates a malformed stored team row and exposes a recoverable safe default", async () => {
    await signup(server.agent, "team-recovery@example.com");
    const created = await server.agent.post("/api/teams").send({ fullName: "Recover Team" }).expect(201);
    server.backend.ctx.db.run("UPDATE teams SET team_json = ? WHERE id = ?", ["{", created.body.team.id]);

    const list = await server.agent.get("/api/teams").expect(200);
    expect(list.body.teams).toHaveLength(1);
    expect(list.body.teams[0].dataRecovered).toBe(true);
    expect(list.body.teams[0].fullName).toBeTruthy();
  });

  it("rejects malformed patches and prototype-pollution keys without changing state", async () => {
    await signup(server.agent, "state-patch@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Safe", type: "soccer" }).expect(201);
    await server.agent
      .patch(`/api/presets/${created.body.preset.id}`)
      .send({ statePatch: { activeGraphics: null }, expectedRevision: 1 })
      .expect(400);
    await server.agent
      .patch(`/api/presets/${created.body.preset.id}`)
      .set("Content-Type", "application/json")
      .send('{"statePatch":{"__proto__":{"polluted":true}},"expectedRevision":1}')
      .expect(400);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const current = await server.agent.get(`/api/presets/${created.body.preset.id}`).expect(200);
    expect(current.body.preset.revision).toBe(1);
  });

  it("uses revisions to reject stale writes", async () => {
    await signup(server.agent, "revision@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Initial", type: "soccer" }).expect(201);
    expect(created.body.preset.revision).toBe(1);
    const missing = await server.agent.patch(`/api/presets/${created.body.preset.id}`).send({ name: "Unconditional" }).expect(428);
    expect(missing.body.error).toMatch(/expectedRevision|If-Match/);
    const first = await server.agent.patch(`/api/presets/${created.body.preset.id}`).set("If-Match", '"1"').send({ name: "First" }).expect(200);
    expect(first.body.preset.revision).toBe(2);
    const stale = await server.agent.patch(`/api/presets/${created.body.preset.id}`).send({ name: "Stale", expectedRevision: 1 }).expect(409);
    expect(stale.body.currentRevision).toBe(2);
    const current = await server.agent.get(`/api/presets/${created.body.preset.id}`).expect(200);
    expect(current.body.preset.name).toBe("First");
  });

  it("uses revisions to reject stale team writes", async () => {
    await signup(server.agent, "team-revision@example.com");
    const created = await server.agent.post("/api/teams").send({ fullName: "Initial FC" }).expect(201);
    expect(created.body.team.revision).toBe(1);
    const missing = await server.agent.patch(`/api/teams/${created.body.team.id}`).send({ fullName: "Unconditional FC" }).expect(428);
    expect(missing.body.error).toMatch(/expectedRevision|If-Match/);
    const first = await server.agent.patch(`/api/teams/${created.body.team.id}`).send({ fullName: "First FC", expectedRevision: 1 }).expect(200);
    expect(first.body.team.revision).toBe(2);
    const stale = await server.agent.patch(`/api/teams/${created.body.team.id}`).send({ fullName: "Stale FC", expectedRevision: 1 }).expect(409);
    expect(stale.body.currentRevision).toBe(2);
    const list = await server.agent.get("/api/teams").expect(200);
    expect(list.body.teams[0].fullName).toBe("First FC");
  });

  it("requires the current revision before deleting a preset", async () => {
    await signup(server.agent, "preset-delete-cas@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Delete CAS", type: "soccer" }).expect(201);
    const id = created.body.preset.id as string;
    await server.agent.patch(`/api/presets/${id}`).send({ name: "Newer", expectedRevision: 1 }).expect(200);

    await server.agent.delete(`/api/presets/${id}`).expect(428);
    const stale = await server.agent.delete(`/api/presets/${id}`).set("If-Match", '"1"').expect(409);
    expect(stale.body.currentRevision).toBe(2);
    await server.agent.get(`/api/presets/${id}`).expect(200);

    await server.agent.delete(`/api/presets/${id}`).set("If-Match", '"2"').expect(200);
    await server.agent.get(`/api/presets/${id}`).expect(404);
  });

  it("requires the current revision before deleting a team", async () => {
    await signup(server.agent, "team-delete-cas@example.com");
    const created = await server.agent.post("/api/teams").send({ fullName: "Delete FC" }).expect(201);
    const id = created.body.team.id as string;
    await server.agent.patch(`/api/teams/${id}`).send({ fullName: "Newer FC", expectedRevision: 1 }).expect(200);

    await server.agent.delete(`/api/teams/${id}`).expect(428);
    const stale = await server.agent.delete(`/api/teams/${id}`).set("If-Match", '"1"').expect(409);
    expect(stale.body.currentRevision).toBe(2);
    expect((await server.agent.get("/api/teams").expect(200)).body.teams).toHaveLength(1);

    await server.agent.delete(`/api/teams/${id}`).set("If-Match", '"2"').expect(200);
    expect((await server.agent.get("/api/teams").expect(200)).body.teams).toHaveLength(0);
  });

  it("rejects domain-invalid scores, enum values, and placements", async () => {
    await signup(server.agent, "domain-validation@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Domain", type: "soccer" }).expect(201);
    const negativeScore = structuredClone(created.body.preset.state);
    negativeScore.score.home = -1;
    await server.agent.patch(`/api/presets/${created.body.preset.id}`).send({ state: negativeScore, expectedRevision: 1 }).expect(400);
    const invalidEnum = structuredClone(created.body.preset.state);
    invalidEnum.style.theme = "unknown";
    await server.agent.patch(`/api/presets/${created.body.preset.id}`).send({ state: invalidEnum, expectedRevision: 1 }).expect(400);
    const invalidPlacement = structuredClone(created.body.preset.state);
    invalidPlacement.elements.scorebug.placement.width = 0;
    await server.agent.patch(`/api/presets/${created.body.preset.id}`).send({ state: invalidPlacement, expectedRevision: 1 }).expect(400);
  });

  it("rejects malformed clock text without resetting or revising the preset", async () => {
    await signup(server.agent, "clock-validation@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Clock", type: "soccer" }).expect(201);

    const missing = await server.agent.patch(`/api/presets/${created.body.preset.id}/soccer`).send({ clockTime: "1:02" }).expect(428);
    expect(missing.body.error).toMatch(/expectedRevision|If-Match/);

    for (const clockTime of ["", "1:60", "1abc", -1, null]) {
      const response = await server.agent.patch(`/api/presets/${created.body.preset.id}/soccer`).send({ clockTime, expectedRevision: 1 }).expect(400);
      expect(response.body.error).toMatch(/clockTime/);
    }

    const current = await server.agent.get(`/api/presets/${created.body.preset.id}`).expect(200);
    expect(current.body.preset.revision).toBe(1);
    expect(current.body.preset.state.clock.baseSeconds).toBe(0);

    const valid = await server.agent.patch(`/api/presets/${created.body.preset.id}/soccer`).send({ clockTime: "1:02", expectedRevision: 1 }).expect(200);
    expect(valid.body.preset.state.clock.baseSeconds).toBe(62);
  });

  it("caps saved-team roster text at 250 canonical entries", async () => {
    await signup(server.agent, "team-roster-boundary@example.com");
    const rosterText = Array.from({ length: 300 }, (_, index) => `${index} Player ${index}`).join("\n");

    const created = await server.agent.post("/api/teams").send({ fullName: "Boundary FC", rosterText }).expect(201);

    expect(created.body.team.roster).toHaveLength(250);
    expect(created.body.team.rosterText.split("\n")).toHaveLength(250);
    expect(created.body.team.roster.at(-1).line).toBe("249 Player 249");
  });

  it("rolls state updates back when their event log write fails", async () => {
    await signup(server.agent, "transaction@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Atomic", type: "soccer" }).expect(201);
    const originalLogEvent = server.backend.ctx.db.logEvent.bind(server.backend.ctx.db);
    server.backend.ctx.db.logEvent = () => {
      throw new Error("simulated log failure");
    };
    await server.agent.post(`/api/presets/${created.body.preset.id}/actions/home-score-plus`).send({ expectedRevision: 1 }).expect(500);
    server.backend.ctx.db.logEvent = originalLogEvent;
    const current = await server.agent.get(`/api/presets/${created.body.preset.id}`).expect(200);
    expect(current.body.preset.revision).toBe(1);
    expect(current.body.preset.state.score.home).toBe(0);
  });

  it("rejects unknown actions and accepts action keys only in the dedicated header", async () => {
    await signup(server.agent, "action-key@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Actions", type: "soccer" }).expect(201);
    await server.agent.post(`/api/presets/${created.body.preset.id}/actions/not-real`).send({}).expect(400);
    const key = await server.agent.post(`/api/presets/${created.body.preset.id}/action-key`).expect(200);
    await server.request.post(`/api/presets/${created.body.preset.id}/actions/home-score-plus?key=${key.body.actionKey}`).send({}).expect(401);
    await server.request.post(`/api/presets/${created.body.preset.id}/actions/home-score-plus`).send({ actionKey: key.body.actionKey }).expect(401);
    await server.request
      .post(`/api/presets/${created.body.preset.id}/actions/home-score-plus`)
      .set("x-openoverlay-action-key", key.body.actionKey)
      .send({})
      .expect(200);
  });

  it("returns not-found rather than a false session-expiry response for an authenticated stale action URL", async () => {
    await signup(server.agent, "stale-action@example.com");
    await server.agent.post("/api/presets/missing/actions/home-score-plus").send({}).expect(404);
    await server.agent.get("/api/auth/me").expect(200);
    await server.request.post("/api/presets/missing/actions/home-score-plus").send({}).expect(401);
  });

  it("rejects undocumented action fields instead of persisting and broadcasting arbitrary payloads", async () => {
    await signup(server.agent, "action-payload@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Payload", type: "soccer" }).expect(201);

    await server.agent
      .post(`/api/presets/${created.body.preset.id}/actions/trigger-goal`)
      .send({ expectedRevision: 1, title: "Goal", unexpected: "x".repeat(10_000) })
      .expect(400);

    const invalidPayloads: Array<[string, Record<string, unknown>]> = [
      ["home-score-plus", { title: "irrelevant" }],
      ["trigger-goal", { overlay: "scorebug" }],
      ["show-overlay", { title: "irrelevant" }],
      ["trigger-goal", { title: 42 }],
      ["trigger-goal", { team: "both" }],
      ["show-overlay", { overlay: "not-an-overlay" }],
      ["trigger-goal", { title: "x".repeat(501) }],
      ["trigger-goal", { title: "😀".repeat(250), subtitle: "😀".repeat(250), label: "😀".repeat(100) }]
    ];
    for (const [action, payload] of invalidPayloads) {
      await server.agent
        .post(`/api/presets/${created.body.preset.id}/actions/${action}`)
        .send({ expectedRevision: 1, ...payload })
        .expect(400);
    }
    const current = await server.agent.get(`/api/presets/${created.body.preset.id}`).expect(200);
    expect(current.body.preset.revision).toBe(1);
    expect(current.body.preset.state.activeGraphics).toEqual([]);

    await server.agent
      .post(`/api/presets/${created.body.preset.id}/actions/trigger-goal`)
      .send({ expectedRevision: 1, title: "Goal", team: "home", durationSeconds: 0 })
      .expect(200);
    const events = await server.agent.get(`/api/presets/${created.body.preset.id}/events`).expect(200);
    const actionEvent = events.body.events.find((event: { type: string }) => event.type === "action.trigger-goal");
    expect(JSON.parse(actionEvent.payload_json)).toEqual({ title: "Goal", team: "home", durationSeconds: 0 });
    expect(Buffer.byteLength(actionEvent.payload_json, "utf8")).toBeLessThanOrEqual(2 * 1024);
  });

  it("returns structured client errors for malformed JSON, missing bodies, and API misses", async () => {
    await server.request.post("/api/auth/signup").expect(400);
    const malformed = await server.request.post("/api/auth/signup").set("Content-Type", "application/json").send("{").expect(400);
    expect(malformed.headers["x-content-type-options"]).toBe("nosniff");
    const missing = await server.request.get("/api/does-not-exist").expect(404);
    expect(missing.body.error).toBe("API route not found");
  });

  it("enforces per-user game and team quotas before creating more rows", async () => {
    await signup(server.agent, "resource-quota@example.com");
    const originalPresetCount = server.backend.ctx.db.countPresetsForUser.bind(server.backend.ctx.db);
    const originalTeamCount = server.backend.ctx.db.countTeamsForUser.bind(server.backend.ctx.db);
    server.backend.ctx.db.countPresetsForUser = () => 100;
    server.backend.ctx.db.countTeamsForUser = () => 250;

    await server.agent.post("/api/presets").send({ name: "Over quota", type: "soccer" }).expect(409);
    await server.agent.post("/api/teams").send({ fullName: "Over quota" }).expect(409);

    server.backend.ctx.db.countPresetsForUser = originalPresetCount;
    server.backend.ctx.db.countTeamsForUser = originalTeamCount;
  });

  it("retains a bounded event history per preset", async () => {
    const user = await signup(server.agent, "event-retention@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Events", type: "soccer" }).expect(201);
    for (let index = 0; index < 1_005; index += 1) {
      server.backend.ctx.db.logEvent({ presetId: created.body.preset.id, ownerUserId: user.id, type: "test.event", payload: { index } });
    }
    const row = server.backend.ctx.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM event_logs WHERE preset_id = ?", [created.body.preset.id]);
    expect(Number(row?.count)).toBe(1_000);
  });

  it("refuses to persist event payloads above the database hard cap", async () => {
    const user = await signup(server.agent, "event-payload-cap@example.com");
    const created = await server.agent.post("/api/presets").send({ name: "Event cap", type: "soccer" }).expect(201);

    expect(() =>
      server.backend.ctx.db.logEvent({
        presetId: created.body.preset.id,
        ownerUserId: user.id,
        type: "test.oversized",
        payload: { value: "x".repeat(4 * 1024) }
      })
    ).toThrow(/4096 bytes/);
    const row = server.backend.ctx.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM event_logs WHERE preset_id = ?", [created.body.preset.id]);
    expect(Number(row?.count)).toBe(1);
  });
});
