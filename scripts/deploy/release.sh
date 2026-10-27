#!/usr/bin/env bash
set -euo pipefail
umask 077
sha=$1
run=$2
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$run" =~ ^[0-9]+-[0-9]+$ ]]
test "$(id -un)" = cdnn-deploy
base=/var/www/congdongngonngu/backend
release="$base/.releases/$sha-$run"
test "$(pwd -P)" = "$release"
test "$(cat .source-sha)" = "$sha"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
exec 9> "$base/.deploy.lock"
flock -n 9 || { echo 'Application deployment is already running' >&2; exit 1; }
# One-time conversion of existing dist must be reviewed separately. Never replace a real directory automatically.
test -L "$base/dist" || { echo 'Reviewed dist symlink bootstrap required; no activation performed' >&2; exit 1; }
previous=$(readlink -f "$base/dist")
[[ "$previous" == "$base/.releases/"*/dist ]]
test -d "$previous"

export PM2_HOME=/home/cdnn-deploy/.pm2
test -f "$base/.env" && test ! -L "$base/.env"
test "$(stat -c %a "$base/.env")" = 600
test "$(stat -c %U "$base/.env")" = cdnn-deploy
# No .env content is printed, copied, or added to a release.
node scripts/deploy/check-runtime.cjs


npm ci --include=dev
npm run build
npm audit --omit=dev --audit-level=moderate
env -u DATABASE_URL node --env-file="$base/.env" scripts/deploy/check-migrations.cjs
# The reviewed actual script must exist inside the staged dist.
node -e 'const fs=require("fs"),path=require("path");const p=require("./scripts/deploy/runtime-contract.json").script;const rel=path.relative("/var/www/congdongngonngu/backend/dist",p);if(!fs.statSync(path.join("dist",rel)).isFile())process.exit(1)'

# Static clients can retain old hashed entry/chunk URLs. Retain previous assets in the next artifact.

activated=0
swap() {
  local destination=$1
  local link="$base/.dist-$sha-$run-$2"
  ln -s "$destination" "$link" && mv -Tf "$link" "$base/dist"
}
verify() {
  for attempt in $(seq 1 12); do
    if node scripts/deploy/verify.cjs; then return 0; fi
    printf 'Verification retry %s/12\n' "$attempt"
    sleep 5
  done
  return 1
}
record() {
  printf '{"sha":"%s","previous":"%s","timestamp":"%s","result":"%s"}\n' "$sha" "$previous" "$(date -u +%FT%TZ)" "$1" >> "$base/.deployment-ledger.jsonl"
}
recover() {
  local status=$?
  trap - EXIT INT TERM
  if (( activated )); then
    if swap "$previous" rollback && pm2 restart cdnn-backend > /dev/null &&
       verify; then
      record rolled_back
    else
      record rollback_failed
      echo 'Rollback verification failed; operator action required' >&2
    fi
  fi
  exit "$status"
}
trap recover EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
activated=1
swap "$release/dist" activation
pm2 restart cdnn-backend > /dev/null

verify
record verified
activated=0
trap - EXIT INT TERM
