#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
base=$(node -p 'require(process.argv[1]).base' "$script_dir/bootstrap-config.json")
[[ "$base" == /var/www/congdongngonngu/backend || "$base" == /var/www/congdongngonngu/frontend ]]
test "$(id -un)" = cdnn-deploy
export PM2_HOME=/home/cdnn-deploy/.pm2
case "${1:-}" in
  --apply|--recover)
    test -d "$base" && test ! -L "$base"
    test "$(realpath -e -- "$base")" = "$base"
    test ! -L "$base/.deploy.lock"
    node -e 'const f=require("node:fs"),s=f.lstatSync(process.argv[1]);if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o022))process.exit(1)' "$base"
    export CDNN_BOOTSTRAP_LOCKED=1
    exec flock -n "$base/.deploy.lock" node "$script_dir/bootstrap.cjs" "$@"
    ;;
  --plan|--recovery-plan|--verify) exec node "$script_dir/bootstrap.cjs" "$@" ;;
  *) echo 'Use --plan, --apply, --recovery-plan, --recover or --verify; read BOOTSTRAP.md' >&2; exit 1 ;;
esac
