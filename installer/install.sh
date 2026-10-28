#!/usr/bin/env bash
# Self Host Layer installer.
#   curl -fsSL https://get.selfhostlayer.com | bash
#
# In the repo this file sources installer/lib/*.sh. scripts/build-installer.sh
# inlines those files to produce the single-file dist/install.sh that users run.
# Everything is a function definition until the last line, so a download that
# gets cut off runs nothing.
set -Eeuo pipefail

LAYER_VERSION="${LAYER_VERSION:-dev}"

# @layer-inline-libs
if [[ -z "${LAYER_BUNDLED:-}" ]]; then
  for lib in "$(dirname "${BASH_SOURCE[0]}")"/lib/*.sh; do
    # shellcheck source=/dev/null
    source "$lib"
  done
fi

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --domain <name>         Serve the panel on this domain instead of <ip>.sslip.io
  --email <address>       Contact email for TLS certificates
  --from-tarball <path>   Install the panel from a local release tarball (development)
  --no-harden-ssh         Leave SSH settings alone
  --yes                   Answer yes to every prompt
  -h, --help              Show this help
EOF
}

parse_args() {
  LAYER_DOMAIN="" LAYER_EMAIL="" LAYER_TARBALL="" LAYER_HARDEN_SSH=1 LAYER_YES=0
  while (($# > 0)); do
    case "$1" in
      --domain) LAYER_DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
      --email) LAYER_EMAIL="${2:?--email needs a value}"; shift 2 ;;
      --from-tarball) LAYER_TARBALL="${2:?--from-tarball needs a path}"; shift 2 ;;
      --no-harden-ssh) LAYER_HARDEN_SSH=0; shift ;;
      --yes) LAYER_YES=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
  if [[ -n "$LAYER_TARBALL" && ! -f "$LAYER_TARBALL" ]]; then
    die "tarball not found: $LAYER_TARBALL"
  fi
  export LAYER_DOMAIN LAYER_EMAIL LAYER_TARBALL LAYER_HARDEN_SSH LAYER_YES
}

main() {
  parse_args "$@"
  mkdir -p "$(dirname "$LAYER_LOG")"
  log "--- Self Host Layer $LAYER_VERSION install started $(date -u +%FT%TZ)"
  printf '\n%sSelf Host Layer%s %s\n\n' "$C_BOLD" "$C_RESET" "$LAYER_VERSION"

  preflight
  # Day 2: packages, swap, node, users, firewall, ssh hardening
  # Day 5: panel + agent, secrets, caddy, services, finish
  info "Preflight passed. The remaining install steps arrive later in Week 1."
}

main "$@"
