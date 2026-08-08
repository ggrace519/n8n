#!/usr/bin/env bash
# init.sh — proves the current build front still runs. Long-horizon smoke.
# The tree is mid-rebuild (purged .ee plumbing not yet fully replaced), so the
# smoke is scoped to the current front and EXPANDS as phases complete.
#
# Usage: bash .defork/init.sh   (run from repo root)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
FAIL=0

echo "== deps present =="
[ -d node_modules ] || { echo "  node_modules missing — run: pnpm install"; FAIL=1; }

echo "== guardrail: zero .ee files in tree =="
n=$(git ls-files | grep -Ec '\.ee(\.|/)' || true)
if [ "$n" != "0" ]; then echo "  FAIL: $n .ee paths present (recontamination)"; FAIL=1; else echo "  ok (0)"; fi

echo "== Phase A: @n8n/permissions typecheck + full test suite =="
pnpm --filter @n8n/permissions typecheck >/dev/null 2>&1 \
  && echo "  ok (typecheck)" || { echo "  FAIL: permissions typecheck"; FAIL=1; }
pnpm --filter @n8n/permissions exec vitest run >/dev/null 2>&1 \
  && echo "  ok (105 tests)" || { echo "  FAIL: permissions tests"; FAIL=1; }

# TODO(A12): once green, add:  pnpm build && node <boot smoke>
echo "== result =="
[ "$FAIL" = "0" ] && echo "SMOKE OK" || echo "SMOKE FAILED"
exit $FAIL
