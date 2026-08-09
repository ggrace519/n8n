# De-fork Changelog

A running log of the work to turn this fork into a fully fair-code (Sustainable
Use License) build by removing all Enterprise-licensed (`.ee`) code and rebuilding
chosen features with clean-room replacements.

**Provenance rule (applies to every entry below):** replacements are written
clean-room — derived only from fair-code *consumers*, public standards/specs, and
this repo's own fair-code. No `.ee` file body (current tree, git history, other
branches, or upstream) is ever read to produce a replacement. See the fork policy
in `AGENTS.md`.

Format follows [Keep a Changelog](https://keepachangelog.com/). Dates are ISO-8601.

---

## [Unreleased]

### 2026-08-08 — Repo severed from upstream & Enterprise code purged

**Removed**
- Purged **all Enterprise-licensed code** from the working tree *and* full git
  history via `git filter-repo --invert-paths --path-regex '\.ee(\.|/)'`.
  - 1,117 files removed from the current tree; 1,805 distinct `.ee` paths removed
    across all 22,816 commits (281 commits that only touched `.ee` files became
    empty and were pruned → 22,535 commits remain).
  - Post-purge verification: 0 `.ee` files in the tree, 0 `.ee` paths in history,
    0 `.ee` blobs reachable in the object graph.
  - Covered whole packages/areas including `@n8n/ai-workflow-builder.ee` (AI
    Builder), `evaluation.ee`, `dynamic-credentials.ee`, `source-control.ee`,
    `external-secrets.ee`, `sso-saml`/`sso-oidc`, `ldap.ee`, `log-streaming.ee`,
    `environments.ee` (variables), `provisioning.ee`, `workflow-reviews.ee`, the
    `@n8n/permissions` `.ee` API, `@n8n/db` `.ee` entities/repositories, core
    service halves (`workflow`/`credentials`/`execution`/`project`/
    `annotation-tag`.service.ee), and `@n8n/blob-storage` S3/Azure stores.

**Infrastructure / process**
- GitHub fork relationship detached (repo is no longer a fork of `n8n-io/n8n`).
- Safety bundle of the pre-purge repo written off-repo for disaster recovery
  (to be deleted once the rebuild is verified green).
- Produced a fair-code-only rebuild inventory + consumer-derived contract
  (`scratchpad/STEP0-inventory-and-runbook.md`, `contract.json`) — built without
  reading any `.ee` body.

### 2026-08-08 — Recontamination guardrails

**Added / Changed**
- Hardened the `no-import-enterprise-edition` ESLint rule
  (`packages/@n8n/eslint-config/src/rules/`) to ban **all** `.ee` references —
  `.ee/` dirs, `.ee.` filename infixes, and bare `.ee` suffixes — across
  imports, re-exports (`export … from`, `export *`), and dynamic `import()`.
  Removed the previous exemptions for `.ee` files and integration tests.
- Enabled that rule in the shared recommended config (`plugin.ts`) so it runs
  repo-wide as an error.
- Added a "Fork policy: no Enterprise (`.ee`) code" section to `AGENTS.md`.

### 2026-08-08 — Post-purge dependency cleanup

**Changed**
- `packages/cli/package.json`: removed the dangling `@n8n/ai-workflow-builder`
  (`workspace:*`) dependency — that package (`ai-workflow-builder.ee`) was purged,
  so the reference blocked `pnpm install`. It was the only dangling workspace dep
  (77 workspace packages remain). Install proceeds after removal.

### 2026-08-08 — Tier-0 rebuild started: `@n8n/permissions` catalog + types

**Clean-room method:** the purge kept the package's *test* files (no `.ee` in
their names) — they specify the deleted modules' exact behavior and are fair-code.
Rebuilding to satisfy them = clean-room spec + built-in verification.

**Added (fair-code replacements for deleted `.ee` modules):**
- `constants.ts` — the `RESOURCES` catalog (46 resources / 180 scopes),
  `API_KEY_RESOURCES`, and the built-in role slugs
  (`project:personalOwner|admin|editor|viewer|chatUser`). Order reconstructed
  exactly from the fair-code `scope-information` snapshot.
