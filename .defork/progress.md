# De-fork + AI rebuild — progress log (append-only)

Newest last. Each entry: WHAT / WHY / NEXT. State of record is `feature_list.json`;
this file records the reasoning so the next session doesn't repeat dead ends.

---

## 2026-08-08 — Purge, guardrails, and Tier-0 foundation

**WHAT.**
- Detached the GitHub fork; purged all Enterprise (`.ee`) code from tree + full
  git history (`git filter-repo`, regex `\.ee(\.|/)`): 1,117 files / 22,535
  commits remain, 0 `.ee` reachable.
- Guardrails: hardened + enabled `no-import-enterprise-edition` (bans all `.ee`
  imports/re-exports/dynamic-imports), AGENTS.md fork policy, `DEFORK_CHANGELOG.md`.
- Fixed the only dangling workspace dep (`packages/cli` → purged
  `@n8n/ai-workflow-builder`); `pnpm install` green.
- Tier-0 `@n8n/permissions`: wrote `constants.ts` (RESOURCES catalog, 46
  resources/180 scopes) + `types.ts` (Scope/ApiKeyScope/role types). VERIFIED:
  `scope-information` snapshot passes byte-exact; `types.test` typechecks.
- Set up long-horizon state kit + `INNOVATIONS.md` (AI-native proposals).

**WHY.**
- Clean-room provenance requires the `.ee` source be *unreachable*, not just
  deleted — hence the history rewrite. The surviving package **test files** are
  fair-code and specify the deleted modules exactly, so we rebuild to pass them
  (spec + verification in one).

**KEY FACTS for the next session.**
- Rebuild order and status live in `feature_list.json`. Current front: finish
  `@n8n/permissions` (items A2–A6), each has a surviving fair-code test to verify.
- The AI foundation SURVIVED the purge (fair-code): `@n8n/instance-ai`,
  `@n8n/workflow-sdk`, `@n8n/ai-node-sdk`, `@n8n/mcp-apps`, `@n8n/mcp-browser`,
  `@n8n/nodes-langchain`, `packages/cli/src/modules/instance-ai/`. Only the
  licensed `ai-workflow-builder.ee` was purged → rebuild it fair-code (item C2).
- Per-role scope SETS (GLOBAL_OWNER_SCOPES etc.) are only partially pinned by
  tests → design community-equivalent (owner=all, graded down), satisfying every
  behavioral assertion. Do NOT read `.ee` history to recover them.
- TS here is tsgo/TS7: isolated typecheck uses `npx tsc --ignoreConfig ...`.
- Test harness needs `@n8n/vitest-config` built first
  (`pnpm --filter @n8n/vitest-config build`).

**NEXT.** Item **A2** — `@n8n/permissions/src/schemas.ts` (zod role schemas), verify
with `src/__tests__/schemas.test.ts`. Before writing, confirm consumer usage of
`Role`, `roleSchema`, `teamRoleSchema`, `assignableProjectRoleSchema`, `scopeSchema`.

## 2026-08-08 — @n8n/permissions fully rebuilt (A2–A6 done)

**WHAT.** Completed the entire `@n8n/permissions` package clean-room: schemas,
per-role scope sets + role-maps, all utilities, custom-role-scopes,
public-api-permissions, index rewrite, all-roles fix, all test imports repointed.
VERIFIED: typecheck clean + **105/105 tests pass**.

**WHY.** This is the Tier-0 foundation (172 consumers). Built to satisfy the
surviving fair-code tests (spec + verification in one). Per-role scope *contents*
were under-pinned by tests → designed community-equivalent; safe to tune later.

**KEY FACTS.**
- The noisy `import ... from '@n8n/permissions'` grep over-spanned statements —
  do NOT trust it as the barrel contract. Use the compiler: consumer typecheck at
  A10/A11 will name any missing barrel export (likely extras like GLOBAL_*_ROLE
  objects/slugs, isProjectRole, COUPLED_HIDDEN_SCOPES, getApiKeyScopesForRole).
- `pick/allOps` helper in `roles/scopes/scope-filters.ts` builds scope lists from
  RESOURCES; reuse it for any scope-set tuning.

**NEXT.** Item **A7** — `ProjectService` fair-code replacement
(`packages/cli/src/services/project.service.ee.ts` was purged; 49 consumers).
Recover its contract from consumers + surviving project.service tests, clean-room.

## 2026-08-08 — Downstream build unwiring (session continued)

**WHAT.** Full `pnpm build` now reaches 51/59 packages. Fixed blob-storage,
rest-api-client (dropped purged .ee barrel re-exports). Fixed a real permissions
bug: `Role` must be the role DTO object (`RoleObject`), not the slug string —
db's `builtInRoleToRoleObject` maps over `ALL_ROLES.*` (RoleObject[]). Added
`settings.ts` + `getApiKeyScopesForRole({role})` to permissions. db partially
unwired (entities + most repos done).

