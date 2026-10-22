import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDraft } from "../src/shared/rules.ts";
import { Conflict, KEEP_VERSIONS, StyleStore, withIds } from "../src/server/styles.ts";
import seed from "../src/server/seed.json" with { type: "json" };

const temporary = () => mkdtemp(join(tmpdir(), "easywords-styles-"));

describe("StyleStore", () => {
  it("saves the seed as version 1 when there is no file", async () => {
    const dir = await temporary();
    const store = await StyleStore.open(dir, () => Date.UTC(2026, 9, 22));
    expect(store.current()).toEqual({ number: 1, savedAt: "2026-10-22T00:00:00.000Z", ...seed });
    const file = JSON.parse(await readFile(join(dir, "styles.json"), "utf8"));
    expect(file.versions).toHaveLength(1);
  });

  it("reads the saved versions back", async () => {
    const dir = await temporary();
    const store = await StyleStore.open(dir);
    await store.save({ rules: "r", styles: [{ name: "Pirate", prompt: "Arr." }] }, 1);
    const again = await StyleStore.open(dir);
    expect(again.versions().map((version) => version.number)).toEqual([2, 1]);
    expect(again.style("pirate")).toEqual({ id: "pirate", name: "Pirate", prompt: "Arr." });
  });

  it(`keeps the last ${KEEP_VERSIONS} versions`, async () => {
    const store = await StyleStore.open(await temporary());
    for (let n = 1; n <= KEEP_VERSIONS + 5; n++) await store.save(seed, n);
    const numbers = store.versions().map((version) => version.number);
    expect(numbers).toHaveLength(KEEP_VERSIONS);
    expect(numbers[0]).toBe(KEEP_VERSIONS + 6);
    expect(numbers.at(-1)).toBe(7);
  });

  it("refuses a save based on an old version, even when two arrive at once", async () => {
    const store = await StyleStore.open(await temporary());
    const results = await Promise.allSettled([store.save(seed, 1), store.save(seed, 1)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
    expect(store.current().number).toBe(2);
  });

  it("refuses to start on a broken file", async () => {
    const dir = await temporary();
    await writeFile(join(dir, "styles.json"), JSON.stringify({ versions: [{ number: 1 }] }));
    await expect(StyleStore.open(dir)).rejects.toThrow(/not a list of style versions/);
  });
});

describe("withIds", () => {
  it("makes ids from names, unique and kept for old styles", () => {
    const settings = withIds({
      rules: "",
      styles: [
        { id: "pirate", name: "Old pirate", prompt: "p" },
        { name: "Pirate", prompt: "p" },
        { name: "Пещерный", prompt: "p" },
        { name: "Señor  Smart!", prompt: "p" },
      ],
    });
    expect(settings.styles.map((style) => style.id)).toEqual(["pirate", "pirate-2", "style", "senor-smart"]);
  });
});

describe("checkDraft", () => {
  const style = { name: "Blunt", prompt: "p" };

  it.each([
    [{ styles: [style] }, "The shared rules are missing."],
    [{ rules: "", styles: [] }, "Keep at least one style."],
    [
      { rules: "", styles: Array.from({ length: 13 }, (_, i) => ({ name: `S${i}`, prompt: "p" })) },
      "Keep at most 12 styles.",
    ],
    [{ rules: "", styles: [{ name: " ", prompt: "p" }] }, "Style 1 has no name."],
    [{ rules: "", styles: [style, { name: "blunt", prompt: "p" }] }, 'Two styles are called "blunt".'],
    [{ rules: "", styles: [{ name: "Blunt", prompt: " " }] }, '"Blunt" has no prompt.'],
    [{ rules: "", styles: [{ ...style, id: "Bad Id" }] }, "Style 1 has a broken id."],
  ])("refuses %j", (draft, error) => {
    expect(checkDraft(draft)).toEqual({ error });
  });

  it("trims names and keeps ids", () => {
    expect(checkDraft({ rules: "r", styles: [{ id: "blunt", name: " Blunt ", prompt: "p" }] })).toEqual({
      rules: "r",
      styles: [{ id: "blunt", name: "Blunt", prompt: "p" }],
    });
  });
});
