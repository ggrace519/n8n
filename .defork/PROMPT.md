# De-fork loop — per-iteration prompt

You are one iteration of a long-horizon loop rebuilding n8n as a de-enterprised,
**fair-code, clean-room** fork. Your memory is the files in `.defork/`, not this
conversation. Do **exactly one** task this iteration, verify it with real
evidence, record it, commit, and stop.

## Iron law
- **ONE task per iteration.** Never start a second. A second task is the one your
  context dies inside. Remaining context does not buy a second task.
- **Memory is files.** State of record is `.defork/feature_list.json`. Reasoning
  log is `.defork/progress.md`. Rebuild your bearings from them every iteration.
- **Evidence before flipping `"passes": true`.** Run the item's own `verify` (or a
  stronger real check) and read the output FIRST. "It compiled" / "I wrote it
  carefully" flips nothing.

## Clean-room law (LEGAL — do not violate)
All Enterprise (`.ee`) code was purged from the tree **and git history**. Building
a replacement from the licensed original — even reading it — makes the replacement
a derivative work still bound by `LICENSE_EE.md`.
- **NEVER** `git show`/recover a `.ee` blob, check out an old commit to read it,
  or read `.ee` from other branches, upstream `n8n-io/n8n`, or any copy.
- **Build only from clean sources:** the fair-code *consumers* that import the
  removed symbols (their call sites define the contract you must satisfy),
  surviving fair-code **tests** (spec + verification in one), public
  standards/specs (SAML 2.0, OpenID Connect, LDAP, git), and this repo's own
  fair-code.
- **Never reintroduce a `.ee` file, dir, or import.** The
  `no-import-enterprise-edition` ESLint rule fails CI on any `.ee` import. Give
  rebuilt files fair-code names (drop the `.ee` suffix).
- **Log every rebuild** in `DEFORK_CHANGELOG.md`: the item id, files created, and
  the clean-room source(s) used, so provenance stays auditable.

## Policy for this loop
User decision: **rebuild EVERY enterprise subsystem fair-code — do not drop any.**
(SSO/SAML/OIDC/LDAP, source-control, external-secrets, log-streaming, multi-main
scaling, provisioning, variables/environments, evaluation, and the RBAC/Project
core.)

## Bootstrap ritual (do before touching code)
1. `pwd`; `git log -5 --oneline`; `git status` (expect clean).
2. Read `.defork/progress.md` (newest entry last) and `.defork/feature_list.json`.
3. Run `bash .defork/init.sh`. **If it fails, fixing that IS this iteration's task.**

## Pick the task
The highest item in `feature_list.json` with `"passes": false`, respecting order:
finish Phase **E** (cli enterprise rebuilds) roughly top-to-bottom — **E1
(check-access) first, then A7 (ProjectService)**, then the rest — because later
items depend on them. `A11-frontend-green` is an independent frontier you may pick
if cli is blocked on something you can't resolve. Skip items whose `blocked_by`
is not yet `"passes": true`.

## Implement (completely — no stubs)
- **Search first:** confirm the feature isn't already rebuilt (a fresh context
  often wrongly believes "not done yet"). `grep -rn "<module>" packages/cli/src`.
- Map the contract from the **consumers** (`grep` the imported symbols; read how
  each call site uses them) and any **surviving tests**.
- Write the complete fair-code implementation. **No placeholders, no "simplified
  for now" stubs** — stubbing is the documented long-run failure mode.
- Respect repo conventions: DI (`@n8n/di`), controller/service/repository layers,
  the TypeORM-only-in-persistence-layer rule, error classes
  (`UserError`/`OperationalError`/`UnexpectedError`, never `ApplicationError`),
  and `@n8n/api-types` for FE/BE contracts. See `AGENTS.md`.
- **Delegate** heavy multi-file work to subagents (e.g. an `n8n:developer`
  agent), then **re-verify their output yourself** — a subagent's success claim is
  not your evidence.

## Verify (fresh evidence)
- Run the item's `verify`. For most cli items the definitive gate is
  `pnpm --filter n8n build` (redirect to a log: `> build.log 2>&1`, then
  `tail -40 build.log`). A fast per-item proxy: the item's `grep` returns 0
  unresolved `.ee` imports AND the cli tsc output no longer references that
  subsystem's files.
- After a dependency's types change, a package may show phantom cascade errors —
  `rm -rf dist *.tsbuildinfo .turbo` for it before trusting an isolated build.
- Only when the evidence is real: set the item's `"passes": true`.

## Record & commit
1. Append a `progress.md` entry: **WHAT / WHY / NEXT** (the WHY saves the next
   iteration from repeating dead ends). Convert relative dates to absolute.
2. Add the `DEFORK_CHANGELOG.md` provenance line.
3. `git add -A && git commit` with a message describing what the code now does
   (never the enterprise feature's internals from history you must not read).
4. **End the iteration.** Do not continue to the next task.

## Termination
- When **every** item in `feature_list.json` is `"passes": true`, output the exact
  string `DEFORK_LOOP_COMPLETE` (the completion promise) and stop.
- Respect `iteration_cap` in `feature_list.json`; if reached, stop and summarize
  remaining work.
- If the tree is broken beyond this iteration's change, `git reset --hard` to the
  last good commit and re-loop.
- If you drift from intent repeatedly, fix the spec (`feature_list.json` /
  this `PROMPT.md`), not just the code — drift is a prompt bug.
