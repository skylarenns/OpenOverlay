import { expect, test, request, type Page, type Route } from "@playwright/test";
import { serviceAccount } from "./serviceAccount";

const backend = process.env.OPENOVERLAY_E2E_BACKEND_URL || `http://127.0.0.1:${Number(process.env.OPENOVERLAY_E2E_BACKEND_PORT) || 18734}`;
const headers = { "X-OpenOverlay-Api-Version": "v1" };
const navigationAccount = serviceAccount("navigation");

const games: Array<{ id: string; name: string; type: string }> = [];

test.beforeAll(async () => {
  const api = await request.newContext();
  try {
    const login = await api.post(`${backend}/api/v1/auth/login`, { headers, data: navigationAccount });
    expect(login.status()).toBe(200);
    for (const name of ["Soccer", "Sunday service"]) {
      const response = await api.post(`${backend}/api/v1/presets`, {
        headers,
        data: { name, type: name === "Soccer" ? "soccer" : "church" }
      });
      expect(response.status()).toBe(201);
      games.push((await response.json()).preset);
    }
  } finally {
    await api.dispose();
  }
});

async function prepare(page: Page) {
  const login = await page.request.post(`${backend}/api/v1/auth/login`, { headers, data: navigationAccount });
  expect(login.status()).toBe(200);
  await page.goto("/dash");
  await expect(page.getByRole("link", { name: "Open Soccer", exact: true })).toBeVisible();
  return games;
}

async function hold(page: Page, matcher: RegExp) {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    await pending;
    await route.continue();
  };
  await page.route(matcher, handler);
  // Keep this handler until page teardown; removing it while a blocked callback
  // resumes can cause Playwright to continue the same request twice.
  return release;
}

test("sidebar lazily loads destinations and restores visited pages during background refresh", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const libraryRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/(teams|media)(?:\?.*)?$/.test(request.url())) libraryRequests.push(request.url());
  });
  const games = await prepare(page);
  expect(libraryRequests).toEqual([]);
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const main = page.getByRole("main");
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("sidebar-light.png") });

  for (const [label, endpoint, status] of [
    ["Teams", "teams", "Loading teams"],
    ["Media", "media", "Loading media"]
  ]) {
    const release = await hold(page, new RegExp(`/api/v1/${endpoint}(?:\\?.*)?$`));
    try {
      await nav.getByRole("link", { name: label, exact: true }).click();
      await expect(main.getByRole("status", { name: status, exact: true })).toBeVisible();
      await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${endpoint}-loading.png`) });
    } finally {
      await release();
    }
    await expect(main.getByRole("status", { name: status, exact: true })).toHaveCount(0);
  }

  // Productions has already loaded: cached cards must remain usable while HTTP waits.
  const releaseProductions = await hold(page, /\/api\/v1\/presets(?:\?.*)?$/);
  await nav.getByRole("link", { name: "Productions", exact: true }).click();
  await expect(main.getByRole("link", { name: "Open Soccer", exact: true })).toBeVisible();
  await expect(main.getByRole("status", { name: "Loading games" })).toHaveCount(0);
  releaseProductions();

  for (const game of games) {
    const releaseHttp = await hold(page, new RegExp(`/api/v1/presets/${game.id}(?:\\?.*)?$`));
    const releaseSocket = await hold(page, /\/socket\.io\//);
    try {
      await nav.getByRole("link", { name: game.name, exact: true }).click();
      await expect(main.getByRole("status", { name: "Loading game", exact: true })).toBeVisible();
      await expect(main.locator(".live-game-page")).toHaveCount(0);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${game.type}-loading.png`) });
    } finally {
      await releaseHttp();
      await releaseSocket();
    }
    await expect(main.locator("h1")).toHaveText(game.name);
    await expect(main.getByRole("status", { name: "Loading game", exact: true })).toHaveCount(0);
    if (game.type === "soccer") await main.getByRole("button", { name: "Match", exact: true }).click();
  }

  // Leaving a pending section must not let its late response replace the new page.
  const releaseTeams = await hold(page, /\/api\/v1\/teams(?:\?.*)?$/);
  await nav.getByRole("link", { name: "Teams", exact: true }).click();
  await expect(main.getByRole("button", { name: "New Team", exact: true })).toBeVisible();
  await expect(main.getByRole("status", { name: "Loading teams" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Media", exact: true }).click();
  await releaseTeams();
  await expect(main.getByRole("heading", { name: "Media", exact: true })).toBeVisible();
  await expect(main.getByRole("status", { name: /Loading/ })).toHaveCount(0);

  const releaseGame = await hold(page, new RegExp(`/api/v1/presets/${games[0].id}(?:\\?.*)?$`));
  const releaseSocket = await hold(page, /\/socket\.io\//);
  await nav.getByRole("link", { name: "Soccer", exact: true }).click();
  await expect(main.locator("h1")).toHaveText("Soccer");
  await expect(main.getByRole("status", { name: "Loading game" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Match", exact: true })).toHaveClass(/active/);
  releaseGame();
  releaseSocket();
  await page.goBack();
  await expect(main.getByRole("heading", { name: "Media", exact: true })).toBeVisible();
  await expect(main.getByRole("status", { name: /Loading/ })).toHaveCount(0);
  await page.goForward();
  await expect(main.getByRole("button", { name: "Match", exact: true })).toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test("sidebar supports dark mode, narrow screens, keyboard collapse, and reduced motion", async ({ page }, testInfo) => {
  await prepare(page);
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("sidebar-dark.png") });
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  await collapse.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeHidden();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();

  for (const width of [1024, 768, 390, 280]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 390) {
      await expect(page.getByRole("navigation", { name: "Workspace" })).toBeHidden();
      await page.getByRole("button", { name: "Expand sidebar" }).click();
    }
    await expect(page.getByRole("navigation", { name: "Workspace" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const brand = page.locator(".sidebar-brand-text");
    // The sidebar can still be resizing after navigation first becomes visible.
    await expect
      .poll(() => brand.evaluate((element) => element.scrollWidth - element.clientWidth), { message: `Sidebar brand fits at ${width}px` })
      .toBeLessThanOrEqual(0);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`sidebar-${width}.png`) });
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  const release = await hold(page, /\/api\/v1\/media(?:\?.*)?$/);
  try {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Media", exact: true }).click();
    await expect(page.getByRole("main").getByRole("status", { name: "Loading media" })).toBeVisible();
    expect(
      await page
        .locator(".skeleton")
        .first()
        .evaluate((element) => getComputedStyle(element, "::after").animationName)
    ).toBe("none");
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("mobile-loading-dark.png") });
  } finally {
    await release();
  }
  await expect(page.getByRole("navigation", { name: "Workspace" })).toBeHidden();
  await expect(page.getByRole("main").getByRole("status", { name: "Loading media" })).toHaveCount(0);
});
