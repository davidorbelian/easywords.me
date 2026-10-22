import {
  checkDraft,
  MAX_INPUT_CHARS,
  MAX_NAME_CHARS,
  MAX_PROMPT_CHARS,
  MAX_RULES_CHARS,
  MAX_STYLES,
  type Draft,
  type Version,
} from "../shared/rules.ts";
import { readEvents } from "./events.ts";

type Item = { key: number; id?: string; name: string; prompt: string };

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const signinForm = element<HTMLFormElement>("signin");
const hassword = element<HTMLInputElement>("hassword");
const signinStatus = element<HTMLParagraphElement>("signin-status");
const signout = element<HTMLButtonElement>("signout");
const editor = element<HTMLDivElement>("editor");
const rules = element<HTMLTextAreaElement>("rules");
const rulesCount = element<HTMLSpanElement>("rules-count");
const styleList = element<HTMLOListElement>("style-list");
const add = element<HTMLButtonElement>("add");
const tryStyle = element<HTMLSelectElement>("try-style");
const tryInput = element<HTMLTextAreaElement>("try-input");
const tryOutput = element<HTMLTextAreaElement>("try-output");
const tryScore = element<HTMLOutputElement>("try-score");
const tryButton = element<HTMLButtonElement>("try");
const tryStatus = element<HTMLParagraphElement>("try-status");
const versionList = element<HTMLOListElement>("versions");
const saveStatus = element<HTMLSpanElement>("save-status");
const discard = element<HTMLButtonElement>("discard");
const save = element<HTMLButtonElement>("save");

let token = "";
let versions: Version[] = [];
let basedOn = 0;
let items: Item[] = [];
let nextKey = 0;
let tryRequest: AbortController | undefined;
let note: { text: string; tone: "info" | "error" } | undefined;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function draft(): Draft {
  return {
    rules: rules.value,
    styles: items.map(({ id, name, prompt }) => (id ? { id, name, prompt } : { name, prompt })),
  };
}

function same(version: Version | undefined): boolean {
  if (!version) return false;
  const { rules: savedRules, styles } = version;
  return JSON.stringify(draft()) === JSON.stringify({ rules: savedRules, styles });
}

function dirty(): boolean {
  return !same(versions[0]);
}

function showStatus(target: HTMLElement, text: string, tone: "info" | "error" = "info"): void {
  target.textContent = text;
  target.dataset.tone = tone;
}

function count(target: HTMLElement, length: number, max: number): void {
  target.textContent = `${length.toLocaleString("en")} / ${max.toLocaleString("en")}`;
  target.toggleAttribute("data-over", length > max);
}

// Textareas grow with their text, so the page scrolls and not each box.
function fit(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
}

function useVersion(version: Version): void {
  rules.value = version.rules;
  items = version.styles.map((style) => ({ ...style, key: nextKey++ }));
  renderStyles();
  fit(rules);
}

function renderStyles(): void {
  styleList.replaceChildren(...items.map(renderItem));
  add.disabled = items.length >= MAX_STYLES;
  const picked = Number(tryStyle.value);
  tryStyle.replaceChildren(
    ...items.map((item) => new Option(item.name.trim() || "Unnamed", String(item.key), false, item.key === picked)),
  );
  update();
}

function renderItem(item: Item, index: number): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "style-item";

  const head = document.createElement("div");
  head.className = "style-head";

  const name = document.createElement("input");
  name.className = "style-name";
  name.value = item.name;
  name.maxLength = MAX_NAME_CHARS;
  name.placeholder = "Name on the button";
  name.ariaLabel = `Name of style ${index + 1}`;
  name.addEventListener("input", () => {
    item.name = name.value;
    const option = [...tryStyle.options].find((choice) => choice.value === String(item.key));
    if (option) option.text = name.value.trim() || "Unnamed";
    label();
    edited();
  });

  const id = document.createElement("span");
  id.className = "style-id";
  id.textContent = item.id ?? "new";
  id.title = item.id ? "The id never changes, so links and saved choices keep working." : "Gets an id when saved.";

  const up = button("↑", index === 0, () => move(index, -1));
  const down = button("↓", index === items.length - 1, () => move(index, 1));
  const remove = button("Remove", items.length === 1, () => {
    items.splice(index, 1);
    renderStyles();
    edited();
  });
  const label = () => {
    const title = item.name.trim() || "style";
    up.ariaLabel = `Move ${title} up`;
    down.ariaLabel = `Move ${title} down`;
    remove.ariaLabel = `Remove ${title}`;
  };
  label();
  const actions = document.createElement("div");
  actions.className = "style-actions";
  actions.append(up, down, remove);
  head.append(name, id, actions);

  const prompt = document.createElement("textarea");
  prompt.className = "style-prompt";
  prompt.value = item.prompt;
  prompt.spellcheck = false;
  prompt.placeholder = "Voice: who talks, and how…";
  prompt.ariaLabel = `Prompt of style ${index + 1}`;
  const promptCount = document.createElement("span");
  promptCount.className = "count";
  count(promptCount, item.prompt.length, MAX_PROMPT_CHARS);
  prompt.addEventListener("input", () => {
    item.prompt = prompt.value;
    count(promptCount, prompt.value.length, MAX_PROMPT_CHARS);
    fit(prompt);
    edited();
  });
  requestAnimationFrame(() => fit(prompt));

  const foot = document.createElement("div");
  foot.className = "style-foot";
  foot.append(promptCount);

  row.append(head, prompt, foot);
  return row;
}

