const { expect, test } = require("@playwright/test");
const { ADMIN_HASSWORD } = require("./admin-hassword.cjs");
const seed = require("../src/server/seed.json");

const HARD = "The feline reposed languidly upon the ornamental rug.";

// Every test starts from the seed styles, saved as the newest version.
test.beforeEach(async ({ page, request }, testInfo) => {
  await page.setExtraHTTPHeaders({ "CF-Connecting-IP": `test-${testInfo.testId}-${testInfo.project.name}` });
  await request.post("/api/admin/signin", { data: { hassword: ADMIN_HASSWORD } });
  const { token, versions } = await (await request.get("/api/admin/styles")).json();
  const saved = await request.put("/api/admin/styles", {
    data: { basedOn: versions[0].number, ...seed },
    headers: { "X-Form-Token": token },
  });
  expect(saved.ok()).toBe(true);
});

async function signIn(page) {
  await page.goto("/admin");
  await page.getByLabel("Hassword").fill(ADMIN_HASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Shared rules" })).toBeVisible();
}

const saveStatus = (page) => page.locator("#save-status");
const nameOf = (page, n) => page.getByRole("textbox", { name: `Name of style ${n}` });
const promptOf = (page, n) => page.getByRole("textbox", { name: `Prompt of style ${n}` });

async function save(page) {
  await page.getByRole("button", { name: "Save for everyone" }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved as version \d+\. Everyone sees it now\.$/);
}

async function paste(page, text) {
  const input = page.getByRole("textbox", { name: "Fancy text" });
  await input.fill(text);
  await page.getByRole("button", { name: /Dumb it down/ }).click();
}

test("the Admin link leads to sign-in, which refuses a wrong hassword", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
  await page.getByLabel("Hassword").fill("not the hassword");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#signin-status")).toHaveText("Wrong hassword.");
  await expect(page.getByRole("heading", { name: "Shared rules" })).toBeHidden();
});

test("explains the lock after too many wrong tries", async ({ page }) => {
  await page.route("**/api/admin/signin", (route) =>
    route.fulfill({ status: 429, json: { error: "locked", retryAfter: 840 } }),
  );
  await page.goto("/admin");
  await page.getByLabel("Hassword").fill("anything");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#signin-status")).toHaveText("Too many wrong tries. Try again in 14 minutes.");
});

test("an edited style can be tried, then saved for everyone", async ({ page }) => {
  await signIn(page);
  await expect(saveStatus(page)).toHaveText("Everyone sees this version.");
  await expect(page.getByRole("button", { name: "Save for everyone" })).toBeDisabled();

  await nameOf(page, 1).fill("Brutal");
  await promptOf(page, 1).fill("Voice: FAKE_REPLY:Arr, it be a cat.");
  await expect(saveStatus(page)).toHaveText("Unsaved changes.");

  await page.getByLabel("Style to try").selectOption({ label: "Brutal" });
  await page.getByLabel("Sample text").fill(HARD);
  await page.getByRole("button", { name: "Try", exact: true }).click();
  await expect(page.getByLabel("Result")).toHaveValue("Arr, it be a cat.");
  await expect(page.locator("#try-score")).toHaveAttribute("data-state", "ready");

  const visitor = await page.context().newPage();
  await visitor.goto("/");
  await expect(visitor.getByRole("radio", { name: "Blunt" })).toBeChecked();
  await visitor.close();

  await save(page);
  await expect(page.locator("#versions li").first()).toContainText("Brutal, Teacher, Caveman");

  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Brutal" })).toBeChecked();
  await paste(page, HARD);
  await expect(page.getByRole("textbox", { name: "Plain truth" })).toHaveValue("Arr, it be a cat.");
});

test("styles can be added, moved and removed", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Add style" }).click();
  await expect(nameOf(page, 4)).toBeFocused();
  await nameOf(page, 4).fill("Pirate");
  await promptOf(page, 4).fill("Voice: a pirate.");
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Move Pirate up" }).click();
  await page.getByRole("button", { name: "Remove Teacher" }).click();
  await save(page);
  await expect(page.locator(".style-id").first()).toHaveText("pirate");

  await page.goto("/");
  await expect(page.getByRole("radiogroup", { name: "Style" }).getByRole("radio")).toHaveCount(3);
  await expect(page.getByRole("radio", { name: "Pirate" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Teacher" })).toHaveCount(0);
});

test("a remembered style that was removed falls back to the first one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: "Caveman" }).check();
  await signIn(page);
  await page.getByRole("button", { name: "Remove Caveman" }).click();
  await save(page);
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Blunt" })).toBeChecked();
});

test("an open page whose style was removed says to reload", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: "Caveman" }).check();
  const admin = await browser.newPage();
  await signIn(admin);
  await admin.getByRole("button", { name: "Remove Caveman" }).click();
  await save(admin);
  await admin.close();
  await paste(page, HARD);
  await expect(page.locator("#status")).toHaveText("That style is gone. Reload the page for the new ones.");
});

test("an older version can be loaded and saved again", async ({ page }) => {
  await signIn(page);
  await nameOf(page, 1).fill("Brutal");
  await save(page);
  const older = page.locator("#versions li").nth(1);
  await expect(older).toContainText("Blunt, Teacher, Caveman");
  await older.getByRole("button", { name: /^Load version/ }).click();
  await expect(nameOf(page, 1)).toHaveValue("Blunt");
  await expect(saveStatus(page)).toHaveText(/^Loaded version \d+\. Save to make it live\.$/);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(nameOf(page, 1)).toHaveValue("Brutal");
  await older.getByRole("button", { name: /^Load version/ }).click();
  await save(page);
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Blunt" })).toBeChecked();
});

test("a save after someone else's asks before it replaces theirs", async ({ page, browser }) => {
  await signIn(page);
  const other = await browser.newPage();
  await signIn(other);
  await nameOf(other, 1).fill("Theirs");
  await save(other);
  await other.close();

  await nameOf(page, 1).fill("Mine");
  await page.getByRole("button", { name: "Save for everyone" }).click();
  await expect(saveStatus(page)).toHaveText(
    /^Someone saved version \d+ while you were editing\. Save again to replace it with yours\.$/,
  );
  await expect(page.locator("#versions li").first()).toContainText("Theirs");
  await save(page);
  await expect(page.locator("#versions li").first()).toContainText("Mine");
});

test("a broken draft is explained and not saved", async ({ page }) => {
  await signIn(page);
  await nameOf(page, 2).fill("Blunt");
  await page.getByRole("button", { name: "Save for everyone" }).click();
  await expect(saveStatus(page)).toHaveText('Two styles are called "Blunt".');
  await expect(saveStatus(page)).toHaveAttribute("data-tone", "error");
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Hassword")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Hassword")).toBeVisible();
});

test("the admin page fits the screen without sideways scrolling", async ({ page }) => {
  await signIn(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
