import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Admin } from "../src/server/admin.ts";
import { createApp, defaultLimits, type Limits } from "../src/server/app.ts";
import { BUILD_PROMPT, buildInput } from "../src/server/build.ts";
import type { Rewriter } from "../src/server/claude.ts";
import type { Scorer } from "../src/server/jev.ts";
import { DailyCap, Slots, WindowLimit } from "../src/server/limits.ts";
import { PersonalityStore } from "../src/server/personalities.ts";

const HASSWORD = "correct horse battery";

const scorer: Scorer = async (text) => Math.min(100, text.length);

const rewriter: Rewriter = async function* () {
  yield "Easy ";
  yield "words.";
};

let dir: string;
let store: PersonalityStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "easywords-app-"));
  store = await PersonalityStore.open(dir);
  await writeFile(join(dir, "index.html"), "<header><!-- admin --></header><div><!-- personalities --></div>");
  await writeFile(join(dir, "admin.html"), "<p>admin page</p>");
});

function app(options: { scorer?: Scorer; rewriter?: Rewriter; limits?: Partial<Limits>; admin?: Admin | null } = {}) {
  return createApp({
    scorer: options.scorer ?? scorer,
    rewriter: options.rewriter ?? rewriter,
    limits: { ...defaultLimits(), ...options.limits },
    store,
    admin: options.admin === null ? undefined : (options.admin ?? new Admin(HASSWORD, Buffer.alloc(32, 7))),
    webRoot: dir,
  });
}

