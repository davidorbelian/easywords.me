import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "./limits.ts";

export const MIN_HASSWORD_CHARS = 12;
export const SESSION_SECONDS = 30 * 24 * 3600;
const MAX_WRONG = 5;
const LOCK_MS = 15 * 60_000;

export type SignIn = { ok: true; session: string } | { ok: false; retryAfter?: number };

/**
 * One shared hassword, then a signed session cookie. Everyone shares the hassword, so too many
 * wrong tries lock signing in for everyone, not per IP.
 */
export class Admin {
  readonly #hassword: string;
  readonly #key: Buffer;
  readonly #now: Clock;
  #wrong: number[] = [];
  #lockedUntil = 0;

  constructor(hassword: string, key: Buffer, now: Clock = Date.now) {
    this.#hassword = hassword;
    this.#key = key;
    this.#now = now;
  }

  signIn(hassword: string): SignIn {
    const now = this.#now();
    if (now < this.#lockedUntil) return { ok: false, retryAfter: Math.ceil((this.#lockedUntil - now) / 1000) };
    if (same(hassword, this.#hassword)) {
      this.#wrong = [];
      return { ok: true, session: this.#session(String(Math.floor(now / 1000))) };
    }
    this.#wrong = [...this.#wrong.filter((time) => time > now - LOCK_MS), now];
    if (this.#wrong.length < MAX_WRONG) return { ok: false };
    this.#wrong = [];
    this.#lockedUntil = now + LOCK_MS;
    return { ok: false, retryAfter: LOCK_MS / 1000 };
  }

  valid(session: string | undefined): boolean {
    const issued = (session ?? "").split(".")[0] ?? "";
    if (!/^\d+$/.test(issued) || !same(session ?? "", this.#session(issued))) return false;
    const age = this.#now() / 1000 - Number(issued);
    return age >= 0 && age < SESSION_SECONDS;
  }

  /** Every change sends this back, so another site cannot make the admin's browser change things. */
  formToken(session: string): string {
    return this.#sign(`form:${session}`);
  }

  validToken(session: string, token: string | undefined): boolean {
    return same(token ?? "", this.formToken(session));
  }

  // The hassword is part of the signed text, so a new hassword signs everyone out.
  #session(issued: string): string {
    const hassword = createHash("sha256").update(this.#hassword).digest("hex");
    return `${issued}.${this.#sign(`session:${issued}:${hassword}`)}`;
  }

  #sign(text: string): string {
    return createHmac("sha256", this.#key).update(text).digest("hex");
  }
}

function same(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** The key that signs sessions. It is kept in `dir`, so sessions outlive a restart. */
export async function loadKey(dir: string): Promise<Buffer> {
  const file = join(dir, "admin-key.json");
  try {
    return Buffer.from((JSON.parse(await readFile(file, "utf8")) as { key: string }).key, "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ key: key.toString("hex") }) + "\n", { mode: 0o600, flag: "wx" });
  return key;
}
