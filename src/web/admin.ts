import {
  checkDraft,
  MAX_INPUT_CHARS,
  MAX_MESSAGES_CHARS,
  MAX_NAME_CHARS,
  MAX_PERSONALITIES,
  MAX_PROMPT_CHARS,
  MAX_RULES_CHARS,
  type Draft,
  type Personality,
  type Version,
} from "../shared/rules.ts";
import { readEvents } from "./events.ts";

type Item = { key: number; id?: string; name: string; prompt: string; messages: string };

/** What the middle panel shows: the shared rules, or the personality with this key. */
type Selected = "rules" | number;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const signinForm = element<HTMLFormElement>("signin");
const hassword = element<HTMLInputElement>("hassword");
const signinStatus = element<HTMLParagraphElement>("signin-status");
const signout = element<HTMLButtonElement>("signout");
const editor = element<HTMLDivElement>("editor");

const pickRules = element<HTMLButtonElement>("pick-rules");
const pickList = element<HTMLOListElement>("pick-list");
const add = element<HTMLButtonElement>("add");

const rulesPanel = element<HTMLElement>("rules-panel");
const rules = element<HTMLTextAreaElement>("rules");
const rulesCount = element<HTMLSpanElement>("rules-count");

const personalityPanel = element<HTMLElement>("personality-panel");
const personalityTitle = element<HTMLHeadingElement>("personality-title");
const personalityPlace = element<HTMLParagraphElement>("personality-place");
const personalityId = element<HTMLSpanElement>("personality-id");
const moveUp = element<HTMLButtonElement>("move-up");
const moveDown = element<HTMLButtonElement>("move-down");
const remove = element<HTMLButtonElement>("remove");
const name = element<HTMLInputElement>("name");
const prompt = element<HTMLTextAreaElement>("prompt");
const promptCount = element<HTMLSpanElement>("prompt-count");
const messages = element<HTMLTextAreaElement>("messages");
const messagesCount = element<HTMLSpanElement>("messages-count");
const build = element<HTMLButtonElement>("build");
const buildStatus = element<HTMLSpanElement>("build-status");

const tryName = element<HTMLSpanElement>("try-name");
const tryInput = element<HTMLTextAreaElement>("try-input");
const tryOutput = element<HTMLTextAreaElement>("try-output");
const tryScore = element<HTMLOutputElement>("try-score");
const tryButton = element<HTMLButtonElement>("try");
const tryStatus = element<HTMLSpanElement>("try-status");
const versionList = element<HTMLOListElement>("versions");

const savebar = element<HTMLDivElement>("savebar");
const saveStatus = element<HTMLSpanElement>("save-status");
const discard = element<HTMLButtonElement>("discard");
const save = element<HTMLButtonElement>("save");

name.maxLength = MAX_NAME_CHARS;

let token = "";
let versions: Version[] = [];
let basedOn = 0;
let items: Item[] = [];
let nextKey = 0;
// Nothing is open before the first load; then the first personality is.
let selected: Selected | undefined;
/** The personality Try uses while the shared rules are open. */
let lastPersonality: number | undefined;
let tryRequest: AbortController | undefined;
let building: number | undefined;
let note: { text: string; tone: "info" | "error" } | undefined;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function draft(): Draft {
  return {
    rules: rules.value,
    personalities: items.map(({ id, name, prompt, messages }) =>
      id ? { id, name, prompt, messages } : { name, prompt, messages },
    ),
  };
}

function dirty(): boolean {
  const live = versions[0];
  if (!live) return items.length > 0;
  const { rules: liveRules, personalities } = live;
  return JSON.stringify(draft()) !== JSON.stringify({ rules: liveRules, personalities });
}

function changed(item: Item): boolean {
  const live = versions[0]?.personalities.find((personality) => personality.id === item.id);
  return !live || live.name !== item.name || live.prompt !== item.prompt || live.messages !== item.messages;
}

function current(): Item | undefined {
  return items.find((item) => item.key === selected);
}

function tried(): Item | undefined {
  return current() ?? items.find((item) => item.key === lastPersonality) ?? items[0];
}

function label(item: Item): string {
  return item.name.trim() || "Unnamed";
}

function showStatus(target: HTMLElement, text: string, tone: "info" | "error" = "info"): void {
  target.textContent = text;
  target.dataset.tone = tone;
}

function count(target: HTMLElement, length: number, max: number): void {
  target.textContent = `${length.toLocaleString("en")} / ${max.toLocaleString("en")}`;
  target.toggleAttribute("data-over", length > max);
}

// Text boxes grow with their text, so the page scrolls and not each box.
function fit(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
}

