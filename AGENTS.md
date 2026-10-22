# easywords

Paste fancy text, get the plain truth back in easy, rude words. Both sides get an "Easy score" from 0 to 100.

The site is a joke. Each style is a comic voice, such as Blunt (a blunt friend), Teacher (a kindergarten teacher losing
patience) and Caveman. Swearing and snark are wanted. The admin page edits the styles for everyone, so the voices and
rules in the code are only the first version.

## How it works

- `src/server` is a Hono app on Node 26. Node runs the TypeScript files directly, so the server has no build step.
- `src/web` is plain HTML, CSS and TypeScript. esbuild bundles it into `dist/web`.
- `src/shared` holds rules both sides use: limits and the check of an edited set of styles.
- Rewrites come from Claude Sonnet through the Claude Agent SDK, with a subscription token from `claude setup-token`.
  The SDK starts the bundled `claude` binary for each rewrite, with no tools and no settings files.
  Its system prompt is the shared rules, then the style's prompt.
- Styles live in `DATA_DIR/styles.json`: the last 50 saved versions, each with all styles and the shared rules.
  The newest version is live. With no file, `src/server/seed.json` becomes version 1, like any save,
  and after that the file is the only truth. A style's id comes from its name when it is made and never changes.
- The server fills the style buttons and the Admin link into `index.html`, so the page needs no extra request.
- The admin page `/admin` is on only when `ADMIN_HASSWORD` is set. It works like Gentilik's: one shared hassword,
  then a signed session cookie for 30 days, with the key in `DATA_DIR/admin-key.json`. A new hassword signs everyone
  out. Every change sends a form token. Five wrong tries in 15 minutes lock signing in for 15 minutes, for everyone.
  A save names the version it started from, and is refused when someone saved after it.
  The cookie is `Secure` only behind HTTPS (`X-Forwarded-Proto`), because browsers drop it on plain HTTP.
- Scores come from Jev (TypeSafe AI, `POST /v1/systemone`), as one `score` question mapped to 0-100.
- Limits live in memory in one process. See `defaultLimits()` in `src/server/app.ts`.
  The client IP comes from `CF-Connecting-IP`, because production traffic only arrives through a Cloudflare tunnel.

## Environment

| Variable                             | Meaning                                             |
| ------------------------------------ | --------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`            | Claude subscription token, required                 |
| `JEV_API_KEY`                        | TypeSafe AI key, required                           |
| `ADMIN_HASSWORD`                     | Turns on the admin page, at least 12 characters     |
| `DATA_DIR`                           | Styles and the admin key. `/data` in the image      |
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
  A system prompt containing `FAKE_REPLY:<words>` makes those words the rewrite.
- The admin tests change the styles every page sees. So they run after the other tests, in one worker,
  and each one starts by saving the seed again.

## Shipping

- The repo is public so CI minutes are free. GHCR gives the image `ghcr.io/davidorbelian/easywords.me` the repo's visibility, so it is public too. It holds no secrets.
- CI runs on pushes to main and on PRs. On main it pushes the image and writes the `tag@digest` pin to the job summary.
- `davidorbelian/infra` owns DNS, secrets, the server and the image pin. This repo only builds the image.
- The image needs a writable `/data` for the `node` user, and keeps no state anywhere else.
  A change to what it needs from the server is an infra pull request, merged before the image that needs it.
