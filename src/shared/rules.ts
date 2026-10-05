export const LEVELS = ["simple", "simpler", "simplest"] as const;

export type Level = (typeof LEVELS)[number];

export const MAX_INPUT_CHARS = 5000;

export function isLevel(value: unknown): value is Level {
  return LEVELS.includes(value as Level);
}
