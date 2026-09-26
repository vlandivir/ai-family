#!/bin/bash
# Вызывается с сервера по отдельному ключу GitHub Actions.
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
cd /opt/ai-family
git fetch origin main
LATEST_SHA="$(git rev-parse origin/main)"
if [ "$DEPLOY_SHA" != "$LATEST_SHA" ]; then
  echo "Skipping superseded commit $DEPLOY_SHA; main is $LATEST_SHA"
  exit 0
fi
LOG=/var/log/ai-family-deploy.log
exec 3>&1
exec >>"$LOG" 2>&1
trap 'echo "Deploy $DEPLOY_SHA failed; see $LOG" >&3' ERR
echo "=== $(date -Is) deploy $DEPLOY_SHA ==="
git cat-file -e "${DEPLOY_SHA}^{commit}"
git reset --hard "$DEPLOY_SHA"
npm ci --prefix worker --omit=dev --ignore-scripts
node --input-type=module -e "await import('./worker/src/storage.js')"
install -m 755 scripts/deploy.sh /usr/local/sbin/ai-family-deploy.sh
if [ -f scripts/install-agent-config.sh ]; then
  bash scripts/install-agent-config.sh
fi
install -m 644 worker/ai-family-worker.service /etc/systemd/system/ai-family-worker.service
systemctl daemon-reload
systemctl restart ai-family-worker
sleep 5
if ! systemctl is-active --quiet ai-family-worker; then
  echo "Worker failed to stay active after $DEPLOY_SHA; see $LOG" >&3
  journalctl -u ai-family-worker -n 30 --no-pager
  exit 1
fi
systemctl show ai-family-worker -p MainPID -p ActiveEnterTimestamp
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"
echo "=== $(date -Is) done ==="
echo "Deployed $DEPLOY_SHA" >&3
