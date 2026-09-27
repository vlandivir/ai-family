#!/bin/bash
# Forced command for the dedicated ai-family SSH deployment key.
set -euo pipefail
if [[ ! "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy[[:space:]]([0-9a-f]{40})$ ]]; then
  echo "Expected: deploy <40-character commit SHA>" >&2
  exit 64
fi
DEPLOY_SHA="${BASH_REMATCH[1]}"
ROOT=/opt/ai-family-runtime
exec 9>"$ROOT/deploy.lock"
if ! flock -w 600 9; then
  echo "Another deployment is still running" >&2
  exit 75
fi

SOURCE="$ROOT/source"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
UNIT=/etc/systemd/system/ai-family-worker.service
SCRIPT="$HOME/bin/ai-family-deploy.sh"
cd "$SOURCE"
git fetch origin main
LATEST_SHA="$(git rev-parse origin/main)"
if [ "$DEPLOY_SHA" != "$LATEST_SHA" ]; then
  echo "Skipping superseded commit $DEPLOY_SHA; main is $LATEST_SHA"
  exit 0
fi

LOG="$ROOT/deploy.log"
exec 3>&1
exec >>"$LOG" 2>&1
echo "=== $(date -Is) deploy $DEPLOY_SHA ==="
STAGING=""
ACTIVATED=0
CONFIG_BACKUP="$(mktemp -d "$ROOT/.config-backup.XXXXXX")"
CONFIG_DEST="${CURSOR_HOME:-$HOME/.cursor}"
CONFIG_CHANGED=0
for file in mcp.json cli-config.json; do
  if [ -f "$CONFIG_DEST/$file" ]; then
    cp -p "$CONFIG_DEST/$file" "$CONFIG_BACKUP/$file"
  fi
done
OLD_TARGET="$(readlink -f "$CURRENT")"

switch_release() {
  local next="$CURRENT.next.$$"
  ln -s "$1" "$next"
  mv -Tf "$next" "$CURRENT"
}

healthy_worker() {
  local first_pid first_restarts
  systemctl is-active --quiet ai-family-worker.service || return 1
  first_pid="$(systemctl show ai-family-worker.service --value -p MainPID)"
  first_restarts="$(systemctl show ai-family-worker.service --value -p NRestarts)"
  [ "$first_pid" -gt 0 ] || return 1
  sleep 5
  systemctl is-active --quiet ai-family-worker.service || return 1
  [ "$(systemctl show ai-family-worker.service --value -p MainPID)" = "$first_pid" ] &&
    [ "$(systemctl show ai-family-worker.service --value -p NRestarts)" = "$first_restarts" ]
}

cleanup() {
  if [[ "$STAGING" == "$RELEASES"/.staging.* ]]; then
    rm -rf -- "$STAGING"
  fi
  if [[ "$CONFIG_BACKUP" == "$ROOT"/.config-backup.* ]]; then
    rm -rf -- "$CONFIG_BACKUP"
  fi
}

rollback() {
  local code="$1"
  trap - ERR
  set +e
  if [ "$CONFIG_CHANGED" -eq 1 ]; then
    for file in mcp.json cli-config.json; do
      if [ -f "$CONFIG_BACKUP/$file" ]; then
        cp -p "$CONFIG_BACKUP/$file" "$CONFIG_DEST/$file"
      else
        rm -f -- "$CONFIG_DEST/$file"
      fi
    done
  fi
  if [ "$ACTIVATED" -eq 1 ]; then
    echo "Rolling back to $OLD_TARGET"
    sudo -n /usr/bin/systemctl stop ai-family-worker.service
    switch_release "$OLD_TARGET"
    sudo -n /usr/bin/systemctl start ai-family-worker.service
    healthy_worker && echo "Previous worker restored"
  fi
  echo "Deploy $DEPLOY_SHA failed; see $LOG" >&3
  exit "$code"
}
trap cleanup EXIT
trap 'rollback $?' ERR

RELEASE="$RELEASES/$DEPLOY_SHA"
mkdir -p "$RELEASES"
if [ ! -d "$RELEASE" ]; then
  STAGING="$(mktemp -d "$RELEASES/.staging.XXXXXX")"
  git archive "$DEPLOY_SHA" | tar -x -C "$STAGING"
  npm ci --prefix "$STAGING/worker" --omit=dev --ignore-scripts
  (cd "$STAGING" && node --input-type=module -e "await import('./worker/src/storage.js')")
  mv "$STAGING" "$RELEASE"
  STAGING=""
fi

if ! cmp -s "$RELEASE/worker/ai-family-worker.service" "$UNIT"; then
  echo "Worker unit changed; an administrator must review and install it first" >&2
  false
fi
node --env-file=/etc/ai-family-deploy.env "$RELEASE/scripts/apply-migrations.mjs" "$RELEASE/supabase/migrations"

if [ "$OLD_TARGET" = "$RELEASE" ] && systemctl is-active --quiet ai-family-worker.service &&
  cmp -s "$RELEASE/scripts/deploy.sh" "$SCRIPT"; then
  echo "Already deployed $DEPLOY_SHA" >&3
  exit 0
fi

if [ -f "$RELEASE/scripts/install-agent-config.sh" ]; then
  CONFIG_CHANGED=1
  bash "$RELEASE/scripts/install-agent-config.sh"
fi
ACTIVATED=1
sudo -n /usr/bin/systemctl stop ai-family-worker.service
switch_release "$RELEASE"
sudo -n /usr/bin/systemctl start ai-family-worker.service
if ! healthy_worker; then
  journalctl -u ai-family-worker.service -n 30 --no-pager
  false
fi
systemctl show ai-family-worker.service -p MainPID -p ActiveEnterTimestamp
install -m 755 "$RELEASE/scripts/deploy.sh" "$SCRIPT"
echo "=== $(date -Is) done ==="
echo "Deployed $DEPLOY_SHA" >&3
