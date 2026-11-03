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
  --internal-tls          Use Caddy's local CA instead of Let's Encrypt (test boxes)
  --apps-domain <name>    Free app URLs under this domain (default <ip-with-dashes>.sslip.io)
  --updates-url <url>     Release feed for one-click updates (default https://get.selfhostlayer.com/releases.json)
  --email <address>       Contact email for TLS certificates
  --from-tarball <path>   Install the panel from a local release tarball (development)
  --no-harden-ssh         Leave SSH settings alone
  --agent-only            A server another Self Host Layer panel deploys to: the agent, no panel
  --panel-key <key>       With --agent-only: the managing panel's SSH public key (ssh-ed25519 …)
  --yes                   Answer yes to every prompt
  -h, --help              Show this help
EOF
}

parse_args() {
  LAYER_DOMAIN="" LAYER_EMAIL="" LAYER_TARBALL="" LAYER_HARDEN_SSH=1 LAYER_YES=0 LAYER_INTERNAL_TLS=0 LAYER_APPS_DOMAIN="" LAYER_UPDATES_URL="" LAYER_AGENT_ONLY=0 LAYER_PANEL_KEY=""
  while (($# > 0)); do
    case "$1" in
      --domain) LAYER_DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
      --email) LAYER_EMAIL="${2:?--email needs a value}"; shift 2 ;;
      --from-tarball) LAYER_TARBALL="${2:?--from-tarball needs a path}"; shift 2 ;;
      --no-harden-ssh) LAYER_HARDEN_SSH=0; shift ;;
      --internal-tls) LAYER_INTERNAL_TLS=1; shift ;;
      --apps-domain) LAYER_APPS_DOMAIN="${2:?--apps-domain needs a value}"; shift 2 ;;
      --updates-url) LAYER_UPDATES_URL="${2:?--updates-url needs a value}"; shift 2 ;;
      --yes) LAYER_YES=1; shift ;;
      --agent-only) LAYER_AGENT_ONLY=1; shift ;;
      --panel-key) LAYER_PANEL_KEY="${2:?--panel-key needs a key}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
  if [[ -n "$LAYER_TARBALL" && ! -f "$LAYER_TARBALL" ]]; then
    die "tarball not found: $LAYER_TARBALL"
  fi
  if [[ -n "$LAYER_DOMAIN" && ! "$LAYER_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
    die "--domain must be a lowercase hostname like panel.example.com"
  fi
  if [[ -n "$LAYER_APPS_DOMAIN" && ! "$LAYER_APPS_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
    die "--apps-domain must be a lowercase domain like apps.example.com"
  fi
  if [[ -n "$LAYER_UPDATES_URL" && ! "$LAYER_UPDATES_URL" =~ ^(https://|http://127\.0\.0\.1[:/])[^[:space:]]+$ ]]; then
    die "--updates-url must be an https URL"
  fi
  # A re-run (a one-click update runs the installer without its flags) stays agent-only.
  if [[ -f /etc/layer/config.json ]] && [[ "$(jq -r '.agentOnly // false' /etc/layer/config.json 2>/dev/null)" == true ]]; then
    LAYER_AGENT_ONLY=1
  fi
  if [[ -n "$LAYER_PANEL_KEY" && ! "$LAYER_PANEL_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [A-Za-z0-9@._-]+)?$ ]]; then
    die "--panel-key must be an ssh-ed25519 public key"
  fi
  if [[ "$LAYER_AGENT_ONLY" == 1 && -n "$LAYER_DOMAIN" ]]; then
    die "--domain is for the panel's address; an agent-only server has no panel"
  fi
  export LAYER_DOMAIN LAYER_EMAIL LAYER_TARBALL LAYER_HARDEN_SSH LAYER_YES LAYER_INTERNAL_TLS LAYER_APPS_DOMAIN LAYER_UPDATES_URL LAYER_AGENT_ONLY LAYER_PANEL_KEY
}

on_error() {
  # set -E runs this trap in subshells too; only the main shell reports.
  [[ "$BASHPID" == "$$" ]] || exit 1
  die "failed at line $1: $2 (see $LAYER_LOG)"
}

main() {
  parse_args "$@"
  mkdir -p "$(dirname "$LAYER_LOG")"
  log "--- Self Host Layer $LAYER_VERSION install started $(date -u +%FT%TZ)"
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  printf '\n%sSelf Host Layer%s %s\n\n' "$C_BOLD" "$C_RESET" "$LAYER_VERSION"

  preflight
  # Swap first, so apt and the Node unpack have headroom on tiny boxes.
  setup_swap
  install_packages
  install_node
  setup_users
  setup_caddy
  install_release
  if [[ "$LAYER_AGENT_ONLY" == 1 ]]; then
    # A server another panel deploys to: the agent, and the panel's way in.
    start_agent
    LAYER_PANEL_HOST="" write_config
    setup_link
    setup_firewall
    harden_ssh
    finish_agent
    return
  fi
  setup_secrets
  start_services
  setup_panel_site
  setup_firewall
  harden_ssh
  finish
}

main "$@"
