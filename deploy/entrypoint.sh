#!/bin/sh
set -eu

processed=/app/data/processed
required="ES/1m.bin ES/5m.bin ES/15m.bin ES/30m.bin ES/1h.bin ES/4h.bin ES/1d.bin NQ/1m.bin NQ/5m.bin NQ/15m.bin NQ/30m.bin NQ/1h.bin NQ/4h.bin NQ/1d.bin"

check_processed() {
  for rel in $required; do
    if [ ! -f "$processed/$rel" ]; then
      echo "缺少 $processed/$rel" >&2
      return 1
    fi
  done
  return 0
}

case "${1:-serve}" in
  preprocess)
    exec tsx /app/scripts/preprocess.ts
    ;;
  serve)
    if ! check_processed; then
      echo "预处理行情不完整。在服务器项目目录执行 ./deploy/preprocess.sh" >&2
      exit 1
    fi
    exec tsx /app/backend/src/server.ts
    ;;
  *)
    echo "未知命令: $1" >&2
    exit 1
    ;;
esac
