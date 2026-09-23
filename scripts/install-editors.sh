#!/usr/bin/env bash
# Installs the local .vsix into every VS Code-compatible editor found on this machine.
set -euo pipefail
vsix="${1:-$(ls -t dist/*.vsix | head -1)}"
declare -a bins=(
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"
)
for bin in "${bins[@]}"; do
  if command -v "$bin" >/dev/null 2>&1 || [ -x "$bin" ]; then
    echo "== $bin"
    "$bin" --install-extension "$vsix" --force
    "$bin" --list-extensions --show-versions | grep -i vertra || true
  else
    echo "== $bin: not found"
  fi
done
