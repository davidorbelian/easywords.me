export const MAX_INPUT_CHARS = 5000;

export const MAX_PERSONALITIES = 12;
export const MAX_NAME_CHARS = 24;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_RULES_CHARS = 10000;

export type Personality = { id: string; name: string; prompt: string };

export type Settings = { rules: string; personalities: Personality[] };

export type Version = Settings & { number: number; savedAt: string };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A personality without an id is new: it gets one from its name when it is saved. */
export type DraftPersonality = { id?: string; name: string; prompt: string };

export type Draft = { rules: string; personalities: DraftPersonality[] };

/** Returns the draft, or an error a person can read. */
export function checkDraft(value: unknown): Draft | { error: string } {
  const draft = value as { rules?: unknown; personalities?: unknown } | undefined;
  if (typeof draft?.rules !== "string") return { error: "The shared rules are missing." };
  if (draft.rules.length > MAX_RULES_CHARS)
    return { error: `The shared rules are longer than ${MAX_RULES_CHARS.toLocaleString("en")} characters.` };
  if (!Array.isArray(draft.personalities) || draft.personalities.length === 0)
    return { error: "Keep at least one personality." };
  if (draft.personalities.length > MAX_PERSONALITIES)
    return { error: `Keep at most ${MAX_PERSONALITIES} personalities.` };

  const personalities: DraftPersonality[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const [index, raw] of (draft.personalities as unknown[]).entries()) {
    const personality = raw as { id?: unknown; name?: unknown; prompt?: unknown } | undefined;
    const label = `Personality ${index + 1}`;
    if (typeof personality?.name !== "string" || typeof personality.prompt !== "string")
      return { error: `${label} is broken.` };
    const name = personality.name.trim();
    if (!name) return { error: `${label} has no name.` };
    if (name.length > MAX_NAME_CHARS) return { error: `"${name}" is longer than ${MAX_NAME_CHARS} characters.` };
    if (names.has(name.toLowerCase())) return { error: `Two personalities are called "${name}".` };
    names.add(name.toLowerCase());
    if (!personality.prompt.trim()) return { error: `"${name}" has no prompt.` };
    if (personality.prompt.length > MAX_PROMPT_CHARS)
      return { error: `The prompt of "${name}" is longer than ${MAX_PROMPT_CHARS.toLocaleString("en")} characters.` };
    if (personality.id !== undefined) {
      if (typeof personality.id !== "string" || !ID.test(personality.id) || ids.has(personality.id))
        return { error: `${label} has a broken id.` };
      ids.add(personality.id);
    }
    personalities.push({
      ...(personality.id === undefined ? {} : { id: personality.id }),
      name,
      prompt: personality.prompt,
    });
  }
  return { rules: draft.rules, personalities };
}
