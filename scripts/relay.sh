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

pid_is_alive() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

command_line_matches_relay() {
  local command_line="$1"
  [[ "$command_line" == *"bun"* && ( "$command_line" == *"src/main.ts"* || "$command_line" == *"run start"* ) ]]
}

proc_entry_matches_relay() {
  local proc="$1"
  local argv=() arg executable exe_path exe_name
  [[ -r "$proc/cmdline" ]] || return 1
  while IFS= read -r -d '' arg; do
    argv+=("$arg")
  done <"$proc/cmdline" 2>/dev/null

  if (( ${#argv[@]} == 0 )); then
    return 1
  fi

  executable="${argv[0]##*/}"
  [[ "$executable" == "bun" ]] || return 1
  exe_path="$(readlink "$proc/exe" 2>/dev/null || true)"
  exe_name="${exe_path##*/}"
  [[ "$exe_name" == "bun" ]] || return 1

  if [[ "${argv[1]:-}" == "src/main.ts" || "${argv[1]:-}" == */src/main.ts ]]; then
    return 0
  fi

  if [[ "${argv[1]:-}" == "--watch" && ( "${argv[2]:-}" == "src/main.ts" || "${argv[2]:-}" == */src/main.ts ) ]]; then
    return 0
  fi

  [[ "${argv[1]:-}" == "run" && "${argv[2]:-}" == "start" ]]
}

pid_matches_relay() {
  local pid="$1"
  local command_line cwd

  if [[ -r "/proc/$pid/cmdline" ]]; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$ROOT_DIR" ]] && proc_entry_matches_relay "/proc/$pid"
    return
  fi

  command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  command_line_matches_relay "$command_line"
}

discover_relay_pids() {
  local proc pid cwd
  if [[ ! -d /proc ]]; then
    return
  fi

  for proc in /proc/[0-9]*; do
    [[ -d "$proc" && -r "$proc/cmdline" ]] || continue
    pid="${proc##*/}"
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$ROOT_DIR" ]] || continue
    if proc_entry_matches_relay "$proc"; then
      printf '%s\n' "$pid"
    fi
  done
}

discover_relay_pid() {
  local pids=() pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(discover_relay_pids)

  case "${#pids[@]}" in
    0)
      return 1
      ;;
    1)
      printf '%s\n' "${pids[0]}"
      ;;
    *)
      echo "multiple agent-relay processes found (${pids[*]}); refusing to manage them" >&2
      return 2
      ;;
  esac
}

current_relay_pid() {
  local pid
  if [[ -f "$PID_FILE" ]]; then
    pid="$(<"$PID_FILE")"
    if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
      echo "invalid PID file: $PID_FILE" >&2
      return 2
    fi

    if ! pid_is_alive "$pid"; then
      rm -f "$PID_FILE"
    elif ! pid_matches_relay "$pid"; then
      echo "PID $pid is running but does not look like this relay process; refusing to manage it" >&2
      return 2
    else
      printf '%s\n' "$pid"
      return
    fi
  fi

  discover_relay_pid
}

start() {
  ensure_bun
  mkdir -p "$DATA_DIR" "$LOG_DIR"

  local pid status=0
  pid="$(current_relay_pid)" || status=$?
  if (( status == 0 )); then
    echo "agent-relay is already running (pid $pid)"
    return
  elif (( status != 1 )); then
    exit 1
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
  local pid status=0
  pid="$(current_relay_pid)" || status=$?
  if (( status == 1 )); then
    echo "agent-relay is not running"
    return
  elif (( status != 0 )); then
    exit 1
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

pid_is_ancestor() {
  local target="$1"
  local pid="$$"
  local parent

  while [[ "$pid" =~ ^[0-9]+$ && "$pid" != "0" ]]; do
    if [[ "$pid" == "$target" ]]; then
      return 0
    fi
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$parent" =~ ^[0-9]+$ && "$parent" != "$pid" ]] || return 1
    pid="$parent"
  done

  return 1
}

schedule_restart() {
  local pid="$1"
  mkdir -p "$DATA_DIR" "$LOG_DIR"
  if command -v setsid >/dev/null 2>&1; then
    (
      cd "$ROOT_DIR"
      setsid -f "$ROOT_DIR/scripts/relay.sh" __restart-worker </dev/null >>"$LOG_FILE" 2>&1
    )
  else
    (
      cd "$ROOT_DIR"
      nohup "$ROOT_DIR/scripts/relay.sh" __restart-worker </dev/null >>"$LOG_FILE" 2>&1 &
    )
  fi
  echo "agent-relay restart scheduled (pid $pid)"
  echo "log: $LOG_FILE"
}

restart_worker() {
  sleep 1
  restart_sequence
}

restart_sequence() {
  stop
  clean_data
  start
}

restart() {
  local pid status=0
  pid="$(current_relay_pid)" || status=$?
  if (( status == 0 )) && pid_is_ancestor "$pid"; then
    schedule_restart "$pid"
    return
  elif (( status != 0 && status != 1 )); then
    exit 1
  fi

  restart_sequence
}

status() {
  local pid status=0
  pid="$(current_relay_pid)" || status=$?
  if (( status == 0 )); then
    echo "agent-relay is running (pid $pid)"
  elif (( status == 1 )); then
    echo "agent-relay is stopped"
  else
    exit 1
  fi
}

clean_data() {
  local pid status=0
  pid="$(current_relay_pid)" || status=$?
  if (( status == 0 )); then
    echo "agent-relay is running (pid $pid); stop it before cleaning data" >&2
    exit 1
  elif (( status != 1 )); then
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
    restart
    ;;
  __restart-worker)
    restart_worker
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
