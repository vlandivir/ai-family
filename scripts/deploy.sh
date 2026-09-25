#!/bin/bash
# Вызывается с сервера по отдельному ключу GitHub Actions.
set -euo pipefail
LOG=/var/log/ai-family-deploy.log
exec >>"$LOG" 2>&1
echo "=== $(date -Is) deploy ==="
cd /opt/ai-family
git fetch origin main
git reset --hard origin/main
install -m 755 scripts/deploy.sh /usr/local/sbin/ai-family-deploy.sh
if [ -f scripts/install-agent-config.sh ]; then
  bash scripts/install-agent-config.sh
fi
install -m 644 worker/ai-family-worker.service /etc/systemd/system/ai-family-worker.service
systemctl daemon-reload
systemctl restart ai-family-worker
systemctl is-active ai-family-worker
echo "=== $(date -Is) done ==="
