import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDefaultChurchState, createDefaultSoccerState } from "@openoverlay/shared";
import { hashPassword } from "./auth.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";

const config = loadConfig();
const db = new Database(config);

try {
  const email = process.env.DEMO_EMAIL || "demo@openoverlay.local";
  const password = process.env.DEMO_PASSWORD || "openoverlay-demo";
  if (config.env === "production" && !process.env.DEMO_PASSWORD) {
    throw new Error("Set DEMO_PASSWORD to seed in production");
  }

  let user = db.findUserByEmail(email);
  if (!user) {
    user = db.createUser(email, await hashPassword(password));
  }

  const createdPaths: string[] = [];
  try {
    db.transaction(() => {
      const existing = db.listPresetsForUser(user.id);
      if (!existing.some((preset) => preset.name === "Demo Soccer")) {
        const soccer = createDefaultSoccerState("District Championship");
        const homeLogo = createLogo("OOU", soccer.home.primaryColor, soccer.home.secondaryColor);
        const awayLogo = createLogo("SKY", soccer.away.primaryColor, soccer.away.secondaryColor);
        const homeMedia = saveSeedMedia(user.id, "oou-logo.svg", homeLogo, createdPaths);
        const awayMedia = saveSeedMedia(user.id, "sky-logo.svg", awayLogo, createdPaths);
        soccer.home.logoMediaId = homeMedia.id;
        soccer.home.logoUrl = `/api/media/file/${homeMedia.public_id}`;
        soccer.away.logoMediaId = awayMedia.id;
        soccer.away.logoUrl = `/api/media/file/${awayMedia.public_id}`;
        db.createPreset({ ownerUserId: user.id, name: "Demo Soccer", type: "soccer", state: soccer });
      }

      if (!existing.some((preset) => preset.name === "Demo Church")) {
        const church = createDefaultChurchState("Sunday Service");
        church.slides.push({
          id: "demo-message-slide",
          title: "Message",
          type: "text",
          text: "Faith for today\nHope for tomorrow",
          section: "Message",
          backgroundColor: "#0f172a",
          textColor: "#f8fafc",
          variant: "broadcast"
        });
        db.createPreset({ ownerUserId: user.id, name: "Demo Church", type: "church", state: church });
      }
    });
  } catch (error) {
    for (const filePath of createdPaths) fs.rmSync(filePath, { force: true });
    throw error;
  }

  console.log(`Seed complete for ${email}`);
} finally {
  db.close();
}

function saveSeedMedia(ownerUserId: string, filename: string, contents: string, createdPaths: string[]) {
  const storedFilename = `${randomUUID()}-${filename}`;
  const filePath = path.join(config.uploadDir, storedFilename);
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o640, flag: "wx" });
  createdPaths.push(filePath);
  return db.createMedia({
    ownerUserId,
    filename: storedFilename,
    originalFilename: filename,
    mimeType: "image/svg+xml",
    width: 320,
    height: 320,
    sizeBytes: Buffer.byteLength(contents),
    filePath
  });
}

function createLogo(text: string, primary: string, secondary: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
  <rect width="320" height="320" rx="64" fill="${primary}"/>
  <path d="M160 34 282 104v112L160 286 38 216V104L160 34Z" fill="${secondary}" opacity=".9"/>
  <circle cx="160" cy="160" r="82" fill="${primary}" opacity=".92"/>
  <text x="160" y="178" font-family="Arial, sans-serif" font-size="68" font-weight="800" text-anchor="middle" fill="#fff">${text}</text>
</svg>`;
}
