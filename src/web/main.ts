import { isLevel, MAX_INPUT_CHARS, type Level } from "../shared/rules.ts";

const SCORE_DELAY_MS = 500;
const LEVEL_KEY = "easywords.level";

const MESSAGES: Record<string, string> = {
  empty: "Paste some text first.",
  too_long: `That text is too long. Keep it under ${MAX_INPUT_CHARS.toLocaleString("en")} characters.`,
  daily_limit: "That's all for today. Come back tomorrow.",
  busy: "Lots of people are here right now. Try again in a moment.",
  failed: "Something went wrong. Please try again.",
};

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const input = element<HTMLTextAreaElement>("input");
const output = element<HTMLTextAreaElement>("output");
const inputScore = element<HTMLOutputElement>("input-score");
const outputScore = element<HTMLOutputElement>("output-score");
const count = element<HTMLSpanElement>("count");
const status = element<HTMLSpanElement>("status");
const run = element<HTMLButtonElement>("run");
const copy = element<HTMLButtonElement>("copy");
const levels = document.querySelectorAll<HTMLInputElement>('input[name="level"]');

let scoreRequest: AbortController | undefined;
let scoreTimer: ReturnType<typeof setTimeout> | undefined;
let rewriteRequest: AbortController | undefined;
let lastInputScore: number | undefined;

type ScoreState = { state: "empty" | "loading" | "failed" } | { state: "ready"; value: number };

function showScore(target: HTMLOutputElement, score: ScoreState, gain?: number): void {
  target.dataset.state = score.state;
  const value = target.querySelector(".score-value")!;
  value.textContent = score.state === "ready" ? String(score.value) : score.state === "loading" ? "··" : "–";
  target.title = score.state === "failed" ? "No score right now" : "";
  if (score.state === "ready") target.style.setProperty("--hue", String(Math.round(score.value * 1.4)));
  const gainLabel = target.querySelector<HTMLElement>(".score-gain");
  if (gainLabel) {
    gainLabel.hidden = gain === undefined || gain === 0;
    gainLabel.textContent = gain === undefined ? "" : gain > 0 ? `+${gain}` : String(gain);
  }
}

function showStatus(text: string, tone: "info" | "error" = "info"): void {
  status.textContent = text;
  status.dataset.tone = tone;
}

function selectedLevel(): Level {
  const checked = document.querySelector<HTMLInputElement>('input[name="level"]:checked');
  return isLevel(checked?.value) ? checked.value : "simple";
}

function updateCount(): void {
  const over = input.value.length > MAX_INPUT_CHARS;
  count.textContent = `${input.value.length.toLocaleString("en")} / ${MAX_INPUT_CHARS.toLocaleString("en")}`;
  count.toggleAttribute("data-over", over);
}

function errorMessage(body: { error?: string; retryAfter?: number } | undefined): string {
  if (body?.error === "slow_down") {
    const seconds = body.retryAfter ?? 60;
    return `Slow down a little. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  }
  return MESSAGES[body?.error ?? ""] ?? MESSAGES.failed!;
}

async function scoreInput(): Promise<void> {
  clearTimeout(scoreTimer);
  scoreRequest?.abort();
  const text = input.value;
  if (!text.trim() || text.length > MAX_INPUT_CHARS) {
    lastInputScore = undefined;
    showScore(inputScore, { state: "empty" });
    return;
  }
  const request = new AbortController();
  scoreRequest = request;
  showScore(inputScore, { state: "loading" });
  try {
    const response = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: request.signal,
    });
    const body = (await response.json()) as { score?: number };
    if (!response.ok || typeof body.score !== "number") throw new Error(String(response.status));
    lastInputScore = body.score;
    showScore(inputScore, { state: "ready", value: body.score });
  } catch {
    if (request.signal.aborted) return;
    lastInputScore = undefined;
    showScore(inputScore, { state: "failed" });
  }
}

function setBusy(busy: boolean): void {
  run.disabled = busy;
  run.querySelector(".run-label")!.textContent = busy ? "Working…" : "Make it easy";
  output.setAttribute("aria-busy", String(busy));
}

async function* readEvents(response: Response): AsyncGenerator<{ event: string; data: string }> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      yield { event, data: data.join("\n") };
    }
  }
}

async function simplify(): Promise<void> {
  const text = input.value;
  if (!text.trim()) {
    showStatus(MESSAGES.empty!, "error");
    input.focus();
    return;
  }
  if (text.length > MAX_INPUT_CHARS) {
    showStatus(MESSAGES.too_long!, "error");
    return;
  }

  rewriteRequest?.abort();
  const request = new AbortController();
  rewriteRequest = request;
  output.value = "";
  copy.disabled = true;
  showScore(outputScore, { state: "empty" });
  showStatus("Making it easy…");
  setBusy(true);

  try {
    const response = await fetch("/api/simplify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, level: selectedLevel() }),
      signal: request.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string; retryAfter?: number };
      showStatus(errorMessage(body), "error");
      return;
    }
    let finished = false;
    for await (const { event, data } of readEvents(response)) {
      if (event === "text") {
        output.value += (JSON.parse(data) as { text: string }).text;
        output.scrollTop = output.scrollHeight;
        copy.disabled = !output.value;
        if (outputScore.dataset.state === "empty") showScore(outputScore, { state: "loading" });
      } else if (event === "done") {
        finished = true;
        const { score } = JSON.parse(data) as { score: number | null };
        if (score === null) showScore(outputScore, { state: "failed" });
        else
          showScore(
            outputScore,
            { state: "ready", value: score },
            lastInputScore === undefined ? undefined : score - lastInputScore,
          );
        showStatus("");
      } else if (event === "failed") {
        finished = true;
        showScore(outputScore, { state: "empty" });
        showStatus(MESSAGES.failed!, "error");
      }
    }
    if (!finished) throw new Error("stream ended early");
  } catch {
    if (request.signal.aborted) return;
    showScore(outputScore, { state: "empty" });
    showStatus(MESSAGES.failed!, "error");
  } finally {
    if (rewriteRequest === request) setBusy(false);
  }
}

function restoreLevel(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LEVEL_KEY);
  } catch {
    // Storage can be blocked; the default level is fine then.
  }
  if (!isLevel(saved)) return;
  for (const radio of levels) radio.checked = radio.value === saved;
}

input.addEventListener("input", () => {
  updateCount();
  clearTimeout(scoreTimer);
  scoreTimer = setTimeout(() => void scoreInput(), SCORE_DELAY_MS);
});

input.addEventListener("paste", () => {
  // The pasted text is in the textarea only after this event.
  setTimeout(() => {
    updateCount();
    void scoreInput();
    void simplify();
  });
});

for (const radio of levels) {
  radio.addEventListener("change", () => {
    try {
      localStorage.setItem(LEVEL_KEY, radio.value);
    } catch {
      // Not remembering the level is fine.
    }
    if (input.value.trim()) void simplify();
  });
}

run.addEventListener("click", () => void simplify());

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !run.disabled) {
    event.preventDefault();
    void simplify();
  }
});

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    copy.textContent = "Copied";
  } catch {
    output.select();
    copy.textContent = "Press Ctrl+C";
  }
  setTimeout(() => (copy.textContent = "Copy"), 1500);
});

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
if (matchMedia("(pointer: fine)").matches) {
  run.querySelector(".run-keys")!.textContent = isMac ? "⌘↵" : "Ctrl ↵";
}

restoreLevel();
updateCount();