/** Shows a saved version, and keeps open what was open when it is still there. */
function useVersion(version: Version): void {
  const open = selected === "rules" ? "rules" : current()?.id;
  rules.value = version.rules;
  items = version.personalities.map((personality: Personality) => ({ ...personality, key: nextKey++ }));
  if (open === "rules") return select("rules");
  const again = items.find((item) => item.id !== undefined && item.id === open);
  select((again ?? items[0]!).key);
}

function select(target: Selected): void {
  selected = target;
  if (target !== "rules") lastPersonality = target;
  showStatus(buildStatus, "");
  renderPicker();
  renderPanel();
  update();
}

function renderPicker(): void {
  pickRules.toggleAttribute("aria-current", selected === "rules");
  pickRules.querySelector<HTMLElement>(".pick-dot")!.hidden = versions[0]?.rules === rules.value;
  pickList.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "pick";
      pick.dataset.key = String(item.key);
      pick.toggleAttribute("aria-current", item.key === selected);
      const text = document.createElement("span");
      text.className = "pick-name";
      text.textContent = label(item);
      const dot = document.createElement("span");
      dot.className = "pick-dot";
      dot.title = "Not saved";
      dot.hidden = !changed(item);
      pick.append(text, dot);
      pick.addEventListener("click", () => select(item.key));
      row.append(pick);
      return row;
    }),
  );
  add.disabled = items.length >= MAX_PERSONALITIES;
}

/** Refreshes the picker's name and dot for one item, without rebuilding the list under the cursor. */
function refreshPick(item: Item): void {
  const pick = pickList.querySelector<HTMLButtonElement>(`[data-key="${item.key}"]`);
  if (!pick) return;
  pick.querySelector(".pick-name")!.textContent = label(item);
  pick.querySelector<HTMLElement>(".pick-dot")!.hidden = !changed(item);
}

function renderPanel(): void {
  const item = current();
  rulesPanel.hidden = item !== undefined;
  personalityPanel.hidden = item === undefined;
  if (!item) {
    fit(rules);
    return;
  }
  const index = items.indexOf(item);
  personalityTitle.textContent = label(item);
  personalityPlace.textContent =
    index === 0
      ? "First on the site. Visitors get this one until they pick another."
      : `Number ${index + 1} of ${items.length} on the site.`;
  personalityId.textContent = item.id ? `id: ${item.id}` : "new";
  personalityId.title = item.id
    ? "The id never changes, so saved choices keep working."
    : "Gets an id from its name when you save.";
  moveUp.disabled = index === 0;
  moveDown.disabled = index === items.length - 1;
  remove.disabled = items.length === 1;
  name.value = item.name;
  prompt.value = item.prompt;
  messages.value = item.messages;
  fit(prompt);
  fit(messages);
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
      names.className = "version-personalities";
      names.textContent = version.personalities.map((personality) => personality.name).join(", ");
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
        const load = document.createElement("button");
        load.type = "button";
        load.className = "copy";
        load.textContent = "Load";
        load.ariaLabel = `Load version ${version.number}`;
        load.addEventListener("click", () => {
          useVersion(version);
          setNote(`Loaded version ${version.number}. Save to make it live.`);
        });
        row.append(load);
      }
      return row;
    }),
  );
}

function update(): void {
  count(rulesCount, rules.value.length, MAX_RULES_CHARS);
  const item = current();
  if (item) {
    count(promptCount, item.prompt.length, MAX_PROMPT_CHARS);
    count(messagesCount, item.messages.length, MAX_MESSAGES_CHARS);
    build.disabled = building !== undefined;
    build.querySelector(".run-label")!.textContent =
      building === item.key ? "Building…" : item.prompt.trim() ? "Rebuild prompt" : "Build prompt";
    prompt.setAttribute("aria-busy", String(building === item.key));
  }
  const target = tried();
  tryName.textContent = target ? `as ${label(target)}` : "";
  tryButton.disabled = !target || tryRequest !== undefined;

  const unsaved = dirty();
  savebar.hidden = !unsaved && !note;
  save.hidden = !unsaved;
  discard.hidden = !unsaved;
  if (note) showStatus(saveStatus, note.text, note.tone);
  else showStatus(saveStatus, unsaved ? "Not saved yet. Visitors still get the live version." : "");
}

function setNote(text: string, tone: "info" | "error" = "info"): void {
  note = { text, tone };
  update();
}

