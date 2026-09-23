import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createDefaultChurchState, createDefaultSoccerState } from "@openoverlay/shared";
import { reconcileMediaStorage } from "../app.js";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  vi.restoreAllMocks();
  server.close();
});

describe("media upload safety", () => {
  it("paginates the media library with an opaque validated cursor", async () => {
    const user = await signup(server.agent, "pagination@example.com");
    for (let index = 0; index < 26; index += 1) {
      server.backend.ctx.db.createMedia({
        ownerUserId: user.id,
        filename: `item-${index}.png`,
        originalFilename: `item-${index}.png`,
        mimeType: "image/png",
        sizeBytes: 1,
        filePath: path.join(server.dir, "uploads", `item-${index}.png`)
      });
    }
    const first = await server.agent.get("/api/media?limit=24").expect(200);
    expect(first.body.media).toHaveLength(24);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await server.agent.get(`/api/media?limit=24&cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200);
    expect(second.body.media).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.media, ...second.body.media].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(26);
    await server.agent.get("/api/media?limit=0").expect(400);
    await server.agent.get("/api/media?cursor=not-a-cursor").expect(400);
  });

  it("rejects SVG files with active content", async () => {
    await signup(server.agent, "svg-block@example.com");

    await server.agent
      .post("/api/media")
      .attach("file", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), {
        filename: "badge.svg",
        contentType: "image/svg+xml"
      })
      .expect(400);
  });

  it("normalizes traversal-looking upload filenames into the upload directory", async () => {
    await signup(server.agent, "safe-name@example.com");

    const response = await server.agent
      .post("/api/media")
      .attach("file", onePixelPng(), {
        filename: "../../evil.png",
        contentType: "image/png"
      })
      .expect(201);

    const filename = response.body.media.filename as string;
    expect(filename).not.toContain("..");
    expect(filename).not.toMatch(/[\\/]/);
    expect(fs.existsSync(path.join(server.dir, "uploads", filename))).toBe(true);
  });

  it("serves accepted SVG files with a sandboxing content security policy", async () => {
    await signup(server.agent, "svg-safe@example.com");

    const upload = await server.agent
      .post("/api/media")
      .attach("file", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'), {
        filename: "logo.svg",
        contentType: "image/svg+xml"
      })
      .expect(201);

    const response = await server.request.get(`/api/media/file/${upload.body.media.publicId}`).expect(200);
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("parses long SVG comment preambles and rejects an unfinished comment", async () => {
    await signup(server.agent, "svg-preamble@example.com");
    const preamble = `<?xml version="1.0"?>\n${"<!-- prepared -->\n".repeat(2_000)}`;
    await server.agent
      .post("/api/media")
      .attach("file", Buffer.from(`${preamble}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`), {
        filename: "preamble.svg",
        contentType: "image/svg+xml"
      })
      .expect(201);
    await server.agent
      .post("/api/media")
      .attach("file", Buffer.from(`${preamble}<!-- unfinished <svg xmlns="http://www.w3.org/2000/svg"></svg>`), {
        filename: "unfinished.svg",
        contentType: "image/svg+xml"
      })
      .expect(400);
  });

  it("rejects mismatched and unrecognized image signatures", async () => {
    await signup(server.agent, "signature@example.com");
    await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "fake.jpg", contentType: "image/jpeg" }).expect(400);
    await server.agent.post("/api/media").attach("file", Buffer.from("icns\0\0\0\x10garbage"), { filename: "fake.png", contentType: "image/png" }).expect(400);
    await server.agent.post("/api/media").attach("file", Buffer.alloc(0), { filename: "empty.png", contentType: "image/png" }).expect(400);
    const truncatedPng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(truncatedPng);
    truncatedPng.write("IHDR", 12, "ascii");
    truncatedPng.writeUInt32BE(1, 16);
    truncatedPng.writeUInt32BE(1, 20);
    await server.agent.post("/api/media").attach("file", truncatedPng, { filename: "truncated.png", contentType: "image/png" }).expect(400);
    await server.agent
      .post("/api/media")
      .attach("file", Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x01, 0x00, 0x01]), { filename: "truncated.jpg", contentType: "image/jpeg" })
      .expect(400);
  });

  it("uses collision-resistant names for concurrent same-name uploads", async () => {
    await signup(server.agent, "collision@example.com");
    const [first, second] = await Promise.all([
      server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "logo.png", contentType: "image/png" }),
      server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "logo.png", contentType: "image/png" })
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.media.filename).not.toBe(second.body.media.filename);
    await server.agent.delete(`/api/media/${first.body.media.id}`).expect(200);
    await server.request.get(second.body.media.url).expect(200);
  });

  it("blocks deletion while media is referenced", async () => {
    await signup(server.agent, "referenced@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "team.png", contentType: "image/png" }).expect(201);
    await server.agent
      .post("/api/teams")
      .send({ fullName: "Media FC", shortName: "Media", logoMediaId: upload.body.media.id, logoUrl: upload.body.media.url })
      .expect(201);
    await server.agent.delete(`/api/media/${upload.body.media.id}`).expect(409);
    await server.request.get(upload.body.media.url).expect(200);
  });

  it("keeps media referenced only by an on-air slide protected and validates its ownership", async () => {
    await signup(server.agent, "on-air-media@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "slide.png", contentType: "image/png" }).expect(201);
    const state = createDefaultChurchState("On air");
    state.onAirSlide = { ...state.slides[0], type: "image", mediaId: upload.body.media.id };
    state.slides = [];
    const created = await server.agent.post("/api/presets").send({ name: "On air", type: "church", state }).expect(201);
    expect(created.body.preset.state.onAirSlide.mediaUrl).toBe(upload.body.media.url);
    await server.agent.delete(`/api/media/${upload.body.media.id}`).expect(409);
    const other = request.agent(server.backend.app);
    await signup(other, "other-on-air@example.com");
    await other.post("/api/presets").send({ name: "Foreign slide", type: "church", state }).expect(400);
  });

  it("reports a failed quarantine restore instead of silently stranding referenced media", async () => {
    await signup(server.agent, "restore-failure@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "team.png", contentType: "image/png" }).expect(201);
    await server.agent.post("/api/teams").send({ fullName: "Restore FC", logoMediaId: upload.body.media.id }).expect(201);
    const originalRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("simulated restore failure");
      return originalRename(...args);
    });
    const logError = vi.spyOn(server.backend.ctx.logger, "error");

    await server.agent.delete(`/api/media/${upload.body.media.id}`).expect(500);

    expect(logError).toHaveBeenCalledWith("media_restore_failed", expect.objectContaining({ error: "simulated restore failure" }));
    expect(fs.readdirSync(path.join(server.dir, "uploads")).some((name) => name.includes(".deleting-"))).toBe(true);
  });

  it("restores interrupted deletes and removes upload files that were never committed", async () => {
    await signup(server.agent, "reconcile@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "recover.png", contentType: "image/png" }).expect(201);
    const originalPath = path.join(server.dir, "uploads", upload.body.media.filename as string);
    const quarantinePath = `${originalPath}.deleting-00000000-0000-4000-8000-000000000000`;
    fs.renameSync(originalPath, quarantinePath);
    fs.utimesSync(quarantinePath, new Date(0), new Date(0));
    const orphanPath = path.join(server.dir, "uploads", "orphan.png");
    fs.writeFileSync(orphanPath, onePixelPng());

    reconcileMediaStorage(server.backend.ctx);

    expect(fs.existsSync(originalPath)).toBe(true);
    expect(fs.existsSync(quarantinePath)).toBe(false);
    expect(fs.existsSync(orphanPath)).toBe(false);
    await server.request.get(upload.body.media.url).expect(200);
  });

  it("keeps a newly published upload when reconciliation runs before its database insert", async () => {
    await signup(server.agent, "reconcile-race@example.com");
    const originalCreateMedia = server.backend.ctx.db.createMedia.bind(server.backend.ctx.db);
    let reconciliationRan = false;
    vi.spyOn(server.backend.ctx.db, "createMedia").mockImplementation((input) => {
      reconciliationRan = true;
      expect(fs.existsSync(input.filePath)).toBe(true);

      // A blue-green candidate can start here with a database snapshot that
      // predates this insert. It must not mistake the freshly published file
      // for a crashed orphan.
      reconcileMediaStorage(server.backend.ctx);
      expect(fs.existsSync(input.filePath)).toBe(true);
      return originalCreateMedia(input);
    });

    const upload = await server.agent
      .post("/api/media")
      .attach("file", onePixelPng(), { filename: "candidate-race.png", contentType: "image/png" })
      .expect(201);

    expect(reconciliationRan).toBe(true);
    const uploadPath = path.join(server.dir, "uploads", upload.body.media.filename as string);
    expect(fs.existsSync(uploadPath)).toBe(true);
    expect(fs.readdirSync(path.join(server.dir, "uploads")).some((name) => name.includes(".uploading-"))).toBe(false);
    await server.request.get(upload.body.media.url).expect(200);
  });

  it("preserves fresh staging artifacts but reclaims them after the crash-recovery grace window", () => {
    const stagingPath = path.join(server.dir, "uploads", "00000000-0000-4000-8000-000000000001-staged.png.uploading-00000000-0000-4000-8000-000000000002");
    fs.writeFileSync(stagingPath, onePixelPng());

    reconcileMediaStorage(server.backend.ctx);
    expect(fs.existsSync(stagingPath)).toBe(true);

    fs.utimesSync(stagingPath, new Date(0), new Date(0));
    reconcileMediaStorage(server.backend.ctx);
    expect(fs.existsSync(stagingPath)).toBe(false);
  });

  it("rejects cross-owner team references before they can lock the owner's media", async () => {
    await signup(server.agent, "media-owner@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "owner.png", contentType: "image/png" }).expect(201);
    const other = request.agent(server.app);
    await signup(other, "media-other@example.com");
    await other
      .post("/api/teams")
      .send({
        fullName: "External Reference FC",
        logoMediaId: upload.body.media.id,
        logoUrl: upload.body.media.url
      })
      .expect(400);

    await server.agent.delete(`/api/media/${upload.body.media.id}`).expect(200);
    await server.request.get(upload.body.media.url).expect(404);
  });

  it("never serves a database path outside the configured upload directory", async () => {
    const user = await signup(server.agent, "external-path@example.com");
    const media = server.backend.ctx.db.createMedia({
      ownerUserId: user.id,
      filename: "external.txt",
      originalFilename: "external.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      filePath: "/etc/hosts"
    });

    await server.request.get(`/api/media/file/${media.public_id}`).expect(404);
  });

  it("requires team media IDs to be owned and canonicalizes their URLs", async () => {
    await signup(server.agent, "team-media-owner@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "team.png", contentType: "image/png" }).expect(201);

    const valid = await server.agent
      .post("/api/teams")
      .send({
        fullName: "Canonical FC",
        logoMediaId: upload.body.media.id
      })
      .expect(201);
    expect(valid.body.team.logoUrl).toBe(upload.body.media.url);

    await server.agent
      .post("/api/teams")
      .send({
        fullName: "Mismatched FC",
        logoMediaId: upload.body.media.id,
        logoUrl: "https://attacker.example/tracker.svg"
      })
      .expect(400);
    await server.agent
      .post("/api/teams")
      .send({
        fullName: "URL-only FC",
        logoUrl: upload.body.media.url
      })
      .expect(400);
    await server.agent
      .post("/api/teams")
      .send({
        fullName: "Missing FC",
        logoMediaId: "missing-media-id"
      })
      .expect(400);
  });

  it("rejects unavailable or mismatched media in soccer and church preset writes", async () => {
    await signup(server.agent, "preset-media-owner@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "preset.png", contentType: "image/png" }).expect(201);

    const soccer = createDefaultSoccerState("Media Match");
    soccer.home.logoMediaId = upload.body.media.id;
    soccer.home.logoUrl = "https://attacker.example/not-the-upload.png";
    await server.agent.post("/api/presets").send({ name: "Bad Soccer", type: "soccer", state: soccer }).expect(400);

    const church = createDefaultChurchState("Media Service");
    church.slides.push({
      id: "image-slide",
      title: "Image",
      type: "image",
      text: "",
      mediaId: "missing-media-id",
      section: "Main",
      backgroundColor: "#000000",
      textColor: "#ffffff",
      variant: "clean"
    });
    await server.agent.post("/api/presets").send({ name: "Bad Church", type: "church", state: church }).expect(400);

    const other = request.agent(server.app);
    await signup(other, "preset-media-other@example.com");
    soccer.home.logoUrl = upload.body.media.url;
    await other.post("/api/presets").send({ name: "Cross-owner Soccer", type: "soccer", state: soccer }).expect(400);
  });

  it("preserves owned media on same-owner duplicate and strips it from cross-account shares", async () => {
    await signup(server.agent, "share-media-owner@example.com");
    const recipient = request.agent(server.app);
    await signup(recipient, "share-media-recipient@example.com");
    const upload = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "shared.png", contentType: "image/png" }).expect(201);
    const state = createDefaultSoccerState("Shared Match");
    state.home.logoMediaId = upload.body.media.id;
    state.home.logoUrl = `/api/media/file/${upload.body.media.publicId}`;
    const created = await server.agent.post("/api/presets").send({ name: "Shared Match", type: "soccer", state }).expect(201);
    expect(created.body.preset.state.home.logoUrl).toBe(upload.body.media.url);

    const duplicate = await server.agent.post(`/api/presets/${created.body.preset.id}/duplicate`).send({}).expect(201);
    expect(duplicate.body.preset.state.home.logoMediaId).toBe(upload.body.media.id);
    expect(duplicate.body.preset.state.home.logoUrl).toBe(upload.body.media.url);

    const clearedState = structuredClone(duplicate.body.preset.state);
    clearedState.home.logoMediaId = "";
    clearedState.home.logoUrl = "";
    const cleared = await server.agent
      .patch(`/api/presets/${duplicate.body.preset.id}`)
      .send({
        state: clearedState,
        expectedRevision: duplicate.body.preset.revision
      })
      .expect(200);
    expect(cleared.body.preset.state.home.logoMediaId).toBeUndefined();
    expect(cleared.body.preset.state.home.logoUrl).toBeUndefined();

    const shared = await server.agent.post(`/api/presets/${created.body.preset.id}/share`).send({ email: "share-media-recipient@example.com" }).expect(201);
    expect(shared.body).toMatchObject({ ok: true, mediaReferencesRemoved: true, receiptId: expect.any(String) });
    expect(shared.body).not.toHaveProperty("preset");
    let recipientPresets = (await recipient.get("/api/presets").expect(200)).body.presets;
    const recipientSoccerSummary = recipientPresets.find((preset: { name: string }) => preset.name === "Shared Match");
    const recipientSoccer = (await recipient.get(`/api/presets/${recipientSoccerSummary.id}`).expect(200)).body.preset;
    expect(recipientSoccer.state.home.logoMediaId).toBeUndefined();
    expect(recipientSoccer.state.home.logoUrl).toBeUndefined();

    const sharedTeam = await server.agent
      .post(`/api/presets/${created.body.preset.id}/share-team`)
      .send({
        email: "share-media-recipient@example.com",
        side: "home"
      })
      .expect(201);
    expect(sharedTeam.body).toMatchObject({ ok: true, mediaReferencesRemoved: true, receiptId: expect.any(String) });
    expect(sharedTeam.body).not.toHaveProperty("preset");
    recipientPresets = (await recipient.get("/api/presets").expect(200)).body.presets;
    const recipientTeamSummary = recipientPresets.find((preset: { name: string }) => preset.name.endsWith(" Team"));
    const recipientTeam = (await recipient.get(`/api/presets/${recipientTeamSummary.id}`).expect(200)).body.preset;
    expect(recipientTeam.state.home.logoMediaId).toBeUndefined();
    expect(recipientTeam.state.home.logoUrl).toBeUndefined();

    const churchState = createDefaultChurchState("Shared Service");
    churchState.slides.push({
      id: "shared-image",
      title: "Shared image",
      type: "image",
      text: "",
      mediaId: upload.body.media.id,
      mediaUrl: upload.body.media.url,
      section: "Main",
      backgroundColor: "#000000",
      textColor: "#ffffff",
      variant: "clean"
    });
    churchState.onAirSlide = structuredClone(churchState.slides.at(-1)!);
    const church = await server.agent.post("/api/presets").send({ name: "Shared Service", type: "church", state: churchState }).expect(201);
    const sharedChurch = await server.agent
      .post(`/api/presets/${church.body.preset.id}/share`)
      .send({
        email: "share-media-recipient@example.com"
      })
      .expect(201);
    expect(sharedChurch.body).toMatchObject({ ok: true, mediaReferencesRemoved: true, receiptId: expect.any(String) });
    expect(sharedChurch.body).not.toHaveProperty("preset");
    recipientPresets = (await recipient.get("/api/presets").expect(200)).body.presets;
    const recipientChurchSummary = recipientPresets.find((preset: { name: string }) => preset.name === "Shared Service");
    const recipientChurch = (await recipient.get(`/api/presets/${recipientChurchSummary.id}`).expect(200)).body.preset;
    expect(recipientChurch.state.slides[0].mediaId).toBeUndefined();
    expect(recipientChurch.state.slides.at(-1).mediaUrl).toBeUndefined();
    expect(recipientChurch.state.onAirSlide).toMatchObject({ id: "shared-image", type: "image" });
    expect(recipientChurch.state.onAirSlide.mediaId).toBeUndefined();
    expect(recipientChurch.state.onAirSlide.mediaUrl).toBeUndefined();
  });

  it("rejects uploads before buffering when a user's media item quota is full", async () => {
    const user = await signup(server.agent, "media-quota@example.com");
    for (let index = 0; index < 100; index += 1) {
      server.backend.ctx.db.createMedia({
        ownerUserId: user.id,
        filename: `quota-${index}.png`,
        originalFilename: `quota-${index}.png`,
        mimeType: "image/png",
        sizeBytes: 1,
        filePath: path.join(server.dir, "uploads", `quota-${index}.png`)
      });
    }

    await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "over-quota.png", contentType: "image/png" }).expect(413);
  });

  it("enforces a global media-byte limit across accounts and leaves no orphan file", async () => {
    server.close();
    server = makeTestServer({ mediaGlobalMaxBytes: 1 });
    await signup(server.agent, "global-media-quota@example.com");

    const response = await server.agent
      .post("/api/media")
      .attach("file", onePixelPng(), { filename: "global-limit.png", contentType: "image/png" })
      .expect(507);

    expect(response.body.error).toMatch(/Global media storage limit/);
    expect(server.backend.ctx.db.getGlobalMediaUsage()).toEqual({ itemCount: 0, sizeBytes: 0 });
    expect(fs.readdirSync(path.join(server.dir, "uploads"))).toEqual([]);
  });

  it("fails closed before upload buffering when the configured free-space floor cannot be met", async () => {
    await signup(server.agent, "disk-floor@example.com");
    server.backend.ctx.config.storageMinimumFreeBytes = Number.MAX_SAFE_INTEGER;

    const response = await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "disk-floor.png", contentType: "image/png" }).expect(507);

    expect(response.body.error).toMatch(/retain at least/);
    expect(server.backend.ctx.db.getGlobalMediaUsage()).toEqual({ itemCount: 0, sizeBytes: 0 });
    expect(fs.readdirSync(path.join(server.dir, "uploads"))).toEqual([]);
  });

  it("removes a just-written file if the database insert fails", async () => {
    await signup(server.agent, "cleanup@example.com");
    const originalCreateMedia = server.backend.ctx.db.createMedia.bind(server.backend.ctx.db);
    server.backend.ctx.db.createMedia = () => {
      throw new Error("simulated database failure");
    };
    await server.agent.post("/api/media").attach("file", onePixelPng(), { filename: "orphan.png", contentType: "image/png" }).expect(500);
    server.backend.ctx.db.createMedia = originalCreateMedia;
    expect(fs.readdirSync(path.join(server.dir, "uploads"))).toEqual([]);
  });

  it("maps oversized uploads to payload too large", async () => {
    await signup(server.agent, "large@example.com");
    await server.agent
      .post("/api/media")
      .attach("file", Buffer.alloc(10 * 1024 * 1024 + 1), { filename: "large.png", contentType: "image/png" })
      .expect(413);
  });
});

function onePixelPng(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
}
