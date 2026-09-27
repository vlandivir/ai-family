#!/bin/bash
# One-time host migration, run as root with the new unit and deploy script staged in /tmp.
set -euo pipefail
USER_NAME=ai-family
ROOT=/opt/ai-family-runtime
UNIT=/etc/systemd/system/ai-family-worker.service
OLD_UNIT=/root/ai-family-worker.service.pre-unprivileged
OLD_RELEASE="$(readlink -f /opt/ai-family-current)"

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/ai-family --shell /bin/bash "$USER_NAME"
fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 750 "$ROOT" "$ROOT/releases"
if [ ! -d "$ROOT/source/.git" ]; then
  cp -a /opt/ai-family "$ROOT/source"
fi
chown -R "$USER_NAME:$USER_NAME" "$ROOT/source" "$ROOT/releases"
COPIED_RELEASE="$ROOT/releases/$(basename "$OLD_RELEASE")"
if [ ! -d "$COPIED_RELEASE" ]; then
  cp -a "$OLD_RELEASE" "$COPIED_RELEASE"
fi
chown -R "$USER_NAME:$USER_NAME" "$COPIED_RELEASE"
ln -s "$COPIED_RELEASE" "$ROOT/current.bootstrap.$$"
mv -Tf "$ROOT/current.bootstrap.$$" "$ROOT/current"
chown -h "$USER_NAME:$USER_NAME" "$ROOT/current"

install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 /home/ai-family/.ssh
grep 'github-actions-ai-family-deploy' /root/.ssh/authorized_keys |
  sed 's#/usr/local/sbin/ai-family-deploy.sh#/home/ai-family/bin/ai-family-deploy.sh#' > /home/ai-family/.ssh/authorized_keys
chown "$USER_NAME:$USER_NAME" /home/ai-family/.ssh/authorized_keys
chmod 600 /home/ai-family/.ssh/authorized_keys
install -d -o "$USER_NAME" -g "$USER_NAME" -m 750 /home/ai-family/bin
install -o "$USER_NAME" -g "$USER_NAME" -m 755 /tmp/ai-family-deploy-new.sh /home/ai-family/bin/ai-family-deploy.sh

install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 /home/ai-family/.local /home/ai-family/.local/bin /home/ai-family/.local/share /home/ai-family/.local/share/cursor-agent /home/ai-family/.local/share/cursor-agent/versions
AGENT_TARGET="$(readlink -f /root/.local/bin/agent)"
AGENT_VERSION="$(basename "$(dirname "$AGENT_TARGET")")"
if [ ! -d "/home/ai-family/.local/share/cursor-agent/versions/$AGENT_VERSION" ]; then
  cp -a "$(dirname "$AGENT_TARGET")" "/home/ai-family/.local/share/cursor-agent/versions/$AGENT_VERSION"
fi
ln -sfn "/home/ai-family/.local/share/cursor-agent/versions/$AGENT_VERSION/cursor-agent" /home/ai-family/.local/bin/agent
chown -R "$USER_NAME:$USER_NAME" /home/ai-family/.local

install -o root -g "$USER_NAME" -m 640 /dev/null /etc/ai-family-deploy.env
grep -E '^(SUPABASE_URL|SUPABASE_ACCESS_TOKEN)=' /etc/ai-family.env > /etc/ai-family-deploy.env
if [ "$(wc -l < /etc/ai-family-deploy.env)" -ne 2 ]; then
  echo "Deployment credentials are incomplete" >&2
  exit 1
fi
cat > /etc/sudoers.d/ai-family-deploy <<'EOF'
ai-family ALL=(root) NOPASSWD: /usr/bin/systemctl stop ai-family-worker.service, /usr/bin/systemctl start ai-family-worker.service
EOF
chmod 440 /etc/sudoers.d/ai-family-deploy
visudo -cf /etc/sudoers.d/ai-family-deploy
runuser -u "$USER_NAME" -- /home/ai-family/.local/bin/agent --version

if [ ! -f "$OLD_UNIT" ]; then
  cp -p "$UNIT" "$OLD_UNIT"
fi
ROLLED_OVER=0
rollback() {
  if [ "$ROLLED_OVER" -eq 1 ]; then
    cp -p "$OLD_UNIT" "$UNIT"
    systemctl daemon-reload
    systemctl start ai-family-worker.service
  fi
}
trap rollback ERR
systemctl stop ai-family-worker.service
ROLLED_OVER=1
if [ ! -d /home/ai-family/.cursor ]; then
  cp -a /root/.cursor /home/ai-family/.cursor
else
  cp -au /root/.cursor/. /home/ai-family/.cursor/
fi
chown -R "$USER_NAME:$USER_NAME" /home/ai-family/.cursor /var/lib/ai-family
install -o "$USER_NAME" -g "$USER_NAME" -m 600 /dev/null "$ROOT/deploy.log"
install -o "$USER_NAME" -g "$USER_NAME" -m 600 /dev/null "$ROOT/deploy.lock"
install -m 644 /tmp/ai-family-worker-new.service "$UNIT"
systemctl daemon-reload
systemctl start ai-family-worker.service
sleep 5
systemctl is-active --quiet ai-family-worker.service
test "$(systemctl show ai-family-worker.service --value -p User)" = "$USER_NAME"
ROLLED_OVER=0
trap - ERR
echo "Worker and deploy account switched to $USER_NAME"
