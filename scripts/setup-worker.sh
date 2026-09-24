#!/bin/bash
# Повторяемая подготовка хоста воркера: пакеты, Node.js 22, Cursor CLI.
# Секреты не хранит. CURSOR_API_KEY, если он есть в окружении, только проверяется.
set -euo pipefail

LOG=/var/log/ai-family-setup.log
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

echo "=== $(date -Is) setup-worker ==="

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git

need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p "process.versions.node.split('.')[0]")
  minor=$(node -p "process.versions.node.split('.')[1]")
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then
    need_node=0
  fi
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node -v)"

if ! command -v agent >/dev/null 2>&1; then
  curl -fsSL https://cursor.com/install | bash
fi
# Официальный установщик кладёт бинарник в ~/.local/bin.
export PATH="$HOME/.local/bin:$PATH"
echo "agent $(agent --version)"

if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "CURSOR_API_KEY не задан, пробный запуск пропущен"
else
  agent -p "Reply with exactly: ok"
fi

echo "=== $(date -Is) done ==="
