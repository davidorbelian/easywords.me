export type Scorer = (text: string, signal?: AbortSignal) => Promise<number>;

// Ordered from hardest to easiest, so a higher Jev score means simpler text.
export const CRITERIA = [
  "Very hard: dense academic, legal or technical writing with long sentences and rare jargon",
  "Hard: long, complex sentences with many abstract or specialist words",
  "Fairly hard: standard adult writing with some long sentences and less common words",
  "Plain: everyday adult writing with mostly common words and medium-length sentences",
  "Easy: short sentences and common words that an English learner at CEFR A2-B1 can follow",
  "Very easy: very short sentences and only the basic words a young child knows",
];

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 400;

export function toPercent(score: number): number {
  const percent = Math.round((score / (CRITERIA.length - 1)) * 100);
  return Math.min(100, Math.max(0, percent));
}

export function createJevScorer(apiKey: string, baseUrl: string): Scorer {
  const send = (text: string, signal?: AbortSignal) =>
    fetch(new URL("/v1/systemone", baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: text,
        questions: {
          simplicity: {
            type: "score",
            instructions: "How easy is this text to read and understand?",
            criteria: CRITERIA,
          },
        },
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });

  return async (text, signal) => {
    let response = await send(text, signal);
    if (response.status === 429 || response.status === 529) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      response = await send(text, signal);
    }
    if (!response.ok) {
      throw new Error(`Jev returned ${response.status}`);
    }
    const body = (await response.json()) as { answers?: { simplicity?: { score?: unknown } } };
    const score = body.answers?.simplicity?.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error("Jev response has no simplicity score");
    }
    return toPercent(score);
  };
}
