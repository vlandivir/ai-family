#!/bin/bash
# Кладёт настройки агента из репозитория в домашний каталог root на хосте.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${CURSOR_HOME:-/root/.cursor}"
mkdir -p "$DEST"
install -m 600 "$ROOT/worker/config/mcp.json" "$DEST/mcp.json"

python3 - "$ROOT/worker/config/cli-permissions.json" "$DEST/cli-config.json" << 'PY'
import json, sys
from pathlib import Path
src = json.loads(Path(sys.argv[1]).read_text())
dest_path = Path(sys.argv[2])
dest = json.loads(dest_path.read_text()) if dest_path.exists() else {"version": 1}
dest["approvalMode"] = src["approvalMode"]
dest["autoAcceptWebSearch"] = src["autoAcceptWebSearch"]
dest["permissions"] = src["permissions"]
dest_path.write_text(json.dumps(dest, indent=2) + "\n")
dest_path.chmod(0o600)
PY

echo "agent config installed in $DEST"
