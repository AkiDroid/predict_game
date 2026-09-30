#!/usr/bin/env bash

_DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

deploy_cd() {
  cd "$_DEPLOY_DIR"
}

repo_root() {
  (cd "$_DEPLOY_DIR/.." && pwd)
}

load_env() {
  if [[ ! -f .env ]]; then
    echo "缺少 ${_DEPLOY_DIR}/.env。先执行: cp ${_DEPLOY_DIR}/.env.example ${_DEPLOY_DIR}/.env" >&2
    exit 1
  fi
  if grep -q $'\r' .env; then
    tr -d '\r' < .env > .env.unix
    mv .env.unix .env
  fi
  chmod 600 .env
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  export HOST_UID="$(id -u)"
  export HOST_GID="$(id -g)"
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "需要 Docker Engine 和 Compose v2（命令是 docker compose，不是 docker-compose）。" >&2
    exit 1
  fi
}

require_password() {
  if [[ ! "${REDIS_PASSWORD:-}" =~ ^[A-Za-z0-9]{16,}$ ]]; then
    echo "REDIS_PASSWORD 需要至少 16 位字母或数字。可用: openssl rand -hex 24" >&2
    exit 1
  fi
}

require_site() {
  if [[ "${SITE_ADDRESS:-}" == ":80" ]]; then
    if [[ "${COOKIE_SECURE:-}" != "0" ]]; then
      echo "SITE_ADDRESS=:80 时，COOKIE_SECURE 必须为 0。" >&2
      exit 1
    fi
    if [[ "${CORS_ORIGIN:-}" != http://* ]]; then
      echo "纯 HTTP 部署时，CORS_ORIGIN 需要以 http:// 开头，例如 http://203.0.113.10" >&2
      exit 1
    fi
    return
  fi
  if [[ ! "${SITE_ADDRESS:-}" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "SITE_ADDRESS 填域名（如 play.example.com），或在只有 IP 时填 :80。" >&2
    exit 1
  fi
  if [[ "${COOKIE_SECURE:-}" != "1" ]]; then
    echo "使用域名时 COOKIE_SECURE 应为 1。" >&2
    exit 1
  fi
  if [[ "${CORS_ORIGIN:-}" != "https://${SITE_ADDRESS}" ]]; then
    echo "CORS_ORIGIN 应为 https://${SITE_ADDRESS}" >&2
    exit 1
  fi
  if [[ ! "${ACME_EMAIL:-}" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
    echo "使用域名时请设置有效的 ACME_EMAIL。" >&2
    exit 1
  fi
}

processed_ready() {
  local data="$1"
  local symbol tf
  for symbol in ES NQ; do
    for tf in 1m 5m 15m 30m 1h 4h 1d; do
      if [[ ! -f "$data/processed/$symbol/$tf.bin" ]]; then
        return 1
      fi
    done
  done
  return 0
}

require_raw_bars() {
  local data="$1"
  local symbol
  for symbol in ES NQ; do
    if [[ ! -f "$data/${symbol}_1min.txt" ]]; then
      echo "缺少 $data/${symbol}_1min.txt" >&2
      exit 1
    fi
  done
}
