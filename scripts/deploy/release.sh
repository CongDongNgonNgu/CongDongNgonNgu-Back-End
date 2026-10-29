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
test "$(realpath "$base")" = "$base"
test "$(cat .source-sha)" = "$sha"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
exec 9> "$base/.deploy.lock"
flock -n 9 || { echo 'Application deployment is already running' >&2; exit 1; }
# Preserve the existing real-directory layout used by the accepted OAuth release.
test -d "$base/dist" && test ! -L "$base/dist"
candidate="$base/.cdnn-next-$sha-$run"
rollback="$base/.cdnn-rollback-$sha-$run"
test ! -e "$candidate" && test ! -L "$candidate"
test ! -e "$rollback" && test ! -L "$rollback"
export PM2_HOME=/home/cdnn-deploy/.pm2
node scripts/deploy/release-assets.cjs reserve "$base"
npm ci --include=dev
npm run build
npm audit --omit=dev --audit-level=moderate
# SELECT-only transaction; never apply a migration or import the application here.
env -u DATABASE_URL node --env-file="$base/.env" scripts/deploy/check-migrations.cjs
node scripts/deploy/release-assets.cjs space "$base" "$base/dist" "$release/dist"
ln -s "$release/node_modules" dist/node_modules
node scripts/deploy/release-assets.cjs dependencies "$release/dist/main.js" "$release"
chmod 755 dist
mv -T "$release/dist" "$candidate"
node scripts/deploy/release-assets.cjs dependencies "$candidate/main.js" "$release"
# Probe the actual same-filesystem exchange before any lifecycle action.
mkdir "$release/.exchange-a" "$release/.exchange-b"
python3 scripts/deploy/exchange.py "$release/.exchange-a" "$release/.exchange-b"
python3 scripts/deploy/exchange.py "$release/.exchange-a" "$release/.exchange-b"
rmdir "$release/.exchange-a" "$release/.exchange-b"
old_inode=$(stat -c '%d:%i' "$base/dist")
new_inode=$(stat -c '%d:%i' "$candidate")
node scripts/deploy/runtime-snapshot.cjs capture "$release/runtime.before.json"
verify() {
  for attempt in $(seq 1 12); do
    if node scripts/deploy/runtime-snapshot.cjs restarted "$release/runtime.before.json" && node scripts/deploy/verify.cjs; then return 0; fi
    printf 'Verification retry %s/12\n' "$attempt"
    sleep 5
  done
  return 1
}
record() {
  printf '{"attempted_sha":"%s","result":"%s","retained_original":"%s","timestamp":"%s"}\n' "$sha" "$1" "$candidate" "$(date -u +%FT%TZ)" >> "$base/.deployment-ledger.jsonl"
}
recover() {
  local status=$?
  trap - EXIT INT TERM
  if ! node scripts/deploy/runtime-snapshot.cjs recoverable "$release/runtime.before.json"; then
    record rollback_failed
    echo 'Runtime drift: no blind rollback or restart; operator inspection required' >&2
    exit "$status"
  fi
  local live_inode
  live_inode=$(stat -c '%d:%i' "$base/dist")
  if [[ "$live_inode" == "$old_inode" ]]; then
    if node scripts/deploy/runtime-snapshot.cjs unchanged "$release/runtime.before.json"; then record failed_without_activation; exit "$status"; fi
    if node scripts/deploy/runtime-snapshot.cjs stopped "$release/runtime.before.json" && pm2 restart cdnn-backend > /dev/null && verify; then record rolled_back; else record rollback_failed; fi
  elif [[ "$live_inode" == "$new_inode" && "$(stat -c '%d:%i' "$candidate")" == "$old_inode" ]]; then
    if pm2 stop cdnn-backend > /dev/null && node scripts/deploy/runtime-snapshot.cjs stopped "$release/runtime.before.json" && python3 scripts/deploy/exchange.py "$base/dist" "$candidate" && pm2 restart cdnn-backend > /dev/null && verify; then record rolled_back; else record rollback_failed; fi
  else
    record rollback_failed
    echo 'Unknown release inode pair; operator inspection required' >&2
  fi
  exit "$status"
}
# Durable intent precedes stop/exchange; retain all source, dependencies and old dist.
printf '{"sha":"%s","old_inode":"%s","new_inode":"%s","candidate":"%s"}\n' "$sha" "$old_inode" "$new_inode" "$candidate" > "$release/activation-intent.json"
node scripts/deploy/runtime-snapshot.cjs unchanged "$release/runtime.before.json"
node scripts/deploy/release-assets.cjs sync "$release/activation-intent.json" "$release" "$base"
trap recover EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pm2 stop cdnn-backend > /dev/null
node scripts/deploy/runtime-snapshot.cjs stopped "$release/runtime.before.json"
python3 scripts/deploy/exchange.py "$base/dist" "$candidate"
test "$(stat -c '%d:%i' "$base/dist")" = "$new_inode"
node scripts/deploy/release-assets.cjs dependencies "$base/dist/main.js" "$release"
pm2 restart cdnn-backend > /dev/null
verify
record verified
printf 'DEPLOYED_SHA=%s RESULT=verified\n' "$sha"
trap - EXIT INT TERM
