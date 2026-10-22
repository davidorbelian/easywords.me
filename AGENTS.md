# easywords

Paste fancy text, get the plain truth back in easy, rude words. Both sides get an "Easy score" from 0 to 100.

The site is a joke. Each personality is a comic voice, such as Blunt (a blunt friend), Teacher (a kindergarten teacher
losing patience) and Caveman. Swearing and snark are wanted. The admin page edits the personalities for everyone, so the
voices and rules in the code are only the first version.

## How it works

- `src/server` is a Hono app on Node 26. Node runs the TypeScript files directly, so the server has no build step.
- `src/web` is plain HTML, CSS and TypeScript. esbuild bundles it into `dist/web`.
  The CSS and JS names get a hash of their content, written into the HTML at build time.
  Browsers keep those files for good and check everything else every time.
  Without our own `Cache-Control`, Cloudflare tells browsers to keep files for 4 hours, so a new page met old CSS.
- `src/shared` holds rules both sides use: limits and the check of an edited set of personalities.
- Rewrites come from Claude Sonnet through the Claude Agent SDK, with a subscription token from `claude setup-token`.
  The SDK starts the bundled `claude` binary for each rewrite, with no tools and no settings files.
  Its system prompt is the shared rules, then the personality's prompt.
- Personalities live in `DATA_DIR/personalities.json`: the last 50 saved versions, each with all personalities and the
  shared rules. The newest version is live. With no file, `src/server/seed.json` becomes version 1, like any save,
  and after that the file is the only truth. A personality's id comes from its name when it is made and never changes.
  Personalities were once called styles. With only an old `styles.json`, the server copies it over once and leaves it.
- A personality may keep `messages`: chat messages an admin pasted. `POST /api/admin/build` asks Claude to write a
  name and a prompt in their voice, and the admin edits, tries and saves it. Rewrites never see the messages.
  They stay so an admin can paste more later and build again.
- The server fills the personality buttons and the Admin link into `index.html`, so the page needs no extra request.
- The admin page `/admin` is on only when `ADMIN_HASSWORD` is set. It works like Gentilik's: one shared hassword,
  then a signed session cookie for 30 days, with the key in `DATA_DIR/admin-key.json`. A new hassword signs everyone
  out. Every change sends a form token. Five wrong tries in 15 minutes lock signing in for 15 minutes, for everyone.
  A save names the version it started from, and is refused when someone saved after it.
  The cookie is `Secure` only behind HTTPS (`X-Forwarded-Proto`), because browsers drop it on plain HTTP.
- Scores come from Jev (TypeSafe AI, `POST /v1/systemone`), as one `score` question mapped to 0-100.
- Limits live in memory in one process. See `defaultLimits()` in `src/server/app.ts`.
  The client IP comes from `CF-Connecting-IP`, because production traffic only arrives through a Cloudflare tunnel.

## Environment

| Variable                             | Meaning                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`            | Claude subscription token, required                   |
| `JEV_API_KEY`                        | TypeSafe AI key, required                             |
| `ADMIN_HASSWORD`                     | Turns on the admin page, at least 12 characters       |
| `DATA_DIR`                           | Personalities and the admin key. `/data` in the image |
| `PORT`                               | Defaults to 8080                                      |
| `JEV_BASE_URL`, `ANTHROPIC_BASE_URL` | Only for tests, to point at `e2e/fake-upstream.mjs`   |

Copy `.env.example` to `.env` for `make dev`. Never commit or print token values.

## Checks

- `make check`: lint, typecheck, unit tests.
- `make test`: the above plus Playwright against the fake upstream.
  Run it with the `playwright` from the nix profile. Never run `playwright install`.
  The Playwright files are `.cjs`, because that `playwright` is found through `NODE_PATH` and ESM ignores it.
- `make e2e-image`: the same browser tests against the built amd64 image, as CI runs them.
- Text containing `FAIL_CLAUDE`, `FAIL_JEV` or `SLOW_CLAUDE` makes the fake upstream fail or slow down.
  A system prompt or text containing `FAKE_REPLY:<words>` makes those words the reply, with `|` as a line break.
- The admin tests change the personalities every page sees. So they run after the other tests, in one worker,
  and each one starts by saving the seed again.

## Shipping

- The repo is public so CI minutes are free. GHCR gives the image `ghcr.io/davidorbelian/easywords.me` the repo's visibility, so it is public too. It holds no secrets.
- `davidorbelian/infra` owns DNS, secrets, the server and the image pin. This repo only builds the image.
- The image needs a writable `/data` for the `node` user, and keeps no state anywhere else.
  A change to what it needs from the server is an infra pull request, merged before the image that needs it.

### A merge to `main` deploys

Every push to `main` that changes more than `*.md` files goes to production on its own. Merge only what may go live now.

1. CI runs the checks and the browser tests against the image, then pushes `ghcr.io/davidorbelian/easywords.me:<commit>`.
2. `scripts/bump-infra.sh` pins it, as `repo:tag@sha256:digest`, in infra's `projects/easywords/envs/prod/images.json`.
   It pushes the branch `bump/easywords-prod`, opens "Run easywords at `<commit>`" and turns on auto-merge.
   A newer push replaces a pin that is still waiting.
3. infra's required check `bump` lets that pull request change only this pin, to an image GHCR has. Then it merges itself.
4. The merge deploys the server, and the stack `easywords-prod` pulls the new image.

The token for step 2 comes from infra's GitHub App `david-orbelian-infra`: the repo variable `INFRA_BUMP_CLIENT_ID`
and the secret `INFRA_BUMP_APP_KEY`. The reasons are in infra's `docs/adr/0002`, `0005` and `0019`.

- **CI failed before the push**: nothing was deployed. Fix it on `main`.
- **The infra pull request did not merge**: see https://github.com/davidorbelian/infra/pulls?q=head%3Abump%2Feasywords-prod.
  Its `bump` check says what it refused.
- **The new image is broken**: revert its "Run easywords at ..." commit in infra, in a pull request.
  The merge deploys the previous image at once. A revert here works too, but it builds and tests a new image first.
  So keep `/data` readable by the previous image.
