const { expect, test } = require("@playwright/test");
const { ADMIN_HASSWORD } = require("./admin-hassword.cjs");
const seed = require("../src/server/seed.json");

const HARD = "The feline reposed languidly upon the ornamental rug.";

// Every test starts from the seed personalities, saved as the newest version.
test.beforeEach(async ({ page, request }, testInfo) => {
  await page.setExtraHTTPHeaders({ "CF-Connecting-IP": `test-${testInfo.testId}-${testInfo.project.name}` });
  await request.post("/api/admin/signin", { data: { hassword: ADMIN_HASSWORD } });
  const { token, versions } = await (await request.get("/api/admin/personalities")).json();
  const saved = await request.put("/api/admin/personalities", {
    data: { basedOn: versions[0].number, ...seed },
    headers: { "X-Form-Token": token },
  });
  expect(saved.ok()).toBe(true);
});

async function signIn(page) {
  await page.goto("/admin");
  await page.getByLabel("Hassword").fill(ADMIN_HASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#personality-title")).toHaveText("Blunt");
}

const picker = (page) => page.getByRole("navigation", { name: "What to edit" });
const open = (page, name) =>
  picker(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
const nameField = (page) => page.getByRole("textbox", { name: "Name", exact: true });
const promptField = (page) => page.getByRole("textbox", { name: "Prompt", exact: true });
const messagesField = (page) => page.getByRole("textbox", { name: "Messages", exact: true });
const saveStatus = (page) => page.locator("#save-status");
const buildStatus = (page) => page.locator("#build-status");

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
  await expect(page.locator("#editor")).toBeHidden();
});

test("a first visit shows only the sign-in card", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByLabel("Hassword")).toBeVisible();
  await expect(page.locator("#signin-status")).toBeEmpty();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
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

test("the save bar shows only while something is not saved", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("#savebar")).toBeHidden();
  await promptField(page).fill("Voice: someone else.");
  await expect(saveStatus(page)).toHaveText("Not saved yet. Visitors still get the live version.");
  await expect(picker(page).locator(".pick-dot").nth(1)).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator("#savebar")).toBeHidden();
  await expect(promptField(page)).toHaveValue(seed.personalities[0].prompt);
});

