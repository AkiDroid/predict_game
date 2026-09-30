#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"
deploy_cd
load_env
require_docker
require_password
require_site

root="$(repo_root)"
data="$root/data"
mkdir -p "$data/backups"
if [[ ! -w "$data" ]]; then
  echo "目录不可写: $data" >&2
  echo "可执行: sudo chown -R $(id -un):$(id -gn) \"$data\"" >&2
  exit 1
fi

if ! processed_ready "$data"; then
  require_raw_bars "$data"
fi

docker compose pull redis caddy
docker compose build

if ! processed_ready "$data"; then
  echo "正在由 1 分钟文本生成预处理行情，首次可能需要几分钟…"
  docker compose run --rm --no-deps app preprocess
fi

if ! processed_ready "$data"; then
  echo "预处理结束，但 data/processed 仍不完整。" >&2
  exit 1
fi

if ! docker compose up -d; then
  echo "启动失败。最近日志:" >&2
  docker compose ps >&2 || true
  docker compose logs --tail 80 app >&2 || true
  exit 1
fi

echo "等待应用载入行情（内存较小的机器可能要几分钟）…"
ready=0
for i in $(seq 1 90); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:5173/api/health').then(async (r)=>{const b=await r.json(); process.exit(r.ok&&b.ok?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if (( i % 5 == 0 )); then
    echo "  仍在启动…"
  fi
  sleep 4
done

docker compose ps
if [[ "$ready" != 1 ]]; then
  echo "应用尚未就绪。最近日志:" >&2
  docker compose logs --tail 80 app >&2
  exit 1
fi

if [[ "$SITE_ADDRESS" == ":80" ]]; then
  echo "应用已就绪。用浏览器打开 ${CORS_ORIGIN}"
else
  echo "应用已就绪。用浏览器打开 https://${SITE_ADDRESS}"
  echo "若证书还在申请，到 deploy 目录执行: docker compose logs caddy"
fi