- `types.ts` — `Scope`/`ApiKeyScope` (derived from the catalog), `Resource`,
  `ScopeLevels`/`MaskLevels`/`ScopeOptions`, the role-slug unions, `RoleObject`,
  `AllRolesMap`, `AuthPrincipal`, `ScopeInformation`.
- Repointed `scope-information.ts` and `__tests__/types.test.ts` off the deleted
  `.ee` paths onto the new modules.

**Verified:** `scope-information.test.ts` snapshot passes (catalog byte-exact) and
`types.test.ts` typechecks (scope typing correct). `constants/types/scope-information`
typecheck clean in isolation.

**Still to rebuild in `@n8n/permissions`:** `schemas.ts` (zod role schemas),
`roles/scopes/*` + `role-maps.ts` (per-role scope sets), the `utilities/*`
(`hasScope`, `hasGlobalScope`, `combineScopes`, `getResourcePermissions`,
`getRoleScopes`, `getGlobalScopes`, `staticRolesWithScope`, `getAuthPrincipalScopes`),
`custom-role-scopes.ts`, `public-api-permissions.ts`, then rewrite `index.ts` and
fix `all-roles.ts`.

### 2026-08-08 — `@n8n/permissions` fully rebuilt (Tier-0 complete)

**Added (clean-room fair-code replacements, verified against surviving tests):**
- `schemas.ts` — zod role schemas (`roleNamespaceSchema`, `globalRoleSchema`,
  `assignableGlobalRoleSchema`, `systemProjectRoleSchema`,
  `assignableProjectRoleSchema`, `projectRoleSchema`, `teamRoleSchema`,
  `credentialSharingRoleSchema`, `workflowSharingRoleSchema`,
  `customProjectRoleSchema`, `roleSchema`, `scopeSchema`, `type Role`).
- `roles/scopes/*` — per-role scope sets (global owner/admin/member/chatUser,
  project owner/admin/editor/viewer/chatUser, credential/workflow/secrets sharing)
  graded community-equivalent (owner = full catalog, graded down), built from the
  RESOURCES catalog via a shared `scope-filters` helper.
- `roles/role-maps.ts` — the five role→scope maps.
- `utilities/*` — `combineScopes`, `hasScope`, `hasGlobalScope`, `getGlobalScopes`,
  `getRoleScopes` + `COMBINED_ROLE_MAP`, `getAuthPrincipalScopes`,
  `staticRolesWithScope`, `getResourcePermissions` + `PermissionsRecord`.
- `roles/custom-role-scopes.ts` — custom-role whitelists, operations, and scope
  groups. `public-api-permissions.ts` — API-key scope helpers.
- Rewrote `index.ts` and fixed `all-roles.ts` + all surviving test imports off the
  deleted `.ee` paths.

**Verified:** `pnpm --filter @n8n/permissions typecheck` clean; **105/105 tests
pass** across 12 files. The RBAC foundation (172 downstream consumers) is green.

**Design note:** per-role scope *assignments* were only partially pinned by the
surviving tests, so they were designed community-equivalent and satisfy every
behavioral assertion (createEndUser grants, member/chatUser exclusions, owner/admin
coverage). Runtime authz can be tuned later without breaking the build.

### Pending — Rebuild to a green build (clean-room)

Known breakage after the purge: **442 fair-code files** import the removed `.ee`
layer. Rebuild order:
1. **Tier 0 — foundational plumbing** (must exist before anything compiles):
   `@n8n/permissions` public API (172 consumers), `ProjectService` (49),
   `@n8n/db` `.ee` entities/repositories (29), core service halves.
2. **Tier 1 — feature modules** (source control, variables, SSO, external
   secrets, LDAP, log streaming, etc.) — reimplement the chosen ones.
3. **Tier 2 — frontend** (253 editor-ui files).

Fair-code features that only need the license *gate* removed (no reimplementation
— they had no `.ee` files): **Insights** dashboard, **Folders**, **instance-ai**
backend module.

### 2026-08-08 — Downstream build unwiring (blob-storage, rest-api-client, db, permissions)

**Build progress:** 51/59 packages build (was 45). Fixed in topological order:
- `@n8n/blob-storage` — dropped purged S3/Azure object-store exports (local
  FsByteStore stays); cli tsconfig no longer references purged ai-workflow-builder.
- `@n8n/rest-api-client` — dropped purged eventbus/externalSecrets/secretsProvider
  frontend API re-exports.