**WHY / GOTCHAS.**
- Stale TS `.tsbuildinfo` caused 22 phantom cascade errors (constants/tag/
  credentials createdAt) — ALWAYS `rm -rf dist *.tsbuildinfo .turbo` for a package
  before trusting its isolated build after a dependency's types change.
- Build in topological order via `pnpm build`; it halts at the first failing
  package (no --continue), so fix that one and re-run.

**NEXT (db-green, then cli).** Item **A8b**: strip execution-annotations from
`packages/@n8n/db/src/repositories/execution.repository.ts` (5 regions: imports,
serializeAnnotation, findSingleExecution, softDeletePrunableExecutions subquery,
and the toQueryBuilder/toQueryBuilderWithAnnotations/reduceExecutionsWithAnnotations
list flow). Verify with the surviving execution.repository tests + `pnpm --filter
@n8n/db build`. THEN item **A7** ProjectService (49 consumers) and the rest of cli
(worklist: scratchpad/dangling_files.txt — 73 source files).

## 2026-08-08 — A8b done (execution.repository annotations stripped)

**WHAT.** Removed every execution-annotation code path from
`@n8n/db/src/repositories/execution.repository.ts` (clean-room — the feature was
`.ee` and purged): the 3 annotation entity imports + `AnnotationVote` + lodash
`pick`; `serializeAnnotation`; `includeAnnotation` from all 4 `findSingleExecution`
overloads + impl + `findIfShared`; the annotation exclusion subquery in
`softDeletePrunableExecutions` (both usages); and the raw-SQL WithAnnotations list
flow (`annotationFields`, `reduceExecutionsWithAnnotations`,
`toQueryBuilderWithAnnotations`, the `vote`/`annotationTags` join in
`toQueryBuilder`). `findManyByRangeQuery` now uses the plain `toQueryBuilder(query)
.getRawMany()` → `toSummary` path (no annotation left-joins → no duplicate rows to
reduce). Delegated the edit to an n8n:developer subagent; VERIFIED INDEPENDENTLY
(fresh build + tests, not the delegate's claim): 0 `execution.repository.ts`
errors, 29/29 unit tests pass.

**WHY / GOTCHAS.**
- The surviving `execution.repository.test.ts` has ZERO annotation refs, so it
  neither blocked removal nor covers these methods — evidence bar for A8b was
  "file typechecks + package builds + existing tests pass", which all hold.
- `annotationTags`/`vote` still exist on the `ExecutionSummaries.Query` type in
  `entities/types-db.ts` (unused-but-harmless); left in scope-tight, clean later.
- `@n8n/db` build is NOT yet fully green: one remaining error surfaced —
  new item **A8c** (migration Scope-type divergence), see below.

**NEXT.** Item **A8c** — `1742918400000-AddScopesColumnToApiKeys.ts(32)`:
`getApiKeyScopesForRole` wants `{scopes: permissions string-union Scope[]}` but
`GLOBAL_ROLES[role]` is a db-entity `Role` whose `scopes` are db `Scope` OBJECTS.
Likely fix: `getApiKeyScopesForRole({ role: { scopes: dbRole.scopes.map(s => s.slug) } })`.
That should make `pnpm --filter @n8n/db build` fully green, then item **A7**.

## 2026-08-08 — A8c + A8d done; @n8n/db fully green (build + tests)

**WHAT.**
- **A8c**: `1742918400000-AddScopesColumnToApiKeys.ts` — `getApiKeyScopesForRole`
  wants the `@n8n/permissions` string-union `Scope[]`, but `GLOBAL_ROLES[role]`
  is a db-entity `Role` whose `scopes` are db `Scope` OBJECTS. Fixed by mapping
  `dbRole.scopes.map((s) => s.slug)`. `pnpm --filter @n8n/db build` now exit 0.
- **A8d**: running the FULL db suite (first time since A8a) surfaced 10 test files
  that fail to *load* because they import purged `.ee` modules (agent-eval-*,
  evaluation-*, workflow-review-request-*). No fair-code source survives for any
  of those 7 features → orphaned. Deleted all 10. VERIFIED: `pnpm --filter
  @n8n/db test` → **31 files / 409 tests pass, exit 0**. Zero `.ee` refs remain
  anywhere in `packages/@n8n/db/src`.

**WHY / GOTCHAS.**
- A8b's per-item verify only ran the single execution.repository test, so the
  orphaned-test breakage was invisible until the full suite ran under A8c. Lesson:
  run the *package* test suite, not just the changed file, before declaring a
  package green.
- Deleting orphaned `.ee` tests is the correct de-fork move (they specify removed
  licensed features); do NOT try to rebuild agent-eval/evaluation/review-request
  unless a fair-code decision says so — they are not in the feature_list.

**NEXT.** `@n8n/db` is now fully green. Item **A7** — ProjectService fair-code
replacement in `packages/cli` (`project.service.ee.ts` purged; 49 consumers).
Recover the contract from consumers + surviving `project.service` tests, clean-room.

## 2026-08-08 — Build frontier reached cli+editor-ui; cli enterprise surface mapped

**WHAT.** Cleared all upstream build blockers so `pnpm build` now reaches the top
of the graph (65/67 tasks). Fixes committed:
- `@n8n/permissions`: added missing barrel type `AssignableProjectRole =
  Exclude<ProjectRole,'project:personalOwner'>` (compiler-named gap).
- `@n8n/backend-test-utils`: cast project-relation role slug at the test-util
  boundary.
- nodes-base Evaluation: clean-room `CannedMetricPrompts.ts` (correctness +
  helpfulness LLM-judge default prompts) + deregistered the 2 purged `.ee`
  Evaluation node classes from package.json (metadata gen was loading missing
  modules). Node rebuild-or-drop = Phase B item **B-eval-node**.

Remaining build failures: **n8n-editor-ui** (vite error, A11) and **cli**
(unbuilt — dist empty; turbo aborted after editor-ui failed).

**KEY: cli enterprise surface (the core of the de-fork).** cli non-test src still
imports **47 distinct purged `.ee` modules**. Top consumers:
`permissions.ee/check-access` (41), `project.service.ee` (40),
`variables.service.ee` (12), `source-control.ee` (12), `sso.ee/sso-helpers` (12),
`external-secrets.ee` (12), `workflow.service.ee` (5), `provisioning.ee` (5),
`worker-status`+`multi-main-setup` (8), `permissions.ee/project-scope.service`
(4), `evaluation.ee` (4), plus oidc/saml/ldap/log-streaming/dynamic-credentials/
credentials.service.ee (1-2 each). Full list: run the grep in this session or
`grep -rhoE "\.ee[^'\"]*" packages/cli/src | ...`.

**STRATEGY (pending user decision on keep/drop per enterprise subsystem).**
- Unambiguous keep+rebuild fair-code (community-core, ~81 consumers):
  `permissions.ee/check-access` + `permissions.ee/project-scope.service`, and
  `project.service.ee` (A7). Do these regardless of policy.
- The rest (SSO/SAML/OIDC/LDAP, source-control, external-secrets, log-streaming,
  multi-main scaling, provisioning, variables/environments, evaluation) are
  keep-fair-code-vs-drop product decisions — ASKED USER for the Phase-A policy
  before grinding (avoid rebuilding a subsystem the fork intends to drop).
- Per-subsystem Phase-A options: (a) clean-room fair-code rebuild, (b) fair-code
  graceful no-op/stub, (c) remove feature + unwire consumers.

**NEXT.** Await keep/drop policy; meanwhile the two RBAC/permissions helpers and
ProjectService are safe to rebuild. editor-ui (A11) is an independent frontier.

## 2026-08-08 — E1 done (check-access + ProjectScopeService rebuilt fair-code)

**WHAT.**
- Smoke first: fresh `pnpm install` left `@n8n/db` unbuildable — tsgo 7.0.2
  fails contextual typing of a `find()` callback through an optional chain in
  `1784000000034-AllowAzureStoredAt.ts`; fixed with an explicit `TableCheck`
  annotation (commit 7a704a7d70). SMOKE OK after.
- **E1**: rebuilt the RBAC access layer clean-room as
  `packages/cli/src/permissions/{check-access.ts,project-scope.service.ts}`:
  `userHasScopes(user, scopes, globalOnly, ctx, trx?)` (global allOf →
  project-role resolution via RoleService.rolesWithScope +
  ProjectRelationRepository.getAccessibleProjectsByRoles → per-resource checks;
  workflow/credential require sharing-role AND project-role on the SAME
  relation row, mirroring workflow-finder's buildSingleWorkflowReadWhere;
  NotFoundError for missing resources → middleware 404) and
  `ProjectScopeService.getProjectIds → string[] | null` (null = global/no
  filter, pinned by agent-mcp-access consumers). Rewired all 41 consumer files
  (sed, incl. test vi.mocks). Added optional `trx` to
  `getAccessibleProjectsByRoles` (@n8n/db).
- Multi-provider loop: codex read-only review caught a REAL BLOCKER —
  `workflow-creation.service.ts:319` passes a 5th `transactionManager` arg my
  symbol-grep verification missed (TS2554 error text doesn't contain the symbol
  name — lesson: grep tsc logs by FILE:LINE, not symbol). Fixed by threading
  `trx?: EntityManager` through. Also per codex: added 22 unit tests
  (src/permissions/__tests__/). grok failed twice (plan-mode returns preamble
  only, no review) — dropped per delegation rule 5.

**VERIFIED.** repo-wide `permissions.ee` = 0; cli tsc 0 errors in
src/permissions + at call sites (1046→1045, delta exactly the fixed arity
error); tests: 22/22 new, 409/409 @n8n/db, 107/107 rewired consumers.

**NEXT.** Item **A7-project-service** — ProjectService fair-code rebuild
(40 consumers import `@/services/project.service.ee`). Same recipe: map
contract from consumers + surviving project.service tests; watch for the
user.service.test reference to `projectService.getProjectIdsWithScope`.
Note: `workflow-creation.service.test.ts` also imports project.service.ee +
workflow.service.ee — it becomes loadable only after A7+E14.
