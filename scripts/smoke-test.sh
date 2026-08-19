#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm test
node --experimental-strip-types --check index.ts
node --experimental-strip-types --check handoff.ts
node --experimental-strip-types --check session-writer.ts
node -e 'JSON.parse(require("fs").readFileSync("schemas/agent-handoff-v1.schema.json","utf8")); console.log("Schema JSON: PASS")'

if grep -R "ctx\.ui\.confirm" index.ts >/dev/null; then
  echo "FAIL: runtime source still contains ctx.ui.confirm" >&2
  exit 1
fi
echo "No-confirm runtime check: PASS"

if ! grep -q 'withSession: async (replacementCtx)' index.ts; then
  echo "FAIL: switchSession withSession lifecycle guard missing" >&2
  exit 1
fi
echo "withSession lifecycle check: PASS"

if ! grep -q 'let mode: CleanupCommandOptions\["mode"\] = "handoff"' index.ts; then
  echo "FAIL: default mode is not handoff" >&2
  exit 1
fi
echo "Default handoff mode check: PASS"

if command -v pi >/dev/null 2>&1; then
  pi -e "$ROOT/index.ts" --list-models >/dev/null
  echo "Pi extension smoke test: PASS"
else
  echo "Pi CLI 未在 PATH 中；跳过真实 extension smoke test。"
fi
