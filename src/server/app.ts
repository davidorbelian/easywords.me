import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { checkDraft, MAX_INPUT_CHARS, MAX_PROMPT_CHARS, MAX_RULES_CHARS } from "../shared/rules.ts";
import { SESSION_SECONDS, type Admin } from "./admin.ts";
import { systemPrompt, type Rewriter } from "./claude.ts";
import type { Scorer } from "./jev.ts";
import { DailyCap, Slots, WindowLimit } from "./limits.ts";
import { Conflict, type PersonalityStore } from "./personalities.ts";

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
  store: PersonalityStore;
  /** The admin page is off without one. */
  admin?: Admin;
  /** Where the built pages are, because the server fills in parts of them. */
  webRoot: string;
};

export function defaultLimits(): Limits {
  return {
    scores: new WindowLimit(60, 60_000),
    rewrites: new WindowLimit(10, 10 * 60_000),
    daily: new DailyCap(300),
    slots: new Slots(2, 8, 15_000),
  };
}

type Env = { Variables: { session: string } };

const COOKIE = "easywords_admin";
const TOKEN_HEADER = "x-form-token";
const HASHED = /-[A-Z0-9]{8}\.(?:js|css)$/;

export function createApp({ scorer, rewriter, limits, store, admin, webRoot }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

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

  // Cloudflare would keep these for 4 hours without a header of our own. Built files have a hash of
  // their content in the name, so they may stay for good, and the rest is checked every time.
  app.use(async (c, next) => {
    await next();
    if ((c.req.method === "GET" || c.req.method === "HEAD") && c.res.ok && !c.res.headers.has("Cache-Control"))
      c.header("Cache-Control", HASHED.test(c.req.path) ? "public, max-age=31536000, immutable" : "no-cache");
  });

  app.get("/health", (c) => c.text("ok"));

  for (const path of ["/", "/index.html"]) {
    app.get(path, async (c) => {
      const page = await readFile(join(webRoot, "index.html"), "utf8");
      const personalities = store
        .current()
        .personalities.map(
          (personality, index) =>
            `<label><input type="radio" name="personality" value="${escape(personality.id)}"${index === 0 ? " checked" : ""} />` +
            `<span>${escape(personality.name)}</span></label>`,
        )
        .join("");
      const link = admin ? '<a class="admin-link" href="/admin">Admin</a>' : "";
      return c.html(page.replace("<!-- personalities -->", personalities).replace("<!-- admin -->", link));
    });
  }

  for (const path of ["/admin", "/admin.html"]) {
    app.get(path, async (c) => {
      if (!admin) return c.notFound();
      return c.html(await readFile(join(webRoot, "admin.html"), "utf8"));
    });
  }

  const tooLong = (c: Context) => c.json({ error: "too_long" }, 413);
  app.use("/api/score", bodyLimit({ maxSize: 64 * 1024, onError: tooLong }));
  app.use("/api/simplify", bodyLimit({ maxSize: 64 * 1024, onError: tooLong }));
  app.use("/api/admin/*", bodyLimit({ maxSize: 256 * 1024, onError: tooLong }));

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
    const id = (body as { personality?: unknown } | undefined)?.personality;
    const personality = typeof id === "string" ? store.personality(id) : undefined;
    if (!personality) return c.json({ error: "bad_personality" }, 400);

    const wait = limits.rewrites.take(clientIp(c));
    if (wait > 0) return c.json({ error: "slow_down", retryAfter: wait }, 429, { "Retry-After": String(wait) });
    if (!limits.daily.take()) return c.json({ error: "daily_limit" }, 429);

    return rewrite(c, text, systemPrompt(store.current().rules, personality.prompt));
  });

  if (admin) adminRoutes(admin);
  else app.all("/api/admin/*", (c) => c.notFound());

  app.use("/*", serveStatic({ root: webRoot }));
  return app;

  function adminRoutes(admin: Admin): void {
    app.post("/api/admin/signin", async (c) => {
      const body = (await readJson(c)) as { hassword?: unknown } | undefined;
      const result = admin.signIn(typeof body?.hassword === "string" ? body.hassword : "");
      if (result.ok) {
        setCookie(c, COOKIE, result.session, {
          path: "/",
          httpOnly: true,
          secure: secure(c),
          sameSite: "Strict",
          maxAge: SESSION_SECONDS,
        });
        return c.body(null, 204);
      }
      if (result.retryAfter)
        return c.json({ error: "locked", retryAfter: result.retryAfter }, 429, {
          "Retry-After": String(result.retryAfter),
        });
      return c.json({ error: "wrong" }, 403);
    });

    const signedIn: MiddlewareHandler<Env> = async (c, next) => {
      const session = getCookie(c, COOKIE);
      if (!session || !admin.valid(session)) return c.json({ error: "signed_out" }, 401);
      if (c.req.method !== "GET" && !admin.validToken(session, c.req.header(TOKEN_HEADER)))
        return c.json({ error: "bad_token" }, 403);
      c.set("session", session);
      await next();
    };
    app.use("/api/admin/signout", signedIn);
    app.use("/api/admin/personalities", signedIn);
    app.use("/api/admin/try", signedIn);

    app.post("/api/admin/signout", (c) => {
      deleteCookie(c, COOKIE, { path: "/", secure: secure(c) });
      return c.body(null, 204);
    });

    app.get("/api/admin/personalities", (c) =>
      c.json({ token: admin.formToken(c.get("session")), versions: store.versions() }),
    );

    app.put("/api/admin/personalities", async (c) => {
      const body = (await readJson(c)) as { basedOn?: unknown } | undefined;
      const draft = checkDraft(body);
      if ("error" in draft) return c.json({ error: "bad_personalities", message: draft.error }, 400);
      if (!Number.isInteger(body?.basedOn))
        return c.json({ error: "bad_personalities", message: "Reload the page." }, 400);
      try {
        await store.save(draft, body!.basedOn as number);
      } catch (error) {
        if (error instanceof Conflict) return c.json({ error: "conflict", versions: store.versions() }, 409);
        console.error("saving personalities failed:", error);
        return c.json({ error: "save_failed" }, 500);
      }
      return c.json({ versions: store.versions() });
    });

    // Tries a personality that is not saved yet. The admin is not held to the per-IP and daily limits.
    app.post("/api/admin/try", async (c) => {
      const body = (await readJson(c)) as { rules?: unknown; prompt?: unknown } | undefined;
      const text = readText(body);
      if (typeof text !== "string") return c.json({ error: text.error }, 400);
      const { rules, prompt } = body ?? {};
      if (typeof rules !== "string" || rules.length > MAX_RULES_CHARS) return c.json({ error: "bad_rules" }, 400);
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS)
        return c.json({ error: "bad_prompt" }, 400);
      return rewrite(c, text, systemPrompt(rules, prompt));
    });
  }

  async function rewrite(c: Context<Env>, text: string, system: string): Promise<Response> {
    const stop = new AbortController();
    const release = await limits.slots.acquire(c.req.raw.signal);
    if (!release) return c.json({ error: "busy" }, 503);

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => stop.abort());
      let output = "";
      try {
        for await (const chunk of rewriter(text, system, stop.signal)) {
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
  }
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

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// The tunnel speaks plain HTTP to the app, and tells it the visitor's scheme. Browsers drop a
// Secure cookie on plain HTTP, so local runs and tests go without.
function secure(c: Context): boolean {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

// Production traffic only arrives through the Cloudflare tunnel, which always sets this header.
function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}
