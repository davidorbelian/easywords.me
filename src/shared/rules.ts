export const MAX_INPUT_CHARS = 5000;

export const MAX_PERSONALITIES = 12;
export const MAX_NAME_CHARS = 24;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_RULES_CHARS = 10000;
export const MAX_MESSAGES_CHARS = 20000;
export const MAX_EXAMPLES = 3;
export const MAX_EXAMPLE_CHARS = 2000;

/** A text and the rewrite an admin kept as one this personality got right. */
export type Example = { text: string; rewrite: string };

/**
 * `messages` are the sample messages the prompt was built from. Rewrites never see them.
 * `examples` are rewrites this personality got right. Every rewrite sees them, to copy the voice.
 */
export type Personality = { id: string; name: string; prompt: string; messages: string; examples: Example[] };

export type Settings = { rules: string; personalities: Personality[] };

export type Version = Settings & { number: number; savedAt: string };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A personality without an id is new: it gets one from its name when it is saved. Missing examples are none. */
export type DraftPersonality = { id?: string; name: string; prompt: string; messages: string; examples?: Example[] };

export type Draft = { rules: string; personalities: DraftPersonality[] };

/** A problem a person can read, and the personality it is about, if it is about one. */
export type DraftError = { error: string; index?: number };

/** Returns the draft, or an error a person can read. */
export function checkDraft(value: unknown): Draft | DraftError {
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
    const personality = raw as
      { id?: unknown; name?: unknown; prompt?: unknown; messages?: unknown; examples?: unknown } | undefined;
    const label = `Personality ${index + 1}`;
    const problem = (error: string): DraftError => ({ error, index });
    if (
      typeof personality?.name !== "string" ||
      typeof personality.prompt !== "string" ||
      typeof personality.messages !== "string"
    )
      return problem(`${label} is broken.`);
    const name = personality.name.trim();
    if (!name) return problem(`${label} has no name.`);
    if (name.length > MAX_NAME_CHARS) return problem(`"${name}" is longer than ${MAX_NAME_CHARS} characters.`);
    if (names.has(name.toLowerCase())) return problem(`Two personalities are called "${name}".`);
    names.add(name.toLowerCase());
    if (!personality.prompt.trim()) return problem(`"${name}" has no prompt.`);
    if (personality.prompt.length > MAX_PROMPT_CHARS)
      return problem(`The prompt of "${name}" is longer than ${MAX_PROMPT_CHARS.toLocaleString("en")} characters.`);
    if (personality.messages.length > MAX_MESSAGES_CHARS)
      return problem(
        `The messages of "${name}" are longer than ${MAX_MESSAGES_CHARS.toLocaleString("en")} characters.`,
      );
    const examples = checkExamples(personality.examples, name);
    if (typeof examples === "string") return problem(examples);
    if (personality.id !== undefined) {
      if (typeof personality.id !== "string" || !ID.test(personality.id) || ids.has(personality.id))
        return problem(`${label} has a broken id.`);
      ids.add(personality.id);
    }
    personalities.push({
      ...(personality.id === undefined ? {} : { id: personality.id }),
      name,
      prompt: personality.prompt,
      messages: personality.messages,
      examples,
    });
  }
  return { rules: draft.rules, personalities };
}

/** Returns the examples of the personality called `name`, or an error a person can read. Missing examples are none. */
export function checkExamples(value: unknown, name: string): Example[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `The examples of "${name}" are broken.`;
  if (value.length > MAX_EXAMPLES) return `Keep at most ${MAX_EXAMPLES} examples for "${name}".`;
  const examples: Example[] = [];
  for (const [index, raw] of (value as unknown[]).entries()) {
    const example = raw as { text?: unknown; rewrite?: unknown } | undefined;
    const label = `Example ${index + 1} of "${name}"`;
    if (typeof example?.text !== "string" || typeof example.rewrite !== "string") return `${label} is broken.`;
    if (!example.text.trim() || !example.rewrite.trim()) return `${label} needs both the text and the rewrite.`;
    if (example.text.length > MAX_EXAMPLE_CHARS || example.rewrite.length > MAX_EXAMPLE_CHARS)
      return `${label} is longer than ${MAX_EXAMPLE_CHARS.toLocaleString("en")} characters.`;
    examples.push({ text: example.text, rewrite: example.rewrite });
  }
  return examples;
}
