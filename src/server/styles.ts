import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Draft, Settings, Style, Version } from "../shared/rules.ts";
import seed from "./seed.json" with { type: "json" };

export const KEEP_VERSIONS = 50;

/** The save was based on a version that is no longer the newest. */
export class Conflict extends Error {}

/** All versions of the styles, saved in one file. The newest version is what users get. */
export class StyleStore {
  #versions: Version[];
  readonly #file: string;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(file: string, versions: Version[], now: () => number) {
    this.#file = file;
    this.#versions = versions;
    this.#now = now;
  }

  /** Reads the file in `dir`. Without one, the seed becomes version 1, as if an admin had saved it. */
  static async open(dir: string, now: () => number = Date.now): Promise<StyleStore> {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "styles.json");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const store = new StyleStore(file, [], now);
      await store.save(seed, 0);
      return store;
    }
    return new StyleStore(file, parse(text, file), now);
  }

  current(): Version {
    return this.#versions.at(-1)!;
  }

  /** Newest first. */
  versions(): Version[] {
    return this.#versions.toReversed();
  }

  style(id: string): Style | undefined {
    return this.current().styles.find((style) => style.id === id);
  }

  /** Saves the draft as a new version, unless someone saved after `basedOn`. */
  save(draft: Draft, basedOn: number): Promise<Version> {
    const run = this.#queue.then(async () => {
      const newest = this.#versions.at(-1)?.number ?? 0;
      if (basedOn !== newest) throw new Conflict();
      const version: Version = { number: newest + 1, savedAt: new Date(this.#now()).toISOString(), ...withIds(draft) };
      const versions = [...this.#versions, version].slice(-KEEP_VERSIONS);
      await writeWhole(this.#file, JSON.stringify({ versions }, null, 2) + "\n");
      this.#versions = versions;
      return version;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** Gives each new style an id made from its name, unique among the others. */
export function withIds(draft: Draft): Settings {
  const taken = new Set(draft.styles.flatMap((style) => (style.id ? [style.id] : [])));
  const styles = draft.styles.map(({ id, name, prompt }) => {
    if (id) return { id, name, prompt };
    const base = slug(name) || "style";
    let unique = base;
    for (let n = 2; taken.has(unique); n++) unique = `${base}-${n}`;
    taken.add(unique);
    return { id: unique, name, prompt };
  });
  return { rules: draft.rules, styles };
}

function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
}

function parse(text: string, file: string): Version[] {
  const versions = (JSON.parse(text) as { versions?: unknown }).versions;
  const valid =
    Array.isArray(versions) &&
    versions.length > 0 &&
    versions.every(
      (version: Partial<Version>) =>
        Number.isInteger(version.number) &&
        typeof version.savedAt === "string" &&
        typeof version.rules === "string" &&
        Array.isArray(version.styles) &&
        version.styles.length > 0 &&
        version.styles.every(
          (style: Partial<Style>) =>
            typeof style.id === "string" && typeof style.name === "string" && typeof style.prompt === "string",
        ),
    );
  if (!valid) throw new Error(`${file} is not a list of style versions`);
  return versions as Version[];
}

// A crash halfway leaves the old file whole, because the rename swaps them in one step.
async function writeWhole(file: string, text: string): Promise<void> {
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