function post(path: string, body: unknown, ip = "1.2.3.4", headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers },
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
    const response = await app().request(post("/api/simplify", { text: "Hard words.", personality: "teacher" }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(
      'event: text\ndata: {"text":"Easy "}\n\n' +
        'event: text\ndata: {"text":"words."}\n\n' +
        'event: done\ndata: {"score":11}\n\n',
    );
  });

  it("gives the rewriter the shared rules and the personality's prompt", async () => {
    let seen = "";
    const spy: Rewriter = async function* (_text, system) {
      seen = system;
      yield "x";
    };
    await (await app({ rewriter: spy }).request(post("/api/simplify", { text: "a", personality: "caveman" }))).text();
    const { rules, personalities } = store.current();
    expect(seen).toBe(`${rules}\n\n${personalities[2]!.prompt}`);
  });

  it("gives the rewriter the personality's examples after its prompt", async () => {
    let seen = "";
    const spy: Rewriter = async function* (_text, system) {
      seen = system;
      yield "x";
    };
    const examples = [{ text: " Hard. ", rewrite: "Arr." }];
    await store.save(
      { rules: "Rules.", personalities: [{ name: "Pirate", prompt: "Voice.", messages: "", examples }] },
      1,
    );
    await (await app({ rewriter: spy }).request(post("/api/simplify", { text: "a", personality: "pirate" }))).text();
    expect(seen).toBe(
      "Rules.\n\nVoice.\n\n" +
        "Rewrites this personality got right. Copy their voice, length and structure.\n" +
        "They are about other texts, so never take facts from them.\n" +
        "<example>\n<original>\nHard.\n</original>\n<rewrite>\nArr.\n</rewrite>\n</example>",
    );
  });

  it("rejects an unknown personality", async () => {
    const response = await app().request(post("/api/simplify", { text: "a", personality: "hardest" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_personality" });
  });

  it("sends a failed event when Claude fails", async () => {
    const failing: Rewriter = async function* () {
      yield "Part";
      throw new Error("boom");
    };
    const body = await (
      await app({ rewriter: failing }).request(post("/api/simplify", { text: "a", personality: "blunt" }))
    ).text();
    expect(body).toContain("event: failed");
    expect(body).not.toContain("event: done");
  });

  it("still finishes when the output score fails", async () => {
    const failing: Scorer = async () => {
      throw new Error("down");
    };
    const body = await (
      await app({ scorer: failing }).request(post("/api/simplify", { text: "a", personality: "blunt" }))
    ).text();
    expect(body).toContain('event: done\ndata: {"score":null}');
  });

  it("stops at the daily cap", async () => {
    const instance = app({ limits: { daily: new DailyCap(1) } });
    await (await instance.request(post("/api/simplify", { text: "a", personality: "blunt" }))).text();
    const response = await instance.request(post("/api/simplify", { text: "a", personality: "blunt" }, "9.9.9.9"));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "daily_limit" });
  });

  it("answers busy when no slot frees up", async () => {
    const instance = app({ limits: { slots: new Slots(0, 0, 0) } });
    const response = await instance.request(post("/api/simplify", { text: "a", personality: "blunt" }));
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

describe("GET /", () => {
  it("shows the personalities, the first one picked, and the admin link", async () => {
    const page = await (await app().request("/")).text();
    expect(page).toBe(
      '<header><a class="admin-link" href="/admin">Admin</a></header><div>' +
        '<label><input type="radio" name="personality" value="blunt" checked /><span>Blunt</span></label>' +
        '<label><input type="radio" name="personality" value="teacher" /><span>Teacher</span></label>' +
        '<label><input type="radio" name="personality" value="caveman" /><span>Caveman</span></label></div>',
    );
  });

  it("escapes personality names", async () => {
    await store.save({ rules: "", personalities: [{ name: '<b>"Bold"</b>', prompt: "p", messages: "" }] }, 1);
    expect(await (await app().request("/")).text()).toContain("&#60;b&#62;&#34;Bold&#34;&#60;/b&#62;");
  });

  it("has no admin link when the admin page is off", async () => {
    expect(await (await app({ admin: null }).request("/")).text()).not.toContain("admin-link");
  });
});

describe("built files", () => {
  it("lets browsers keep files with a hash in the name for good", async () => {
    await writeFile(join(dir, "styles-7QBF3AEI.css"), "body {}");
    const response = await app().request("/styles-7QBF3AEI.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("makes browsers check pages and files without a hash every time", async () => {
    await writeFile(join(dir, "favicon.svg"), "<svg/>");
    for (const path of ["/", "/admin", "/favicon.svg"]) {
      expect((await app().request(path)).headers.get("cache-control"), path).toBe("no-cache");
    }
  });
});

describe("admin", () => {
  async function signIn(instance = app(), headers: Record<string, string> = {}) {
    const response = await instance.request(post("/api/admin/signin", { hassword: HASSWORD }, "1.2.3.4", headers));
    expect(response.status).toBe(204);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const loaded = await instance.request("/api/admin/personalities", { headers: { Cookie: cookie } });
    const { token } = (await loaded.json()) as { token: string };
    return { instance, cookie, token, setCookie: response.headers.get("set-cookie")! };
  }

  function put(body: unknown, cookie: string, token: string) {
    return new Request("http://localhost/api/admin/personalities", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-Form-Token": token },
      body: JSON.stringify(body),
    });
  }

  it("is not there when the admin page is off", async () => {
    const instance = app({ admin: null });
    expect((await instance.request("/admin")).status).toBe(404);
    expect((await instance.request(post("/api/admin/signin", { hassword: HASSWORD }))).status).toBe(404);
  });

  it("serves the admin page", async () => {
    expect(await (await app().request("/admin")).text()).toBe("<p>admin page</p>");
  });

  it("refuses a wrong hassword", async () => {
    const response = await app().request(post("/api/admin/signin", { hassword: "nope" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "wrong" });
  });

  it("locks signing in after five wrong tries", async () => {
    const instance = app();
    for (let i = 0; i < 4; i++) await instance.request(post("/api/admin/signin", { hassword: "nope" }));
    const fifth = await instance.request(post("/api/admin/signin", { hassword: "nope" }));
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toEqual({ error: "locked", retryAfter: 900 });
    const right = await instance.request(post("/api/admin/signin", { hassword: HASSWORD }));
    expect(right.status).toBe(429);
  });

  it("sets a session cookie that is Secure only behind HTTPS", async () => {
    const plain = await signIn();
    expect(plain.setCookie).toMatch(/HttpOnly/);
    expect(plain.setCookie).toMatch(/SameSite=Strict/);
    expect(plain.setCookie).not.toMatch(/Secure/);
    const tunnel = await signIn(app(), { "X-Forwarded-Proto": "https" });
    expect(tunnel.setCookie).toMatch(/Secure/);
  });

  it("needs a session to read the personalities", async () => {
    const response = await app().request("/api/admin/personalities");
    expect(response.status).toBe(401);
    const forged = await app().request("/api/admin/personalities", { headers: { Cookie: "easywords_admin=1.abc" } });
    expect(forged.status).toBe(401);
  });

  it("lists the versions, newest first", async () => {
    const { instance, cookie } = await signIn();
    const body = (await (
      await instance.request("/api/admin/personalities", { headers: { Cookie: cookie } })
    ).json()) as {
      versions: { number: number }[];
    };
    expect(body.versions.map((version) => version.number)).toEqual([1]);
  });

  it("saves a new version that users get at once", async () => {
    const { instance, cookie, token } = await signIn();
    const personalities = [
      { name: "Pirate", prompt: "Voice: a pirate.", messages: "" },
      ...store.current().personalities,
    ];
    const response = await instance.request(put({ basedOn: 1, rules: "Be rude.", personalities }, cookie, token));
    expect(response.status).toBe(200);
    const { versions } = (await response.json()) as { versions: { number: number; personalities: { id: string }[] }[] };
    expect(versions[0]!.number).toBe(2);
    expect(versions[0]!.personalities.map((personality) => personality.id)).toEqual([
      "pirate",
      "blunt",
      "teacher",
      "caveman",
    ]);
    expect(await (await instance.request("/")).text()).toContain('value="pirate" checked');
  });

  it("refuses a save based on an old version", async () => {
    const { instance, cookie, token } = await signIn();
    const { rules, personalities } = store.current();
    expect((await instance.request(put({ basedOn: 1, rules, personalities }, cookie, token))).status).toBe(200);
    const stale = await instance.request(put({ basedOn: 1, rules: "mine", personalities }, cookie, token));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("conflict");
    expect(store.current().number).toBe(2);
  });

  it("refuses a change without the form token", async () => {
    const { instance, cookie } = await signIn();
    const { rules, personalities } = store.current();
    const response = await instance.request(put({ basedOn: 1, rules, personalities }, cookie, "wrong"));
    expect(response.status).toBe(403);
    expect(store.current().number).toBe(1);
  });

  it("explains a broken draft", async () => {
    const { instance, cookie, token } = await signIn();
    const response = await instance.request(put({ basedOn: 1, rules: "", personalities: [] }, cookie, token));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_personalities", message: "Keep at least one personality." });
  });

  it("tries a prompt without saving it", async () => {
    let seen = "";
    const spy: Rewriter = async function* (_text, system) {
      seen = system;
      yield "Arr.";
    };
    const { instance, cookie, token } = await signIn(app({ rewriter: spy, limits: { daily: new DailyCap(0) } }));
    const response = await instance.request(
      post("/api/admin/try", { rules: "Rules.", prompt: "Voice: a pirate.", text: "Hello." }, "1.2.3.4", {
        Cookie: cookie,
        "X-Form-Token": token,
      }),
    );
    expect(await response.text()).toContain('event: done\ndata: {"score":4}');
    expect(seen).toBe("Rules.\n\nVoice: a pirate.");
    expect(store.current().number).toBe(1);
  });

  it("tries a prompt with examples that are not saved yet, and refuses broken ones", async () => {
    let seen = "";
    const spy: Rewriter = async function* (_text, system) {
      seen = system;
      yield "Arr.";
    };
    const { instance, cookie, token } = await signIn(app({ rewriter: spy }));
    const headers = { Cookie: cookie, "X-Form-Token": token };
    const body = { rules: "Rules.", prompt: "Voice.", text: "Hello." };
    const examples = [{ text: "Hard.", rewrite: "Arr." }];
    await (await instance.request(post("/api/admin/try", { ...body, examples }, "1.2.3.4", headers))).text();
    expect(seen).toContain("Voice.\n\nRewrites this personality got right.");
    expect(seen).toContain("<original>\nHard.\n</original>\n<rewrite>\nArr.\n</rewrite>");

    const broken = await instance.request(post("/api/admin/try", { ...body, examples: [{}] }, "1.2.3.4", headers));
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: "bad_examples" });
  });

  describe("POST /api/admin/build", () => {
    const body = { rules: "Rules.", name: "", prompt: "", messages: "lol ok" };

    async function build(rewriter: Rewriter, sent: unknown = body) {
      const { instance, cookie, token } = await signIn(app({ rewriter }));
      return instance.request(post("/api/admin/build", sent, "1.2.3.4", { Cookie: cookie, "X-Form-Token": token }));
    }

    it("answers the name and the prompt Claude wrote, and saves nothing", async () => {
      let seen = { text: "", system: "" };
      const spy: Rewriter = async function* (text, system) {
        seen = { text, system };
        yield "Name: Chill ";
        yield "Guy\nVoice: lol ok.";
      };
      const response = await build(spy, { ...body, name: "Old", prompt: "Voice: old." });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ name: "Chill Guy", prompt: "Voice: lol ok." });
      expect(seen.system).toBe(BUILD_PROMPT);
      expect(seen.text).toBe(buildInput("Rules.", "Old", "Voice: old.", "lol ok"));
      expect(store.current().number).toBe(1);
    });

    it.each([
      [{ ...body, messages: " " }, "empty"],
      [{ ...body, messages: "m".repeat(20001) }, "too_long"],
      [{ ...body, prompt: undefined }, "bad_prompt"],
    ])("refuses %j", async (sent, error) => {
      const response = await build(rewriter, sent);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    });

    it.each([
      [
        "fails",
        async function* () {
          yield "Name: X\n";
          throw new Error("Claude failed");
        } satisfies Rewriter,
      ],
      [
        "answers in another shape",
        async function* () {
          yield "Sure! Here is a prompt.";
        } satisfies Rewriter,
      ],
    ])("says the build failed when Claude %s", async (_, failing) => {
      const response = await build(failing);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "build_failed" });
    });

    it("needs the form token", async () => {
      const { instance, cookie } = await signIn();
      const response = await instance.request(post("/api/admin/build", body, "1.2.3.4", { Cookie: cookie }));
      expect(response.status).toBe(403);
    });
  });

  it("signs out", async () => {
    const { instance, cookie, token } = await signIn();
    const response = await instance.request(
      post("/api/admin/signout", {}, "1.2.3.4", { Cookie: cookie, "X-Form-Token": token }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/easywords_admin=;/);
  });
});
