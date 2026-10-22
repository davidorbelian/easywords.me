import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Admin, loadKey, SESSION_SECONDS } from "../src/server/admin.ts";

const KEY = Buffer.alloc(32, 1);

function signedIn(admin: Admin): string {
  const result = admin.signIn("correct horse battery");
  if (!result.ok) throw new Error("not signed in");
  return result.session;
}

describe("Admin", () => {
  it("keeps a session valid for 30 days", () => {
    let now = 1_000_000_000_000;
    const admin = new Admin("correct horse battery", KEY, () => now);
    const session = signedIn(admin);
    expect(admin.valid(session)).toBe(true);
    now += (SESSION_SECONDS - 1) * 1000;
    expect(admin.valid(session)).toBe(true);
    now += 2000;
    expect(admin.valid(session)).toBe(false);
  });

  it("signs everyone out when the hassword changes", () => {
    const session = signedIn(new Admin("correct horse battery", KEY));
    expect(new Admin("another long hassword", KEY).valid(session)).toBe(false);
  });

  it("refuses a session with a changed time", () => {
    const admin = new Admin("correct horse battery", KEY);
    const [issued, signature] = signedIn(admin).split(".");
    expect(admin.valid(`${Number(issued) + 1000}.${signature}`)).toBe(false);
  });

  it("opens again after the lock", () => {
    let now = 0;
    const admin = new Admin("correct horse battery", KEY, () => now);
    for (let i = 0; i < 5; i++) admin.signIn("nope");
    expect(admin.signIn("correct horse battery")).toEqual({ ok: false, retryAfter: 900 });
    now += 15 * 60_000;
    expect(admin.signIn("correct horse battery").ok).toBe(true);
  });

  it("forgets wrong tries older than 15 minutes", () => {
    let now = 0;
    const admin = new Admin("correct horse battery", KEY, () => now);
    for (let i = 0; i < 4; i++) admin.signIn("nope");
    now += 15 * 60_000 + 1;
    expect(admin.signIn("nope")).toEqual({ ok: false });
  });

  it("ties the form token to the session", () => {
    const admin = new Admin("correct horse battery", KEY);
    const session = signedIn(admin);
    expect(admin.validToken(session, admin.formToken(session))).toBe(true);
    expect(admin.validToken(session, admin.formToken("other"))).toBe(false);
    expect(admin.validToken(session, undefined)).toBe(false);
  });
});

describe("loadKey", () => {
  it("makes a key once and then keeps it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easywords-key-"));
    const key = await loadKey(dir);
    expect(key).toHaveLength(32);
    expect(await loadKey(dir)).toEqual(key);
    expect(JSON.parse(await readFile(join(dir, "admin-key.json"), "utf8"))).toEqual({ key: key.toString("hex") });
  });
});
