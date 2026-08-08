# `.defork/` — de-fork long-horizon loop kit

State-in-files kit for rebuilding n8n as a de-enterprised, **fair-code,
clean-room** fork across many sessions. The loop's memory lives here, not in any
one conversation.

## Files
- **`feature_list.json`** — the state of record. Every unit of work; each flips
  `"passes": false` → `true` only with real verification evidence. Carries the
  `completion_promise` (`DEFORK_LOOP_COMPLETE`), `iteration_cap`, and the
  keep/rebuild `policy`.
- **`PROMPT.md`** — the per-iteration instructions (iron law, clean-room law,
  bootstrap ritual, verify-before-flip). This is what each iteration runs.
- **`progress.md`** — append-only WHAT/WHY/NEXT log. Read it to reconstruct
  "where was I" and avoid repeating dead ends.
- **`init.sh`** — smoke: proves the current build front still runs. Expands as
  phases complete. If it fails, fixing that is the iteration's task.
- **`run-loop.sh`** — the harness: runs the agent fresh on `PROMPT.md` each
  iteration until the completion promise or the cap.

## Run it locally
```bash
# from repo root, clean tree, deps installed
pnpm install
bash .defork/init.sh          # sanity: should print SMOKE OK
bash .defork/run-loop.sh      # start the loop (Ctrl-C to stop; resumable)
```
Override the agent or cap:
```bash
MAX_ITERS=25 AGENT_CMD='claude -p --permission-mode acceptEdits' bash .defork/run-loop.sh
```
Each iteration does exactly one task, verifies it, commits, and ends — so you can
stop and resume anytime; the next run rebuilds context from these files.

## Current frontier (2026-08-08)
Upstream packages (permissions, db, nodes-base, backend-test-utils) build green.
Remaining Phase-A/E work: rebuild the **cli** enterprise subsystems fair-code
(start `E1-perm-check-access`, then `A7-project-service`), reach `A10-cli-green`,
then the independent `A11-frontend-green`, then `A12-app-smoke`. See
`progress.md` (newest entry) for the full cli `.ee` surface map.

## Non-negotiables
- **Clean-room only.** Never read purged `.ee` source (history, other branches,
  upstream). Rebuild from consumers, surviving tests, and public specs. Log the
  source used in `../DEFORK_CHANGELOG.md`.
- **One task per iteration.** Evidence before flipping `passes:true`.
