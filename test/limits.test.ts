import { describe, expect, it } from "vitest";
import { DailyCap, Slots, WindowLimit } from "../src/server/limits.ts";

describe("WindowLimit", () => {
  it("allows hits again once they leave the window", () => {
    let now = 0;
    const limit = new WindowLimit(2, 10_000, () => now);
    expect(limit.take("a")).toBe(0);
    now = 4_000;
    expect(limit.take("a")).toBe(0);
    expect(limit.take("a")).toBe(6);
    now = 10_001;
    expect(limit.take("a")).toBe(0);
  });

  it("forgets idle keys on sweep", () => {
    let now = 0;
    const limit = new WindowLimit(1, 1_000, () => now);
    limit.take("a");
    now = 5_000;
    limit.sweep();
    expect(limit.take("a")).toBe(0);
  });
});

describe("DailyCap", () => {
  it("resets at UTC midnight", () => {
    let now = Date.parse("2026-10-05T23:59:00Z");
    const cap = new DailyCap(1, () => now);
    expect(cap.take()).toBe(true);
    expect(cap.take()).toBe(false);
    now = Date.parse("2026-10-06T00:00:01Z");
    expect(cap.take()).toBe(true);
  });
});

describe("Slots", () => {
  const signal = new AbortController().signal;

  it("hands a freed slot to the next waiter", async () => {
    const slots = new Slots(1, 1, 1_000);
    const first = await slots.acquire(signal);
    const second = slots.acquire(signal);
    first!();
    const release = await second;
    expect(release).toBeTypeOf("function");
  });

  it("gives up after the wait time", async () => {
    const slots = new Slots(1, 1, 10);
    await slots.acquire(signal);
    expect(await slots.acquire(signal)).toBeNull();
  });

  it("refuses when the queue is full", async () => {
    const slots = new Slots(1, 0, 1_000);
    await slots.acquire(signal);
    expect(await slots.acquire(signal)).toBeNull();
  });

  it("lets an aborted waiter leave the queue", async () => {
    const slots = new Slots(1, 1, 1_000);
    const first = await slots.acquire(signal);
    const stop = new AbortController();
    const waiting = slots.acquire(stop.signal);
    stop.abort();
    expect(await waiting).toBeNull();
    first!();
    expect(await slots.acquire(signal)).toBeTypeOf("function");
  });
});
