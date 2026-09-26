#!/bin/bash
# Вызывается ограниченным SSH-ключом GitHub Actions.
set -euo pipefail
if [[ ! "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy[[:space:]]([0-9a-f]{40})$ ]]; then
  echo "Expected: deploy <40-character commit SHA>" >&2
  exit 64
fi
DEPLOY_SHA="${BASH_REMATCH[1]}"
exec 9>/run/lock/ai-family-deploy.lock
if ! flock -w 600 9; then
  echo "Another deployment is still running" >&2
  exit 75
fi

SOURCE=/opt/ai-family
RELEASES=/opt/ai-family-releases
CURRENT=/opt/ai-family-current
UNIT=/etc/systemd/system/ai-family-worker.service
cd "$SOURCE"
git fetch origin main
LATEST_SHA="$(git rev-parse origin/main)"
if [ "$DEPLOY_SHA" != "$LATEST_SHA" ]; then
  echo "Skipping superseded commit $DEPLOY_SHA; main is $LATEST_SHA"
  exit 0
fi

LOG=/var/log/ai-family-deploy.log
exec 3>&1
exec >>"$LOG" 2>&1
echo "=== $(date -Is) deploy $DEPLOY_SHA ==="
STAGING=""
ACTIVATED=0
UNIT_BACKUP="$(mktemp /tmp/ai-family-worker.service.XXXXXX)"
cp "$UNIT" "$UNIT_BACKUP"
CONFIG_BACKUP="$(mktemp -d /tmp/ai-family-config.XXXXXX)"
CONFIG_DEST="${CURSOR_HOME:-/root/.cursor}"
CONFIG_CHANGED=0
for file in mcp.json cli-config.json; do
  if [ -f "$CONFIG_DEST/$file" ]; then
    cp -p "$CONFIG_DEST/$file" "$CONFIG_BACKUP/$file"
  fi
done
if [ -L "$CURRENT" ]; then
  OLD_TARGET="$(readlink -f "$CURRENT")"
else
  OLD_TARGET="$SOURCE"
fi

switch_release() {
  local next="$CURRENT.next.$$"
  ln -s "$1" "$next"
  mv -Tf "$next" "$CURRENT"
}

healthy_worker() {
  local first_pid first_restarts
  systemctl is-active --quiet ai-family-worker || return 1
  first_pid="$(systemctl show ai-family-worker --value -p MainPID)"
  first_restarts="$(systemctl show ai-family-worker --value -p NRestarts)"
  [ "$first_pid" -gt 0 ] || return 1
  sleep 5
  systemctl is-active --quiet ai-family-worker || return 1
  [ "$(systemctl show ai-family-worker --value -p MainPID)" = "$first_pid" ] &&
    [ "$(systemctl show ai-family-worker --value -p NRestarts)" = "$first_restarts" ]
}

cleanup() {
  if [[ "$STAGING" == "$RELEASES"/.staging.* ]]; then
    rm -rf -- "$STAGING"
  fi
  rm -f -- "$UNIT_BACKUP"
  if [[ "$CONFIG_BACKUP" == /tmp/ai-family-config.* ]]; then
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
    switch_release "$OLD_TARGET"
    install -m 644 "$UNIT_BACKUP" "$UNIT"
    systemctl daemon-reload
    systemctl restart ai-family-worker
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

if [ "$OLD_TARGET" = "$RELEASE" ] && systemctl is-active --quiet ai-family-worker; then
  echo "Already deployed $DEPLOY_SHA" >&3
  exit 0
fi

if [ -f "$RELEASE/scripts/install-agent-config.sh" ]; then
  CONFIG_CHANGED=1
  bash "$RELEASE/scripts/install-agent-config.sh"
fi
ACTIVATED=1
install -m 644 "$RELEASE/worker/ai-family-worker.service" "$UNIT"
systemctl daemon-reload
switch_release "$RELEASE"
systemctl restart ai-family-worker
if ! healthy_worker; then
  journalctl -u ai-family-worker -n 30 --no-pager
  false
fi
systemctl show ai-family-worker -p MainPID -p ActiveEnterTimestamp
install -m 755 "$RELEASE/scripts/deploy.sh" /usr/local/sbin/ai-family-deploy.sh
echo "=== $(date -Is) done ==="
echo "Deployed $DEPLOY_SHA" >&3
