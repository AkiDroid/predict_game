#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法: ./deploy/restore.sh data/backups/app-YYYYMMDD-HHMMSS.sqlite" >&2
  exit 1
fi
if [[ ! -f "$1" ]]; then
  echo "找不到备份文件: $1" >&2
  exit 1
fi
src="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

source "$(dirname "$0")/common.sh"
deploy_cd
load_env
require_docker
require_password

root="$(repo_root)"
case "$src" in
  "$root"/data/backups/*.sqlite) ;;
  *)
    echo "只恢复 $root/data/backups/ 里的 .sqlite 备份。" >&2
    exit 1
    ;;
esac

stamp="$(date +%Y%m%d-%H%M%S)"
echo "停止应用，保留当前库为 data/backups/app-before-restore-${stamp}.sqlite，再恢复:"
echo "  $src"

docker compose up -d redis
docker compose stop app
if [[ -f "$root/data/app.sqlite" ]]; then
  mv "$root/data/app.sqlite" "$root/data/backups/app-before-restore-${stamp}.sqlite"
fi
rm -f "$root/data/app.sqlite-wal" "$root/data/app.sqlite-shm"
cp "$src" "$root/data/app.sqlite"
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHDB >/dev/null
docker compose up -d
echo "已恢复。登录态已清除，需要重新登录。"
