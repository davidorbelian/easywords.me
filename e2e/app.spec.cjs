const { expect, test } = require("@playwright/test");

const HARD = "The feline reposed languidly upon the ornamental rug.";
const EASY = "The cat sat on the mat.";

// Each test gets its own client IP, so the per-IP limits never leak between tests.
test.beforeEach(async ({ page }, testInfo) => {
  await page.setExtraHTTPHeaders({ "CF-Connecting-IP": `test-${testInfo.testId}-${testInfo.project.name}` });
  await page.goto("/");
});

async function paste(page, text) {
  const input = page.getByRole("textbox", { name: "Fancy text" });
  await input.focus();
  await page.evaluate((value) => {
    const target = document.activeElement;
    const data = new DataTransfer();
    data.setData("text/plain", value);
    target.value = value;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

const inputScore = (page) => page.locator("#input-score");
const outputScore = (page) => page.locator("#output-score");
const output = (page) => page.getByRole("textbox", { name: "Plain truth" });

test("paste scores the input, streams easy words and scores them", async ({ page }) => {
  await paste(page, HARD);
  await expect(output(page)).toHaveValue(EASY);
  await expect(inputScore(page)).toHaveAttribute("data-state", "ready");
  await expect(outputScore(page)).toHaveAttribute("data-state", "ready");
  await expect(outputScore(page).locator(".score-value")).toHaveText("100");
  const before = Number(await inputScore(page).locator(".score-value").textContent());
  await expect(outputScore(page).locator(".score-gain")).toHaveText(`+${100 - before}`);
  await expect(page.getByRole("button", { name: "Copy" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Dumb it down/ })).toBeEnabled();
});

test("typing only updates the input score", async ({ page }) => {
  let rewrites = 0;
  page.on("request", (request) => request.url().endsWith("/api/simplify") && rewrites++);
  await page.getByRole("textbox", { name: "Fancy text" }).pressSequentially("Short words here");
  await expect(inputScore(page)).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#count")).toHaveText("16 / 5,000");
  expect(rewrites).toBe(0);
  await expect(output(page)).toHaveValue("");
});

test("the button and the style picker rerun the rewrite", async ({ page }) => {
  await page.getByRole("textbox", { name: "Fancy text" }).fill(HARD);
  const first = page.waitForRequest("**/api/simplify");
  await page.getByRole("button", { name: /Dumb it down/ }).click();
  expect((await first).postDataJSON()).toEqual({ text: HARD, style: "blunt" });
  await expect(output(page)).toHaveValue(EASY);

  const second = page.waitForRequest("**/api/simplify");
  await page.getByRole("radio", { name: "Caveman" }).click();
  expect((await second).postDataJSON()).toEqual({ text: HARD, style: "caveman" });
  await expect(output(page)).toHaveValue(EASY);

  await page.reload();
  await expect(page.getByRole("radio", { name: "Caveman" })).toBeChecked();
});

test("Ctrl+Enter reruns the rewrite", async ({ page, isMobile }) => {
  test.skip(isMobile, "phones have no keyboard shortcut");
  await page.getByRole("textbox", { name: "Fancy text" }).fill(HARD);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(output(page)).toHaveValue(EASY);
});

test("asks for text when the input is empty", async ({ page }) => {
  await page.getByRole("button", { name: /Dumb it down/ }).click();
  await expect(page.locator("#status")).toHaveText("Paste some text first. We can't roast nothing.");
});

test("blocks text over the limit", async ({ page }) => {
  await page.getByRole("textbox", { name: "Fancy text" }).fill("a ".repeat(2501));
  await expect(page.locator("#count")).toHaveText("5,002 / 5,000");
  await expect(page.locator("#count")).toHaveAttribute("data-over", "");
  await page.getByRole("button", { name: /Dumb it down/ }).click();
  await expect(page.locator("#status")).toHaveText(
    "Nobody reads that much, not even us. Keep it under 5,000 characters.",
  );
});

test("shows a Claude failure", async ({ page }) => {
  await paste(page, "FAIL_CLAUDE please");
  await expect(page.locator("#status")).toHaveText("Well, shit. We broke it. Please try again.");
  await expect(outputScore(page)).toHaveAttribute("data-state", "empty");
  await expect(page.getByRole("button", { name: /Dumb it down/ })).toBeEnabled();
});

test("shows a missing score when Jev fails", async ({ page }) => {
  await page.getByRole("textbox", { name: "Fancy text" }).fill("FAIL_JEV text");
  await expect(inputScore(page)).toHaveAttribute("data-state", "failed");
  await expect(inputScore(page).locator(".score-value")).toHaveText("–");
});

test("a new paste replaces a running rewrite", async ({ page }) => {
  await paste(page, "SLOW_CLAUDE text");
  await expect(page.getByRole("button", { name: /Dumbing/ })).toBeDisabled();
  await paste(page, HARD);
  await expect(output(page)).toHaveValue(EASY);
  await expect(page.locator("#status")).toHaveText("");
});

for (const [status, body, message] of [
  [429, { error: "slow_down", retryAfter: 42 }, "Whoa, easy. Try again in 42 seconds."],
  [429, { error: "slow_down", retryAfter: 1 }, "Whoa, easy. Try again in 1 second."],
  [429, { error: "daily_limit" }, "That's enough truth for one day. Come back tomorrow."],
  [503, { error: "busy" }, "Too many people are being rude right now. Try again in a moment."],
]) {
  test(`explains ${message}`, async ({ page }) => {
    await page.route("**/api/simplify", (route) => route.fulfill({ status, json: body }));
    await page.getByRole("textbox", { name: "Fancy text" }).fill(HARD);
    await page.getByRole("button", { name: /Dumb it down/ }).click();
    await expect(page.locator("#status")).toHaveText(message);
  });
}

test("fits the screen without sideways scrolling", async ({ page }) => {
  await paste(page, HARD);
  await expect(output(page)).toHaveValue(EASY);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
