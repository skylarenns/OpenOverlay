import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { serviceAccount } from "./serviceAccount";

const backend = process.env.OPENOVERLAY_E2E_BACKEND_URL || `http://127.0.0.1:${Number(process.env.OPENOVERLAY_E2E_BACKEND_PORT) || 18734}`;
const headers = { "X-OpenOverlay-Api-Version": "v1" };
const churchAccount = serviceAccount("church");

async function createService(page: Page) {
  const login = await page.request.post(`${backend}/api/v1/auth/login`, {
    headers,
    data: churchAccount
  });
  expect(login.status()).toBe(200);
  const response = await page.request.post(`${backend}/api/v1/presets`, { headers, data: { name: "Sunday morning", type: "church" } });
  expect(response.status()).toBe(201);
  const preset = (await response.json()).preset;
  await page.goto(`/dash/presets/${preset.id}`);
  await expect(page.getByRole("heading", { name: "Sunday morning", exact: true })).toBeVisible();
  return preset;
}

test("tablet and phone church layouts put monitors before preparation fields", async ({ page }) => {
  await createService(page);
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 390) await page.reload();
    const monitors = await page.locator(".church-monitors").boundingBox();
    const rundown = await page.locator(".church-rundown").boundingBox();
    const workbench = await page.locator(".church-slide-workbench").boundingBox();
    expect(monitors && rundown && workbench).toBeTruthy();
    expect(monitors!.y).toBeLessThan(rundown!.y);
    expect(monitors!.y).toBeLessThan(workbench!.y);
    await expect(page.getByRole("button", { name: "Show slide", exact: true })).toBeVisible();
    if (width === 390) await expect(page.locator(".church-slide-editor")).not.toHaveAttribute("open");
  }
});

test("a direct public output page loads without the operator module", async ({ page, context }) => {
  const preset = await createService(page);
  const output = await context.newPage();
  const modules: string[] = [];
  output.on("request", (request) => modules.push(new URL(request.url()).pathname));
  await output.goto(`/overlay/${preset.publicId}?display=projector`);
  await expect(output.getByRole("main", { name: "Projector output" })).toBeVisible();
  expect(modules.some((name) => name.endsWith("/src/App.tsx"))).toBe(false);
  await output.close();
});

test("stage controls explain when an older backend lacks the stage feature", async ({ page }) => {
  let stageRequests = 0;
  await page.route("**/api/v1/presets/*/stage", async (route) => {
    stageRequests += 1;
    await route.continue();
  });
  await page.route("**/health", async (route) => {
    const response = await route.fetch();
    const health = (await response.json()) as { compatibility?: { features?: Record<string, unknown> } };
    await route.fulfill({
      response,
      json: {
        ...health,
        compatibility: { ...health.compatibility, features: { ...health.compatibility?.features, stage: false } }
      }
    });
  });
  await createService(page);
  await expect(page.getByText("Stage display requires a backend with stage access support.")).toBeVisible();
  expect(stageRequests).toBe(0);
});

