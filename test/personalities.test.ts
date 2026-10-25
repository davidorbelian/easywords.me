import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDraft } from "../src/shared/rules.ts";
import { Conflict, KEEP_VERSIONS, PersonalityStore, withIds } from "../src/server/personalities.ts";
import seed from "../src/server/seed.json" with { type: "json" };

const temporary = () => mkdtemp(join(tmpdir(), "easywords-personalities-"));

describe("PersonalityStore", () => {
  it("saves the seed as version 1 when there is no file", async () => {
    const dir = await temporary();
    const store = await PersonalityStore.open(dir, () => Date.UTC(2026, 9, 22));
    expect(store.current()).toEqual({ number: 1, savedAt: "2026-10-22T00:00:00.000Z", ...seed });
    const file = JSON.parse(await readFile(join(dir, "personalities.json"), "utf8"));
    expect(file.versions).toHaveLength(1);
  });

  it("reads the saved versions back", async () => {
    const dir = await temporary();
    const store = await PersonalityStore.open(dir);
    const examples = [{ text: "Hard.", rewrite: "Easy." }];
    await store.save({ rules: "r", personalities: [{ name: "Pirate", prompt: "Arr.", messages: "", examples }] }, 1);
    const again = await PersonalityStore.open(dir);
    expect(again.versions().map((version) => version.number)).toEqual([2, 1]);
    expect(again.personality("pirate")).toEqual({
      id: "pirate",
      name: "Pirate",
      prompt: "Arr.",
      messages: "",
      examples,
    });
  });

  it(`keeps the last ${KEEP_VERSIONS} versions`, async () => {
    const store = await PersonalityStore.open(await temporary());
    for (let n = 1; n <= KEEP_VERSIONS + 5; n++) await store.save(seed, n);
    const numbers = store.versions().map((version) => version.number);
    expect(numbers).toHaveLength(KEEP_VERSIONS);
    expect(numbers[0]).toBe(KEEP_VERSIONS + 6);
    expect(numbers.at(-1)).toBe(7);
  });

  it("refuses a save based on an old version, even when two arrive at once", async () => {
    const store = await PersonalityStore.open(await temporary());
    const results = await Promise.allSettled([store.save(seed, 1), store.save(seed, 1)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
    expect(store.current().number).toBe(2);
  });

  it("reads versions saved before messages and examples were kept as having none", async () => {
    const dir = await temporary();
    const version = { number: 3, savedAt: "2026-10-22T00:00:00.000Z", rules: "r" };
    await writeFile(
      join(dir, "personalities.json"),
      JSON.stringify({ versions: [{ ...version, personalities: [{ id: "a", name: "A", prompt: "p" }] }] }),
    );
    expect((await PersonalityStore.open(dir)).personality("a")).toEqual({
      id: "a",
      name: "A",
      prompt: "p",
      messages: "",
      examples: [],
    });
  });

  it("refuses to start on a broken file", async () => {
    const dir = await temporary();
    await writeFile(join(dir, "personalities.json"), JSON.stringify({ versions: [{ number: 1 }] }));
    await expect(PersonalityStore.open(dir)).rejects.toThrow(/not a list of personality versions/);
  });

  it("refuses to start on broken examples", async () => {
    const dir = await temporary();
    const personality = { id: "a", name: "A", prompt: "p", messages: "", examples: [{ text: "t" }] };
    await writeFile(
      join(dir, "personalities.json"),
      JSON.stringify({
        versions: [{ number: 1, savedAt: "2026-10-22T00:00:00.000Z", rules: "r", personalities: [personality] }],
      }),
    );
    await expect(PersonalityStore.open(dir)).rejects.toThrow(/not a list of personality versions/);
  });

  it("moves the versions over from styles.json, and leaves that file as it was", async () => {
    const dir = await temporary();
    const old = JSON.stringify({
      versions: [
        {
          number: 6,
          savedAt: "2026-10-21T00:00:00.000Z",
          rules: "r",
          styles: [{ id: "a", name: "A", prompt: "p", messages: "" }],
        },
        {
          number: 7,
          savedAt: "2026-10-22T00:00:00.000Z",
          rules: "r",
          styles: [{ id: "b", name: "B", prompt: "q", messages: "" }],
        },
      ],
    });
    await writeFile(join(dir, "styles.json"), old);
    const store = await PersonalityStore.open(dir);
    expect(store.versions().map((version) => version.number)).toEqual([7, 6]);
    expect(store.personality("b")).toEqual({ id: "b", name: "B", prompt: "q", messages: "", examples: [] });
    await store.save({ rules: "r", personalities: [{ name: "C", prompt: "p", messages: "" }] }, 7);
    expect((await PersonalityStore.open(dir)).current().number).toBe(8);
    expect(await readFile(join(dir, "styles.json"), "utf8")).toBe(old);
  });

  it("refuses to start on a broken styles.json, and writes nothing", async () => {
    const dir = await temporary();
    await writeFile(join(dir, "styles.json"), JSON.stringify({ versions: [{ number: 1 }] }));
    await expect(PersonalityStore.open(dir)).rejects.toThrow(/styles\.json is not a list of personality versions/);
    await expect(readFile(join(dir, "personalities.json"))).rejects.toThrow(/ENOENT/);
  });
});

describe("withIds", () => {
  it("makes ids from names, unique and kept for old personalities", () => {
    const settings = withIds({
      rules: "",
      personalities: [
        { id: "pirate", name: "Old pirate", prompt: "p", messages: "" },
        { name: "Pirate", prompt: "p", messages: "" },
        { name: "Пещерный", prompt: "p", messages: "" },
        { name: "Señor  Smart!", prompt: "p", messages: "" },
      ],
    });
    expect(settings.personalities.map((personality) => personality.id)).toEqual([
      "pirate",
      "pirate-2",
      "personality",
      "senor-smart",
    ]);
  });
});

describe("checkDraft", () => {
  const personality = { name: "Blunt", prompt: "p", messages: "" };

  it.each([
    [{ personalities: [personality] }, "The shared rules are missing."],
    [{ rules: "", personalities: [] }, "Keep at least one personality."],
    [
      {
        rules: "",
        personalities: Array.from({ length: 13 }, (_, i) => ({ name: `S${i}`, prompt: "p", messages: "" })),
      },
      "Keep at most 12 personalities.",
    ],
  ])("refuses %j", (draft, error) => {
    expect(checkDraft(draft)).toEqual({ error });
  });

  it.each([
    [{ name: " " }, "Personality 2 has no name."],
    [{ name: "blunt" }, 'Two personalities are called "blunt".'],
    [{ name: "Teacher", prompt: " " }, '"Teacher" has no prompt.'],
    [{ name: "Teacher", messages: "m".repeat(20001) }, 'The messages of "Teacher" are longer than 20,000 characters.'],
    [{ name: "Teacher", messages: undefined }, "Personality 2 is broken."],
    [{ name: "Teacher", id: "Bad Id" }, "Personality 2 has a broken id."],
    [{ name: "Teacher", examples: "e" }, 'The examples of "Teacher" are broken.'],
    [
      { name: "Teacher", examples: Array.from({ length: 4 }, () => ({ text: "t", rewrite: "r" })) },
      'Keep at most 3 examples for "Teacher".',
    ],
    [{ name: "Teacher", examples: [{ text: "t" }] }, 'Example 1 of "Teacher" is broken.'],
    [
      {
        name: "Teacher",
        examples: [
          { text: "t", rewrite: "r" },
          { text: "t", rewrite: " " },
        ],
      },
      'Example 2 of "Teacher" needs both the text and the rewrite.',
    ],
    [
      { name: "Teacher", examples: [{ text: "t".repeat(2001), rewrite: "r" }] },
      'Example 1 of "Teacher" is longer than 2,000 characters.',
    ],
  ])("refuses a second personality like %j, and says which one", (second, error) => {
    const draft = { rules: "", personalities: [personality, { ...personality, ...second }] };
    expect(checkDraft(draft)).toEqual({ error, index: 1 });
  });

  it("trims names and keeps ids, messages and examples", () => {
    const examples = [{ text: " t ", rewrite: " r " }];
    expect(
      checkDraft({
        rules: "r",
        personalities: [
          { id: "blunt", name: " Blunt ", prompt: "p", messages: " m ", examples },
          { name: "Teacher", prompt: "p", messages: "" },
        ],
      }),
    ).toEqual({
      rules: "r",
      personalities: [
        { id: "blunt", name: "Blunt", prompt: "p", messages: " m ", examples },
        { name: "Teacher", prompt: "p", messages: "", examples: [] },
      ],
    });
  });
});
