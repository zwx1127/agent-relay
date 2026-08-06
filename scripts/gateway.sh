#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:-}"

usage() {
  echo "usage: $(basename "$0") <setup|start|stop|status|remove>"
}

case "$COMMAND" in
  setup | start | stop | status | remove)
    ;;
  help | -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not available on PATH" >&2
  exit 1
fi

cd "$ROOT_DIR"
exec bun src/gateway/manage.ts "$COMMAND"
