# shellcheck shell=bash
# Step 12: tell the user where to go.

finish() {
  local url="https://$LAYER_PANEL_HOST"
  local bar="$C_GREEN│$C_RESET"
  printf '\n%s┌──────────────────────────────────────────────────────────────┐%s\n' "$C_GREEN" "$C_RESET"
  printf '%s  %sSelf Host Layer %s is ready%s\n' "$bar" "$C_BOLD" "$LAYER_INSTALLED_VERSION" "$C_RESET"
  printf '%s\n' "$bar"
  printf '%s  Open:         %s%s%s\n' "$bar" "$C_BOLD" "$url" "$C_RESET"
  if [[ -n "$LAYER_SETUP_TOKEN" ]]; then
    printf '%s  Setup token:  %s%s%s\n' "$bar" "$C_BOLD" "$LAYER_SETUP_TOKEN" "$C_RESET"
    printf '%s  %s(valid 24h, works once; re-run the installer for a new one)%s\n' "$bar" "$C_DIM" "$C_RESET"
  else
    printf '%s  Sign in with your admin account.\n' "$bar"
  fi
  printf '%s\n' "$bar"
  printf '%s  On the server: %slayer ps%s · %slayer info%s · %slayer logs <app> -f%s\n' "$bar" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf '%s└──────────────────────────────────────────────────────────────┘%s\n\n' "$C_GREEN" "$C_RESET"
  log "finished: $url (setup token printed: $([[ -n "$LAYER_SETUP_TOKEN" ]] && echo yes || echo no))"
  info "Full log: $LAYER_LOG"
}
