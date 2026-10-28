# shellcheck shell=bash
# Step 7: the key that encrypts secrets in the panel DB, and the one-time
# setup token. Only the token's hash is stored; the installer prints it once.

SECRET_KEY=/etc/layer/secret.key
SETUP_TOKEN_FILE=/etc/layer/setup-token
SETUP_TOKEN_HOURS=24
PANEL_DB=/var/lib/layer/panel.db

setup_secrets() {
  step "Creating secrets"
  if [[ ! -s "$SECRET_KEY" ]]; then
    install -m 640 -o root -g "$LAYER_USER" /dev/null "$SECRET_KEY"
    head -c 32 /dev/urandom | base64 >"$SECRET_KEY"
    ok "Encryption key in $SECRET_KEY"
  else
    ok "Encryption key already in $SECRET_KEY"
  fi

  LAYER_SETUP_TOKEN=""
  if panel_has_admin; then
    rm -f "$SETUP_TOKEN_FILE"
    ok "Admin account exists: no setup token needed"
    return
  fi
  # A fresh token on every run until setup is done, so a lost one is easy to replace.
  LAYER_SETUP_TOKEN="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
  local hash expires
  hash="$(printf '%s' "$LAYER_SETUP_TOKEN" | sha256sum | cut -d' ' -f1)"
  expires=$(($(date +%s) + SETUP_TOKEN_HOURS * 3600))
  install -m 640 -o root -g "$LAYER_USER" /dev/null "$SETUP_TOKEN_FILE"
  printf 'sha256:%s %s\n' "$hash" "$expires" >"$SETUP_TOKEN_FILE"
  ok "One-time setup token created (valid ${SETUP_TOKEN_HOURS}h)"
}

panel_has_admin() {
  [[ -f "$PANEL_DB" ]] || return 1
  local count
  count="$(sqlite3 -readonly "$PANEL_DB" "SELECT COUNT(*) FROM users" 2>/dev/null || echo 0)"
  ((count > 0))
}
