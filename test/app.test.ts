import { describe, expect, it } from "vitest";
import { createApp, defaultLimits, type Limits } from "../src/server/app.ts";
import type { Rewriter } from "../src/server/claude.ts";
import type { Scorer } from "../src/server/jev.ts";
import { DailyCap, Slots, WindowLimit } from "../src/server/limits.ts";

const scorer: Scorer = async (text) => Math.min(100, text.length);

const rewriter: Rewriter = async function* () {
  yield "Easy ";
  yield "words.";
};

function app(options: { scorer?: Scorer; rewriter?: Rewriter; limits?: Partial<Limits> } = {}) {
  return createApp({
    scorer: options.scorer ?? scorer,
    rewriter: options.rewriter ?? rewriter,
    limits: { ...defaultLimits(), ...options.limits },
  });
}

function post(path: string, body: unknown, ip = "1.2.3.4") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/score", () => {
  it("returns the score", async () => {
    const response = await app().request(post("/api/score", { text: "hello" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ score: 5 });
  });

  it.each([
    [{}, "empty"],
    [{ text: "   " }, "empty"],
    [{ text: "x".repeat(5001) }, "too_long"],
  ])("rejects %j", async (body, error) => {
    const response = await app().request(post("/api/score", body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  it("limits each IP", async () => {
    const instance = app({ limits: { scores: new WindowLimit(1, 60_000) } });
    expect((await instance.request(post("/api/score", { text: "a" }))).status).toBe(200);
    const limited = await instance.request(post("/api/score", { text: "a" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "slow_down", retryAfter: 60 });
    expect((await instance.request(post("/api/score", { text: "a" }, "5.6.7.8"))).status).toBe(200);
  });

  it("reports a Jev failure", async () => {
    const failing: Scorer = async () => {
      throw new Error("down");
    };
    const response = await app({ scorer: failing }).request(post("/api/score", { text: "a" }));
    expect(response.status).toBe(502);
  });
});

describe("POST /api/simplify", () => {
  it("streams the text, then the output score", async () => {
    const response = await app().request(post("/api/simplify", { text: "Hard words.", level: "simpler" }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(
      'event: text\ndata: {"text":"Easy "}\n\n' +
        'event: text\ndata: {"text":"words."}\n\n' +
        'event: done\ndata: {"score":11}\n\n',
    );
  });

  it("passes the level to the rewriter", async () => {
    let seen = "";
    const spy: Rewriter = async function* (_text, level) {
      seen = level;
      yield "x";
    };
    await (await app({ rewriter: spy }).request(post("/api/simplify", { text: "a", level: "simplest" }))).text();
    expect(seen).toBe("simplest");
  });

  it("rejects an unknown level", async () => {
    const response = await app().request(post("/api/simplify", { text: "a", level: "hardest" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_level" });
  });

  it("sends a failed event when Claude fails", async () => {
    const failing: Rewriter = async function* () {
      yield "Part";
      throw new Error("boom");
    };
    const body = await (
      await app({ rewriter: failing }).request(post("/api/simplify", { text: "a", level: "simple" }))
    ).text();
    expect(body).toContain("event: failed");
    expect(body).not.toContain("event: done");
  });

  it("still finishes when the output score fails", async () => {
    const failing: Scorer = async () => {
      throw new Error("down");
    };
    const body = await (
      await app({ scorer: failing }).request(post("/api/simplify", { text: "a", level: "simple" }))
    ).text();
    expect(body).toContain('event: done\ndata: {"score":null}');
  });

  it("stops at the daily cap", async () => {
    const instance = app({ limits: { daily: new DailyCap(1) } });
    await (await instance.request(post("/api/simplify", { text: "a", level: "simple" }))).text();
    const response = await instance.request(post("/api/simplify", { text: "a", level: "simple" }, "9.9.9.9"));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "daily_limit" });
  });

  it("answers busy when no slot frees up", async () => {
    const instance = app({ limits: { slots: new Slots(0, 0, 0) } });
    const response = await instance.request(post("/api/simplify", { text: "a", level: "simple" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "busy" });
  });
});

describe("GET /health", () => {
  it("is ok", async () => {
    const response = await app().request("/health");
    expect(await response.text()).toBe("ok");
  });
});
