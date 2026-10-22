import { describe, expect, it } from "vitest";
import { buildInput, readBuilt } from "../src/server/build.ts";

describe("readBuilt", () => {
  it("reads the name from the first line and the prompt from the rest", () => {
    expect(readBuilt("Name: Grump\nVoice: a grumpy uncle.\n\nSays ugh a lot.\n")).toEqual({
      name: "Grump",
      prompt: "Voice: a grumpy uncle.\n\nSays ugh a lot.",
    });
  });

  it("cuts a name that is too long", () => {
    expect(readBuilt("Name: The Most Annoying Uncle Ever Born\nVoice: x")?.name).toBe("The Most Annoying Uncle");
  });

  it.each(["Voice: no name line", "Name: \nVoice: x", "Name: Grump\n  ", "Here you go:\nName: Grump\nVoice: x"])(
    "refuses %j",
    (reply) => {
      expect(readBuilt(reply)).toBeUndefined();
    },
  );
});

describe("buildInput", () => {
  it("leaves out a name and a prompt that are empty", () => {
    expect(buildInput("Rules.", " ", "", "lol\nok")).toBe(
      "<rules>\nRules.\n</rules>\n<messages>\nlol\nok\n</messages>",
    );
  });

  it("puts in the current name and prompt", () => {
    expect(buildInput("Rules.", "Grump", "Voice: x.", "lol")).toBe(
      "<rules>\nRules.\n</rules>\n<name>Grump</name>\n<prompt>\nVoice: x.\n</prompt>\n<messages>\nlol\n</messages>",
    );
  });
});
