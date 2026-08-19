#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${1:-$HOME/.pi/agent/extensions/session-cleanup}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$(dirname "$DEST_DIR")"
if [[ -e "$DEST_DIR" ]]; then
  BACKUP="${DEST_DIR}.backup-${STAMP}"
  mv "$DEST_DIR" "$BACKUP"
  echo "旧版本已备份到: $BACKUP"
fi

mkdir -p "$DEST_DIR"
cp -R \
  "$SRC_DIR/index.ts" \
  "$SRC_DIR/core.ts" \
  "$SRC_DIR/textual.ts" \
  "$SRC_DIR/handoff.ts" \
  "$SRC_DIR/session-writer.ts" \
  "$SRC_DIR/standalone.ts" \
  "$SRC_DIR/test" \
  "$SRC_DIR/scripts" \
  "$SRC_DIR/references" \
  "$SRC_DIR/schemas" \
  "$SRC_DIR/README.md" \
  "$SRC_DIR/DESIGN.md" \
  "$SRC_DIR/VALIDATION.md" \
  "$SRC_DIR/CHANGELOG.md" \
  "$SRC_DIR/package.json" \
  "$SRC_DIR/.gitignore" \
  "$DEST_DIR/"
chmod -R go-rwx "$DEST_DIR"

echo "已安装到: $DEST_DIR"
echo "测试: cd '$DEST_DIR' && npm test"
echo "Pi smoke test: pi -e '$DEST_DIR/index.ts' --list-models"
echo "默认使用: /cleanup this"
echo "机械文本模式: /cleanup --textual this"
echo "知识胶囊模式: /cleanup --capsule this"
