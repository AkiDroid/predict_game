#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"
deploy_cd
load_env
require_docker
require_password

root="$(repo_root)"
require_raw_bars "$root/data"

echo "重新生成 data/processed。应用会在结束后重启以载入新行情。"
docker compose build app
docker compose run --rm --no-deps app preprocess
docker compose up -d --force-recreate app
echo "预处理完成。"
