import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Draft, Example, Settings, Personality, Version } from "../shared/rules.ts";
import seed from "./seed.json" with { type: "json" };

export const KEEP_VERSIONS = 50;

/** The save was based on a version that is no longer the newest. */
export class Conflict extends Error {}

/** All versions of the personalities, saved in one file. The newest version is what users get. */
export class PersonalityStore {
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
  static async open(dir: string, now: () => number = Date.now): Promise<PersonalityStore> {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "personalities.json");
    const text = await readIfThere(file);
    if (text !== undefined) return new PersonalityStore(file, parse(text, file), now);
    const old = await fromStyles(dir);
    if (old !== undefined) {
      const versions = parse(old, join(dir, "styles.json"));
      await writeWhole(file, serialize(versions));
      return new PersonalityStore(file, versions, now);
    }
    const store = new PersonalityStore(file, [], now);
    await store.save(seed, 0);
    return store;
  }

  current(): Version {
    return this.#versions.at(-1)!;
  }

  /** Newest first. */
  versions(): Version[] {
    return this.#versions.toReversed();
  }

  personality(id: string): Personality | undefined {
    return this.current().personalities.find((personality) => personality.id === id);
  }

  /** Saves the draft as a new version, unless someone saved after `basedOn`. */
  save(draft: Draft, basedOn: number): Promise<Version> {
    const run = this.#queue.then(async () => {
      const newest = this.#versions.at(-1)?.number ?? 0;
      if (basedOn !== newest) throw new Conflict();
      const version: Version = { number: newest + 1, savedAt: new Date(this.#now()).toISOString(), ...withIds(draft) };
      const versions = [...this.#versions, version].slice(-KEEP_VERSIONS);
      await writeWhole(this.#file, serialize(versions));
      this.#versions = versions;
      return version;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** Gives each new personality an id made from its name, unique among the others. */
export function withIds(draft: Draft): Settings {
  const taken = new Set(draft.personalities.flatMap((personality) => (personality.id ? [personality.id] : [])));
  const personalities = draft.personalities.map(({ id, name, prompt, messages, examples = [] }) => {
    if (id) return { id, name, prompt, messages, examples };
    const base = slug(name) || "personality";
    let unique = base;
    for (let n = 2; taken.has(unique); n++) unique = `${base}-${n}`;
    taken.add(unique);
    return { id: unique, name, prompt, messages, examples };
  });
  return { rules: draft.rules, personalities };
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
        Array.isArray(version.personalities) &&
        version.personalities.length > 0 &&
        version.personalities.every(
          (personality: Partial<Personality>) =>
            typeof personality.id === "string" &&
            typeof personality.name === "string" &&
            typeof personality.prompt === "string" &&
            (personality.messages === undefined || typeof personality.messages === "string") &&
            (personality.examples === undefined ||
              (Array.isArray(personality.examples) &&
                personality.examples.every(
                  (example: Partial<Example> | undefined) =>
                    typeof example?.text === "string" && typeof example.rewrite === "string",
                ))),
        ),
    );
  if (!valid) throw new Error(`${file} is not a list of personality versions`);
  // Versions saved before messages or examples were kept have none.
  return (versions as Version[]).map((version) => ({
    ...version,
    personalities: version.personalities.map((personality) => ({
      ...personality,
      messages: personality.messages ?? "",
      examples: personality.examples ?? [],
    })),
  }));
}

// Personalities were called styles before, in styles.json. That file stays as it was, so the
// image from before the rename still starts after a rollback.
async function fromStyles(dir: string): Promise<string | undefined> {
  const text = await readIfThere(join(dir, "styles.json"));
  if (text === undefined) return undefined;
  const { versions } = JSON.parse(text) as { versions?: Array<{ styles?: unknown }> };
  if (!Array.isArray(versions)) return text;
  return serialize(versions.map(({ styles, ...version }) => ({ ...version, personalities: styles })));
}

async function readIfThere(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function serialize(versions: unknown[]): string {
  return JSON.stringify({ versions }, null, 2) + "\n";
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
