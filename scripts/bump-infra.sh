#!/usr/bin/env bash
# Deploys a pushed image: pins it for easywords-prod in davidorbelian/infra, in a pull request that merges
# itself once infra's checks pass. CI runs it with infra checked out in ./infra and GH_TOKEN set to a token
# of infra's david-orbelian-infra App. A newer image replaces a pending one, because the stack has one bump
# branch.
set -euo pipefail
image=${1:?usage: bump-infra.sh <repo:tag@sha256:digest>}
: "${GH_TOKEN:?} ${APP_SLUG:?} ${GITHUB_REPOSITORY:?} ${GITHUB_SHA:?} ${GITHUB_RUN_ID:?}"
infra=davidorbelian/infra
branch=bump/easywords-prod
pins=projects/easywords/envs/prod/images.json

change=$(git log -1 --format=%s)
# A merged pull request's title is the first line of its merge commit's body.
if [[ $change == "Merge pull request #"* ]]; then
  change=$(git log -1 --format=%b | sed -n '/./{p;q;}')
fi

cd infra
old=$(jq -r .web "$pins")
if [ "$old" = "$image" ]; then
  echo "infra already runs $image"
  exit 0
fi
old_commit=${old%@*}
old_commit=${old_commit##*:}
jq --arg image "$image" '.web = $image' "$pins" >"$pins.new"
mv "$pins.new" "$pins"

title="Run easywords at ${GITHUB_SHA:0:7}: $change"
body="Pins \`$image\`.

Changes: https://github.com/$GITHUB_REPOSITORY/compare/$old_commit...$GITHUB_SHA
Opened by https://github.com/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

bot="${APP_SLUG}[bot]"
bot_id=$(gh api "users/$bot" --jq .id)
git switch -q -c "$branch"
git add "$pins"
git -c user.name="$bot" -c user.email="$bot_id+$bot@users.noreply.github.com" commit -q -m "$title"
git push -q --force origin "HEAD:refs/heads/$branch"

number=$(gh pr list -R "$infra" --head "$branch" --state open --json number --jq '.[0].number // empty')
if [ -z "$number" ]; then
  gh pr create -R "$infra" --base main --head "$branch" --title "$title" --body "$body"
else
  gh pr edit -R "$infra" "$number" --title "$title" --body "$body"
fi
gh pr merge -R "$infra" "$branch" --auto --squash
