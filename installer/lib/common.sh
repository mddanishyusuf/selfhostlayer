# shellcheck shell=bash
# Shared helpers. Function definitions only: nothing runs until main().

LAYER_LOG="${LAYER_LOG:-/var/log/layer-install.log}"

if [[ -t 1 ]]; then
  C_DIM=$'\e[2m' C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_BOLD=$'\e[1m' C_RESET=$'\e[0m'
else
  C_DIM="" C_RED="" C_GREEN="" C_BOLD="" C_RESET=""
fi

log() {
  printf '%s\n' "$*" 2>/dev/null >>"$LAYER_LOG" || true
}

step() {
  printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"
  log "==> $*"
}

info() {
  printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"
  log "    $*"
}

ok() {
  printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"
  log "    ok: $*"
}

die() {
  printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  log "error: $*"
  exit 1
}

# Runs a command with its output going only to the log file.
run() {
  log "+ $*"
  "$@" >>"$LAYER_LOG" 2>&1 || die "command failed: $* (see $LAYER_LOG)"
}

confirm() {
  local prompt="$1"
  if [[ "${LAYER_YES:-0}" == 1 ]]; then
    return 0
  fi
  # /dev/tty can exist and look readable but fail to open when there's no
  # controlling terminal (CI, cloud-init, ssh without -t). Treat that as "no".
  { exec 3</dev/tty; } 2>/dev/null || return 1
  local answer=""
  read -r -u 3 -p "    $prompt [y/N] " answer || true
  exec 3<&-
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}
