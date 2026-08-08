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

echo "== Phase A front: @n8n/permissions verified tests =="
# Expand this list as items A2..A6 land; today only the catalog+types are green.
pnpm --filter @n8n/permissions exec vitest run \
  src/__tests__/scope-information.test.ts \
  src/__tests__/types.test.ts >/dev/null 2>&1 \
  && echo "  ok (catalog+types)" || { echo "  FAIL: permissions catalog/types tests"; FAIL=1; }

# TODO(A12): once green, add:  pnpm build && node <boot smoke>
echo "== result =="
[ "$FAIL" = "0" ] && echo "SMOKE OK" || echo "SMOKE FAILED"
exit $FAIL