test("prepare and run a full Sunday service with independent projector and stage screens", async ({ page, context }, info) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  context.on("page", (newPage) => newPage.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  const preset = await createService(page);
  const program = page.frameLocator('iframe[title="Church live output"]');
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Welcome to Sunday service");
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(program.getByText("Welcome to Sunday service", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add to service" });
  await dialog.getByLabel("Item title").fill("Opening song");
  await dialog
    .getByLabel("Lyrics")
    .fill("[Verse 1]\nMorning light\nWe gather here\n\n[Chorus]\nSing together\nWith one voice\n\n[Verse 2]\nA new beginning\nA song of hope");
  await expect(dialog.getByRole("button", { name: "Add 3 slides", exact: true })).toBeEnabled();
  await page.screenshot({ animations: "disabled", path: info.outputPath("song-import.png") });
  await dialog.getByRole("button", { name: "Add 3 slides", exact: true }).click();
  await expect(program.getByText("Welcome to Sunday service", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move item up", exact: true }).click();
  await page.getByRole("button", { name: "Move item up", exact: true }).click();
  await page.getByRole("button", { name: "Move item up", exact: true }).click();
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(program.getByText("Morning light\nWe gather here", { exact: true })).toBeVisible();

  const projector = await context.newPage();
  await projector.goto(`/overlay/${preset.publicId}?display=projector`);
  const stage = await context.newPage();
  const stageCapability = await page.request.get(`${backend}/api/v1/presets/${preset.id}/stage`, { headers });
  expect(stageCapability.status()).toBe(200);
  await stage.goto(`/overlay/${preset.publicId}?display=stage#${(await stageCapability.json()).stageKey}`);
  await expect(stage.getByRole("region", { name: "Current slide" })).toContainText("Morning light");
  await expect(stage.getByRole("region", { name: "Next slide" })).toContainText("Sing together");
  await expect(projector.getByText("Morning light\nWe gather here", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Preview Opening song · 2, slide/ }).click();
  await expect(projector.getByText("Morning light\nWe gather here", { exact: true })).toBeVisible();
  if (!(await page.locator(".church-slide-editor").getAttribute("open")) && !(await page.getByLabel("Stage notes", { exact: true }).isVisible()))
    await page.locator(".church-slide-editor > summary").click();
  await page.getByLabel("Stage notes", { exact: true }).fill("Band enters after this line");
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(projector.getByText("Sing together\nWith one voice", { exact: true })).toBeVisible();
  await expect(stage.getByText("Band enters after this line", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Edited chorus draft");
  await expect(projector.getByText("Sing together\nWith one voice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Blackout", exact: true }).click();
  await expect(projector.getByLabel("Blackout")).toBeVisible();
  await expect(stage.getByRole("region", { name: "Current slide" })).toContainText("Sing together");
  await page.getByRole("button", { name: "Restore screen", exact: true }).click();
  await expect(projector.getByText("Sing together\nWith one voice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear text", exact: true }).click();
  await expect(projector.getByText("Sing together\nWith one voice", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore text", exact: true }).click();
  await page.locator(".church-service-tools > summary").filter({ hasText: "Stage message" }).click();
  await page.getByLabel("Message to stage").fill("Two minutes remaining");
  await page.getByRole("button", { name: "Send to stage", exact: true }).click();
  await expect(stage.getByText("Two minutes remaining", { exact: true })).toBeVisible();
  await expect(projector.getByText("Two minutes remaining", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(projector.getByText("A new beginning\nA song of hope", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await dialog.getByRole("button", { name: "Scripture", exact: true }).click();
  await dialog.getByLabel("Item title").fill("Scripture reading");
  await dialog.getByLabel("Scripture text", { exact: true }).fill("First line of the reading\nSecond line of the reading\n\nThe reading continues");
  await dialog.getByLabel("Bible reference & translation").fill("Reading reference · supplied text");
  await dialog.getByRole("button", { name: "Add 2 slides", exact: true }).click();
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(projector.getByText("Reading reference · supplied text", { exact: true })).toBeVisible();
  await page.getByLabel("Countdown length").fill("00:30");
  await page.getByLabel("Countdown length").blur();
  await page.getByRole("button", { name: "Start countdown", exact: true }).click();
  await expect(stage.locator(".church-stage-timer")).toContainText("Service begins in");
  await page.getByRole("button", { name: "Stop countdown", exact: true }).click();

  if (!(await page.getByLabel("Upload slide image").isVisible())) {
    if (!(await page.getByRole("textbox", { name: "Text", exact: true }).isVisible())) await page.locator(".church-slide-editor > summary").click();
  }
  await expect(page.getByLabel("Upload slide image")).toBeEnabled();
  await page.getByLabel("Upload slide image").setInputFiles({
    name: "service-background.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#164e63"/></svg>')
  });
  await expect(page.getByRole("status").filter({ hasText: "Image added to the draft slide" })).toBeVisible();
  await expect(projector.locator(".church-slide img")).toHaveCount(0);
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(projector.locator(".church-slide img")).toBeVisible();
  await projector.keyboard.press("f");
  await expect.poll(() => projector.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await projector.keyboard.press("f");
  await expect.poll(() => projector.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await projector.mouse.move(500, 200);
  await expect(projector.locator(".church-display-tools")).toHaveCSS("opacity", "0", { timeout: 5000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ animations: "disabled", path: info.outputPath("service-desktop-light.png"), fullPage: true });
  await projector.screenshot({ animations: "disabled", path: info.outputPath("projector.png") });
  await stage.screenshot({ animations: "disabled", path: info.outputPath("stage.png") });
  const accessibility = await new AxeBuilder({ page }).include(".church-workspace").analyze();
  expect(accessibility.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([]);
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 920 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const link of await page.locator(".church-output-links .button").all()) {
      expect(await link.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    const monitor = await page.locator(".church-program").boundingBox();
    expect(monitor!.width / monitor!.height).toBeCloseTo(16 / 9, 1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ animations: "disabled", path: info.outputPath(`service-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ animations: "disabled", path: info.outputPath("service-desktop-dark.png"), fullPage: true });
  const saved = await page.request.get(`${backend}/api/v1/presets/${preset.id}`, { headers });
  expect((await saved.json()).preset.state.stageMessage).toBe("Two minutes remaining");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export service", exact: true }).click();
  const download = await downloadPromise;
  const path = info.outputPath("service.json");
  await download.saveAs(path);
  await page.getByLabel("Service file", { exact: true }).setInputFiles(path);
  await page
    .getByRole("dialog", { name: "Import service" })
    .getByRole("button", { name: /Add \d+ slides/ })
    .click();
  await expect(page.getByRole("navigation", { name: "Service order" }).getByRole("button", { name: /Opening song \(2\)/ })).toBeVisible();
  await expect(projector.getByText("Reading reference · supplied text", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Service order" }).getByRole("button", { name: /Opening song \(2\)/ })).toBeVisible();
  await expect(projector.getByText("Reading reference · supplied text", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Panic clear", exact: true }).click();
  await expect(projector.locator(".church-slide")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("worship backgrounds animate gently, preserve live drafts, and respect reduced motion", async ({ page, context }, info) => {
  const preset = await createService(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("A quiet moment\nA song of hope");
  await page.getByRole("button", { name: "Aurora background", exact: true }).click();
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  const output = await context.newPage();
  output.on("pageerror", (error) => errors.push(error.message));
  await output.goto(`/overlay/${preset.publicId}?display=projector`);
  const background = output.locator(".church-backdrop");
  await expect(background).toHaveClass(/backdrop-aurora/);
  await expect(background.locator("i").first()).toHaveCSS("animation-duration", "64s");
  const initialTransform = await background
    .locator("i")
    .first()
    .evaluate((element) => getComputedStyle(element).transform);
  await expect
    .poll(() =>
      background
        .locator("i")
        .first()
        .evaluate((element) => getComputedStyle(element).transform)
    )
    .not.toBe(initialTransform);
  await expect(page.locator(".church-thumbnail .church-backdrop > i").first()).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Geometry background", exact: true }).click();
  await expect(background).toHaveClass(/backdrop-aurora/);
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(background).toHaveClass(/backdrop-geometry/);
  await page.getByRole("button", { name: "Still", exact: true }).click();
  await expect(background.locator("i").first()).toHaveCSS("animation-name", "worship-drift");
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(background.locator("i").first()).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Slow", exact: true }).click();
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(background.locator("i").first()).toHaveCSS("animation-name", "worship-drift");
  await output.emulateMedia({ reducedMotion: "reduce" });
  await expect(background.locator("i").first()).toHaveCSS("animation-name", "none");
  await output.emulateMedia({ reducedMotion: "no-preference" });
  await expect(background.locator("i").first()).toHaveCSS("animation-name", "worship-drift");

  // The same background layer continues through a song's slide changes.
  const elapsed = await background
    .locator("i")
    .first()
    .evaluate((element) => Number(element.getAnimations()[0].currentTime));
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("The next verse");
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  expect(
    await background
      .locator("i")
      .first()
      .evaluate((element) => Number(element.getAnimations()[0].currentTime))
  ).toBeGreaterThan(elapsed);
  await page.getByRole("button", { name: "Starlight background", exact: true }).click();
  await page.getByRole("button", { name: "Apply appearance to this item", exact: true }).click();
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(background).toHaveClass(/backdrop-stars/);
  const saved = await page.request.get(`${backend}/api/v1/presets/${preset.id}`, { headers });
  const savedState = (await saved.json()).preset.state;
  expect(savedState.slides.every((slide: { backgroundPreset: string }) => slide.backgroundPreset === "stars")).toBe(true);
  await page.getByRole("button", { name: "Clear text", exact: true }).click();
  await expect(output.getByText("The next verse", { exact: true })).toHaveCount(0);
  await expect(background).toBeVisible();
  await page.getByRole("button", { name: "Restore text", exact: true }).click();
  for (const [label, id] of [
    ["Aurora", "aurora"],
    ["Dusk", "dusk"],
    ["Ocean", "ocean"],
    ["Geometry", "geometry"],
    ["Soft arcs", "rings"],
    ["Starlight", "stars"]
  ]) {
    await page.getByRole("button", { name: `${label} background`, exact: true }).click();
    await page.getByRole("button", { name: "Show slide", exact: true }).click();
    await expect(background).toHaveClass(new RegExp(`backdrop-${id}`));
    await output.screenshot({ animations: "disabled", path: info.outputPath(`background-${id}.png`) });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("background-picker.png") });
  const audit = await new AxeBuilder({ page }).include(".church-workspace").analyze();
  expect(audit.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ animations: "disabled", fullPage: true, path: info.outputPath("background-picker-mobile.png") });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export service", exact: true }).click();
  const download = await downloadPromise;
  const filePath = info.outputPath("background-service.json");
  await download.saveAs(filePath);
  await page.getByLabel("Service file", { exact: true }).setInputFiles(filePath);
  await page.getByRole("dialog", { name: "Import service" }).getByRole("button", { name: "Add 2 slides", exact: true }).click();
  await expect(page.getByRole("button", { name: "Starlight background", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});
