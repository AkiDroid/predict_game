#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"
deploy_cd
load_env
require_docker

root="$(repo_root)"
mkdir -p "$root/data/backups"
stamp="$(date +%Y%m%d-%H%M%S)"
dest="/app/data/backups/app-${stamp}.sqlite"

docker compose exec -T -e "BACKUP_DEST=${dest}" app node /app/backup.mjs
echo "已写入 $root/data/backups/app-${stamp}.sqlite"
echo "会话在 Redis 里，这份文件不含登录态。恢复后需要重新登录。"
