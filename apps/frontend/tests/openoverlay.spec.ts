import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { serviceAccount } from "./serviceAccount";

const backendPort = Number(process.env.OPENOVERLAY_E2E_BACKEND_PORT) || 18734;
const backendUrl = process.env.OPENOVERLAY_E2E_BACKEND_URL || `http://127.0.0.1:${backendPort}`;
const browserErrors = new WeakMap<BrowserContext, string[]>();
const sharedAccount = serviceAccount("openoverlay");
let accountSequence = 0;

test.beforeEach(async ({ context }) => {
  const errors: string[] = [];
  const monitoredPages = new WeakSet<Page>();
  browserErrors.set(context, errors);

  const monitor = (page: Page) => {
    if (monitoredPages.has(page)) return;
    monitoredPages.add(page);
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // Chromium also mirrors every HTTP failure as a generic console message.
      // The response listener below records those with their precise URL/status.
      if (message.text().startsWith("Failed to load resource:")) return;
      errors.push(`console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const pathname = new URL(response.url()).pathname;
      const expectedSignedOutProbe = response.status() === 401 && pathname.endsWith("/api/v1/auth/me");
      if (!expectedSignedOutProbe) errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    });
  };

  for (const page of context.pages()) monitor(page);
  context.on("page", monitor);
});

test.afterEach(async ({ context }) => {
  expect.soft(browserErrors.get(context) || [], "the browser should not report page, console, or unexpected HTTP errors").toEqual([]);
});

function uniqueEmail(label: string): string {
  accountSequence += 1;
  return `e2e-${label}-${Date.now()}-${process.pid}-${accountSequence}@openoverlay.local`;
}

async function signUp(page: Page, label: string): Promise<{ email: string; password: string }> {
  const account = { email: uniqueEmail(label), password: "password123" };
  await page.goto("/signup");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Productions" })).toBeVisible();
  return account;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(sharedAccount.email);
  await page.getByLabel("Password").fill(sharedAccount.password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page.getByRole("heading", { name: "Productions" })).toBeVisible();
}

async function createGame(page: Page, name: string, type: "soccer" | "church" = "soccer"): Promise<string> {
  await page.goto("/dash");
  await expect(page.getByRole("heading", { name: "Productions" })).toBeVisible();
  await page.getByRole("button", { name: /New production/i }).click();
  if (type !== "soccer") await page.getByLabel("Production type").selectOption(type);
  await page.getByLabel("Production name").fill(name);
  await page.getByRole("button", { name: "Create production" }).click();
  await expect(page.locator("main h1")).toHaveText(name);
  const match = new URL(page.url()).pathname.match(/^\/dash\/presets\/([^/]+)$/);
  expect(match, `expected the ${name} editor URL to include a preset id`).toBeTruthy();
  return match![1];
}

async function assertNoHorizontalClipping(page: Page, width: number): Promise<void> {
  const report = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll<HTMLElement>(".app-shell, .main, .live-game-page, .editor-layout, .soccer-bottom-control-panel")
    ]
      .filter((element, index, all) => all.indexOf(element) === index)
      .map((element) => ({
        element: element === document.documentElement ? "html" : element === document.body ? "body" : element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
      }))
      .filter(({ clientWidth, scrollWidth }) => clientWidth > 0 && scrollWidth > clientWidth + 1);

    const clippedControls = [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([type='file']):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role='tab']"
      )
    ]
      .filter((element) => {
        if (!element.checkVisibility() || element.closest("[aria-hidden='true'], [inert]")) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .slice(0, 20)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 80) || element.tagName,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          viewportWidth
        };
      });

    return { overflow, clippedControls };
  });

  expect(report.overflow, `${width}px layout should not hide content in overflowing root/editor containers`).toEqual([]);
  expect(report.clippedControls, `${width}px layout should keep interactive controls inside the viewport`).toEqual([]);
}

test("protected routes redirect to login and return to the requested URL", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/dash/teams?source=protected-route");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(sharedAccount.email);
  await page.getByLabel("Password").fill(sharedAccount.password);
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page).toHaveURL(/\/dash\/teams\?source=protected-route$/);
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
});

test("new-game dialog traps keyboard focus, closes with Escape, and restores focus", async ({ page }) => {
  await signIn(page);
  const opener = page.getByRole("button", { name: /New production/i });
  await opener.click();

  const dialog = page.getByRole("dialog", { name: "New production" });
  const gameType = page.getByLabel("Production type");
  const gameName = page.getByLabel("Production name");
  const cancel = page.getByRole("button", { name: "Cancel" });
  const submit = page.getByRole("button", { name: "Create production" });
  await expect(dialog).toBeVisible();
  await expect(gameName).toBeFocused();
  await gameName.fill("");
  await expect(submit).toBeDisabled();
  await gameName.fill("Keyboard test");
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");

  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(gameType).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(submit).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden", "true");
});

test("a delayed autosave remains bound to its preset during rapid route navigation", async ({ page }) => {
  await signIn(page);
  const firstPresetId = await createGame(page, "Route Race A");
  await createGame(page, "Route Race B");
  await page.goto(`/dash/presets/${firstPresetId}`);
  await expect(page.getByRole("heading", { name: "Route Race A" })).toBeVisible();
  await page.getByRole("button", { name: "Match", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Home team details/ })
    .click();

  let delayedPatchObserved = false;
  await page.route(`**/api/v1/presets/${firstPresetId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      delayedPatchObserved = true;
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    await route.continue();
  });
  const firstSave = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${firstPresetId}`));

  let navigationWarning = "";
  page.once("dialog", async (dialog) => {
    navigationWarning = dialog.message();
    await dialog.accept();
  });
  await page.getByLabel("Team name").first().fill("Route A Edited");
  await page.getByRole("link", { name: "Route Race B", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Route Race B" })).toBeVisible();
  expect(navigationWarning).toContain("unsaved or staged changes");
  expect((await firstSave).status()).toBe(200);
  expect(delayedPatchObserved).toBe(true);

  await page.getByRole("button", { name: "Match", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Home team details/ })
    .click();
  await expect(page.getByLabel("Team name").first()).not.toHaveValue("Route A Edited");
  await page.reload();
  await page.getByRole("button", { name: "Match", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Home team details/ })
    .click();
  await expect(page.getByLabel("Team name").first()).not.toHaveValue("Route A Edited");

  await page.goto(`/dash/presets/${firstPresetId}`);
  await page.getByRole("button", { name: "Match", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Home team details/ })
    .click();
  await expect(page.getByLabel("Team name").first()).toHaveValue("Route A Edited");
});

test("an action waits for the pending autosave and preserves both changes", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Ordered Mutations");
  let patchFinished = false;
  let actionStartedBeforePatchFinished = false;

  await page.route(new RegExp(`/api/v1/presets/${presetId}(?:$|/)`), async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "PATCH" && pathname.endsWith(`/presets/${presetId}`)) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      const response = await route.fetch();
      patchFinished = true;
      await route.fulfill({ response });
      return;
    }
    if (method === "POST" && pathname.includes(`/presets/${presetId}/actions/`)) {
      actionStartedBeforePatchFinished = !patchFinished;
    }
    await route.continue();
  });

  const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${presetId}`));
  const actionResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/home-score-plus`)
  );
  await page.getByLabel("Period", { exact: true }).fill("RACE");
  await page.getByRole("button", { name: "Add point to HOME" }).click();

  expect((await saveResponse).status()).toBe(200);
  expect((await actionResponse).status()).toBe(200);
  expect(actionStartedBeforePatchFinished).toBe(false);
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("1");

  await page.reload();
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("RACE");
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("1");
});

test("a failed autosave stays dirty and blocks actions until a successful retry", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Autosave Recovery");
  let patchAttempts = 0;
  let actionAttempts = 0;

  await page.route(new RegExp(`/api/v1/presets/${presetId}(?:$|/)`), async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "PATCH" && pathname.endsWith(`/presets/${presetId}`)) {
      patchAttempts += 1;
      if (patchAttempts <= 2) {
        await route.abort("connectionreset");
        return;
      }
    }
    if (method === "POST" && pathname.includes(`/presets/${presetId}/actions/home-score-plus`)) {
      actionAttempts += 1;
    }
    await route.continue();
  });

  await page.getByLabel("Period", { exact: true }).fill("RECOVERED");
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  expect(patchAttempts).toBe(2);

  await page.getByRole("button", { name: "Add point to HOME" }).click();
  await expect(page.getByRole("alert")).toContainText("Unsaved game changes must be saved");
  expect(actionAttempts).toBe(0);
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("0");

  let navigationWarning = "";
  page.once("dialog", async (dialog) => {
    navigationWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "Productions", exact: true }).click();
  await expect.poll(() => navigationWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  let backWarning = "";
  page.once("dialog", async (dialog) => {
    backWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.evaluate(() => window.history.back());
  await expect.poll(() => backWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  let logoutWarning = "";
  page.once("dialog", async (dialog) => {
    logoutWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Logout" }).click();
  await expect.poll(() => logoutWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  const retryResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${presetId}`));
  await page.getByRole("button", { name: "Retry save" }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Retry save" })).toBeHidden();

  const actionResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/home-score-plus`)
  );
  await page.getByRole("button", { name: "Add point to HOME" }).click();
  expect((await actionResponse).status()).toBe(200);
  expect(actionAttempts).toBe(1);

  await page.reload();
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("RECOVERED");
  await expect(page.locator(".score-control").first().locator("strong")).toHaveText("1");
});

test("failed and delayed sidebar duplication cannot bypass or hijack dirty navigation", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Dirty Duplicate Guard");
  let patchAttempts = 0;
  let duplicateAttempts = 0;
  let markSecondDuplicateStarted!: () => void;
  let releaseSecondDuplicate!: () => void;
  const secondDuplicateStarted = new Promise<void>((resolve) => {
    markSecondDuplicateStarted = resolve;
  });
  const secondDuplicateGate = new Promise<void>((resolve) => {
    releaseSecondDuplicate = resolve;
  });

  await page.route(new RegExp(`/api/v1/presets/${presetId}(?:$|/)`), async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "PATCH" && pathname.endsWith(`/presets/${presetId}`)) {
      patchAttempts += 1;
      if (patchAttempts <= 2) {
        await route.abort("connectionreset");
        return;
      }
    }
    if (method === "POST" && pathname.endsWith(`/presets/${presetId}/duplicate`)) {
      duplicateAttempts += 1;
      if (duplicateAttempts === 1) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      markSecondDuplicateStarted();
      await secondDuplicateGate;
      const response = await route.fetch();
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  await page.getByLabel("Period", { exact: true }).fill("DIRTY");
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();

  const sidebarGame = page.getByRole("link", { name: "Dirty Duplicate Guard", exact: true });
  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  let firstDuplicateWarning = "";
  page.once("dialog", async (dialog) => {
    firstDuplicateWarning = dialog.message();
    await dialog.accept();
  });
  const failedDuplicateResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/presets/${presetId}/duplicate`)
  );
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  expect((await failedDuplicateResponse).status()).toBe(200);
  expect(firstDuplicateWarning).toContain("unsaved or staged changes");
  await expect(page.locator(".shell-error")).toHaveText("Server response did not include a valid preset");

  let afterFailureWarning = "";
  page.once("dialog", async (dialog) => {
    afterFailureWarning = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "Productions", exact: true }).click();
  await expect.poll(() => afterFailureWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(new RegExp(`/dash/presets/${presetId}$`));

  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  page.once("dialog", async (dialog) => dialog.accept());
  const delayedDuplicateResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/presets/${presetId}/duplicate`)
  );
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await secondDuplicateStarted;

  let navigationWarning = "";
  page.once("dialog", async (dialog) => {
    navigationWarning = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("link", { name: "Productions", exact: true }).click();
  await expect.poll(() => navigationWarning).toContain("unsaved or staged changes");
  await expect(page).toHaveURL(/\/dash$/);

  releaseSecondDuplicate();
  expect((await delayedDuplicateResponse).status()).toBe(201);
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/\/dash$/);
  expect(duplicateAttempts).toBe(2);
});

test("soccer operator tools update output, clear graphics, rotate keys, and expose events", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Operator Tools");
  const output = page.frameLocator(".output-preview-iframe");

  const sidebarGame = page.getByRole("link", { name: "Operator Tools", exact: true });
  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  const gameMenu = page.getByRole("menu", { name: "Operator Tools actions" });
  const duplicateMenuItem = gameMenu.getByRole("menuitem", { name: "Duplicate" });
  const deleteMenuItem = gameMenu.getByRole("menuitem", { name: "Delete" });
  await expect(gameMenu).toBeVisible();
  await expect(duplicateMenuItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(deleteMenuItem).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(duplicateMenuItem).toBeFocused();
  await page.keyboard.press("End");
  await expect(deleteMenuItem).toBeFocused();
  await page.keyboard.press("Home");
  await expect(duplicateMenuItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(gameMenu).toBeHidden();
  await expect(sidebarGame).toBeFocused();

  await expect(page.getByRole("button", { name: /Add one to .* shots/ })).toHaveCount(0);
  await page.getByText("Custom text", { exact: true }).click();
  await page.getByLabel("Graphic title", { exact: true }).fill("E2E GOAL");
  await page.getByLabel("Subtitle / player", { exact: true }).fill("Player 9");
  const goalResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/trigger-goal`)
  );
  await page.getByRole("button", { name: "Goal", exact: true }).click();
  expect((await goalResponse).status()).toBe(200);
  await expect(output.getByRole("heading", { name: "E2E GOAL" })).toBeVisible();
  await expect(output.getByText("Player 9", { exact: true })).toBeVisible();

  const clearResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/v1/presets/${presetId}/actions/clear`)
  );
  await page.getByRole("button", { name: "Panic clear" }).click();
  expect((await clearResponse).status()).toBe(200);
  await expect(output.getByRole("heading", { name: "E2E GOAL" })).toBeHidden();

  let confirmMessage = "";
  page.once("dialog", async (dialog) => {
    confirmMessage = dialog.message();
    await dialog.accept();
  });
  const actionKeyResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/presets/${presetId}/action-key`)
  );
  await page.getByLabel("Game actions", { exact: true }).click();
  await page.getByRole("button", { name: "Rotate action key" }).click();
  expect((await actionKeyResponse).status()).toBe(200);
  expect(confirmMessage).toContain("Existing Stream Deck and automation keys will stop working immediately");
  await expect(page.locator(".action-key-notice code")).toHaveText(/^ooa_[A-Za-z0-9_-]{32}$/);

  const initialEventResponse = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().endsWith(`/api/v1/presets/${presetId}/events`)
  );
  await page.getByLabel("Game actions", { exact: true }).click();
  await page.getByRole("button", { name: "Event log" }).click();
  expect((await initialEventResponse).status()).toBe(200);
  const eventLog = page.getByRole("region", { name: "Preset event log" });
  await expect(eventLog).toBeVisible();
  await expect(eventLog.getByText("action.trigger-goal", { exact: true })).toBeVisible();
  await expect(eventLog.getByText("action.clear", { exact: true })).toBeVisible();
  await expect(eventLog.getByText("preset.action-key.rotate", { exact: true })).toBeVisible();

  const refreshResponse = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().endsWith(`/api/v1/presets/${presetId}/events`)
  );
  await eventLog.getByRole("button", { name: "Refresh" }).click();
  expect((await refreshResponse).status()).toBe(200);
  await expect(eventLog.getByText("preset.action-key.rotate", { exact: true })).toBeVisible();
});

