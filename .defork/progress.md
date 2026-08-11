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

## 2026-08-08 — A7 done (ProjectService rebuilt fair-code)

**WHAT.** Rebuilt `packages/cli/src/services/project.service.ts` (24 methods +
2 error classes) + 10 use-case repo methods in @n8n/db + @n8n/permissions
schema/type fixes. Multi-provider: codex extracted the 42-file consumer
contract inventory (read-only), Claude implemented, codex reviewed the diff.

**KEY DISCOVERIES (don't re-learn these).**
- `test/integration/project.api.test.ts` (1544 lines) + `public-api/projects.test.ts`
  SURVIVED and pin byte-exact error messages, quota semantics (incl. a
  parallel-creation race test), 409-vs-200 membership semantics, personal-project
  404s, and transfer authorization. They can't RUN yet (file imports purged .ee
  modules) — they become the A10 gate. Codex's review surfaced them; my own
  contract pass missed them. Lesson: search test/integration/** for specs BEFORE
  implementing, not just src/**/__tests__.
- License semantics: role licensing applies only to roles a change NEWLY grants
  (re-adding an existing admin is license-free; granting viewer to a new member
  requires feat:projectRole:viewer). Resolves the apparent contradiction between
  the service integration tests and the public-api 400 pin.
- Custom role slugs are `${roleType}:${name}-${rand}` (see
  RoleService.createCustomRole) — NOT only 'custom:*'. Any schema that gates
  assignable project roles must accept both namespaces (teamRoleSchema does now).
- `AssignableGlobalRole` = string (custom global roles are free-form);
  assignableGlobalRoleSchema rejects only 'global:owner' (message pinned).
- Dynamic imports in cli need the `.js` suffix ('@/workflows/workflow.service.js')
  — used to break the ProjectService↔WorkflowService/CredentialsService/
  OwnershipTransferService DI cycles (same pattern as execution-recovery.service).
- eslint ratchet allowlist (packages/cli/eslint.config.mjs): renamed/rebuilt files
  carry over their old entries (permissions.ee/check-access.ts →
  permissions/check-access.ts; project.service.ts added as the rebuild of the
  purged .ee leak). Do the same for future E-item renames.

