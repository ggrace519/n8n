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
  && echo "  ok (110 tests)" || { echo "  FAIL: permissions tests"; FAIL=1; }

echo "== Phase A: @n8n/db is de-forked (0 .ee refs) + builds =="
n_db=$(grep -rlE "\.ee['\"]" packages/@n8n/db/src 2>/dev/null | wc -l | tr -d ' ')
if [ "$n_db" != "0" ]; then echo "  FAIL: $n_db .ee refs in @n8n/db/src"; FAIL=1; else echo "  ok (0 .ee refs)"; fi
pnpm --filter @n8n/db build >/dev/null 2>&1 \
  && echo "  ok (db build)" || { echo "  FAIL: @n8n/db build"; FAIL=1; }

echo "== Phase A10: packages/cli builds (all four steps) =="
pnpm --filter n8n... build >/dev/null 2>&1 \
  && echo "  ok (cli build)" || { echo "  FAIL: cli build"; FAIL=1; }

# TODO(A12): once app green, add:  pnpm build && node <boot smoke>
echo "== result =="
[ "$FAIL" = "0" ] && echo "SMOKE OK" || echo "SMOKE FAILED"
exit $FAIL