test("rapid sidebar duplicate clicks create only one copy", async ({ page }) => {
  await signIn(page);
  const presetId = await createGame(page, "Duplicate Guard");
  let duplicateRequests = 0;
  await page.route(`**/api/v1/presets/${presetId}/duplicate`, async (route) => {
    duplicateRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  const sidebarGame = page.getByRole("link", { name: "Duplicate Guard", exact: true });
  await sidebarGame.focus();
  await page.keyboard.press("Shift+F10");
  const duplicate = page.getByRole("menuitem", { name: "Duplicate" });
  await duplicate.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect(page.getByRole("heading", { name: "Duplicate Guard Copy" })).toBeVisible();
  expect(duplicateRequests).toBe(1);
});

test("a long desktop sidebar keeps its first and last navigation items reachable", async ({ page }) => {
  await signIn(page);
  const updatedAt = "2026-08-11T12:00:00.000Z";
  const presets = Array.from({ length: 100 }, (_, index) => ({
    id: `sidebar-preset-${index + 1}`,
    publicId: `sidebar-public-${index + 1}`,
    name: `Sidebar Game ${String(index + 1).padStart(3, "0")}`,
    type: "soccer",
    revision: 1,
    updatedAt,
    overlayClientCount: 0
  }));
  await page.route("**/api/v1/presets", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname.endsWith("/api/v1/presets")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ presets }) });
      return;
    }
    await route.continue();
  });

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/dash");
  await expect(page.locator(".sidebar-subnav a")).toHaveCount(100);

  const reachability = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".sidebar-nav");
    const firstGame = document.querySelector<HTMLElement>(".sidebar-subnav a");
    const media = document.querySelector<HTMLElement>("a[href='/dash/media']");
    if (!nav || !firstGame || !media) throw new Error("sidebar navigation elements are missing");

    nav.scrollTop = 0;
    const navAtTop = nav.getBoundingClientRect();
    const firstAtTop = firstGame.getBoundingClientRect();
    const firstReachable = firstAtTop.top >= navAtTop.top - 1 && firstAtTop.bottom <= navAtTop.bottom + 1;

    nav.scrollTop = nav.scrollHeight;
    const navAtBottom = nav.getBoundingClientRect();
    const mediaAtBottom = media.getBoundingClientRect();
    const lastReachable = mediaAtBottom.top >= navAtBottom.top - 1 && mediaAtBottom.bottom <= navAtBottom.bottom + 1;

    return {
      firstReachable,
      lastReachable,
      scrollable: nav.scrollHeight > nav.clientHeight,
      maxScrollTop: nav.scrollTop
    };
  });

  expect(reachability.scrollable).toBe(true);
  expect(reachability.maxScrollTop).toBeGreaterThan(0);
  expect(reachability.firstReachable).toBe(true);
  expect(reachability.lastReachable).toBe(true);
});

