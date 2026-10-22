export const MAX_INPUT_CHARS = 5000;

export const MAX_STYLES = 12;
export const MAX_NAME_CHARS = 24;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_RULES_CHARS = 10000;

export type Style = { id: string; name: string; prompt: string };

export type Settings = { rules: string; styles: Style[] };

export type Version = Settings & { number: number; savedAt: string };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A style without an id is new: it gets one from its name when it is saved. */
export type DraftStyle = { id?: string; name: string; prompt: string };

export type Draft = { rules: string; styles: DraftStyle[] };

/** Returns the draft, or an error a person can read. */
export function checkDraft(value: unknown): Draft | { error: string } {
  const draft = value as { rules?: unknown; styles?: unknown } | undefined;
  if (typeof draft?.rules !== "string") return { error: "The shared rules are missing." };
  if (draft.rules.length > MAX_RULES_CHARS)
    return { error: `The shared rules are longer than ${MAX_RULES_CHARS.toLocaleString("en")} characters.` };
  if (!Array.isArray(draft.styles) || draft.styles.length === 0) return { error: "Keep at least one style." };
  if (draft.styles.length > MAX_STYLES) return { error: `Keep at most ${MAX_STYLES} styles.` };

  const styles: DraftStyle[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const [index, raw] of (draft.styles as unknown[]).entries()) {
    const style = raw as { id?: unknown; name?: unknown; prompt?: unknown } | undefined;
    const label = `Style ${index + 1}`;
    if (typeof style?.name !== "string" || typeof style.prompt !== "string") return { error: `${label} is broken.` };
    const name = style.name.trim();
    if (!name) return { error: `${label} has no name.` };
    if (name.length > MAX_NAME_CHARS) return { error: `"${name}" is longer than ${MAX_NAME_CHARS} characters.` };
    if (names.has(name.toLowerCase())) return { error: `Two styles are called "${name}".` };
    names.add(name.toLowerCase());
    if (!style.prompt.trim()) return { error: `"${name}" has no prompt.` };
    if (style.prompt.length > MAX_PROMPT_CHARS)
      return { error: `The prompt of "${name}" is longer than ${MAX_PROMPT_CHARS.toLocaleString("en")} characters.` };
    if (style.id !== undefined) {
      if (typeof style.id !== "string" || !ID.test(style.id) || ids.has(style.id))
        return { error: `${label} has a broken id.` };
      ids.add(style.id);
    }
    styles.push({ ...(style.id === undefined ? {} : { id: style.id }), name, prompt: style.prompt });
  }
  return { rules: draft.rules, styles };
}