**VERIFIED.** grep=0; cli tsc 968→946, zero regressions; integration 25/25;
permissions 105/105; api-types 1773/1773 (3 pre-existing failures FIXED —
they were gaps in the A2 rebuild only visible from api-types' suite); db 409/409.
Codex review: 10 findings, 8 fixed (incl. 2 blockers: transfer-authz 404 and…
quota race), 1 documented deviation (permission-aware deletes mirror
users.controller), 1 was the changelog entry itself. grok dropped (2 empty
responses in plan mode — rule 5 fallback; investigate grok flags before next use).

**NEXT.** Item **E2-variables** (environments.ee, 12 consumers) per feature_list
order. Same recipe: check test/integration/environments/** for surviving specs
FIRST (there are 92 tsc errors under test/integration/environments — the specs
exist), then consumers, then codex contract pass if large.

## 2026-08-08 — E2 done (variables rebuilt; boot-chain slices of E3/E8/E12/E13)

**WHAT.** Rebuilt the variables subsystem fair-code at
`packages/cli/src/variables/` (service + controller); REST spec **23/23**.
Unblocking the spec's app boot required small clean-room slices of FOUR other
E-items (static-import chain): evaluation-concurrency.helper (E13),
SourceControlPreferencesService + types (E3), ExternalSecretsConfig +
SecretsProviderAccessCheckService + connection repository (E8),
dynamic-credentials shared-fields helper (E12). Codex produced the contract
inventory (routes/methods/licensing/RBAC with verbatim pins) — very high value.

**KEY DISCOVERIES.**
- Public-api suites are ALL-OR-NOTHING: any request initializes the eov router,
  which imports EVERY handler; one purged import (currently
  credentials.service.ee → E15) 500s every public-api route. Public-api specs
  are therefore an A10-level gate, not per-item. Same for n8n-packages importer
  specs (workflow.service.ee → E14).
- Debugging those 500s: bodies are generic; instrument
  `sendPublicApiErrorResponse` temporarily (ErrorReporter spy does NOT see
  router-init errors).
- REAL BUG found+fixed from the newly-runnable tags spec baseline:
  `getApiKeyScopesForRole` expected slug arrays but all cli callers pass
  AuthPrincipal (scope OBJECTS) → every API key had zero valid scopes (403s).
  A8c's migration mapping was a workaround for the wrong signature — reverted.
- API_KEY_RESOURCES catalog was under-inclusive vs public-api handlers
  (variable:update, credential:list, folder:*, eventBusDestination:*, ldap,
  oidc, otel, saml, securitySettings) — completed; ApiKeyScope derives from it.
- VariableCountLimitReachedError covers BOTH quota and duplicate-key (pinned by
  the importer's race-recovery comment, LIGO-880); message 'Variables limit
  reached' pinned by mocks.
- GLOBAL_MEMBER lost global projectVariable:{read,list} — cross-project
  visibility pin (public-api "not a member" test). Members see project vars via
  project roles only.
- ccds-guard blocks Read/sed under packages/cli/src/credentials/ (thinks it's a
  secrets dir); grep passes — use grep for that tree, or Greg can tune
  guard-rules.txt.
- tags.test.ts public-api baseline: 12 failed/12 passed BEFORE my changes (the
  403 class is now fixed; 404→500s remain — likely EntityNotFound
  classification; investigate at A10).

**VERIFIED.** environments.ee refs = 0; REST spec 23/23; 111 consumer unit
tests; api-keys 14/14; db 409/409; permissions 105/105; api-types 1773/1773;
cli tsc 946→815 zero regressions; eslint clean on all new dirs.

**NEXT.** **E3-source-control** (largest remaining; preferences service slice
exists; specs: test/integration/environments/source-control*.test.ts — 5 files;
decompose per PROMPT if needed). Alternative next: E14/E15 (workflow/credentials
service .ee halves) to unlock the public-api + n8n-packages gates sooner —
consider E15 FIRST since it unblocks the entire public-api suite for all
subsequent items.

## 2026-08-08 — E15 started, PAUSED on ccds-guard (session end)

**WHAT.** Selected E15 (credentials.service.ee → EnterpriseCredentialsService)
as next: only 2 consumers, and it unblocks the ENTIRE public-api integration
suite (the eov router imports the credentials handler on any request).
Contract mapped so far, from consumers:
- `getOneForUser(user, credentialId, includeData?)` → credential WITH `shared`
  relations (controller destructures `{ shared, ...credential }`); used when
  `licenseState.isSharingLicensed()`, else falls back to fair-code
  `credentialsService.getOne`. Spec: credentials.api.test.ts:1703 (GET /:id).
- `shareWithProjects(user, credentialId, projectIds, trx)` — called inside the
  controller's own transaction after it deletes unshared rows; inserts
  SharedCredentials 'credential:user' rows (mirror upsert semantics).
- `transferOne(user, credentialId, destinationProjectId)` — mirror the
  fair-code transfer patterns (workflowService.transferAll /
  credentialsService.transferAll survive) + A7's target authorization
  (getProjectWithScope(user, dest, ['credential:create'])).

**BLOCKER.** ccds-guard now blocks grep/Read on packages/cli/src/credentials/*
("may contain secrets" — false positive on source code; adjudication is
nondeterministic, earlier greps of the same tree passed). E15 needs those files
read. DON'T route around the guard — Greg should add an allow rule for
`packages/cli/src/credentials/**` (and `packages/cli/test/integration/
credentials/**`) in the ccds-guard plugin's guard-rules.txt first.

**NEXT.** After the guard tune: finish E15 (rebuild at
`src/credentials/credentials.service.enterprise.ts`? no — fair-code name, e.g.
`credentials-sharing.service.ts`), verify with credentials.api.test.ts + the
public-api credentials spec, then confirm the public-api variables spec (E2's
deferred gate) turns green too. Then E3 or E14.

## 2026-08-08 — E15 done (credentials sharing service rebuilt; guard removed)

**WHAT.** Greg removed the ccds-guard block; finished E15. New
`src/credentials/credentials-sharing.service.ts` (EnterpriseCredentialsService:
getOneForUser / shareWithProjects / transferOne — thin over the fair-code
CredentialsFinderService, which already had the role-based sharing lookup).
Also rebuilt the purged `SecretsProviderConnectionRepository` in @n8n/db (DI
was injecting undefined → 500s on every credential create/update) and fixed
three permissions-package bugs the newly-runnable credentials spec exposed:
getAuthPrincipalScopes resource filter, credential sharing masks
(owner: +connect -list; sharee: read+connect), editor ops (connect yes, move no
— move is ownership-level, now in SHARE_OPS).

**VERIFIED.** credentials.api.test.ts 80/80; resolvable spec pins honored via
mirrored getOne enrichment; permissions 105/105; db 409/409; cli tsc 815→802;
grep credentials.service.ee = 0; eslint clean (ratchet entry carried over).

**KEY FACTS.**
- CredentialsFinderService.findCredentialForUser IS the sharing lookup — future
  sharing-ish rebuilds should reuse it, not reimplement.
- test/integration/database/repositories/secrets-provider-connection.repository
  .test.ts is a SURVIVING E8 spec pinning more repo methods
  (findEnabledGlobalConnections, ProjectSecretsProviderAccessRepository) — use
  it as the E8 spec.
- Public-api router chain now blocks ONLY on workflow.service.ee (E14).

**NEXT.** **E14** — EnterpriseWorkflowService, 9 methods pinned by consumers:
addCredentialsToWorkflow, addOwnerAndSharings, getFolderUsedCredentials,
getWorkflowIdsWithResolvableCredentials, preventTampering, shareWithProjects,
transferFolder, transferWorkflow, validateCredentialPermissionsToUser.
Consumers: workflows.controller, workflow.service (2 lazy imports),
workflow-creation.service, folder.controller, public-api workflows handler,
instance-ai.adapter. After E14: re-run the whole public-api suite (tags 404→500
class still open) + n8n-packages variable specs (E2's deferred gate).

## 2026-08-08 — E14 done (workflow-collaboration service; E11 slice; scope model corrected)

**WHAT.** Rebuilt `workflow.service.ee` as
`src/workflows/workflow-collaboration.service.ts` (EnterpriseWorkflowService,
9 methods) + db repo methods (SharedWorkflow share/transfer, workflow
folder/resolvable queries, folder re-homing) + minimal ProvisioningService
(E11 slice — full module/controller still open) + major @n8n/permissions
scope-model corrections pinned by the newly-runnable specs.

**SCOPE-MODEL PINS LEARNED (critical for remaining items).**
- Workflow sharing masks: owner = read/update/delete/move/share/unshare/
  execute/execute-chat/export/publish/unpublish/enable+disableRedaction +
  execution:reveal (cross-resource); editor sharee = read/update/execute/
  execute-chat/export/publish/unpublish. list/activate/deactivate NEVER pass
  the per-item mask.
- COUPLED_HIDDEN_SCOPES: workflow:activate/deactivate are legacy public-API
  aliases of publish/unpublish — excluded from role sets, added to API keys
  when the coupled scope is held (getApiKeyScopesForRole).
- Team admins do NOT hold workflow:share/unshare (personal owners do).
- Personal owners hold NO projectVariable:* (team feature) — this closed the
  E2/importer open question and its 3 failing specs.
- Editor tier: no move, no reveal (both SHARE_OPS now); editors DO delete.

**VERIFIED.** Regression battery 448/448 (credentials 80, workflows 201+35,
folders 107, projects 25); n8n-packages variable + REST variables 98/98 (E2's
deferred gate CLOSED); permissions 105/105; db 409/409 build+tests; cli tsc
session total 1046→784, 0 errors in new files; eslint 0 errors.

**KEY FACTS.**
- Public-api router still gated by SIX subsystems' handler imports:
  E3 source-control, E5 saml, E6 oidc, E7 ldap, E9 log-streaming,
  E13 evaluation (test-runner.service.ee via evaluations.handler). Each lands
  → rerun the full public-api suite; it is effectively the A10 pre-gate.
- transferFolder/transferWorkflow pins: destination gated on workflow:create
  (404), same-project 400, foreign workflows in folder 400, '0' = root parent,
  activation errors PROPAGATE (500 pin — do not swallow), ownership caches
  must be invalidated (ownershipService.invalidateWorkflowProjectCacheByIds),
  shareCredentials only shares what the user may SHARE (use-grant must not
  escalate).
- addOwnerAndSharings must initialize usedCredentials: [] (create-response pin).
- provisioning-config.api.test.ts pins the FULL E11 surface
  (/sso/provisioning/config GET/PATCH, provisioning:manage scope,
  handleReloadSsoProvisioningConfiguration) — finish at E11 and repoint that
  spec's .ee imports.
- main-only-modules.test.ts imports provisioning.ee/provisioning.module —
  repoint when E11's module definition lands.

**NEXT.** E3 (source-control — largest; 5 surviving specs in
test/integration/environments/) or E13 (evaluation backend — unlocks
evaluations handler + agent-evals). E4 (sso-helpers) before E5/E6.

## 2026-08-08 — E16 done (execution-sharing seam)

**WHAT.** EnterpriseExecutionsService.findOne rebuilt as a delegating seam over
the community ExecutionService.findOne — one consumer, identical
signature/return, no surviving spec distinguishes behavior (access already
flows through caller-scoped workflow IDs). grep=0, tsc 784→783, eslint clean,
execution-persistence 4/4.

**NEXT.** Remaining E items by size: E4 (sso-helpers, foundation for E5/E6) →
E13 (evaluation backend) → E9 (log-streaming) → E7 (ldap) → E8 (external-secrets
full) → E10 (multi-main) → E11 (full provisioning module) → E3 (source-control,
largest) → E5/E6 (saml/oidc). Then A10 sweep (repoint spec .ee imports, full
public-api suite), A11, A12, A13, B-eval-node, C1-C6.

## 2026-08-08 — E4 done (sso-helpers)

**WHAT.** `src/sso/sso-helpers.ts`: auth-method state (config.getEnv/set on
'userManagement.authenticationMethod' + settings row loadOnStartup — start.ts
feeds rows back into config on boot), predicates, enable-guard (pinned by
surviving saml-helpers.ts), SAML license/label accessors. 8 consumers rewired.

**VERIFIED.** grep sso.ee (src, non-test) = 0; invitation.controller 10/10
(was a load-failure all session); me/password 47/47; tsc 783→766; eslint 0.

**KEY FACTS.**
- modules/sso-saml survived EXCEPT saml.service.ee/saml.controller.ee/
  service-provider.ee — saml-helpers.ts + middleware + types are fair-code and
  pin much of E5.
- auth.controller.test still blocked by ldap.ee (E7).
- isOidcLicensed lives on LicenseState (not sso-helpers).

**NEXT.** E7 (ldap — unblocks auth.controller suite) or E13 (evaluation) or
E9 (log-streaming). E5/E6 now unblocked by E4.

## 2026-08-08 — E7 done (LDAP subsystem)

**WHAT.** Full LDAP rebuild at src/modules/ldap/ (service, controller,
auth-handler, helpers, errors, module). Internal ldap.api.test.ts 30/30.
Config persisted as features.ldap settings row; ldapts client;
dry/live sync into AuthProviderSyncHistory; @AuthHandler password login.
Codex extracted the contract from the 709-line spec (17KB, high value).

**3 SPEC BEHAVIORS the first cut missed (all fixed):**
1. Config PUT rejects unknown props at the ENDPOINT even though the DTO strips
   them — two surviving tests conflict (ldap-configuration.dto.test.ts pins
   STRIP, ldap.api.test.ts pins REJECT). Resolution: DTO stays strip;
   controller re-validates req.body with schema.strict(). Do NOT make the DTO
   strict (breaks the unit test).
2. Invalid-email directory entry for an EXISTING user = "seen" → user NOT
   disabled (add ldapId to seenLdapIds BEFORE the email-validity skip).
3. email→LDAP conversion must ADOPT the directory's mapped first/last name,
   not just attach the identity.

**KEY FACTS.**
- Auth handlers self-register via @AuthHandler decorator (import the file);
  login flow tries the registry's password handler for the current auth method
  when the preliminary user isn't the instance owner. EmailAuthHandler is the
  template.
- Module dir <name>/ auto-substitutes for the purged <name>.ee/ in
  module-registry (getModuleEntryUrl fallback) — no registry edit needed.
- LOG_SCOPES (@n8n/config) is a closed union — new scoped loggers need the
  scope added there ('ldap' added).
- RunningMode/SyncStatus come from @n8n/db via types-db re-export.
- test-server.ts endpointGroups 'ldap' imports the controller + auth-handler.

**BLOCKED (not E7 defects):** public-api ldap spec + ldap:reset command spec
both fail to LOAD on evaluation.ee/test-runner (E13) — base-command.ts and the
shared public-api router import it. E13 unblocks both.

**NEXT.** E13 (evaluation backend) — highest leverage: unblocks base-command
(→ all command specs), the public-api router (→ full public-api suite incl.
E7's ldap public-api spec), and agent-evals. Then E9 (log-streaming), E5/E6
(saml/oidc, need service-provider rebuild), E8 (external-secrets full), E10,
E11 (full provisioning module), E3 (source-control, largest).

## 2026-08-09 — E13a+E13b done (evaluation db substrate + test-runner core); B-eval-node flipped

**WHAT.**
- Pulled fresh master (PRs #1 Evaluation nodes, #2 S3/Azure blob storage —
  external agents). VERIFIED B-eval-node: nodes registered, 92/92 tests →
  flipped passes:true.
- **E13a**: @n8n/db evaluation persistence: TestRun/TestCaseExecution/
  EvaluationConfig/EvaluationCollection entities (schema pinned EXACTLY by the
  surviving migrations — note CleanEvaluations RECREATES test_run/
  test_case_execution, so pre-1745322634000 columns are obsolete),
  TestRun+TestCaseExecution repositories, WorkflowEntity.testRuns relation.
  db build + 409/409.
- **E13b**: cli test-runner core: TestRunnerService (engine), cleanup service,
  internal controller, LlmJudgeProviderRegistry; 'evaluation' log scope in
  @n8n/config. Internal spec 28/28; ldap-reset + license command specs
  unblocked (base-command) 16/16; 0 tsc errors in src/evaluation.

**KEY ENGINE FACTS (don't re-derive).**
- EvaluationTrigger is SELF-ITERATING (outputs one row + _rowsLeft), but the
  runner does NOT chain executions: it prefetches ALL rows via the trigger's
  `dataset.getRows` customOperation (set `forceCustomOperation:
  {resource:'dataset', operation:'getRows'}` on the node + destinationNode =
  trigger, mode 'evaluation'), then runs one pinned execution per row
  (pinData = {[triggerName]: [row]}; evaluation mode honors pinData —
  workflow-runner.ts:355). runIndex = original dataset index (rowIndices pin).
- ActiveExecutions SKIPS capacity reservation for mode 'evaluation'
  (deadlock guard, TRUST-144) — the runner owns throttle/release via
  ConcurrencyControlService. Template: agent-eval-runner.service.ts
  (pool/cancel/settle patterns; pLimit + AbortController + DB cancel flag).
- canBeCancelled is INVERTED (true = terminal) — public handler pins it.
- Internal controller: @ProjectScope alone is WRONG for these specs — global
  owner short-circuits scope checks and unshared workflows would 200. Use
  WorkflowFinderService.findWorkflowForUser (sharing-row-based) → 404; viewer
  gets 404 not 403. Read=workflow:read, delete=workflow:update,
  cancel/new=workflow:execute.
- Codex contract inventory (HIGH VALUE, reuse it):
  scratchpad/e13-contract.md in this session's scratchpad; key unpinned areas
  listed in its §9. Config controller GET /rest/workflows/:id/
  evaluation-configs pinned by @n8n/instance-ai/evaluations/clients/
  n8n-client.ts:422. Collections routes pinned by playwright
  eval-collections-compare.spec.ts. Feature gates: 088_config_evaluations /
  N8N_CONFIG_EVALS_ENABLED; 084_eval_collections / N8N_EVAL_COLLECTIONS_ENABLED.

**OPEN (E13 stays passes:false).**
- E13c: EvaluationConfigRepository + EvaluationConfigService +
  evaluation-config.controller (+ dataset-row endpoints per
  api-types/dto/evaluations/dataset-row.dto.ts) + WorkflowCompilerService +
  thread compileFromConfig into TestRunnerService (currently throws UserError).
  instance-ai adapter + its test still import
  '@/evaluation.ee/evaluation-config.service' — rewire when it exists.
- E13d: evaluation-collections.controller + insights (eval-insights schema,
  LLM + deterministic fallback, insightsCache on collection).
- NEW GAP discovered: agent-evals cli module (fair-code, survived) imports
  AgentEvalDataset/Run/Result repos from @n8n/db that DON'T exist (purged;
  migration CreateAgentEvalTables survives) — add feature item E17-agent-eval-db.
- Public-api evaluations spec still gated by source-control/saml/oidc/
  log-streaming handler imports (A10 pre-gate).

**NEXT.** E13c (delegate config service+controller+repo to n8n:developer with
the codex contract; compiler + runner threading by hand), then E13d, then flip
E13. Then E9 (log-streaming) or E4-done→E5/E6.

## 2026-08-09 — E13 DONE (evaluation backend fully rebuilt; multi-provider loop)

**WHAT.** E13c (config service/controller/repo — delegated to n8n:developer
subagent, verified independently: adapter 179/179) + WorkflowCompilerService +
compileFromConfig/collection/version-pin threading in the runner (by hand) +
E13d (collections + insights — second n8n:developer subagent; grep
evaluation.ee = 0 across src+test) + codex adversarial review (11 findings,
8 fixed: queue-mode executionData serialization mirroring offloaded manual
executions, triggerToStartFrom forcing, evaluationData extraction for
setInputs/setOutputs, cancel classification + completion CAS on
cancelRequested, failRun rethrow, internal 409 lifecycle guards, OpenAI
plain-string model param, ordering tiebreakers). E13 flipped passes:true.

**DEFERRED (non-blocking, no surviving consumer pins):** structured
EvaluationApiError transport on config-validation responses; SQL-side run
summaries (getMany relation-loads cases — perf risk for huge runs); Vertex
projectId + Azure authentication params on compiled judge nodes (needs DTO
extension); execution-id registration window in cancellation; insights LLM
path (deterministic 'fallback' only — no injectable model seam outside the
instance-ai module boundary).

**KEY LESSONS.**
- setInputs/setOutputs put data on item.evaluationData of the FIRST item
  (node comment literally says "test-runner only looks at first item") —
  json holds the passthrough workflow item.
- Queue mode persists ONLY executionData; transient IWorkflowExecutionDataProcess
  fields (pinData/triggerToStartFrom/destinationNode) must be serialized via
  createRunExecutionData exactly like OFFLOAD_MANUAL_EXECUTIONS does.
- Evaluation mode DOES enqueue in queue mode (workflow-runner shouldEnqueue
  excludes only 'manual').
- markAsCompleted is a CAS on cancelRequested=false — late cancels must win.

**NEXT.** Per feature_list order: E3 (source-control, largest — 5 surviving
specs in test/integration/environments/), or E9 (log-streaming) / E5/E6
(saml/oidc) / E8 / E10 / E11 / E17-agent-eval-db. After those: A10 sweep
(public-api suite ungated once source-control/saml/oidc/log-streaming land).

## 2026-08-09 — E13 merged (PR #3); E3 iteration started

**WHAT.** Pushed feat/defork-e13-evaluation-backend, PR #3 opened + merged
(merge commit, preserving the 9 slice commits), master synced. Started E3
(source-control): codex contract extraction dispatched over the 5 surviving
specs (4,745 lines) + consumers → will land at the session scratchpad as
e3-contract.md (re-dispatch with .defork/e3-brief snapshot if lost).

**E3 FILE MAP (from spec imports — the files to rebuild).**
modules/source-control.ee/: constants.ts, source-control-context.factory.ts,
source-control-export.service.ee.ts, source-control-git.service.ee.ts,
source-control-import.service.ee.ts, source-control-scoped.service.ts,
source-control-status.service.ee.ts, plus source-control.service.ee +
source-control-helper.ee (public-api handler imports) + controller + types.
Preferences service ALREADY fair-code at modules/source-control/.
SourceControlledFile type survives in @n8n/api-types. Specs also pin export
constants (SOURCE_CONTROL_{CREDENTIAL,DATATABLES,WORKFLOW}_EXPORT_FOLDER,
SOURCE_CONTROL_{FOLDERS,TAGS}_EXPORT_FILE) and use Cipher (n8n-core) +
fast-glob. Consumers beyond specs: public-api handler, data-table
branch-write-access middleware + controller + proxy, instance-ai service +
adapter, telemetry/pubsub event maps.

**PLAN.** Decompose E3 into: E3a git service + helpers + constants; E3b
export service; E3c import service (2,019-line spec — crown jewel); E3d
status/scoped/context; E3e service + controller + public-api handler rewire.
Delegate mechanical slices to n8n:developer subagents (non-overlapping
files), verify each against its own spec file, codex review at the end.

**NEXT.** When e3-contract.md lands: decompose + dispatch. Verify gate per
slice: its spec file green; item gate: all 5 specs + grep source-control.ee
= 0 (non-test).

## 2026-08-09 — E3a/E3b/E3c done (source-control foundation + export + import)

**WHAT.** Three slices landed and committed, each spec-gated:
- E3a foundation (subagent + empirical git smoke harness that caught 2 real
  bugs: unborn-branch HEAD, upstream-less pull). Files at
  modules/source-control/ (constants, types/*, context factory, scoped
  service, git service, helper).
- E3b export service: spec 13/13. Also implemented workflow/folder/
  data-table exports (contract-pinned shapes, spec covers creds+tags only —
  behavioral pin arrives with E3d's pushWorkfolder spec).
- E3c import service: spec 47/47 (2,019-line spec). Cipher via
  Container.get at point of use (spec swaps container instance).
  Non-destructive ownership on existing workflows (open question — chose
  conservative).
db 409/409 throughout; 0 tsc errors in the module; eslint clean.

**IN FLIGHT.** E3d subagent: status service + SourceControlService +
controller + module registration + public-api handler rewire + the 3
remaining specs (service 1608 / api 283 / access-control 184) + grep
source-control.ee = 0. After it: codex adversarial review of the whole E3
diff, then flip E3.

**NOTE for later.** E3a recommendation: add sourceControl:['push'] to the
team-admin role map in @n8n/permissions and drop the scoped service's
explicit PROJECT_ADMIN union (touches role snapshots — do deliberately,
with the permissions test suite as gate).

## 2026-08-09 — E3 DONE (source-control fully rebuilt + hardened)

**WHAT.** E3d (status/service/controller/module + rewires; 3 specs 26/20/16)
landed; codex adversarial review produced 14 findings — 12 fixed by a
dedicated hardening subagent (server-side push-selection derivation, symlink
containment, credential-data merge on pull, pull completeness dispatch incl.
scoped deletions + folders/data-tables, archived/active consistency via
ActiveWorkflowManager, in-process operation mutex, fail-closed sync,
owner-type checks, remote-owner authz, SSH quoting/perms, branch-name
validation, license-gated key generation), 2 deferred (spec-pinned non-string
leaves; existing-workflow ownership transfer). All 122/122 spec tests with
ZERO assertion changes + 57 new unit tests. E3 flipped.

**KEY FACTS.**
- Import spec forces decrypt-merge-reencrypt for existing credentials (it
  asserts data IS rewritten) — "preserve untouched" would fail the spec.
- pullWorkfolder has NO integration coverage (specs say "pull: TBD") — pull
  dispatch verified by unit/type/lint only. Re-verify at A10 via public-api
  pull spec (blocked on E9 log-streaming handler).
- E3d added a minimal provisioning module registration (main-only-modules
  gate) — full provisioning surface still E11.
- Public-api router now blocked ONLY by E9 (log-streaming) + E5/E6
  (saml/oidc handlers/mappers) — E9 is highest leverage next.

**NEXT.** E9 (log-streaming) → unlocks entire public-api suite → then E5/E6,
E8, E10, E11, E17, A10 sweep.

## 2026-08-09 — E9 DONE (log-streaming; public-api router UNGATED)

**WHAT.** Full module at modules/log-streaming (webhook/sentry/syslog
destinations, service, factory, controller, module-local EventDestinations
entity/repo). Specs 68/68; loader 20/20; codex review 8/8 findings fixed
(credential-binding authz, fail-closed auth, per-destination ack tracking,
read-API redaction, bounded queues + drain, persist-before-swap, narrowed
resolver containment, working circuit breaker) + 42 new unit tests. E9
flipped.

**KEY FACTS.**
- public-api/index.ts resolver now contains ONLY unresolvable pending `.ee`
  specifiers (sso-oidc/sso-saml) — their routes 500, everything else works.
  Public-api suite runs: log-streaming 44/44; tags 23/24.
- NEW PRE-EXISTING BUGS surfaced for later items: (1) tags public-api
  'non-owner should not delete tag' expects 403 gets 200 — RBAC gap, route
  to A10; (2) sso/provisioning.instance-settings-loader.test 3/7 fail —
  loader writes 'sso.provisioning.config', test expects
  'features.provisioning' — belongs to E11 provisioning rebuild.
- Eventbus writer (fair-code) confirm semantics: first confirm marks sent —
  service-side per-destination tracking designed around it, writer untouched.

**NEXT.** E5/E6 (saml/oidc — last router-gating items) or E8/E10/E11/E17.

## 2026-08-09 — E5/E6 built, NOT flipped: security review found 7 real defects

**WHAT.** SAML + OIDC backends rebuilt in parallel (committed, specs green:
SAML units 39/39 + public-api 16/16 + loader 2/2; OIDC units 35/35 +
public-api 24/24). Codex adversarial security review (hostile-IdP threat
model) returned REQUEST CHANGES: 5 HIGH + 2 MEDIUM. Hardening agents
dispatched (SAML: #1,#2,#3,#4,#6 / OIDC: #2,#3,#5,#7).

**THE DEFECTS (do not lose these — E5/E6 stay passes:false until fixed).**
1. SAML: assertion not bound to this SP — no Audience/Recipient/Destination/
   InResponseTo/SubjectConfirmationData-NotOnOrAfter checks; samlify 2.13.0
   accepts response OR assertion signature when both requested (must enforce
   each explicitly).
2. BOTH: an IdP-asserted email auto-links to an existing privileged (owner/
   admin) local account.
3. BOTH: provisioning role-mapping policy (incl. block:access) never
   evaluated — must fail closed BEFORE account mutation/session issuance.
   Blocked saml.api.test.ts:978 pins denial-before-mutation.
4. SAML: metadata endpoint URLs only type-checked as string — `javascript:`
   scheme passes SamlValidator and reaches window.location.href (reviewer
   VERIFIED this empirically). Restrict to https (localhost http exception).
5. OIDC: email taken from UserInfo while email_verified falls back to the ID
   token — a verified flag can attest a different address. Resolve the pair
   atomically from one source.
6. SAML: no replay protection — no request-ID/browser-flow binding, no
   response/assertion ID cache.
7. OIDC: identities keyed by bare `sub` without issuer.

**SOUND per review:** OIDC state/nonce/PKCE genuinely validated; ID-token
iss/aud/exp/alg enforced (no none/HS confusion); SAML XSW + comment-
truncation not exploitable via samlify; connection-test tokens 128-bit
single-use 5-min and never issue a session; secrets encrypted+redacted, not
logged; discovery/metadata fetch via guarded outbound transport; route
license/scope gates and auth-method mutual exclusion correct.

**COVERAGE HOLES.** saml.api.test.ts (ACS/permissions/signing pins) and
oidc.instance-settings-loader.test.ts are BLOCKED on the missing provisioning
module — E11 must land and both must then be run. Hardening agents told to
repoint to surviving `modules/provisioning/constants` where that works.

**NEXT.** Verify hardening → re-review the auth-critical diff → flip E5/E6 →
PR. Then E11 (unblocks 2 SSO specs + carries role provisioning), E8, E10,
E17, A10.

## 2026-08-09 — VERIFICATION FLAW FOUND: corrected a false green (E12) + audit

**WHAT.** While hardening E6, a subagent hit a NUL byte that made `grep` treat
a source file as binary and silently skip it. That is the SECOND such incident
(E9 found the same in e2e.controller.ts). Since my per-item "0 `.ee`
references" evidence is exactly this kind of grep, I re-ran every past claim
with `grep -ran` over src AND test.

**RESULT — one false green, one untracked item, one scope error.**
- **E12 (dynamic-credentials) REOPENED (was passes:true).** Its grep excluded
  `.test.` files and never scanned `packages/cli/test`. Only
  `services/shared-fields.ts` was ever rebuilt (the single consumer that
  blocked the build). 8 surviving spec files pin a whole module: the
  DynamicCredentialEntry/UserEntry entities, three repositories, the *Storage
  classes, DynamicCredentialsConfig, constants, credential-resolver
  (N8NIdentifier).
- **E18-workflow-reviews ADDED** — `workflow-reviews.ee` was never in the
  feature list at all (1 ref: test-server.ts module import).
- **E8 scope corrected** — src is already 0; the real remaining work is the
  module its 10 surviving spec files pin.
- CONFIRMED GENUINELY CLEAN across src+test with -a: evaluation, source-control,
  log-streaming, permissions, environments, sso, ldap, project.service,
  workflow.service, credentials.service, execution.service. Those flips stand.

**FIX APPLIED TO THE LOOP ITSELF (not just the code).** PROMPT.md "Verify" now
mandates `grep -ran`, scanning src AND test, never filtering `.test.` files,
and honest scoping ("the build stopped complaining" != "the subsystem is
rebuilt" — list which surviving specs actually RUN before flipping).
feature_list.verify_notes carries the same rule.

**LESSON.** Narrow verification scope is how a long-horizon loop lies to
itself. The grep that proves an item done must cover every place the symbol
can appear, in a form that cannot silently skip files.

## 2026-08-09 — E5/E6 hardened (7 findings fixed) + 2 new defects found

**WHAT.** Both hardening agents landed. SAML: units 39→84, integration 21/21.
OIDC: units 35→60, integration 28/28 (also un-blocked the oidc loader spec by
repointing to the surviving modules/provisioning/constants).

**ALL 7 REVIEW FINDINGS FIXED.** SAML assertion binding (audience/recipient/
destination/InResponseTo/both NotOnOrAfter, one bearer confirmation, ±60s
skew) + explicit assertion-signature re-verification on a response-signature-
stripped copy (samlify's redirectFlow verifies NO xml signature — real gap);
one-time request/response/assertion ids + path-scoped flow cookie; https-only
IdP endpoints enforced at validation AND URL generation; privileged-account
auto-linking refused (both protocols); OIDC atomic (email, email_verified)
from one document + subject/email disagreement rejection; OIDC identities
keyed (issuer, sub) with in-place legacy upgrade gated on verified email +
non-privileged.

**2 NEW DEFECTS FOUND BY THE HARDENING PASS.**
- FIXED: redirect-binding octet string included the Signature parameter, so
  redirect-binding ACS could NEVER verify (SAML bindings 3.4.4.1).
- NOT FIXED (KI-1): root package.json overrides node-rsa to 2.0.0 while
  samlify declares ^1.1.1. I verified empirically: sign() returns Uint8Array
  (isBuffer false) so samlify's .toString('base64') emits comma-separated
  decimals, AND the default signingScheme changed to pss while SAML advertises
  rsa-sha256 (pkcs1). node-rsa's MIGRATION.md claims Buffer-unchanged-on-Node
  — WRONG for the installed build; only testing caught it.

**GITHUB ISSUES ARE DISABLED on this fork** → created .defork/KNOWN_ISSUES.md
as the tracker (KI-1 node-rsa, KI-2 tags RBAC, KI-3 provisioning loader key,
KI-4 SSO denied while provisioning configured, KI-5 saml.api.test.ts blocked).
Ask Greg whether to enable GitHub issues.

**PROVISIONING DIVERGENCE RECONCILED.** Both agents independently chose
fail-closed deny when provisioning is configured but unevaluable. E11's scope
expanded in feature_list to own the engine + removing both deny branches.

## 2026-08-09 — Issues enabled; repo now PRIVATE

Greg enabled GitHub issues and made the fork private. The five KI-* defects
were filed as issues **#7 node-rsa override**, **#8 tags non-owner delete**,
**#9 provisioning loader settings key**, **#10 SSO denied while provisioning
configured**, **#11 saml.api.test.ts blocked**. `.defork/KNOWN_ISSUES.md` is
now just an index of what's already filed (so a fresh session doesn't re-file
them); use GitHub issues from here on, and close with `Closes #N` from the
fixing PR. feature_list carries `closes_issues` on E11 (#9,#10,#11) and A10
(#8).

AGENTS.md's two "**This is a public repository**" claims were false for this
fork and are corrected — the hygiene practices are kept (upstream is public
and this fork may be opened later), but the factual claim now matches reality.

## 2026-08-09 — E11 DONE (provisioning + role-mapping engine); 3 issues closed

**WHAT.** Full module: ProvisioningService (init + provisioningConfig), the
role-mapping evaluation engine, controller, role-mapping-rule service +
controller, real module registration replacing E3d's placeholder. Both SSO
deny branches replaced with real evaluation before account mutation.

**HEADLINE.** `saml.api.test.ts` RUNS and passes **69/69** — 0 collected since
the purge. Getting the last 5 needed two fixes I made myself after the agent
proved them pre-existing:
1. `outboundHttp.requests()`/`transport()` default SSRF protection ON,
   overriding the instance setting (which is OPT-IN by design and whose
   docstring names discovery endpoints). SAML metadata + OIDC discovery now
   use `ssrf: config.enabled ? service : 'disabled'` (workflows.controller
   precedent). NOTE: the OIDC discovery spec passes `ssrf:'disabled'` in its
   OWN harness, so it never covered the production path — the defect was
   invisible.
2. ACS required SAML *enabled*, but a connection test happens BEFORE
   enabling. New `samlLicensedAndEnabledOrConnectionTestMiddleware` admits
   licensed + connection-test RelayState (single-use token, never issues a
   session).

**ENGINE SECURITY.** Expressions run in an isolated V8 (@n8n/expression-runtime
ExpressionEvaluator + IsolatedVmBridge + ThisSanitizer/PrototypeSanitizer/
DollarSignValidator), 500ms/16MB (vs 5s/128MB workflow defaults), pool 1,
lazy + @OnShutdown disposal. Exposed: structuredClone($claims), $provider,
$oidc.{idToken,userInfo}. Claims JSON-size-capped 128KB, depth 16, BEFORE the
clone. Boolean result required. Timeout/memory/syntax/security/non-boolean/
oversized all -> ProvisioningExpressionError(ruleId, class) -> login denied.
Logs carry rule id + failure class only; a test asserts a secret claim value
appears in neither message nor serialized error.

**AGENT-FOUND REAL BUGS (fixed).** Project claims split at LAST colon dropped
every entry (role slugs contain colons) -> first-colon split + unit test.
buildScopes() read GlobalConfig while policy read the persisted document, so
enabling a role claim via PATCH never requested its scope -> both read the
persisted policy.

**ISSUES CLOSED:** #9 (settings key - 3 stale test literals fixed, production
key proven authoritative), #10 (SSO deny branches removed), #11 (saml.api
spec runs+passes).

**STILL OPEN:** #7 node-rsa override, #8 tags RBAC (A10).

**NOT VERIFIED (documented).** applyLoginProvisioning isn't one cross-table
transaction (project relations are atomic; revocations precede grants so an
interruption can only reduce access). Multi-main pubsub reload only via local
handler. SQLite only — the staged-negative-range reorder exists for Postgres'
per-row UNIQUE(type, order) but is unobserved there.

**NEXT.** E12 (my false green - reopened), then E8, E10, E17, E18, A10.

## 2026-08-09 — E12 DONE (properly this time); false green corrected

**WHAT.** Full dynamic-credentials module rebuilt: 3 entities + barrel, 3
repositories, 2 storage classes, N8NIdentifier, config, constants, errors,
services/providers (resolver, connection-status, resolver-workflow, CRUD,
credential-check) registered on DynamicCredentialsProxy /
CredentialConnectionStatusProxy, module registration with entities() +
idempotent system-resolver seeding, and a /credential-resolvers CRUD
controller.

**THE NUMBERS THAT MATTER.** grep -ran dynamic-credentials.ee: 19 -> 0. All 9
gates that could not even IMPORT before now run: dynamic-credentials 43/43,
resolvable REST 37/37, manual-execution-credential-context 5/5,
credentials-helper 49/49 (was 47 pass / 2 FAIL). Regression: credentials.api
80/80, sso+provisioning+main-only 205/205.

**REAL DEFECT FIXED.** The 2 credentials-helper failures were surviving-code
bugs, not the agent's: transferOne() did neither the destination
credential:createEndUser check nor connection reconciliation.

**REAL DEFECT FOUND, FILED AS #13 (not fixed).** Unshare cleanup is a no-op:
credentials.controller.ts:546 calls cleanupOrphanedEntriesForProjects(...,trx)
inside the transaction that just deleted the SharedCredentials rows, but
userHasScopes -> getAllRelationsForCredentials is called WITHOUT trx, so it
reads pre-delete rows and concludes access still exists. Fix belongs in
@n8n/db and needs its own gate (the unshare spec asserts sharings, not
entries).

**HONEST SCOPING (the whole point of this redo).** Under-pinned and labelled
as such: SYSTEM_RESOLVER_NAME/TYPE values, CredentialResolutionError
inheritance, resolution merge rule + encryption envelope, /credential-resolvers
CRUD controller (NO gate exercises it), 2 CORS env names, licenseFlag.
NOT built on purpose (contract: "must not be invented silently"): custom-
resolver type-specific validation, resolvableAllowFallback semantics,
/workflows/:id/execution-status, credentials authorize/revoke.
NO end-to-end coverage: resolveIfNeeded/storeIfNeeded, CredentialCheckService.

**NEXT.** E8 (external-secrets: src already 0, the work is what its 10
surviving specs pin), E10, E17, E18, then A10. A11 is the other agent's.

## 2026-08-09 — E8 DONE (external-secrets)

**WHAT.** 25 new files at modules/external-secrets: two-registry split (type
catalog vs live instances keyed by providerKey), provider lifecycle state
machine, secrets cache, settings store, connection manager, project-cleanup,
system-roles store, module wiring (pubsub reload + @OnShutdown), 5 controllers
covering 25 endpoints, and the $secrets expression integration. New
ProjectSecretsProviderAccessRepository in @n8n/db.

**GATES.** external-secrets 154/154 (9 files: module 5, api 16, connections 44,
project 46, types 13, completions 21, project-deletion 5, events 2,
expression-access 2) + secrets-provider-connection.repository 11/11 = 165/165.
Regression: credentials.api 80/80, sso+provisioning+dynamic-credentials
201/201, db 409/409. grep -ran external-secrets.ee = 0. eslint clean.

**THE CAVEAT THAT MATTERS.** 154 passing tests = ZERO real-provider coverage.
Every acceptance spec registers its OWN dummy provider. Provider identities are
pinned by the DTO enum; settings metadata is pinned only for Vault + AWS, and
only via test fixtures. GCP has one projectId example; Azure/Infisical/
1Password are identity-only. All six ship metadata + interface and FAIL LOUDLY
on connect rather than fabricating vendor protocols. Real SDK integrations are
deliberately NOT built — if someone later needs live Vault/AWS/etc., that is
new work with new gates, not a bug in this rebuild.

**REDACTION INVENTORY (verified).** encryptedSettings + feature.externalSecrets
row encrypted at rest via the credential subsystem's Cipher; password-typed
fields blanked with CREDENTIAL_BLANKING_VALUE in legacy GET /providers,
GET /providers/:provider, and connection create/read/update; settings+secrets
omitted entirely from the connection LIST; DELETE returns 204 no body;
non-password fields (region/url/namespace) returned verbatim per spec;
blanking marker round-trips without overwriting the stored password;
completions return names only, values read live and never cached.

**DEFECT FOUND (filed #15, not fixed).** ownership-transfer.manifest.test.ts
fails 2/6 on master: the manifest still lists WorkflowReviewRequest ->
workflow-review-request.ee.ts (purged). Belongs to E18 — fixing it here would
pre-empt that item's rebuild-vs-remove decision.

**NEXT.** E10 (multi-main), E17 (agent-eval db), E18 (workflow-reviews, owns
#15), then A10. A11 is the other agent's.

## 2026-08-09 — E17 DONE (agent-eval db substrate)

**WHAT.** 4 entities + 4 repositories in @n8n/db, rebuilt from the
CreateAgentEvalTables migration (authoritative schema) + the surviving
fair-code call sites in modules/agent-evals. Registered in BOTH the export
block and the `entities` map (the map's keys are what testDb.truncate's
EntityName union derives from — specs depend on it).

**GATES.** agent-evals unit 228/228 (7 files — could not run at all before);
integration 22/22 (4 files); db build + 409/409 unchanged; scoped tsc 0;
eslint clean. Agent verified on BOTH drivers: 17/17 sqlite AND 17/17 Postgres
via testcontainers, migration spec 4/4 on both.

**I PROMOTED THE AGENT'S THROWAWAY PROBE INTO A KEPT SPEC.** It had verified
markAllIncompleteAsError / markAsError / countByStatus with a temporary file
then deleted it. That path matters: markAllIncompleteAsError uses In() inside
update() criteria, and cleanupInterruptedRuns() SWALLOWS ITS OWN THROW — a
regression would surface only as runs polling 'running' forever. New spec
agent-eval-run-transitions.integration.test.ts, 5/5.

**KEY DESIGN CALL.** agentId is a DB-level FK only, NOT a @ManyToOne: Agent is
registered by the agents MODULE, so a relation from an always-loaded @n8n/db
entity would break TypeORM metadata whenever that module is off (the surviving
assertRequiredModulesActive guard exists for exactly this class of failure).
Intra-db relations (run->dataset, result->run, rating->result) and User
relations are wired normally.

**NO defects found in surviving code** — every call site was satisfiable as
written.

**NEXT.** E18 (workflow-reviews, owns #15), E10 (multi-main), then A10.

## 2026-08-09 — E18 DONE (workflow-reviews rebuilt + hardened)

**DECISION: rebuild, not remove.** Contract §8 argued it and I agreed: removal
would mean unwinding 7 DTOs, the whole frontend feature, settings surfaces,
policy store, push message, collaboration helper, publish/mutation proxies,
blocked-publication error contract, publication-state API, a repo integration
test, and ownership metadata — AND authoring a new forward migration because
the existing one may already have run in deployed DBs. That's a product
deprecation with a data migration, not de-fork cleanup.

**NO BACKEND SPEC SURVIVED — so the tests were AUTHORED.** 31 unit + 77
integration, green on BOTH sqlite and Postgres. The agent mutation-tested them
twice (before and after hardening): 9 invariants broken, each caught. That is
the mitigation for self-authored gates; it is not a substitute for the
independent review.

**CODEX REVIEW: 5 findings, all fixed.**
1. BLOCKER: decisions weren't bound to the reviewed version (approve V1 -> V2
   published unreviewed). Server race fixed: whole transition in ONE
   transaction, link taken with a conditional write re-asserting the pin,
   auto-publish uses the version returned BY that transaction. Lock order
   unified link-then-request across create/re-pin/decide/closure (an ABBA
   deadlock appeared once the sentinel existed).
2. single-open-review was check-then-insert -> nullable openWorkflowId
   sentinel + plain UNIQUE (NULLs distinct on both drivers, so no partial
   index), new migration that resolves pre-existing duplicates then backfills.
3. a pin from ANOTHER workflow was accepted (FK only checks globally-unique
   versionId) -> (workflowId, versionId) validated on create AND re-pin;
   zero-row metadata update is now an error.
4. transfer cleanup moved INTO the ownership transaction (not merely earlier);
   required threading OperationContext through SharedWorkflowRepository
   .transferOwnership + FolderRepository (promoted to BaseRepository).
5. deletion orphans -> pre-delete failures propagate, post-delete sweeps
   linkless requests.

**REVIEW CLEARED** the hand-rolled inbox EXISTS filter (matches
WorkflowFinderService/userHasScopes incl. personal-project semantics), cursor
tampering, all 8 routes' authz, author-self-approval, and the pruning SQL.

**RESIDUAL LIVE DEFECT -> #18.** expectedVersionId is OPTIONAL so the existing
frontend keeps working; a NON-racing re-pin can therefore still approve an
unreviewed version. Framed as a live defect, not a caveat. Backend needs
nothing more — both responses already carry the value to echo back.

**BEHAVIOUR CHANGE worth knowing:** a review-closure failure now FAILS the
enclosing transfer/delete instead of being swallowed (project deletion and
user deletion loop WorkflowService.delete).

**PRE-EXISTING BUG FOUND+FIXED:** an inline `await` inside a `.send()` payload
literal in the api spec — the request starts during the await so the body is
empty. SQLite was fast enough to hide it; Postgres wasn't.

**NEXT.** E10 (multi-main) is the LAST Phase-E item, then A10.

## 2026-08-10 — E10 DONE (multi-main) — 3 P0 split-brain defects found and fixed

**LAST PHASE-E ITEM.** MultiMainSetup + WorkerStatusService rebuilt at fair-code
paths on top of the surviving leader-election-client.

**THE REVIEW EARNED ITS KEEP AGAIN — 276 specs passed, then codex found 3 P0s:**
1. hostId was the lock-owner token, but Docker derives it from the hostname and
   this repo ALREADY detects live host-ID clashes -> two mains sharing one could
   both renew/delete the same lease. Now an unguessable per-acquisition token,
   minted BEFORE the SET NX so a timed-out claim that reached Redis is still
   recognised as ours.
2. Reading our own key via GET promoted without an atomic renew -> a follower
   could promote on an about-to-expire key. Now compare-and-renew; key-missing
   falls through to NX; another owner stays follower.
3. Leadership was not bounded by the lease: takeover handlers ran INSIDE the
   in-flight guard, so a slow handler blocked renewals until the key expired.
   Handlers now run in a serialized queue outside the check; a dedicated 500ms
   watchdog demotes before the last PROVEN deadline (measured from when the
   proof was SENT, not when it resolved); config requires
   interval + command-timeout + margin < ttl (ttl=2/interval=1 now rejected).
Plus: subscribe-before-start, unconditional release after draining, fail-stop on
failed stepdown teardown, get-worker-status made immediate (two users' requests
were collapsing), requestingUserId no longer echoed to the browser.

309 scaling tests; 9 mutation tests each caught their target. One mutation came
back CLEAN first time — the agent had assigned a handler promise without
awaiting; corrected, it failed 2 tests. Good example of mutation testing finding
a weak test rather than weak code.

**STILL OPEN -> #20:** a lease alone cannot survive a process pause or Redis
failover; only fencing/generation tokens threaded through leader-only work close
that. Deliberately out of scope.

**MY PROCESS ERROR (fixed, and worth not repeating).** I ran `git add -A` in a
worktree where the E10 subagent was mid-edit, so my small cross-package commit
absorbed ~590 lines of its in-flight hardening under a message documenting none
of it. Branch was unpushed, so I split it: soft-reset, recommitted with EXPLICIT
paths, and verified `git rev-parse HEAD^{tree}` matched byte-for-byte before and
after. RULE: when a subagent is editing the same worktree, stage explicit paths —
never `git add -A`.

## 2026-08-10 — SESSION END — resume state

**MASTER: 29/40 items pass, clean, synced.** Phase E complete except E19.

**IN-FLIGHT WHEN STOPPED (nothing lost, but nothing verified):**
- Branch `fix/shared-role-types`, commit `666ce906b0`, pushed, marked
  **WIP/UNVERIFIED — DO NOT MERGE**. Partial Buckets 1-6 (shared role types).
  4 files touched: permissions `types.ts`, `constants.ts`,
  `roles/custom-role-scopes.ts`, i18n `en.json`. ZERO gates were run.
  **Resume:** re-verify each bucket against fair-code evidence, then run
  permissions 105/105, api-types 1773, db 409/409, cli tsc-count-not-increased
  vs master, role.service + project/users role-assignment specs, eslint.
  Reject any bucket whose evidence doesn't hold rather than applying it.

**WHY THOSE BUCKETS MATTER (verified by me, these are MY bugs):**
1. `AssignableProjectRole` = `Exclude<ProjectRole,'project:personalOwner'>`
   CONTRADICTS its own runtime validator `teamRoleSchema` (schemas.ts:75),
   which accepts `/^(project|custom):.+/`. Custom project roles ARE
   assignable. Should mirror `AssignableGlobalRole` (already `string`).
2. `RoleObject` (= `Role`, schemas.ts:108) lacks `usedByUsers`/`usedByProjects`,
   but `RoleService.dbRoleToRoleDTO` (role.service.ts:61) ALREADY RETURNS them.
   The backend sends fields the type denies.

**NEXT TASK IN ORDER:**
1. Finish + verify Buckets 1-6 (unblocks the other agent's editor-ui: their 166
   remaining vue-tsc errors are ALL waiting on this).
2. **E19-execution-annotations** — the last Phase-E item, and it also unblocks
   A10: `start.test.ts` collects 0 tests solely because `server.ts:35` imports
   the missing `annotation-tags.controller.ee`. FROZEN CONTRACT from the A11
   agent is in `/tmp/agent-comms.md` on host `n8n` (message
   "FROZEN annotation contract for E19"), key points:
   - tags CRUD at `/rest/annotation-tags` (generic `createTagsStore` base),
     name <= 24 chars
   - `PATCH /rest/executions/:id` `{tags?: string[], vote?: 'up'|'down'|null,
     note?: string}`, upsert ONE annotation per execution
   - PATCH MUST return the FULL updated `ExecutionSummary` (scopes + embedded
     annotation), NOT a bare annotation — the surviving store does
     `addExecution(response)`
   - `note` must appear in the embedded `annotation` on list/get AND PATCH
   - ALSO MINE: add `note?: string` to `ExecutionSummary.annotation` in
     `packages/workflow`
   - the annotation store/api SURVIVED as fair-code (only the 4 Vue components
     were purged), so those clients pin the routes exactly
   - restore what A8b stripped from `@n8n/db` execution.repository.ts
     (serializeAnnotation, includeAnnotation across 4 findSingleExecution
     overloads + findIfShared, the softDeletePrunableExecutions exclusion
     subquery, the raw-SQL WithAnnotations list flow)
3. A10-cli-green sweep (also resolves issue #8).

**AGREED WITH THE A11 AGENT:** merge **E19 before their A11 PR #22**, so
annotations aren't dark on master. They are watching agent-comms AND
origin/master and will auto-resume.

**OPEN ISSUES:** #7 node-rsa override (needs Greg's call — repo-wide dep pin),
#8 tags authz (A10), #13 unshare cleanup (@n8n/db + own gate), #18 decide
`expectedVersionId` (A11 agent owns the FE half), #20 multi-main fencing
(architectural).

**AWAITING GREG:** the annotations (A) drop override — standing policy is
rebuild, which is what both agents are doing; cheapest to reverse before E19.

## 2026-08-10 — E19 DONE (backend) + a scope-catalog bug found on the way

**BRANCH HYGIENE FIRST.** `fix/shared-role-types` sat on stale master behind a
commit titled "wip … UNVERIFIED". `fix/shared-role-types-verified` was NOT a
second implementation — the reflog shows it is a changelog-only commit made by
accident on master. Rebuilt as `fix/shared-role-types-v2` on current master, two
clean signed commits, permissions 105/105 re-run on the new base → **PR #23**.
Old refs left for Greg to delete.

**FOUND WHILE MEASURING THE BASELINE (→ PR #23, 3 more commits).** The API-key
catalog and the public API's own `x-required-scope` had drifted: 88 scopes
required by routes, 80 declared, **8 missing**. Not cosmetic — `getApiKeyScopesForRole`
filters by the catalog, so an undeclared scope can never be granted and its route
403s for everyone. The parity test only asserted catalog ⊆ required, never the
converse, which is why it stayed green. Fixed both directions; `execution:stop`
needed a second commit because it was not an RBAC scope at all (adding it writes
one new `scope` row on each instance's next boot — no migration, the table syncs
from ALL_SCOPES).

**AND A BIGGER ONE → ISSUE #24.** 13 further API-key scopes (`dataTableRow:*`,
`dataTableColumn:*`, `executionTags:*`, `testRun:create|cancel`) have no exact-slug
counterpart in `RESOURCES`, so they are ungrantable and their routes 403 for
everyone. Proven, not theorised: `public-api/evaluations.test.ts` is 12 failed /
11 passed, every failure an unexpected 403, and it reproduces identically with
`constants.ts` reverted to the branch base. Needs a deliberate
`ApiKeyScope -> Scope` bridge, so it got its own issue rather than being absorbed.

**E19 (branch `feat/defork-e19-execution-annotations`).** 3 entities + 3
repositories in `@n8n/db`, the `execution.repository.ts` paths A8b stripped, a
fair-code `annotation-tags.controller.ts`, and `note` threaded end to end.
cli tsc **32 → 16, 0 new**. Everything green: db 411/411, workflow 5510/5510,
cli executions 231/231, `execution.service.integration` 37/37 (was 32/37 — the 5
failures were the annotated-list specs, which pinned the contract better than any
note could), executions.controller 15/15, pruning 22/22, new annotation-tags api
9/9.

**TWO THINGS THE SURVIVING TESTS TAUGHT ME, both of which I had guessed wrong:**
1. Every summary must carry `annotation: {tags, vote}` even when unannotated, and
   the list annotation carries **no** `note` (the specs use `toEqual`, so adding
   one breaks them). My first design only attached annotations when filtering.
2. Attaching annotations must NOT be a join on the list query — a tag join
   multiplies rows and `LIMIT` would truncate executions instead of tags. It is a
   second query keyed on the already-paginated ids.

**MUTATION-TESTED** the two behaviours with no natural failure signal: removing
the prune exclusion fails 2 specs; reverting the field-wise upsert fails 2. Both
load-bearing.

**CORRECTION TO THE LAST SESSION'S NOTE.** E19 does **not** unblock A10 on its
own. `start.test.ts` still collects 0 tests — the second blocker is
`@n8n/ai-workflow-builder` via `ai.controller.ts`. There were two blockers; this
closed one. (Filed as **E20** on 2026-08-10 — I originally wrote "item C2" here,
which was wrong and created a cycle: C2 is `blocked_by` A12, which needs A10,
which needs this package. See E20's note.)

**DOC BUG WORTH FIXING:** `AGENTS.md` says a single test file runs with
`pnpm test <file>`. Integration specs need `pnpm test:integration <file>`;
`pnpm test` reports "No test files found" for them.

**NEXT:** rebuilding `@n8n/ai-workflow-builder` is the thing standing between here
and A10-cli-green — tracked as **E20**, not C2 (see the correction above). Then #24.

## Agent-comms channel — where it is and how to write to it

**The channel is `/tmp/agent-comms.md` on host `n8n`** (ssh alias `n8n`, in
`~/.ssh/config`). Not on this box. I lost an afternoon to that once: the loop
runs on `victus`, so checking `/tmp` locally shows nothing and looks exactly
like the thread was wiped. It was not.

Do **not** move this into the repo. Tried it; reverted. A channel you have to
commit, push and merge before the other agent can read it is not a channel —
and a committed mirror drifts out of sync the moment either side posts.

**Read:**
```
ssh n8n 'tail -80 /tmp/agent-comms.md'
```

**Write — in place, as the `n8n` user:**
```
ssh n8n "su -s /bin/bash n8n -c 'cat >> /tmp/agent-comms.md'" < note.md
```
Root **cannot** append to that file on that box (never established why — no
immutable flag, `/tmp` is writable, `test -w` even says yes). Do not work around
it with copy → append → `mv`: that replaces the inode, which drops any
concurrent post from the other agent and leaves the file root-owned, silently
locking them out. A previous session did exactly that and broke their write
access for seven minutes.

**Local recovery copy:** `~/.defork-backup/agent-comms.md` — refresh it with
`scp n8n:/tmp/agent-comms.md ~/.defork-backup/agent-comms.md` after posting, so
the thread can be restored verbatim if `/tmp` is cleared. Recovery only; it is
not a second channel.

## 2026-08-10 — SESSION END (2) — resume state

**MASTER: 31/41 pass, clean, synced at `daa7ee78c0`. No open PRs.** Phase E is
complete except the item split out below. Nothing is half-built: every branch
this session was merged and deleted.

**MERGED TODAY:** #23 (shared role/scope types + 8 missing API-key scopes),
#29 (E19 execution annotations), #28 (13-scope API-key bridge, closes #24),
#22 (A11 editor-ui, the other agent's). `packages/cli` tsc: **66 → 16**.

**STOPPED HERE — E20, nothing written yet.** Rebuild the purged
`@n8n/ai-workflow-builder`. Tracking and contract derivation are DONE and live
in the E20 item in `feature_list.json`; the code is not started. Resume by
reading that item's note first — it has the four layers and the contract source,
so none of it needs re-deriving.

- Layers 1–3 (tool descriptors + `SDK_IMPORT_STATEMENT`; parse/validate;
  session storage) are derivable from the ~12
  `vi.mock('@n8n/ai-workflow-builder', …)` blocks and were what I was about to
  build. Each mock carries the real `toolName` for the tool its file tests and
  placeholders for the others, so read the value from its OWN test. Tool names
  are independently corroborated by the public n8n MCP tool surface.
- **Layer 4 is the risk** — `AiWorkflowBuilderService` + `ChatPayload` +
  `createPassthroughSsrfGuard` + `ResourceLocatorCallbackFactory`, an LLM agent
  behind `@Licensed('feat:aiBuilder')`/`feat:aiGateway` in `ai.controller.ts`.
  **Do not stub it silently.** It must fail loudly when unavailable — the
  `OWNER_API_KEY_SCOPES` bug earlier today was exactly that shape: a symbol that
  satisfied a check while production used a different path. Greg wants eyes on
  this design before it is committed to.

**DELEGATION IN FLIGHT (no reply yet).** Asked the A11 agent, via
`/tmp/agent-comms.md` on host `n8n`, to extract the `/ai/build` wire contract
from the surviving `packages/frontend/editor-ui/src/features/ai/assistant/`
client + its tests — routes, `ChatPayload` shape, whether it streams and the
framing, error/abort behaviour, session continuity (which pins layer 3). That is
the thing layer 4 cannot be safely designed without. Their reply will be in that
file. They were told to mark anything the FE does not pin as "not pinned"
rather than guess.

**THE WATCHER DIES WITH THE SESSION.** A `Monitor` was polling
`n8n:/tmp/agent-comms.md` every 60s, emitting one event per new post from the
other side and refreshing `~/.defork-backup/agent-comms.md`. Session-scoped, so
it is gone — re-arm it on resume, or just read the file. Nothing is lost either
way; the file on host `n8n` is durable.

**CORRECTED TODAY, worth not re-breaking:**
- `@n8n/ai-workflow-builder` is **E20, not C2**. Filing it under C2 made the
  board circular (C2 `blocked_by` A12 → A10 → this package).
- **A10 is not blocked by annotations.** E19 closed one of two blockers;
  `start.test.ts` still collects 0 tests because of this package.
- A11 was passing but unflipped — nobody ran its gate after #22.

**OPEN ISSUES:** #26 (API keys derive scopes from the global role only, so
members get 7 of 88 — the structural half of #24), #20 (multi-main fencing),
#18 (review/version binding; FE half landed in #22, backend half open),
#13 (unshare cleanup), #8 (public API tag delete), #7 (node-rsa override —
needs Greg's call on a repo-wide pin).

**ALSO UNTRACKED:** GitHub reports 159 Dependabot vulnerabilities on master
(2 critical, 44 high), inherited from upstream. Not in `.defork/` anywhere.

**ORDER ON RESUME:** E20 layers 1–3 → read the A11 reply → design layer 4 with
Greg → A10 → A12 → A13. C2 only after A12.

## 2026-08-11 — E20 DONE: `@n8n/ai-workflow-builder` rebuilt fair-code

**Board: 32/41.** Branch `feat/e20-ai-workflow-builder`, not pushed.

**Built `packages/@n8n/ai-workflow-builder`** (no `.ee`), single CJS build
mirroring `@n8n/workflow-sdk` rather than `ai-utilities`' dual ESM/CJS — the
only consumer is `packages/cli`, which is CJS, and the SDK it depends on is
CJS-only. Deps kept to four: `@langchain/core`, `@n8n/utils`,
`@n8n/workflow-sdk`, `n8n-workflow`.

**Layers 1–3 are real.** The MCP builder tools parse and validate actual SDK
code again; the session repository has its contract back. Layer 2 is
orchestration over `@n8n/workflow-sdk` (`parseWorkflowCodeToBuilder`,
`validateWorkflow`, `ValidationWarning`) — no parsing or validation was
reimplemented.

**Layer 4 is a loud-failing seam** (Greg's call, both options taken as
recommended). Real 13-arg constructor and lifecycle; `chat()` and
`getBuilderInstanceCredits()` throw `AiBuilderUnavailableError`; storage-only
operations run for real. `getSessions` throws rather than reporting `[]` when a
conversation exists — those turns are in the agent's encoding and telling a user
their history is empty is a different, wrong statement. Routes stay registered.

**THREE THINGS THE CONTRACT DERIVATION GOT WRONG, now proven:**
- `CODE_BUILDER_VALIDATE_TOOL.toolName` is **`validate_workflow`**, not the
  mocks' `validate_workflow_code`. `mcp-scopes.ts` grants by it and
  `mcp-scopes.test.ts` (unmocked) has drift guards both ways. The mocks are
  authoritative for `displayTitle` only — `mcp-scopes.ts` owns `toolName`.
- `parseAndValidate` **throws** on invalid input; there is no `errors` field on
  its result. Consumers report failures from their `catch`. Parse failures must
  carry `name === 'WorkflowCodeParseError'` or `getSdkReferenceHint` silently
  drops the hint that tells a failing client how to recover.
- `reranker` is in the SDK's import line and in the AST interpreter's
  `sdkFunctions` table, but is **not** re-exported from `@n8n/workflow-sdk`'s
  index. A test written against package exports fails; the interpreter's table
  is what actually resolves these names. Anchored the test to the SDK's own
  `WORKFLOW_PATTERNS_DETAILED` instead.

**VERIFIED** against the same tree with the package stashed out: cli
`Cannot find module` 10 → **0**; cli typecheck total 80 → **68**, with a
line-by-line diff showing **zero new errors** and 2 pre-existing cascading ones
fixed; `start.test.ts` **0 → 9 tests** (the recorded symptom, closed);
`mcp-scopes.test.ts` file-failed → **15 passed**;
`mcp.settings.controller.api.test.ts` file-failed/28-skipped → **26 passed**;
cli MCP + workflow-builder + builder-service **1224/1226**. New package **62
tests**, typecheck and lint clean.

**A10 IS RED FOR OTHER REASONS — this is the next real finding.**
`pnpm --filter n8n build` now clears module resolution and fails on **31
pre-existing `src/` errors** that have nothing to do with this package:
`source-control-import.service.ts` (12 × TS6138, unused injected dependencies —
the code that used them was almost certainly `.ee`), `workflows.controller.ts`
(5 × `ProjectSummary`/`shared` mismatches plus 2 stale `@ts-expect-error`),
`evaluation/test-runner/test-runner.service.ts`, and
`source-control-status.service.ts`. **E20's verify clause was corrected** — it
was `pnpm --filter n8n build`, a gate this item can never satisfy alone.

**2 SPECS NEWLY EXPOSED — MECHANISM CERTAIN, VERDICT NOT.** Not a regression:
`mcp.settings.controller.api.test.ts` could not load at all before this change
(28 skipped), and now runs 26/28. The two failures mint users with role
`global:member`; `GET /mcp/api-key` is guarded by
`@GlobalScope('mcpApiKey:create')`, and `GLOBAL_MEMBER_SCOPES` does not carry
it, so they 403.

**I first recorded this as a proven missing grant. That was overstated** — the
surviving fair-code leans the other way:
- `custom-role-scopes.ts` files `mcpApiKey:create`/`rotate` under
  **`settings.Manage`**, the admin bundle.
- editor-ui's `features/ai/mcpAccess/module.descriptor.ts` gates the entire MCP
  settings page on `['mcp:manage','mcp:oauth','mcpApiKey:create','mcpApiKey:rotate']`,
  so no personal MCP-key control is surfaced to a plain member anyway.
- Both specs are really asserting key **uniqueness**; `global:member` is just a
  cheap way to mint five distinct users. The sibling test at line 55 uses
  `owner` and passes.

So the likely fix is to switch those two specs to an entitled role, **not** to
widen `GLOBAL_MEMBER_SCOPES`. Do not add the scopes without deciding this:
widening a role grant on the strength of a stale spec is the one change here
that is genuinely hard to walk back.

**ORDER ON RESUME:** settle the 2 specs above (spec fix vs. grant) → A10's 31
errors → A12 → A13. C2 (the actual agent) only after A12.
