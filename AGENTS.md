# easywords

Paste hard text, get the same text in easy words. Both sides get an "Easy score" from 0 to 100.

## How it works

- `src/server` is a Hono app on Node 26. Node runs the TypeScript files directly, so the server has no build step.
- `src/web` is plain HTML, CSS and TypeScript. esbuild bundles it into `dist/web`.
- `src/shared` holds rules both sides use: levels and the input limit.
- Rewrites come from Claude Sonnet through the Claude Agent SDK, with a subscription token from `claude setup-token`.
  The SDK starts the bundled `claude` binary for each rewrite, with no tools and no settings files.
- Scores come from Jev (TypeSafe AI, `POST /v1/systemone`), as one `score` question mapped to 0-100.
- Limits live in memory in one process. See `defaultLimits()` in `src/server/app.ts`.
  The client IP comes from `CF-Connecting-IP`, because production traffic only arrives through a Cloudflare tunnel.

## Environment

| Variable                             | Meaning                                             |
| ------------------------------------ | --------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`            | Claude subscription token, required                 |
| `JEV_API_KEY`                        | TypeSafe AI key, required                           |
| `PORT`                               | Defaults to 8080                                    |
| `JEV_BASE_URL`, `ANTHROPIC_BASE_URL` | Only for tests, to point at `e2e/fake-upstream.mjs` |

Copy `.env.example` to `.env` for `make dev`. Never commit or print token values.

## Checks

- `make check`: lint, typecheck, unit tests.
- `make test`: the above plus Playwright against the fake upstream.
  Run it with the `playwright` from the nix profile. Never run `playwright install`.
  The Playwright files are `.cjs`, because that `playwright` is found through `NODE_PATH` and ESM ignores it.
- `make e2e-image`: the same browser tests against the built amd64 image, as CI runs them.
- Text containing `FAIL_CLAUDE`, `FAIL_JEV` or `SLOW_CLAUDE` makes the fake upstream fail or slow down.

## Shipping

- The repo is public so CI minutes are free. GHCR gives the image `ghcr.io/davidorbelian/easywords.me` the repo's visibility, so it is public too. It holds no secrets.
- CI runs on pushes to main and on PRs. On main it pushes the image and writes the `tag@digest` pin to the job summary.
- `davidorbelian/infra` owns DNS, secrets, the server and the image pin. This repo only builds the image.
