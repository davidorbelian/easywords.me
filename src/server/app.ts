import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { isLevel, MAX_INPUT_CHARS } from "../shared/rules.ts";
import type { Rewriter } from "./claude.ts";
import type { Scorer } from "./jev.ts";
import { DailyCap, Slots, WindowLimit } from "./limits.ts";

export type Limits = {
  scores: WindowLimit;
  rewrites: WindowLimit;
  daily: DailyCap;
  slots: Slots;
};

export type AppOptions = {
  scorer: Scorer;
  rewriter: Rewriter;
  limits: Limits;
};

export function defaultLimits(): Limits {
  return {
    scores: new WindowLimit(60, 60_000),
    rewrites: new WindowLimit(10, 10 * 60_000),
    daily: new DailyCap(300),
    slots: new Slots(2, 8, 15_000),
  };
}

export function createApp({ scorer, rewriter, limits }: AppOptions): Hono {
  const app = new Hono();

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.get("/health", (c) => c.text("ok"));

  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "too_long" }, 413) }));

  app.post("/api/score", async (c) => {
    const text = readText(await readJson(c));
    if (typeof text !== "string") return c.json({ error: text.error }, 400);

    const wait = limits.scores.take(clientIp(c));
    if (wait > 0) return c.json({ error: "slow_down", retryAfter: wait }, 429, { "Retry-After": String(wait) });

    try {
      return c.json({ score: await scorer(text, c.req.raw.signal) });
    } catch (error) {
      console.error("score failed:", error);
      return c.json({ error: "score_failed" }, 502);
    }
  });

  app.post("/api/simplify", async (c) => {
    const body = await readJson(c);
    const text = readText(body);
    if (typeof text !== "string") return c.json({ error: text.error }, 400);
    const level = (body as { level?: unknown } | undefined)?.level;
    if (!isLevel(level)) return c.json({ error: "bad_level" }, 400);

    const wait = limits.rewrites.take(clientIp(c));
    if (wait > 0) return c.json({ error: "slow_down", retryAfter: wait }, 429, { "Retry-After": String(wait) });
    if (!limits.daily.take()) return c.json({ error: "daily_limit" }, 429);

    const stop = new AbortController();
    const release = await limits.slots.acquire(c.req.raw.signal);
    if (!release) return c.json({ error: "busy" }, 503);

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => stop.abort());
      let output = "";
      try {
        for await (const chunk of rewriter(text, level, stop.signal)) {
          output += chunk;
          await stream.writeSSE({ event: "text", data: JSON.stringify({ text: chunk }) });
        }
      } catch (error) {
        if (!stop.signal.aborted) {
          console.error("simplify failed:", error);
          await stream.writeSSE({ event: "failed", data: JSON.stringify({ error: "simplify_failed" }) });
        }
        return;
      } finally {
        release();
      }

      let score: number | null = null;
      if (output.trim()) {
        try {
          score = await scorer(output, stop.signal);
        } catch (error) {
          console.error("output score failed:", error);
        }
      }
      await stream.writeSSE({ event: "done", data: JSON.stringify({ score }) });
    });
  });

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function readText(body: unknown): string | { error: string } {
  const text = (body as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || !text.trim()) return { error: "empty" };
  if (text.length > MAX_INPUT_CHARS) return { error: "too_long" };
  return text;
}

// Production traffic only arrives through the Cloudflare tunnel, which always sets this header.
function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}