test("an edited personality can be tried, then saved for everyone", async ({ page }) => {
  await signIn(page);
  await nameField(page).fill("Brutal");
  await promptField(page).fill("Voice: FAKE_REPLY:Arr, it be a cat.");
  await expect(page.getByRole("heading", { name: "Try as Brutal" })).toBeVisible();

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

test("Try uses the open personality, and keeps it while the shared rules are open", async ({ page }) => {
  await signIn(page);
  await open(page, "Caveman");
  await expect(page.getByRole("heading", { name: "Try as Caveman" })).toBeVisible();
  await open(page, "Shared rules");
  await expect(page.getByRole("heading", { name: "Shared rules" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Try as Caveman" })).toBeVisible();
});

test("personalities can be added, moved and removed", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "+ New personality" }).click();
  await expect(nameField(page)).toBeFocused();
  await nameField(page).fill("Pirate");
  await promptField(page).fill("Voice: a pirate.");
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Move up" }).click();
  await expect(page.getByRole("button", { name: "Move down" })).toBeFocused();
  await open(page, "Teacher");
  await page.getByRole("button", { name: "Remove" }).click();
  await save(page);
  await open(page, "Pirate");
  await expect(page.locator("#personality-id")).toHaveText("id: pirate");

  await page.goto("/");
  await expect(page.getByRole("radiogroup", { name: "Personality" }).getByRole("radio")).toHaveCount(3);
  await expect(page.getByRole("radio", { name: "Pirate" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Teacher" })).toHaveCount(0);
});

test("a personality is built from messages, which stay for the next build", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "+ New personality" }).click();
  await page.getByRole("button", { name: "Build prompt" }).click();
  await expect(buildStatus(page)).toHaveText("Paste some messages first.");

  const first = "FAKE_REPLY:Name: Grump|Voice: a grumpy uncle.\nugh. kids these days";
  await messagesField(page).fill(first);
  await page.getByRole("button", { name: "Build prompt" }).click();
  await expect(buildStatus(page)).toHaveText("Built. Try it, then save.");
  await expect(nameField(page)).toHaveValue("Grump");
  await expect(promptField(page)).toHaveValue("Voice: a grumpy uncle.");
  await save(page);

  await page.reload();
  await open(page, "Grump");
  await expect(messagesField(page)).toHaveValue(first);
  await messagesField(page).fill(`${first}\nback in my day we walked`);
  const sent = page.waitForRequest("**/api/admin/build");
  await page.getByRole("button", { name: "Rebuild prompt" }).click();
  expect((await sent).postDataJSON()).toMatchObject({
    name: "Grump",
    prompt: "Voice: a grumpy uncle.",
    messages: `${first}\nback in my day we walked`,
  });
  await expect(buildStatus(page)).toHaveText("Built. Try it, then save.");
  await expect(nameField(page)).toHaveValue("Grump");
});

test("a failed build says so and changes nothing", async ({ page }) => {
  await signIn(page);
  await messagesField(page).fill("FAIL_CLAUDE");
  await page.getByRole("button", { name: "Rebuild prompt" }).click();
  await expect(buildStatus(page)).toHaveText("Claude failed on this one. Try again.");
  await expect(promptField(page)).toHaveValue(seed.personalities[0].prompt);
});

test("a remembered personality that was removed falls back to the first one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: "Caveman" }).check();
  await signIn(page);
  await open(page, "Caveman");
  await page.getByRole("button", { name: "Remove" }).click();
  await save(page);
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Blunt" })).toBeChecked();
});

test("an open page whose personality was removed says to reload", async ({ page, browser }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: "Caveman" }).check();
  const admin = await browser.newPage();
  await signIn(admin);
  await open(admin, "Caveman");
  await admin.getByRole("button", { name: "Remove" }).click();
  await save(admin);
  await admin.close();
  await paste(page, HARD);
  await expect(page.locator("#status")).toHaveText("That personality is gone. Reload the page for the new ones.");
});

test("an older version can be loaded and saved again", async ({ page }) => {
  await signIn(page);
  await nameField(page).fill("Brutal");
  await save(page);
  const older = page.locator("#versions li").nth(1);
  await expect(older).toContainText("Blunt, Teacher, Caveman");
  await older.getByRole("button", { name: /^Load version/ }).click();
  await expect(nameField(page)).toHaveValue("Blunt");
  await expect(saveStatus(page)).toHaveText(/^Loaded version \d+\. Save to make it live\.$/);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(nameField(page)).toHaveValue("Brutal");
  await older.getByRole("button", { name: /^Load version/ }).click();
  await save(page);
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "Blunt" })).toBeChecked();
});

test("a save after someone else's asks before it replaces theirs", async ({ page, browser }) => {
  await signIn(page);
  const other = await browser.newPage();
  await signIn(other);
  await nameField(other).fill("Theirs");
  await save(other);
  await other.close();

  await nameField(page).fill("Mine");
  await page.getByRole("button", { name: "Save for everyone" }).click();
  await expect(saveStatus(page)).toHaveText(
    /^Someone saved version \d+ while you were editing\. Save again to replace it with yours\.$/,
  );
  await expect(page.locator("#versions li").first()).toContainText("Theirs");
  await save(page);
  await expect(page.locator("#versions li").first()).toContainText("Mine");
});

test("a broken draft is explained, opens the personality it is about, and is not saved", async ({ page }) => {
  await signIn(page);
  await open(page, "Teacher");
  await nameField(page).fill("Blunt");
  await open(page, "Shared rules");
  await page.getByRole("button", { name: "Save for everyone" }).click();
  await expect(saveStatus(page)).toHaveText('Two personalities are called "Blunt".');
  await expect(saveStatus(page)).toHaveAttribute("data-tone", "error");
  await expect(picker(page).getByRole("listitem").nth(1).getByRole("button")).toHaveAttribute("aria-current");
  await expect(nameField(page)).toBeVisible();
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
  await page.getByRole("button", { name: "+ New personality" }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