test("the preset editor renders before optional media and team libraries finish loading", async ({ page }) => {
  await signIn(page);
  let releaseOptionalRequests!: () => void;
  const optionalRequestGate = new Promise<void>((resolve) => {
    releaseOptionalRequests = resolve;
  });
  const optionalRequests = new Set<string>();

  for (const endpoint of ["media", "teams"]) {
    await page.route(new RegExp(`/api/v1/${endpoint}(?:\\?.*)?$`), async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      optionalRequests.add(endpoint);
      await optionalRequestGate;
      await route.continue();
    });
  }

  await page.getByRole("button", { name: /New production/i }).click();
  await page.getByLabel("Production name").fill("Optional Data Latency");
  await page.getByRole("button", { name: "Create production" }).click();

  try {
    await expect.poll(() => optionalRequests.size).toBe(2);
    await expect(page.getByRole("heading", { name: "Optional Data Latency" })).toBeVisible({ timeout: 1_500 });
  } finally {
    releaseOptionalRequests();
  }
});

test("failed optional catalogs retry without reloading the production editor", async ({ page }) => {
  await signIn(page);
  const retryAllowed = { media: false, teams: false };
  for (const endpoint of ["media", "teams"]) {
    await page.route(new RegExp(`/api/v1/${endpoint}(?:\\?.*)?$`), async (route) => {
      if (route.request().method() === "GET" && !retryAllowed[endpoint as keyof typeof retryAllowed]) {
        await route.abort("failed");
      } else await route.continue();
    });
  }
  await createGame(page, "Catalog recovery");
  await expect(page.getByRole("button", { name: "Retry media" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry teams" })).toBeVisible();
  retryAllowed.media = true;
  retryAllowed.teams = true;
  await page.getByRole("button", { name: "Retry media" }).click();
  await page.getByRole("button", { name: "Retry teams" }).click();
  await expect(page.getByText("No saved media yet.")).toBeVisible();
  await expect(page.getByText("No saved teams yet.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Catalog recovery" })).toBeVisible();
});

test("dashboard, teams, and soccer editor avoid horizontal clipping at responsive widths", async ({ page }) => {
  await signIn(page);
  const responsiveWidths = [280, 320, 430, 768, 1101, 1280, 1281, 1920];

  for (const width of responsiveWidths) {
    await test.step(`dashboard at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/dash");
      await expect(page.getByRole("heading", { name: "Productions" })).toBeVisible();
      await assertNoHorizontalClipping(page, width);
    });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dash/teams");
  await page.getByRole("button", { name: "New Team" }).click();
  const teamDialog = page.getByRole("dialog", { name: "New team" });
  await teamDialog.getByRole("textbox", { name: "Team name" }).fill("Responsive Team");
  await teamDialog.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByRole("heading", { name: "Responsive Team" })).toBeVisible();
  for (const width of responsiveWidths) {
    await test.step(`team editor at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await assertNoHorizontalClipping(page, width);
    });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await createGame(page, "Responsive Editor");
  for (const width of responsiveWidths) {
    await test.step(`soccer editor at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("heading", { name: "Responsive Editor" })).toBeVisible();
      await assertNoHorizontalClipping(page, width);
    });
  }
});

test("deleting a live preset clears connected editor and overlay clients", async ({ page, context }) => {
  await signIn(page);
  const presetId = await createGame(page, "Realtime Delete");
  await expect(page.locator(".status-pill", { hasText: "connected" }).first()).toBeVisible();

  const presetResponse = await page.request.get(`${backendUrl}/api/v1/presets/${presetId}`, {
    headers: { "X-OpenOverlay-Api-Version": "v1" }
  });
  expect(presetResponse.status()).toBe(200);
  const presetBody = (await presetResponse.json()) as { preset: { publicId: string; revision: number } };

  const overlayPage = await context.newPage();
  await overlayPage.goto(`/overlay-test/${presetBody.preset.publicId}`);
  await expect(overlayPage.getByText(`${presetBody.preset.publicId} · connected`)).toBeVisible();
  await expect(overlayPage.locator(".overlay-viewport")).toBeVisible();

  const deleteResponse = await page.request.delete(`${backendUrl}/api/v1/presets/${presetId}`, {
    headers: {
      "X-OpenOverlay-Api-Version": "v1",
      "If-Match": `"${presetBody.preset.revision}"`
    }
  });
  expect(deleteResponse.status()).toBe(200);

  await expect(page.getByRole("heading", { name: "Production deleted" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to productions" })).toBeVisible();
  await expect(overlayPage.getByRole("alert")).toHaveText("This overlay was deleted and is no longer available.");
  await expect(overlayPage.locator(".overlay-viewport")).toHaveCount(0);
  await overlayPage.close();
});

test("soccer and church workflows render in dashboard and overlay", async ({ page, context }) => {
  await signUp(page, "happy-path");

  await page.getByRole("button", { name: /New production/i }).click();
  await page.getByLabel("Production name").fill("E2E Soccer");
  await page.getByRole("button", { name: "Create production" }).click();
  await expect(page.getByRole("heading", { name: "E2E Soccer" })).toBeVisible();
  await expect(page.getByText(/\d+ outputs?/)).toBeVisible();

  await page.getByRole("link", { name: "Media" }).click();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#0f766e"/><text x="60" y="70" text-anchor="middle" font-size="38" fill="white">OO</text></svg>`;
  await page.getByLabel("Upload media files").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await expect(page.getByText("logo.svg")).toBeVisible();

  await page.getByRole("link", { name: "Productions" }).click();
  await page.getByRole("link", { name: "Open E2E Soccer" }).click();
  await page.getByRole("button", { name: "Match", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Home team details/ })
    .click();
  const saveResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && /\/api\/v\d+\/presets\//.test(response.url()));
  await page.getByLabel("Team name").first().fill("Home Academy");
  await page
    .locator("summary")
    .filter({ hasText: /^Away team details/ })
    .click();
  await page.getByLabel("Team name").nth(1).fill("Away Academy");
  await page.getByLabel("Abbreviation").first().fill("HOM");
  await page.getByLabel("Abbreviation").nth(1).fill("AWY");
  await page.getByLabel("Roster").first().fill("10 Max Grenham\n11 Avery Stone");
  await saveResponse;

  await page.getByRole("button", { name: "Live" }).click();
  const homeScore = page.locator(".score-control", { hasText: "HOM" });
  await homeScore.getByRole("button", { name: "Add point to HOM" }).click();
  await expect(homeScore.locator("strong")).toHaveText("1");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(homeScore.locator("strong")).toHaveText("0");
  await homeScore.getByRole("button", { name: "Add point to HOM" }).click();
  await page.locator(".score-control", { hasText: "AWY" }).getByRole("button", { name: "Add point to AWY" }).click();

  await page.getByRole("button", { name: "Play Full page matchup", exact: true }).click();
  const previewSrc = await page.locator(".output-preview-iframe").getAttribute("src");
  expect(previewSrc).toBeTruthy();
  const overlayPage = await context.newPage();
  const publicAuthRequests: string[] = [];
  overlayPage.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/v1/auth/me")) publicAuthRequests.push(request.url());
  });
  await overlayPage.goto(previewSrc!.replace(/[?&]client=preview/, ""));
  const soccerPackage = overlayPage.frameLocator(".lab-frame");
  await expect(soccerPackage.getByText("Home Academy")).toBeVisible();
  await expect(soccerPackage.getByText("Away Academy")).toBeVisible();
  expect(publicAuthRequests, "public overlays should not make a private session probe").toEqual([]);
  await overlayPage.reload();
  await expect(soccerPackage.getByText("Home Academy")).toBeVisible();
  await overlayPage.close();

  await page.getByRole("link", { name: "Productions" }).click();
  await page.getByRole("button", { name: /New production/i }).click();
  await page.getByLabel("Production type").selectOption("church");
  await page.getByLabel("Production name").fill("E2E Church");
  await page.getByRole("button", { name: "Create production" }).click();
  await expect(page.getByRole("heading", { name: "E2E Church" })).toBeVisible();
  await page.getByRole("button", { name: "Service", exact: true }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Welcome\nE2E Service");
  await expect(page.frameLocator('iframe[title="Church live output"]').getByText("E2E Service")).toHaveCount(0);
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(page.frameLocator('iframe[title="Church live output"]').getByText("E2E Service")).toBeVisible();
});

test("an older media item remains selectable after the first library page", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const presetId = await createGame(page, "Older media selection");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#123456"/></svg>');
  let oldestId = "";
  for (let index = 0; index < 26; index += 1) {
    const response = await page.request.post(`${backendUrl}/api/v1/media`, {
      multipart: { file: { name: index === 0 ? "oldest-logo.svg" : `newer-${index}.svg`, mimeType: "image/svg+xml", buffer: svg } }
    });
    expect(response.status()).toBe(201);
    if (index === 0) oldestId = (await response.json()).media.id;
  }
  await page.getByRole("button", { name: "Match", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Home team details/ })
    .click();
  await page
    .getByRole("button", { name: /Choose existing logo from media library/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Load more" }).click();
  const save = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/v1/presets/${presetId}`));
  await page.getByRole("button", { name: "oldest-logo.svg" }).click();
  const saved = await save;
  expect(saved.status()).toBe(200);
  const detail = await page.request.get(`${backendUrl}/api/v1/presets/${presetId}`);
  expect((await detail.json()).preset.state.home.logoMediaId).toBe(oldestId);
});

test("live output survives concurrent scores, capture clock skew, reconnect, and 16:9 resizing", async ({ page, browser }, testInfo) => {
  await signIn(page);
  const presetId = await createGame(page, "Live Stress");
  const capture = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await capture.addInitScript(() => {
    const wallClock = Date.now;
    Date.now = () => wallClock() + 120_000;
  });
  const output = await capture.newPage();
  try {
    const src = (await page.locator(".output-preview-iframe").getAttribute("src"))!.replace(/[?&]client=preview/, "");
    await output.goto(src);
    await expect(output.locator(".overlay-stage")).toBeVisible();
    const action = async (name: string, data = {}) => {
      const response = await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/${name}`, { data });
      expect(response.status()).toBe(200);
      return (await response.json()).preset;
    };
    await action("show-overlay", { overlay: "scorebug" });
    const score = output.frameLocator(".lab-frame").locator("[data-bind-score]").first();
    await expect(score).toHaveText("0");
    await Promise.all(Array.from({ length: 20 }, () => action("home-score-plus")));
    await expect(score).toHaveText("20");
    await expect(page.locator(".score-control strong").first()).toHaveText("20");
    // Browser clicks wait for the existing mutation lock; none may be lost.
    for (let index = 0; index < 6; index += 1) await page.getByRole("button", { name: "Add point to HOME" }).click();
    await expect(score).toHaveText("26");
    await output.reload();
    await expect(score).toHaveText("26");
    await expect(output.frameLocator(".lab-frame").locator(".overlay-entering")).toHaveCount(0);

    for (const width of [1280, 1920, 2560, 3840]) {
      const height = (width * 9) / 16;
      await output.setViewportSize({ width, height });
      await expect.poll(async () => Math.round((await output.locator(".overlay-stage").boundingBox())!.width)).toBe(width);
      const box = (await output.locator(".overlay-stage").boundingBox())!;
      expect(Math.round(box.height)).toBe(height);
      expect(Math.round(box.x)).toBe(0);
      expect(Math.round(box.y)).toBe(0);
      expect(await output.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      await output.screenshot({ path: testInfo.outputPath(`capture-${width}.png`), omitBackground: true });
    }
    await capture.setOffline(true);
    await action("away-score-plus");
    await expect(score).toHaveText("26");
    await capture.setOffline(false);
    await expect(output.frameLocator(".lab-frame").locator("[data-bind-score]").nth(1)).toHaveText("1", { timeout: 15_000 });
    await action("countdown-start", { durationSeconds: 5 });
    const timer = output.frameLocator(".lab-frame").locator(".timer-value");
    await expect(timer).toHaveText(/00:0[1-5]/);
    await expect(timer).toHaveText("00:00", { timeout: 8_000 });
    await action("trigger-goal", { title: "Expires offline", durationSeconds: 2 });
    await expect(output.getByRole("heading", { name: "Expires offline" })).toBeVisible();
    await capture.setOffline(true);
    await expect(output.getByRole("heading", { name: "Expires offline" })).toBeHidden({ timeout: 5_000 });
    await capture.setOffline(false);
  } finally {
    await capture.close();
  }
});

test("overlay falls back to HTTP polling when WebSocket transport is blocked", async ({ page, browser }) => {
  await signIn(page);
  const presetId = await createGame(page, "Polling Fallback");
  const capture = await browser.newContext();
  await capture.addInitScript(() => {
    window.WebSocket = class extends WebSocket {
      constructor() {
        super("blocked://capture-policy");
      }
    };
  });
  const output = await capture.newPage();
  try {
    const polling = output.waitForResponse((response) => response.url().includes("transport=polling") && response.status() === 200);
    const src = (await page.locator(".output-preview-iframe").getAttribute("src"))!;
    await output.goto(src);
    await polling;
    const response = await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/trigger-goal`, {
      data: { title: "Polling is live", durationSeconds: 0 }
    });
    expect(response.status()).toBe(200);
    await expect(output.getByRole("heading", { name: "Polling is live" })).toBeVisible();
  } finally {
    await capture.close();
  }
});

test("teams, media deletion, sharing, church output, and accessible controls work end to end", async ({ page, browser }, testInfo) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await signIn(page);
  const checkAccessibility = async () => {
    // Navigation fades briefly composite readable text against the page background.
    // Audit the settled surface while retaining every contrast assertion.
    await page.evaluate(async () => {
      const animations = document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      report.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target), details: nodes.map((node) => node.failureSummary) }))
    ).toEqual([]);
  };
  await checkAccessibility();
  await page.getByRole("link", { name: "Teams", exact: true }).click();
  await page.getByRole("button", { name: "New Team" }).click();
  await page.getByRole("dialog").getByLabel("Team name").fill("Audit United");
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByRole("heading", { name: "Audit United" })).toBeVisible();
  const teamSave = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.startsWith("/api/v1/teams/"));
  await page.getByLabel("Abbreviation", { exact: true }).fill("AUC");
  expect((await teamSave).status()).toBe(200);
  await expect(page.locator(".autosave-status")).toContainText(/Saved|Updated/);
  await page.reload();
  await expect(page.getByLabel("Abbreviation", { exact: true })).toHaveValue("AUC");
  await checkAccessibility();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit United" })).toBeHidden();

  await page.getByRole("link", { name: "Media", exact: true }).click();
  await page.getByLabel("Upload media files").setInputFiles({
    name: "audit.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
  });
  await expect(page.getByText("audit.svg")).toBeVisible();
  await checkAccessibility();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("article").filter({ hasText: "audit.svg" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("audit.svg")).toBeHidden();

  await createGame(page, "Shared Service", "church");
  const previewWidth = (await page.locator(".church-program").boundingBox())!.width;
  const columnWidth = (await page.locator(".church-monitors").boundingBox())!.width;
  expect(previewWidth).toBeGreaterThan(columnWidth * 0.85);
  await expect(page.getByRole("button", { name: "Hide slide", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Show selected lower third" }).click();
  const output = page.frameLocator('iframe[title="Church live output"]');
  await expect(output.locator(".church-lower-third")).toBeVisible();
  await page.getByLabel("Countdown length").fill("00:03");
  await page.getByLabel("Countdown length").blur();
  await page.getByRole("button", { name: "Start countdown" }).click();
  await expect(output.locator(".countdown-element")).toBeVisible();
  await expect(output.locator(".countdown-element")).toBeHidden({ timeout: 6_000 });
  await expect(page.getByRole("button", { name: "Start countdown", exact: true })).toBeVisible();
  await checkAccessibility();
  await page.screenshot({ path: testInfo.outputPath("church-controls.png") });

  const recipientContext = await browser.newContext();
  const recipient = await recipientContext.newPage();
  try {
    const account = await signUp(recipient, "share-recipient");
    await page.getByLabel("Service actions", { exact: true }).click();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByLabel("Recipient account email").fill(account.email);
    await page.getByRole("button", { name: "Share copy", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /A copy was shared/ })).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByRole("link", { name: /Open Shared Service/ })).toBeVisible();
    await recipient.getByRole("link", { name: /Open Shared Service/ }).click();
    await expect(recipient.locator("main h1")).toContainText("Shared Service");
  } finally {
    await recipientContext.close();
  }
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(page.getByRole("button", { name: "Login", exact: true })).toBeVisible();
});

test("a lost action response preserves the committed score and the next action", async ({ page, context }) => {
  let receivedCommit!: () => void;
  const committed = new Promise<void>((resolve) => {
    receivedCommit = resolve;
  });
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string" && payload.includes('"preset:update"') && payload.includes('"score":{"home":1,"away":0}')) receivedCommit();
    })
  );
  await signIn(page);
  const presetId = await createGame(page, "Lost acknowledgement");
  const output = await context.newPage();
  const src = (await page.locator(".output-preview-iframe").getAttribute("src"))!;
  await output.goto(src);
  await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/show-overlay`, { data: { overlay: "scorebug" } });
  const score = output.frameLocator(".lab-frame").locator("[data-bind-score]").first();
  await expect(score).toHaveText("0");
  await page.route(
    `**/presets/${presetId}/actions/home-score-plus`,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await committed;
      await expect(score).toHaveText("1");
      await route.abort("connectionreset");
    },
    { times: 1 }
  );
  await page.getByRole("button", { name: "Add point to HOME" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".score-control strong").first()).toHaveText("1");
  await page.getByRole("button", { name: "Add point to HOME" }).click();
  await expect(score).toHaveText("2");
  await expect(page.locator(".score-control strong").first()).toHaveText("2");
  await page.reload();
  await expect(page.locator(".score-control strong").first()).toHaveText("2");
});

test("server-timed soccer controls keep running through focus and tab changes", async ({ page }) => {
  await page.addInitScript(() => {
    const wallClock = Date.now;
    Date.now = () => wallClock() + 120_000;
  });
  await signIn(page);
  await createGame(page, "Control clock skew");
  await page.getByRole("button", { name: "Play Scorebug", exact: true }).click();
  await page.getByRole("button", { name: "Start clock", exact: true }).click();
  const manual = page.getByLabel("Manual time", { exact: true });
  await expect(manual).toHaveValue(/00:0[1-3]/);
  await manual.focus();
  const focused = await manual.inputValue();
  await expect
    .poll(async () => page.frameLocator(".output-preview-iframe").frameLocator(".lab-frame").locator(".bug-clock strong").first().textContent())
    .not.toBe(focused);
  await page.getByRole("heading", { name: "Clock", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause clock", exact: true })).toBeVisible();
  await expect(manual).toHaveValue(/00:0[3-9]/);
  const beforeSwitch = await manual.inputValue();
  await page.getByRole("button", { name: "Design", exact: true }).click();
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await expect.poll(async () => (await manual.inputValue()) >= beforeSwitch).toBe(true);
  const beforeModeChange = await manual.inputValue();
  await page.getByRole("combobox", { name: "Mode", exact: true }).first().selectOption("down");
  await expect(page.getByRole("button", { name: "Start clock", exact: true })).toBeVisible();
  expect((await manual.inputValue()) >= beforeModeChange).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const pausedTime = await manual.inputValue();
  await page.reload();
  await expect(manual).toHaveValue(pausedTime);
});

test("controls and public output recover after server-initiated subscription disconnects", async ({ page, browser }) => {
  let adminChannel: { send(message: string): void } | undefined;
  let adminTransports = 0;
  await page.routeWebSocket("**/socket.io/**", (channel) => {
    adminTransports++;
    const server = channel.connectToServer();
    channel.onMessage((message) => {
      server.send(message);
      // Wait for Engine.IO's upgrade packet, not a state update that may have
      // already arrived over the initial polling transport.
      if (String(message) === "5" && new URL(channel.url()).searchParams.get("role") === "admin") adminChannel = channel;
    });
  });
  await signIn(page);
  const presetId = await createGame(page, "Subscription recovery");
  const capture = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  let outputChannel: { send(message: string): void } | undefined;
  let outputTransports = 0;
  await capture.routeWebSocket("**/socket.io/**", (channel) => {
    outputTransports++;
    const server = channel.connectToServer();
    channel.onMessage((message) => {
      server.send(message);
      if (String(message) === "5") outputChannel = channel;
    });
  });
  const output = await capture.newPage();
  try {
    await output.goto((await page.locator(".output-preview-iframe").getAttribute("src"))!);
    await expect.poll(() => Boolean(outputChannel) && adminTransports > 0).toBe(true);
    await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/show-overlay`, { data: { overlay: "scorebug" } });
    await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/home-score-plus`, { data: {} });
    const score = output.frameLocator(".lab-frame").locator("[data-bind-score]").first();
    await expect(score).toHaveText("1");
    await expect.poll(() => Boolean(adminChannel)).toBe(true);
    const beforeAdmin = adminTransports;
    const beforeOutput = outputTransports;
    for (const channel of [adminChannel!, outputChannel!]) {
      channel.send('42["error:message",{"error":"Realtime connection failed"}]');
      channel.send("41");
    }
    await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/home-score-plus`, { data: {} });
    await expect(score).toHaveText("2");
    await expect(page.locator(".score-control strong").first()).toHaveText("2");
    await expect.poll(() => adminTransports > beforeAdmin && outputTransports > beforeOutput).toBe(true);
  } finally {
    await capture.close();
  }
});

test("revoked editor sessions return to login while public output stays live", async ({ page, browser }) => {
  await signIn(page);
  const presetId = await createGame(page, "Session revocation");
  await page.getByRole("button", { name: "Start clock", exact: true }).click();
  const capture = await browser.newContext();
  const output = await capture.newPage();
  try {
    await output.goto((await page.locator(".output-preview-iframe").getAttribute("src"))!);
    const timer = output.frameLocator(".lab-frame").locator(".bug-clock strong");
    await expect(timer).toHaveText(/00:0[1-3]/);
    const before = await timer.textContent();
    // Revoke through a separate HTTP client, as another signed-in tab would.
    const revoked = await page.request.post(`${backendUrl}/api/v1/auth/logout`, { data: {} });
    expect(revoked.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Login", exact: true })).toBeVisible();
    await expect(timer).not.toHaveText(before!);
    // Revocation destroys the Engine.IO session. Its final in-flight polling
    // POST may correctly receive Unknown session (400) during teardown.
    const closedSessionRequest = `http 400: POST ${backendUrl}/socket.io/?role=admin&presetId=${presetId}&`;
    browserErrors.set(
      page.context(),
      (browserErrors.get(page.context()) || []).filter((error) => !error.startsWith(closedSessionRequest))
    );
  } finally {
    await capture.close();
  }
});

test("team editing stays available during slow media and preserves selection across delayed deletion", async ({ page }) => {
  await signIn(page);
  const names = ["Library Alpha", "Library Bravo", "Library Charlie"];
  for (const fullName of names) {
    const response = await page.request.post(`${backendUrl}/api/v1/teams`, {
      data: { fullName },
      headers: { Origin: new URL(page.url()).origin, "X-OpenOverlay-Api-Version": "v1" }
    });
    expect(response.status()).toBe(201);
  }
  let releaseMedia!: () => void;
  const mediaGate = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  await page.route("**/api/v1/media**", async (route) => {
    await mediaGate;
    await route.continue();
  });
  await page.goto("/dash/teams");
  try {
    await expect(page.getByRole("button", { name: /Library Alpha/ })).toBeVisible();
  } finally {
    releaseMedia();
  }
  await page.getByRole("button", { name: /Library Alpha/ }).click();
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  await page.route("**/api/v1/teams/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const response = await route.fetch();
    await deleteGate;
    await route.fulfill({ response });
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".team-editor-panel button").filter({ hasText: "Deleting..." })).toBeDisabled();
  await page.getByRole("button", { name: /Library Charlie/ }).click();
  releaseDelete();
  await expect(page.getByRole("button", { name: /Library Alpha/ })).toBeHidden();
  await expect(page.getByLabel("Team name", { exact: true })).toHaveValue("Library Charlie");
});

test("media upload and deletion remain accurate when library refreshes fail", async ({ page }) => {
  await signIn(page);
  await page.goto("/dash/media");
  await expect(page.getByText("Drop images here")).toBeVisible();
  // Let the initial GET settle before faulting the post-mutation refreshes.
  await page.waitForLoadState("networkidle");
  let failRefresh = true;
  await page.route("**/api/v1/media**", async (route) => {
    if (route.request().method() === "GET" && failRefresh) return route.abort("failed");
    await route.continue();
  });
  await page.getByLabel("Upload media files").setInputFiles({
    name: "refresh-survivor.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>')
  });
  await expect(page.getByRole("alert")).toContainText("Uploads finished");
  const card = page.locator(".media-card").filter({ hasText: "refresh-survivor.svg" });
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Retry media" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load media");
  failRefresh = false;
  await page.getByRole("button", { name: "Retry media" }).click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(card).toBeVisible();
  failRefresh = true;
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alert")).toContainText("Media deleted");
  await expect(card).toBeHidden();
  failRefresh = false;
  await page.getByRole("button", { name: "Retry media" }).click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(card).toBeHidden();
});

test("panic clear cancels a queued graphic entrance in the independent browser source", async ({ page, browser }) => {
  await signIn(page);
  const presetId = await createGame(page, "Interrupted Broadcast");
  const preset = (await (await page.request.get(`${backendUrl}/api/v1/presets/${presetId}`)).json()).preset;
  await page.getByRole("button", { name: "Play Full page matchup", exact: true }).click();
  const capture = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const output = await capture.newPage();
    await output.goto(new URL(`/overlay/${preset.publicId}`, page.url()).href);
    const stage = output.frameLocator(".lab-frame").locator("#stage");
    await expect(stage.locator(".overlay-full-matchup")).toBeVisible();
    await expect(stage.locator(".overlay-entering")).toHaveCount(0);
    const shown = await page.request.post(`${backendUrl}/api/v1/presets/${presetId}/actions/show-overlay`, {
      data: { overlay: "scorebug" },
      headers: { Origin: new URL(page.url()).origin }
    });
    expect(shown.ok()).toBe(true);
    await expect(stage.locator(".overlay-full-matchup.overlay-exiting")).toHaveCount(1);
    await page.getByRole("button", { name: "Panic clear" }).click();
    // Observe the whole transition window, including brief stale entrances.
    const reappeared = await stage.evaluate(async (node) => {
      let entered = false;
      const check = () => {
        if (node.querySelector(".overlay-scorebug:not(.overlay-exiting)")) entered = true;
      };
      const observer = new MutationObserver(check);
      observer.observe(node, { subtree: true, childList: true, attributes: true });
      check();
      await new Promise((resolve) => setTimeout(resolve, 1800));
      observer.disconnect();
      return entered;
    });
    expect(reappeared).toBe(false);
    await expect(stage.locator(".overlay-scorebug, .overlay-full-matchup")).toHaveCount(0);
  } finally {
    await capture.close();
  }
});

test("both packages keep transparent output and matchup teams on one row", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const { default: sharp } = await import("sharp");
  const { createDefaultSoccerState } = await import("@openoverlay/shared");
  await signIn(page);
  const id = await createGame(page, "Package rendering");
  let preset = (await (await page.request.get(`${backendUrl}/api/v1/presets/${id}`)).json()).preset;
  expect(preset.state.soccerPackage.activeOverlay).toBeNull();
  const capture = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    storageState: { cookies: [], origins: [{ origin: new URL(page.url()).origin, localStorage: [{ name: "openoverlay:theme", value: "dark" }] }] }
  });
  const output = await capture.newPage();
  await output.setViewportSize({ width: 1920, height: 1080 });
  try {
    for (const packageName of ["classic", "rounded"] as const) {
      for (const overlay of [
        "full-matchup",
        "lower-matchup",
        "lower-result",
        "lineup-panel",
        "scorebug",
        "countdown-timer",
        "one-line-text",
        "two-line-text"
      ] as const) {
        const state = createDefaultSoccerState("Package rendering");
        state.soccerPackage = { ...state.soccerPackage, overlayPackage: packageName, activeOverlay: overlay, packageBackground: false };
        const response = await page.request.patch(`${backendUrl}/api/v1/presets/${id}`, { data: { state, expectedRevision: preset.revision } });
        expect(response.status()).toBe(200);
        preset = (await response.json()).preset;
        await output.goto(`/overlay/${preset.publicId}`);
        await expect(output.locator("html")).toHaveAttribute("data-theme", "dark");
        const frame = output.frameLocator(".lab-frame");
        await expect(frame.locator("article")).toBeVisible();
        await expect(frame.locator(".overlay-entering")).toHaveCount(0);
        const png = await output.screenshot({ omitBackground: true, path: testInfo.outputPath(`${packageName}-${overlay}.png`) });
        const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(data[3], `${packageName}/${overlay} canvas should be transparent`).toBe(0);
        const teamSelector =
          overlay === "full-matchup" ? ".full-team" : overlay === "lower-matchup" ? ".lower-team" : overlay === "lower-result" ? ".lower-result-team" : null;
        if (teamSelector) {
          const teams = await frame.locator(teamSelector).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
          expect(teams).toHaveLength(2);
          expect(Math.abs(teams[0].y - teams[1].y)).toBeLessThan(2);
          expect(teams[0].right).toBeLessThanOrEqual(teams[1].left + 2);
        }
      }
    }
  } finally {
    await capture.close();
  }
});

test("church drafts, reordering, and deletion never change a published slide", async ({ page }) => {
  await signIn(page);
  const id = await createGame(page, "Draft safety", "church");
  const output = page.frameLocator('iframe[title="Church live output"]');
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Opening song");
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(output.getByText("Opening song", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Next song");
  await page.getByRole("button", { name: "Move slide up", exact: true }).click();
  await expect(output.getByText("Opening song", { exact: true })).toBeVisible();
  await expect(output.getByText("Next song", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toContainText("Saved");
  await page.reload();
  await expect(output.getByText("Opening song", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(output.getByText("Next song", { exact: true })).toBeVisible();
  if (!(await page.getByRole("button", { name: "Delete slide", exact: true }).isVisible())) await page.locator(".church-slide-editor > summary").click();
  await expect(page.getByRole("button", { name: "Delete slide", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /^Preview Slide 1, slide/ }).click();
  await page.getByRole("button", { name: "Delete slide", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toContainText("Saved");
  await page.reload();
  await expect(output.getByText("Next song", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide slide", exact: true }).click();
  await expect(output.getByText("Next song", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show slide", exact: true }).click();
  await expect(output.getByText("Next song", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Panic clear", exact: true }).click();
  await expect(output.getByText("Next song", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(output.getByText("Next song", { exact: true })).toHaveCount(0);
  const saved = await page.request.get(`${backendUrl}/api/v1/presets/${id}`);
  expect(saved.status()).toBe(200);
});