function edited(item?: Item): void {
  note = undefined;
  if (item) refreshPick(item);
  pickRules.querySelector<HTMLElement>(".pick-dot")!.hidden = versions[0]?.rules === rules.value;
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
  const response = await api("GET", "/api/admin/personalities");
  if (response.status === 401) return;
  const body = (await response.json()) as { token: string; versions: Version[] };
  token = body.token;
  const kept = keepDraft && items.length > 0 && dirty();
  const keptBasedOn = basedOn;
  showVersions(body.versions);
  signinForm.hidden = true;
  editor.hidden = false;
  signout.hidden = false;
  note = undefined;
  if (kept) {
    basedOn = keptBasedOn;
    select(selected ?? "rules");
  } else {
    useVersion(body.versions[0]!);
  }
}

function addPersonality(): void {
  const item: Item = { key: nextKey++, name: "", prompt: "", messages: "" };
  items.push(item);
  select(item.key);
  edited();
  name.focus();
}

function move(by: number): void {
  const item = current();
  if (!item) return;
  const index = items.indexOf(item);
  items.splice(index, 1);
  items.splice(index + by, 0, item);
  renderPicker();
  renderPanel();
  edited();
  // A button that just became disabled drops the focus, so hand it to the other one.
  if (moveUp.disabled && document.activeElement !== moveDown) moveDown.focus();
  if (moveDown.disabled && document.activeElement !== moveUp) moveUp.focus();
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

pickRules.addEventListener("click", () => select("rules"));
add.addEventListener("click", addPersonality);

rules.addEventListener("input", () => {
  fit(rules);
  edited();
});

name.addEventListener("input", () => {
  const item = current();
  if (!item) return;
  item.name = name.value;
  personalityTitle.textContent = label(item);
  edited(item);
});

prompt.addEventListener("input", () => {
  const item = current();
  if (!item) return;
  item.prompt = prompt.value;
  fit(prompt);
  edited(item);
});

messages.addEventListener("input", () => {
  const item = current();
  if (!item) return;
  item.messages = messages.value;
  fit(messages);
  edited(item);
});

moveUp.addEventListener("click", () => move(-1));
moveDown.addEventListener("click", () => move(1));

remove.addEventListener("click", () => {
  const item = current();
  if (!item || items.length === 1) return;
  const index = items.indexOf(item);
  items.splice(index, 1);
  select(items[Math.min(index, items.length - 1)]!.key);
  edited();
});

discard.addEventListener("click", () => {
  if (!versions[0]) return;
  useVersion(versions[0]);
  edited();
});

save.addEventListener("click", async () => {
  const checked = checkDraft(draft());
  if ("error" in checked) {
    if (checked.index !== undefined) select(items[checked.index]!.key);
    setNote(checked.error, "error");
    return;
  }
  save.disabled = true;
  setNote("Saving…");
  try {
    const response = await api("PUT", "/api/admin/personalities", { ...checked, basedOn });
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
  } finally {
    save.disabled = false;
  }
});

build.addEventListener("click", async () => {
  const item = current();
  if (!item) return;
  if (!item.messages.trim()) {
    showStatus(buildStatus, "Paste some messages first.", "error");
    messages.focus();
    return;
  }
  if (item.messages.length > MAX_MESSAGES_CHARS) {
    showStatus(buildStatus, `Keep the messages under ${MAX_MESSAGES_CHARS.toLocaleString("en")} characters.`, "error");
    return;
  }
  building = item.key;
  showStatus(buildStatus, "Reading the messages…");
  update();
  try {
    const response = await api("POST", "/api/admin/build", {
      rules: rules.value,
      name: item.name,
      prompt: item.prompt,
      messages: item.messages,
    });
    const body = (await response.json().catch(() => undefined)) as { name?: string; prompt?: string } | undefined;
    if (response.ok && body?.name && body.prompt) {
      item.prompt = body.prompt;
      if (!item.name.trim()) item.name = body.name;
      if (current() === item) renderPanel();
      edited(item);
      showStatus(buildStatus, "Built. Try it, then save.");
    } else if (response.status !== 401) {
      showStatus(
        buildStatus,
        response.status === 503 ? "Claude is busy. Try again in a moment." : "Claude failed on this one. Try again.",
        "error",
      );
    }
  } catch {
    showStatus(buildStatus, "That didn't work. Try again.", "error");
  } finally {
    building = undefined;
    update();
  }
});

tryButton.addEventListener("click", async () => {
  const item = tried();
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
    showStatus(tryStatus, `${label(item)} has no prompt yet.`, "error");
    return;
  }

  const request = new AbortController();
  tryRequest = request;
  tryOutput.value = "";
  fit(tryOutput);
  setScore("empty");
  showStatus(tryStatus, "Trying…");
  update();
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
