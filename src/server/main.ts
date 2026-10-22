import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Admin, loadKey, MIN_HASSWORD_CHARS } from "./admin.ts";
import { createApp, defaultLimits } from "./app.ts";
import { createClaudeRewriter } from "./claude.ts";
import { createJevScorer } from "./jev.ts";
import { StyleStore } from "./styles.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

// Spaces count: the hassword is typed exactly.
const hassword = process.env.ADMIN_HASSWORD || undefined;
if (hassword && hassword.length < MIN_HASSWORD_CHARS) {
  console.error(`ADMIN_HASSWORD must be at least ${MIN_HASSWORD_CHARS} characters long`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR ?? "data";
const webRoot = process.env.WEB_ROOT ?? "dist/web";
const limits = defaultLimits();
const app = createApp({
  scorer: createJevScorer(required("JEV_API_KEY"), process.env.JEV_BASE_URL ?? "https://api.typesafe.ai"),
  rewriter: createClaudeRewriter(required("CLAUDE_CODE_OAUTH_TOKEN"), process.env.ANTHROPIC_BASE_URL),
  limits,
  store: await StyleStore.open(dataDir),
  admin: hassword ? new Admin(hassword, await loadKey(dataDir)) : undefined,
  webRoot,
});
app.use("/*", serveStatic({ root: webRoot }));

setInterval(() => {
  limits.scores.sweep();
  limits.rewrites.sweep();
}, 60_000).unref();

const server = serve({ fetch: app.fetch, port }, (info) => console.log(`listening on :${info.port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
