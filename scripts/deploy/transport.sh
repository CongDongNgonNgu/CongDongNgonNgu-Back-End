#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
[[ "$CDNN_SSH_USER" == cdnn-deploy && "$CDNN_SSH_HOST" == 103.173.226.189 ]]
test "$(git rev-parse HEAD)" = "$APPROVED_SHA"
# No runtime environment files may enter the archive.
if git ls-tree -r --name-only "$APPROVED_SHA" | grep -E '(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$'; then
  echo 'Tracked environment file rejected' >&2; exit 1
fi
scratch=$(mktemp -d)
trap 'rm -f -- "$scratch/key" "$scratch/known_hosts" "$scratch/source.tar"; rmdir -- "$scratch"' EXIT
printf '%s\n' "$CDNN_SSH_PRIVATE_KEY" > "$scratch/key"
printf '%s\n' "$CDNN_KNOWN_HOSTS" > "$scratch/known_hosts"
unset CDNN_SSH_PRIVATE_KEY CDNN_KNOWN_HOSTS
ssh-keygen -F "$CDNN_SSH_HOST" -f "$scratch/known_hosts" > /dev/null
options=(-i "$scratch/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o "UserKnownHostsFile=$scratch/known_hosts")
target="$CDNN_SSH_USER@$CDNN_SSH_HOST"
release="/var/www/congdongngonngu/backend/.releases/$APPROVED_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
git archive --format=tar "$APPROVED_SHA" > "$scratch/source.tar"
digest=$(sha256sum "$scratch/source.tar" | cut -d ' ' -f 1)
# Every interpolated remote argument is a validated hex/digit value or a fixed path.
remote_command="umask 077; test \"\$(id -un)\" = cdnn-deploy && mkdir -p /var/www/congdongngonngu/backend/.releases && mkdir '$release'"
ssh "${options[@]}" "$target" "$remote_command"
remote_command="cat > '$release/source.tar'"
ssh "${options[@]}" "$target" "$remote_command" < "$scratch/source.tar"
remote_command="set -eu; cd '$release'; printf '%s  source.tar\n' '$digest' | sha256sum -c -; tar -xf source.tar; rm source.tar; printf '%s\n' '$APPROVED_SHA' > .source-sha; bash scripts/deploy/release.sh '$APPROVED_SHA' '$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT'"
ssh "${options[@]}" "$target" "$remote_command"
