import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevScorer, CRITERIA, toPercent } from "../src/server/jev.ts";

afterEach(() => vi.unstubAllGlobals());

function reply(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

describe("toPercent", () => {
  it("maps the Jev scale to 0-100", () => {
    const top = CRITERIA.length - 1;
    expect(toPercent(0)).toBe(0);
    expect(toPercent(top / 2)).toBe(50);
    expect(toPercent(top)).toBe(100);
    expect(toPercent(top + 1)).toBe(100);
  });
});

describe("createJevScorer", () => {
  it("sends a score question and maps the answer", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { answers: { simplicity: { score: CRITERIA.length - 1 } } }));
    vi.stubGlobal("fetch", fetch);
    expect(await createJevScorer("key", "https://jev.test")("Some text")).toBe(100);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://jev.test/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer key");
    const body = JSON.parse(init.body);
    expect(body.state).toBe("Some text");
    expect(body.questions.simplicity).toMatchObject({ type: "score", criteria: CRITERIA });
  });

  it("retries once when Jev is overloaded", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(529))
      .mockResolvedValueOnce(reply(200, { answers: { simplicity: { score: 0 } } }));
    vi.stubGlobal("fetch", fetch);
    expect(await createJevScorer("key", "https://jev.test")("x")).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails on an error status or a missing score", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(401)));
    await expect(createJevScorer("key", "https://jev.test")("x")).rejects.toThrow("401");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, { answers: {} })));
    await expect(createJevScorer("key", "https://jev.test")("x")).rejects.toThrow("no simplicity score");
  });
});
