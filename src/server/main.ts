import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, defaultLimits } from "./app.ts";
import { createClaudeRewriter } from "./claude.ts";
import { createJevScorer } from "./jev.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.PORT ?? 8080);
const limits = defaultLimits();
const app = createApp({
  scorer: createJevScorer(required("JEV_API_KEY"), process.env.JEV_BASE_URL ?? "https://api.typesafe.ai"),
  rewriter: createClaudeRewriter(required("CLAUDE_CODE_OAUTH_TOKEN"), process.env.ANTHROPIC_BASE_URL),
  limits,
});
app.use("/*", serveStatic({ root: process.env.WEB_ROOT ?? "dist/web" }));

setInterval(() => {
  limits.scores.sweep();
  limits.rewrites.sweep();
}, 60_000).unref();

const server = serve({ fetch: app.fetch, port }, (info) => console.log(`listening on :${info.port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
