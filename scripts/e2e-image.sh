#!/usr/bin/env bash
# Runs the browser tests against a built image, with fake Jev and Claude upstreams.
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:?usage: e2e-image.sh <image>}

docker build -q -f e2e/Browser.Dockerfile -t easywords-browser e2e >/dev/null
app=$(docker run -d --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e PORT=8788 -e JEV_API_KEY=fake -e JEV_BASE_URL=http://127.0.0.1:8787 \
  -e CLAUDE_CODE_OAUTH_TOKEN=fake -e ANTHROPIC_BASE_URL=http://127.0.0.1:8787 "$image")
trap 'docker logs "$app" | tail -20; docker rm -f "$app" >/dev/null' EXIT
for _ in {1..30}; do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$app")" == healthy ]] && break
  sleep 1
done

docker run --rm --network host --ipc host -e CI -e BASE_URL=http://127.0.0.1:8788 \
  -v "$PWD:/work" easywords-browser test
