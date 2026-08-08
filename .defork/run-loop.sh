#!/usr/bin/env bash
# run-loop.sh — drive the de-fork long-horizon loop locally.
#
# Each iteration runs the agent with a FRESH context on .defork/PROMPT.md (fresh
# context per iteration beats compaction for long runs). The loop stops when the
# agent emits the completion promise, when the iteration cap is hit, or on Ctrl-C.
#
# Prereqs: run from the repo root, on a clean working tree, deps installed
# (`pnpm install`). The agent must be allowed to edit/commit non-interactively.
#
# Usage:
#   bash .defork/run-loop.sh                 # use defaults (Claude Code headless)
#   MAX_ITERS=50 bash .defork/run-loop.sh    # override the cap for this run
#   AGENT_CMD='<your agent cli>' bash .defork/run-loop.sh   # use a different agent
#
# The agent command receives the prompt on stdin and must run one iteration
# non-interactively, with tools enabled. Default targets Claude Code:
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

PROMPT_FILE=".defork/PROMPT.md"
FEATURES=".defork/feature_list.json"
PROMISE="$(grep -oE '"completion_promise"\s*:\s*"[^"]+"' "$FEATURES" | sed -E 's/.*"([^"]+)"$/\1/')"
CAP="$(grep -oE '"iteration_cap"\s*:\s*[0-9]+' "$FEATURES" | grep -oE '[0-9]+')"
MAX_ITERS="${MAX_ITERS:-$CAP}"
LOG_DIR=".defork/loop-logs"
mkdir -p "$LOG_DIR"

# Default agent: Claude Code headless. `-p` = one non-interactive turn (fresh
# context). Permissions must be pre-granted for it to edit/commit unattended;
# `--permission-mode acceptEdits` accepts file edits. Adjust to your setup.
AGENT_CMD="${AGENT_CMD:-claude -p --permission-mode acceptEdits}"

echo "Loop: promise='$PROMISE' cap=$MAX_ITERS agent='$AGENT_CMD'"
[ -n "$PROMISE" ] || { echo "FATAL: no completion_promise in $FEATURES"; exit 2; }

for ((i=1; i<=MAX_ITERS; i++)); do
  ts="$(date +%Y%m%d-%H%M%S)"
  out="$LOG_DIR/iter-$(printf '%03d' "$i")-$ts.log"
  echo "=== iteration $i/$MAX_ITERS  ($ts) -> $out ==="

  # Fresh context each iteration: pipe the prompt in anew.
  if ! $AGENT_CMD < "$PROMPT_FILE" > "$out" 2>&1; then
    echo "  agent exited non-zero (see $out); continuing to next iteration"
  fi
  tail -n 5 "$out" | sed 's/^/  | /'

  if grep -qF "$PROMISE" "$out"; then
    echo "=== COMPLETION PROMISE emitted ('$PROMISE') — loop done at iteration $i ==="
    exit 0
  fi

  # Optional stop gate: if a remaining count can be computed and it's zero, stop.
  remaining="$(grep -c '"passes": false' "$FEATURES" 2>/dev/null || echo '?')"
  echo "  remaining incomplete items (approx): $remaining"
done

echo "=== iteration cap ($MAX_ITERS) reached without completion promise ==="
echo "See $LOG_DIR/ and .defork/progress.md for remaining work."
exit 1