function button(text: string, disabled: boolean, onClick: () => void, label?: string): HTMLButtonElement {
  const target = document.createElement("button");
  target.type = "button";
  target.className = "copy";
  target.textContent = text;
  if (label) target.ariaLabel = label;
  target.disabled = disabled;
  target.addEventListener("click", onClick);
  return target;
}

function move(index: number, by: number): void {
  const [item] = items.splice(index, 1);
  items.splice(index + by, 0, item!);
  renderStyles();
  edited();
  styleList.children[index + by]?.querySelector<HTMLButtonElement>(by < 0 ? "button" : "button + button")?.focus();
}

function renderVersions(): void {
  versionList.replaceChildren(
    ...versions.map((version, index) => {
      const row = document.createElement("li");
      const number = document.createElement("strong");
      number.textContent = `#${version.number}`;
      const time = document.createElement("time");
      time.dateTime = version.savedAt;
      time.textContent = timeFormat.format(new Date(version.savedAt));
      const names = document.createElement("span");
      names.className = "version-styles";
      names.textContent = version.styles.map((style) => style.name).join(", ");
      const info = document.createElement("div");
      info.className = "version-info";
      info.append(number, time, names);
      row.append(info);
      if (index === 0) {
        const live = document.createElement("span");
        live.className = "badge";
        live.textContent = "Live";
        row.append(live);
      } else {
        row.append(
          button(
            "Load",
            false,
            () => {
              useVersion(version);
              setNote(`Loaded version ${version.number}. Save to make it live.`);
            },
            `Load version ${version.number}`,
          ),
        );
      }
      return row;
    }),
  );
}

function update(): void {
  count(rulesCount, rules.value.length, MAX_RULES_CHARS);
  const changed = dirty();
  save.disabled = !changed;
  discard.disabled = !changed;
  if (note) showStatus(saveStatus, note.text, note.tone);
  else showStatus(saveStatus, changed ? "Unsaved changes." : "Everyone sees this version.");
  tryButton.disabled = items.length === 0 || tryRequest !== undefined;
}

function setNote(text: string, tone: "info" | "error" = "info"): void {
  note = { text, tone };
  update();
}

function edited(): void {
  note = undefined;
  update();
}

function showVersions(list: Version[]): void {
  versions = list;
  basedOn = list[0]?.number ?? 0;
  renderVersions();
}

async function api(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Form-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.status === 401)
    showSignin(!editor.hidden && dirty() ? "You were signed out. Sign in again; your edits are still here." : "");
  return response;
}

function showSignin(message = ""): void {
  editor.hidden = true;
  signout.hidden = true;
  signinForm.hidden = false;
  showStatus(signinStatus, message);
  hassword.focus();
}

async function load(keepDraft: boolean): Promise<void> {
  const response = await api("GET", "/api/admin/styles");
  if (response.status === 401) return;
  const body = (await response.json()) as { token: string; versions: Version[] };
  token = body.token;
  const kept = keepDraft && items.length > 0 && dirty();
  const keptBasedOn = basedOn;
  showVersions(body.versions);
  if (kept) basedOn = keptBasedOn;
  else useVersion(body.versions[0]!);
  note = undefined;
  signinForm.hidden = true;
  editor.hidden = false;
  signout.hidden = false;
  update();
  fit(rules);
}

signinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus(signinStatus, "");
  const response = await fetch("/api/admin/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hassword: hassword.value }),
  });
  if (response.ok) {
    hassword.value = "";
    await load(true);
    return;
  }
  const body = (await response.json().catch(() => undefined)) as { error?: string; retryAfter?: number } | undefined;
  if (body?.error === "locked") {
    const minutes = Math.max(1, Math.ceil((body.retryAfter ?? 900) / 60));
    showStatus(
      signinStatus,
      `Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      "error",
    );
  } else if (body?.error === "wrong") {
    showStatus(signinStatus, "Wrong hassword.", "error");
    hassword.select();
  } else {
    showStatus(signinStatus, "That didn't work. Try again.", "error");
  }
});

signout.addEventListener("click", async () => {
  if (dirty() && !confirm("Sign out and lose your unsaved changes?")) return;
  await api("POST", "/api/admin/signout");
  items = [];
  versions = [];
  showSignin();
});

rules.addEventListener("input", () => {
  fit(rules);
  edited();
});

add.addEventListener("click", () => {
  items.push({ key: nextKey++, name: "", prompt: "" });
  renderStyles();
  edited();
  styleList.lastElementChild?.querySelector("input")?.focus();
});

discard.addEventListener("click", () => {
  if (!versions[0]) return;
  useVersion(versions[0]);
  edited();
});

save.addEventListener("click", async () => {
  const checked = checkDraft(draft());
  if ("error" in checked) {
    setNote(checked.error, "error");
    return;
  }
  save.disabled = true;
  setNote("Saving…");
  try {
    const response = await api("PUT", "/api/admin/styles", { ...checked, basedOn });
    const body = (await response.json().catch(() => undefined)) as
      { versions?: Version[]; error?: string; message?: string } | undefined;
    if (response.ok && body?.versions) {
      showVersions(body.versions);
      useVersion(body.versions[0]!);
      setNote(`Saved as version ${basedOn}. Everyone sees it now.`);
    } else if (response.status === 409 && body?.versions) {
      showVersions(body.versions);
      setNote(`Someone saved version ${basedOn} while you were editing. Save again to replace it with yours.`, "error");
    } else if (response.status === 401) {
      edited();
    } else {
      setNote(body?.message ?? "Saving failed. Try again.", "error");
    }
  } catch {
    setNote("Saving failed. Try again.", "error");
  }
});

tryButton.addEventListener("click", async () => {
  const item = items.find((style) => String(style.key) === tryStyle.value) ?? items[0];
  const text = tryInput.value;
  if (!item) return;
  if (!text.trim()) {
    showStatus(tryStatus, "Paste some sample text first.", "error");
    tryInput.focus();
    return;
  }
  if (text.length > MAX_INPUT_CHARS) {
    showStatus(tryStatus, `Keep the sample under ${MAX_INPUT_CHARS.toLocaleString("en")} characters.`, "error");
    return;
  }
  if (!item.prompt.trim()) {
    showStatus(tryStatus, "This style has no prompt yet.", "error");
    return;
  }

  const request = new AbortController();
  tryRequest = request;
  tryOutput.value = "";
  setScore("empty");
  showStatus(tryStatus, "Trying…");
  tryButton.disabled = true;
  try {
    const response = await api(
      "POST",
      "/api/admin/try",
      { rules: rules.value, prompt: item.prompt, text },
      request.signal,
    );
    if (!response.ok) {
      if (response.status !== 401)
        showStatus(
          tryStatus,
          response.status === 503 ? "Claude is busy. Try again in a moment." : "That didn't work.",
          "error",
        );
      return;
    }
    let finished = false;
    for await (const { event, data } of readEvents(response)) {
      if (event === "text") {
        tryOutput.value += (JSON.parse(data) as { text: string }).text;
        fit(tryOutput);
        setScore("loading");
      } else if (event === "done") {
        finished = true;
        const { score } = JSON.parse(data) as { score: number | null };
        setScore(score === null ? "failed" : "ready", score ?? undefined);
        showStatus(tryStatus, "");
      } else if (event === "failed") {
        finished = true;
        setScore("empty");
        showStatus(tryStatus, "Claude failed on this one. Try again.", "error");
      }
    }
    if (!finished) throw new Error("stream ended early");
  } catch {
    setScore("empty");
    showStatus(tryStatus, "That didn't work.", "error");
  } finally {
    tryRequest = undefined;
    update();
  }
});

function setScore(state: "empty" | "loading" | "failed" | "ready", value?: number): void {
  tryScore.dataset.state = state;
  tryScore.querySelector(".score-value")!.textContent =
    state === "ready" ? String(value) : state === "loading" ? "··" : "–";
  if (value !== undefined) tryScore.style.setProperty("--hue", String(Math.round(value * 1.4)));
}

tryInput.addEventListener("input", () => fit(tryInput));

window.addEventListener("beforeunload", (event) => {
  if (!editor.hidden && dirty()) event.preventDefault();
});

void load(false);