- `@n8n/permissions` — **fixed `Role` to be the role DTO (`RoleObject`)** not the
  slug string (db's `builtInRoleToRoleObject` proved the shape); added
  `getApiKeyScopesForRole({ role })`; added `settings.ts`
  (`PERSONAL_SPACE_PUBLISHING_SETTING`, `PERSONAL_SPACE_SHARING_SETTING`,
  `EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING`). Still builds + 105 tests pass.
- `@n8n/db` (partial) — removed purged `.ee` entities from the entity barrel +
  registry; stripped the `annotation`/`testRuns` relations from the core
  `execution`/`workflow` entities; deleted purged-feature repositories
  (evaluation-*, workflow-review-request*, execution-annotation) and their barrel
  exports; removed review-request logic from `workflow-history.repository`; deleted
  orphan `get-final-test-result` util.

**Remaining for `@n8n/db` green (next iteration):** `execution.repository.ts` still
has the execution-annotations feature woven into its core list flow
(`findManyByRangeQuery` → `toQueryBuilderWithAnnotations` →
`reduceExecutionsWithAnnotations`, plus a prune-exclusion subquery and
`findSingleExecution` handling). Strip it carefully and verify against the
surviving execution.repository tests — the raw-SQL column mapping must stay correct.

### 2026-08-08 — E1: RBAC access layer rebuilt fair-code (`check-access` + `ProjectScopeService`)

**Added (clean-room rebuild of purged `permissions.ee` cli modules)**
- `packages/cli/src/permissions/check-access.ts` — `userHasScopes(user, scopes,
  globalOnly, {credentialId?|workflowId?|projectId?|dataTableId?}, trx?)`.
  Global pass requires the user's global role to hold **all** scopes
  (`hasGlobalScope(..., {mode:'allOf'})`); otherwise resolves the projects where
  the user's project role grants all scopes and checks the resource against
  them. Workflows/credentials additionally require a sufficient sharing role on
  the same resource↔project relation. Throws `NotFoundError` for nonexistent
  resources (callers answer 404 vs 403) and `UnexpectedError` when no resource
  id is in context.
- `packages/cli/src/permissions/project-scope.service.ts` —
  `ProjectScopeService.getProjectIds(user, scopes): string[] | null`
  (`null` = global access, callers treat as unfiltered).
- Unit tests: `src/permissions/__tests__/` (22 tests: allOf semantics, same-row
  sharing/project correlation, cross-row denial, 404-vs-403, trx threading,
  extra-param tolerance).
- `@n8n/db` `ProjectRelationRepository.getAccessibleProjectsByRoles` gained an
  optional `trx?: EntityManager` (transactional callers, e.g. workflow creation).

**Clean-room sources:** consumer call sites (41 files: `controller.registry.ts`,
`public-api` middlewares/registry, `workflow-finder.service.ts`
`buildSingleWorkflowReadWhere` for the sharing-role AND project-role pattern,
`agent-mcp-access.service.ts` for the `null` contract), surviving consumer test
mocks, `@n8n/permissions` utilities, `@n8n/db` repositories. No `.ee` source read.

**Verification:** repo-wide `permissions.ee` refs = 0; cli tsc has 0 errors in
`src/permissions/` and 0 at rewired call sites (error count 1046→1045, delta is
exactly the fixed call-site arity); 22/22 new unit tests, 409/409 `@n8n/db`
tests, 107/107 rewired-consumer unit tests pass. Independent codex (OpenAI)
review of the diff: blocker (missing trx param) found and fixed; test-coverage
findings addressed.

### 2026-08-08 — A7: ProjectService rebuilt fair-code

**Added (clean-room rebuild of purged `services/project.service.ee.ts`)**
- `packages/cli/src/services/project.service.ts` — 24 methods +
  `TeamProjectOverQuotaError` / `UnlicensedProjectRoleError` (messages pinned
  byte-exact by surviving `project.api.test.ts` / `public-api/projects.test.ts`).
  Semantics derived from consumers and surviving specs: quota-guarded
  transactional team-project creation (`quota:maxTeamProjects`, -1 unlimited);
  `getProjectWithScope` (global allOf, else project-role membership, optional
  EntityManager); add/sync membership with role-existence checks and
  license checks on newly-granted roles only (re-asserting a held role stays
  license-free — pinned by the re-add-admin integration test);
  conflict-semantics adds (409 only on role mismatch, same-role re-add = 200
  no-op); personal projects 404 on update; delete with resource cleanup
  (mirrors the fair-code `users.controller` user-deletion recipe) or transfer
  gated on `workflow:create`+`credential:create` in the target (404 otherwise);
  DI cycles broken via lazy `await import(...)` like the rest of the codebase.
- `@n8n/db` use-case repo methods: ProjectRepository.{createTeamProjectUnderLimit,
  findById, findByIdForUserWithRoles, getExistingProjectIds, findByIds},
  ProjectRelationRepository.{findRelation, getRelationsForProject,
  getRelationsForUser, upsertRelation, replaceAllRelationsForProject,
  removeRelation}.
- `@n8n/permissions` fixes surfaced by consumer typechecking + surviving tests:
  added missing `AssignableGlobalRole` (= string; custom roles are free-form);
  `assignableGlobalRoleSchema` now rejects only `global:owner` (error message
  pinned by api-types tests, custom global roles pass);
  `projectRoleSchema`/`teamRoleSchema` accept generated custom project slugs
  (`project:<name>-<suffix>` per `RoleService.createCustomRole`), personalOwner
  still not team-assignable. api-types `projectRelationSchema` role →
  `teamRoleSchema`. cli `GetMyProjectsResponse.role`/mailer `newSharees.role` →
  string.

**Known deviation:** non-transfer project deletion removes owned resources via
the permission-aware `WorkflowService.delete`/`CredentialsService.delete`
(the same recipe the fair-code `users.controller` uses); a custom role holding
`project:delete` without resource-delete scopes could leave orphans. Tracked
for the A10 sweep.

**Clean-room sources:** 42 consumer files (project.controller, public-api
projects handler + middlewares, credentials/workflow services, n8n-packages
importers/exporters, instance-ai adapter), surviving integration specs
(project.service.test.ts, project.service.integration.test.ts,
project.api.test.ts, public-api/projects.test.ts), @n8n/db repositories,
@n8n/permissions. No `.ee` source read. Contract inventory cross-checked by an
independent codex (OpenAI) read-only pass; its review found 10 issues (2
blockers) — 8 fixed, 1 retained as documented deviation, 1 was this entry.

**Verification:** `project.service.ee` refs repo-wide = 0; cli tsc 968→946
errors with zero regressions (remaining errors belong to other un-rebuilt .ee
subsystems); integration 25/25; @n8n/permissions 105/105; @n8n/api-types
1773/1773 (fixed 3 pre-existing failures); @n8n/db 409/409; eslint clean on
changed files (ratchet allowlist entries carried over for the renamed/rebuilt
files, not new leaks).

### 2026-08-08 — E2: variables subsystem rebuilt fair-code (+ boot-chain slices of E3/E8/E12/E13)

**Added (clean-room rebuilds of purged `environments.ee/variables` + boot-chain deps)**
- `packages/cli/src/variables/{variables.service.ts,variables.controller.ts}` —
  full variables subsystem: cache-backed reads (`getAllCached`/`getCached`/
  `updateCache`), user-visibility filtering (`getAllForUser`: global variables +
  projects where the role grants `projectVariable:read`; owner unrestricted),
  quota (`getRemainingVariableQuota` → `{limit,remaining}|null`), create/update/
  delete with per-destination key uniqueness and `VariableCountLimitReachedError`
  for both quota and duplicate (one error type — the package importer's pinned
  race-recovery contract), REST routes with `variable:*` global scopes +
  `feat:variables` license gates on mutations.
- Boot-chain slices (each unblocked the variables spec's app boot):
  `src/evaluation/evaluation-concurrency.helper.ts` (E13 slice; env override →
  license quota → unlimited), `src/modules/source-control/
  source-control-preferences.service.ts` + types (E3 slice; settings-persisted
  prefs, branch guards), `src/modules/external-secrets/{external-secrets.config,
  secret-provider-access-check.service,secrets-provider-connection.repository}`
  (E8 slice; empty project-access = global provider), `src/modules/
  dynamic-credentials/services/shared-fields.ts` (E12 slice; changed
  non-resolvableField names).
- Fixes surfaced by newly-runnable suites: `getApiKeyScopesForRole` now takes an
  `AuthPrincipal`-shaped input (was slug-array; every cli caller passes scope
  OBJECTS — API keys got empty scope sets → public-api 403s); A8c's migration
  workaround reverted accordingly. `API_KEY_RESOURCES` catalog completed
  (`variable:update`, `credential:list`, folder/eventBusDestination/ldap/oidc/
  otel/saml/securitySettings entries the public-api handlers use). Public-api
  variables create handler now returns the created variable (spec pins
  `response.body.id`; the surviving handler discarded it). `GLOBAL_MEMBER_SCOPES`
  drops global `projectVariable:{read,list}` (visibility comes from project
  roles — pinned by the public-api cross-project test).

**Clean-room sources:** surviving specs (`test/integration/variables.test.ts`,
`public-api/variables.test.ts`), consumers (workflow-helpers, n8n-packages
variable importer/exporter, public-api handlers, telemetry, data-table branch
guards, concurrency-control), api-types DTOs, db entities, FE mock-server
preferences shape. No `.ee` source read.

**Verification:** `environments.ee` refs = 0 repo-wide; REST spec 23/23; 111
variable-consumer unit tests; api-key tests 14/14; permissions 105/105;
api-types 1773/1773; db build + 409/409; cli tsc 946→815 with zero regressions.
Deferred to later gates: public-api variables spec (blocked by E15
credentials.service.ee in the shared public-api router init) and the
n8n-packages variable integration specs (blocked by E14 workflow.service.ee).

### 2026-08-08 — E15: sharing-aware credential operations rebuilt fair-code

**Added (clean-room rebuild of purged `credentials/credentials.service.ee.ts`)**
- `packages/cli/src/credentials/credentials-sharing.service.ts`
  (`EnterpriseCredentialsService`, name kept for its 2 consumers):
  `getOneForUser` (role-resolved credential with sharing relations; decryption
  gated on `credential:update`, redacted via `CredentialsService.decrypt`;
  resolvable-credential `connectedByMe`/`connectedUserCount`/per-user
  oauthTokenData semantics mirror the fair-code `getOne` and are pinned by
  `credentials.resolvable.api.test.ts`); `shareWithProjects` (credential:user
  upserts, tolerant of nonexistent projects, joins the controller's
  transaction); `transferOne` (needs `credential:move` on the credential +
  `credential:create` in the destination; destination becomes sole owner —
  pinned by the public-api transfer spec).
- `@n8n/db`: rebuilt purged `SecretsProviderConnectionRepository`
  (findIdByProviderKey, findIdsByProviderKeys, findByProviderKeyWithAccess,
  findAllAccessibleProviderKeysByCredentialId) — its absence made DI inject
  `undefined` into `CredentialDependencyService` and 500 every credential
  create/update; `SharedCredentialsRepository.{shareWithProjects,
  transferOwnership}`. The cli external-secrets module now uses the db repo.
- `@n8n/permissions` fixes pinned by the newly-runnable credentials spec:
  `getAuthPrincipalScopes(principal, filters?)` gained the resource filter
  (`combineResourceScopes` was leaking global member scopes into per-resource
  scope lists); credential sharing masks corrected (owner: read/update/delete/
  move/share/unshare/createEndUser/connect; sharee: read/connect); editors
  `connect` credentials but don't `move` them (ownership-level op).

**Clean-room sources:** consumers (credentials.controller, public-api
credentials handler), fair-code `CredentialsFinderService`/`CredentialsService`
patterns, surviving specs (`credentials.api.test.ts`,
`credentials.resolvable.api.test.ts`, `public-api/credentials.test.ts`).
No `.ee` source read.

**Verification:** `credentials.service.ee` refs = 0; `credentials.api.test.ts`
**80/80** (was: file could not even load); permissions 105/105; db 409/409;
cli tsc 815→802, remaining errors belong to other E-items. Public-api suite
now advances past credentials to the next purged import
(`workflow.service.ee` → E14, the last shared-router blocker).

### 2026-08-08 — E14: sharing-aware workflow operations rebuilt fair-code (+ E11 slice)

**Added (clean-room rebuild of purged `workflows/workflow.service.ee.ts`)**
- `packages/cli/src/workflows/workflow-collaboration.service.ts`
  (`EnterpriseWorkflowService`, name kept for its 7 consumers): 9 methods —
  `addOwnerAndSharings` (homeProject/sharedWithProjects/usedCredentials
  response metadata), `addCredentialsToWorkflow` (per-credential access info),
  `validateCredentialPermissionsToUser`, `preventTampering` (rejects nodes
  newly referencing inaccessible credentials; reverts edits to read-only
  credential nodes; returns adjusted data), `getWorkflowIdsWithResolvableCredentials`
  (via the workflow dependency index), `shareWithProjects` (workflow:editor
  upserts in the controller's transaction), `transferWorkflow` and
  `transferFolder` (destination gated on `workflow:create`; subtree re-homing;
  foreign-workflow rejection; active workflows deactivated/reactivated with
  activation errors propagating — pinned 500; ownership caches invalidated;
  `shareCredentials` shares only credentials the user may SHARE — a use-grant
  must not escalate), `getFolderUsedCredentials` (folder subtree credential
  usage, FolderNotFoundError → 404).
- `@n8n/db`: SharedWorkflowRepository.{shareWithProjects, transferOwnership},
  WorkflowRepository.{findByParentFolderIds, findIdsWithResolvableCredentials},
  FolderRepository.moveFoldersToProject.
- E11 slice: `packages/cli/src/modules/provisioning/{constants,provisioning.service}.ts`
  — ProvisioningService reading the persisted ProvisioningConfigDto row
  (disabled-defaults fallback pinned by the fair-code settings loader);
  unblocked project/users controllers and the public-api projects handler.
- `@n8n/permissions` scope-model corrections, all pinned by the newly-runnable
  workflow/folder/n8n-packages specs: workflow sharing masks rebuilt (owner
  mask includes redaction ops, export and `execution:reveal`, excludes
  list/activate/deactivate; editor mask = read/update/execute/execute-chat/
  export/publish/unpublish); `COUPLED_HIDDEN_SCOPES` introduced
  (workflow:activate/deactivate are legacy public-API aliases coupled to
  publish/unpublish — hidden from role sets, granted to API keys through the
  coupling); team-project admins no longer hold workflow:share/unshare;
  personal-project owners hold no projectVariable:* scopes (project variables
  are a team feature — closes E2's importer-gating open question);
  `execution:reveal` moved out of editor-tier ops.

**Clean-room sources:** 7 consumer files, surviving specs
(workflows.controller.test.ts, folder.controller.test.ts,
workflow.service.test.ts, workflow-sharing.service.test.ts, public-api
workflows spec, n8n-packages variable import/export specs), fair-code
analogues (OwnershipService.addOwnedByAndSharedWith, CredentialsFinderService,
E15's credentials-sharing service). No `.ee` source read.

**Verification:** `workflow.service.ee` + `provisioning.ee` refs in src = 0;
regression battery **448/448** (credentials 80, workflows 201, workflow
service/sharing 35, folders 107, projects 25); n8n-packages variable specs +
REST variables **98/98** (E2's deferred gate now closed); permissions 105/105;
db 409/409; cli tsc 1046→784 across the session, zero errors in new files;
eslint clean. Public-api suite still gated by the six remaining subsystems
(E3 source-control, E5 saml, E6 oidc, E7 ldap, E9 log-streaming, E13
evaluation) whose handlers the shared router imports.

### 2026-08-08 — E16: sharing-licensed execution reads rebuilt fair-code

**Added:** `packages/cli/src/executions/execution-sharing.service.ts`
(`EnterpriseExecutionsService.findOne`). The single consumer
(`executions.controller`) switches between it and the community
`ExecutionService.findOne` on the sharing license; both take the same
caller-scoped accessible-workflow IDs and return the same response shape, and
no surviving spec distinguishes their behavior — with sharing enabled the
access difference already flows through the role-based workflow-ID resolution.
The licensed path therefore delegates to the community implementation, kept as
a separate DI seam for future divergence.

**Clean-room sources:** the consumer call site + fair-code
`ExecutionService.findOne`. **Verification:** `execution.service.ee` refs = 0;
execution-persistence spec 4/4; cli tsc 784→783; eslint clean.
