#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/.data"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$DATA_DIR/agent-relay.pid"
LOG_FILE="$LOG_DIR/agent-relay.log"
STOP_TIMEOUT_SECONDS=20

usage() {
  cat <<USAGE
usage: $(basename "$0") <start|stop|restart|status|clean-data|clean>
USAGE
}

ensure_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is not available on PATH" >&2
    exit 1
  fi
}

read_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(<"$PID_FILE")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "invalid PID file: $PID_FILE" >&2
    return 1
  fi

  printf '%s\n' "$pid"
}

pid_is_alive() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

pid_matches_relay() {
  local pid="$1"
  local command_line cwd

  if [[ -r "/proc/$pid/cmdline" ]]; then
    command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$ROOT_DIR" && "$command_line" == *"bun"* && "$command_line" == *"src/main.ts"* ]]
    return
  fi

  command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$command_line" == *"bun"* && "$command_line" == *"src/main.ts"* ]]
}

current_relay_pid() {
  local pid
  if ! pid="$(read_pid)"; then
    return 1
  fi

  if ! pid_is_alive "$pid"; then
    rm -f "$PID_FILE"
    return 1
  fi

  if ! pid_matches_relay "$pid"; then
    echo "PID $pid is running but does not look like this relay process; refusing to manage it" >&2
    exit 1
  fi

  printf '%s\n' "$pid"
}

start() {
  ensure_bun
  mkdir -p "$DATA_DIR" "$LOG_DIR"

  local pid
  if pid="$(current_relay_pid)"; then
    echo "agent-relay is already running (pid $pid)"
    return
  fi

  (
    cd "$ROOT_DIR"
    nohup bun src/main.ts >>"$LOG_FILE" 2>&1 &
    printf '%s\n' "$!" >"$PID_FILE"
  )

  pid="$(<"$PID_FILE")"
  sleep 1
  if ! pid_is_alive "$pid"; then
    rm -f "$PID_FILE"
    echo "agent-relay failed to start; see $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    exit 1
  fi

  echo "agent-relay started (pid $pid)"
  echo "log: $LOG_FILE"
}

stop() {
  local pid
  if ! pid="$(current_relay_pid)"; then
    echo "agent-relay is not running"
    return
  fi

  echo "stopping agent-relay (pid $pid)"
  kill -TERM "$pid"

  local elapsed=0
  while pid_is_alive "$pid"; do
    if (( elapsed >= STOP_TIMEOUT_SECONDS )); then
      echo "agent-relay did not stop after ${STOP_TIMEOUT_SECONDS}s; sending SIGKILL" >&2
      kill -KILL "$pid" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  rm -f "$PID_FILE"
  echo "agent-relay stopped"
}

status() {
  local pid
  if pid="$(current_relay_pid)"; then
    echo "agent-relay is running (pid $pid)"
  else
    echo "agent-relay is stopped"
  fi
}

clean_data() {
  local pid
  if pid="$(current_relay_pid)"; then
    echo "agent-relay is running (pid $pid); stop it before cleaning data" >&2
    exit 1
  fi

  rm -rf "$DATA_DIR" "$LOG_DIR"
  echo "removed $DATA_DIR and $LOG_DIR"
}

command="${1:-}"
case "$command" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop
    start
    ;;
  status)
    status
    ;;
  clean-data | clean)
    clean_data
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
