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

### 2026-08-08 — E4: SSO helpers rebuilt fair-code

**Added:** `packages/cli/src/sso/sso-helpers.ts` — the shared SSO state
helpers: current-authentication-method get/set (runtime config +
load-on-startup settings row, the persistence mechanism pinned by the
fair-code `start` command and `config/schema.ts`), per-method predicates,
`isSsoCurrentAuthenticationMethod` (SAML or OIDC),
`assertAuthenticationMethodCanBeEnabled` (a protocol may only be enabled from
`email` or itself — pinned by the surviving `saml-helpers.ts` toggle logic),
SAML license/enabled/label accessors over `LicenseState`/`GlobalConfig`.
All 8 consumers rewired (frontend settings, auth/me/password-reset/invitation
controllers, SSO settings loaders, surviving sso-saml module files).

**Clean-room sources:** the 8 consumer call sites (the surviving
`modules/sso-saml/saml-helpers.ts` pins the enable/disable semantics verbatim),
`config/schema.ts`, `start.ts` settings loading, `AuthenticationMethod` in
api-types. **Verification:** `sso.ee` refs in src = 0; invitation controller
suite now loads and passes 10/10 (failed to load all session); me/password
controller suites 47/47; cli tsc 783→766; eslint clean.

### 2026-08-08 — E7: LDAP subsystem rebuilt fair-code

**Added (clean-room rebuild of purged `modules/ldap.ee/`):**
`packages/cli/src/modules/ldap/` — `ldap.service.ts` (config lifecycle
persisted as the `features.ldap` settings row; `ldapts`-backed
`searchWithAdminBinding`/`validUser`/`testConnection`; dry/live user sync with
`AuthProviderSyncHistory`; scheduled sync; RFC-4515 filter escaping;
admin-password encryption via `Cipher`), `ldap.controller.ts` (REST /ldap
config/test-connection/sync, `ldap:manage` + `feat:ldap` gated; PUT rejects
unknown properties while the DTO strips them — reconciling the two surviving
tests), `ldap.auth-handler.ts` (`@AuthHandler` password login: create /
update / email-account-conversion with mapped-field adoption), `helpers.ts`
(sync persistence + LDAP-identity/user queries + mapping + email validation),
`ldap.errors.ts` (LdapConnectionError/LdapRejectionError), `ldap.module.ts`.
Added `'ldap'` to `@n8n/config` LOG_SCOPES.

**Clean-room sources:** the 709-line `ldap.api.test.ts`, `shared/ldap.ts`
fixtures, the public-api ldap handler/mapper, `auth.controller` login flow +
`EmailAuthHandler` pattern, `commands/ldap/reset.ts`, `AuthIdentity` /
`AuthProviderSyncHistory` entities, `LDAP_DEFAULT_CONFIGURATION` /
`LdapConfig` in `@n8n/constants`, the ldap DTOs. No `.ee` source read; codex
produced the consumer/spec contract inventory.

**Verification:** `ldap.ee` refs in src = 0; internal `ldap.api.test.ts`
**30/30** (was a load-failure); permissions 105/105; api-types 1773/1773;
config 121/121; db 409/409; cli tsc 766→736, 0 errors in the module; eslint
clean. The public-api ldap spec + `ldap:reset` command spec remain blocked on
`evaluation.ee/test-runner` (E13), imported by the shared public-api router and
`base-command.ts` — not an E7 defect.

**Key finding:** three real behaviors the spec pins and the first cut missed —
config PUT must reject unknown props at the endpoint though the DTO strips
them (two surviving tests, reconciled controller-side); an invalid-email
directory entry for an existing user counts as "seen" so the user is NOT
disabled; email→LDAP account conversion must adopt the directory's mapped
first/last name, not just attach the identity.

## 2026-08-09 — E13a: evaluation persistence layer (`@n8n/db`)

**Rebuilt (clean-room):** `entities/test-run.ts`, `entities/test-case-execution.ts`,
`entities/evaluation-config.ts`, `entities/evaluation-collection.ts`,
`repositories/test-run.repository.ts`, `repositories/test-case-execution.repository.ts`;
`WorkflowEntity.testRuns` relation restored; entities/repository index registration.

**Clean-room sources:** the surviving fair-code migrations
(`CreateTestRunTable` → `CleanEvaluations` → `AddScalingFieldsToTestRun` →
`AddWorkflowVersionToTestRun` → `AddEvaluationConfigColumnsToTestRun` →
`CreateEvaluationCollection`, + `CreateEvaluationConfig`,
`AddInputsOutputsToTestCaseExecution`, `AddRunIndexToTestCaseExecution`) which
pin the exact schema; surviving `types-db.ts` types (`TestRunErrorCode`,
`TestCaseExecutionErrorCode`, `TestRunFinalResult`, `AggregatedTestRunMetrics`);
the fair-code consumers (`public-api/v1/handlers/evaluations/*`,
`test/integration/shared/db/evaluation.ts` factory, both surviving integration
specs) which pin repository method contracts;
`@n8n/api-types/dto/evaluations/public-api-test-run.dto.ts` status unions;
`WorkflowRepository.getWorkflowsWithEvaluationCount` (pins the `testRuns`
relation). No `.ee` source read.

**Verification:** `pnpm --filter @n8n/db build` exit 0;
`pnpm --filter @n8n/db test` 31 files / 409 tests pass.

## 2026-08-09 — E13b: evaluation test-runner core (`packages/cli`)

**Rebuilt (clean-room):** `src/evaluation/test-runner/test-runner.service.ts`
(TestRunnerService: dataset prefetch via the trigger's `dataset.getRows`
custom operation, per-row pinned `evaluation`-mode executions in a bounded
pool owning the shared evaluation concurrency reservation, metric/input/
output collection off the Evaluation nodes' task data, per-key mean
aggregation, DB-flag + local-abort + pubsub `cancel-test-run` cancellation),
`test-run-cleanup.service.ts` (boot-time interrupted-run settlement),
`test-runs.controller.ts` (internal REST, workflow-finder-scoped 404s),
`llm-judge-provider-registry.ts` (derives from `LLM_JUDGE_PROVIDERS` in
api-types). Supporting: `evaluation` log scope in `@n8n/config`; TestRun/
TestCaseExecution repository state-transition methods in `@n8n/db`. Rewired:
server.ts, base-command.ts, public-api evaluations handler, test-server,
both integration specs, instance-ai adapter registry import.

**Clean-room sources:** the 511-line internal spec + 401-line public-api spec
(codex-extracted contract inventory + own read); the fair-code Evaluation
node classes (`getRows` custom operation, `_rowsLeft` iteration contract,
setMetrics/setInputs/setOutputs operations); the surviving
`agent-eval-runner.service.ts` (pool/cancel/settle/concurrency-slot
patterns); `ActiveExecutions`' evaluation-mode reservation comments;
`manual-execution.service.ts` + core `WorkflowExecute.run` (pinData +
`forceCustomOperation` mechanics); `evaluation-concurrency.helper.ts`;
api-types DTOs; pubsub event map. No `.ee` source read.

**Verification:** internal `test-runs.api.test.ts` **28/28** (was
load-blocked); command specs unblocked via base-command — ldap reset +
license cmd **16/16** (were load-blocked since E7); cli tsc: **0 errors in
src/evaluation/**; eslint clean; `@n8n/db` build exit 0.

**Still open in E13:** evaluation-config service/controller +
compileFromConfig compiler (E13c), collections + insights controllers
(E13d). `startTestRun` rejects `compileFromConfig` with a UserError until
E13c lands. Public-api evaluations spec remains gated by the shared router
(source-control/saml/oidc/log-streaming handlers still import purged
modules).

## 2026-08-09 — E13c: evaluation-config service + workflow compiler (`packages/cli`, `@n8n/db`)

**Rebuilt (clean-room):** `@n8n/db` `evaluation-config.repository.ts`
(findManyByWorkflowId / findOneInWorkflow / existsByName);
`src/evaluation/evaluation-config.service.ts` (list/get/create/update/delete
pinned by the instance-ai adapter; validation raising `EvaluationConfigError`
with the `EvaluationErrorCode` catalog: start/end node existence,
end-reachable-from-start via `getChildNodes`, duplicate metric ids/names,
whitespace-only metric inputs); `evaluation-config.controller.ts`
(GET list route pinned by `@n8n/instance-ai` n8n-client; CRUD alongside;
workflow-finder-based 404 authorization); `workflow-compiler.service.ts`
(compiles a config onto a workflow: injects a reserved-prefix Evaluation
Trigger wired to the config dataset + per-metric Set Metrics nodes after the
end node, LLM-judge metrics get their chat-model node connected via
ai_languageModel); `compileFromConfig`/`evaluationConfigId` threaded through
TestRunnerService (config snapshot frozen onto the run row). Implementation
of the config repo/service/controller delegated to an n8n:developer
subagent against the codex contract inventory; verified independently.

**Clean-room sources:** instance-ai adapter + its 179-test suite (service
contract), `@n8n/instance-ai/evaluations/clients/n8n-client.ts` (route pin),
api-types evaluation DTOs/schemas/error codes, the fair-code Evaluation node
descriptions (metric values, parameter names, canned-prompt fallback),
`n8n-workflow` graph utilities. No `.ee` source read. Dataset-row endpoints
(`dataset-row.dto.ts`) deliberately NOT rebuilt — no fair-code consumer
survives to pin their routes.

**Verification:** cli tsc 0 errors in `src/evaluation/**` (125 pre-existing
elsewhere); internal test-runs spec 28/28; instance-ai adapter suite
**179/179** (was import-blocked); `@n8n/db` build exit 0; eslint clean.

## 2026-08-09 — E13d: eval collections + AI insights (`packages/cli`, `@n8n/db`)

**Rebuilt (clean-room):** `@n8n/db`
`repositories/evaluation-collection.repository.ts` (findManyByWorkflowId with
grouped run counts, workflow-scoped findOneInWorkflow /
findOneWithRunsInWorkflow, updateInsightsCache) + index export;
`src/evaluation/evaluation-collections.service.ts` (list/detail/create/
update/delete/addRun/cancelCollection; detail maps runs through the
api-types scoring helpers — `metricScalesFromSnapshot` falling back to
`metricScalesFromConfig`, `averageNormalizedScore`; create validates the
config + referenced runs up front, then attaches existing runs or starts new
ones via `TestRunnerService.startTestRun` with `compileFromConfig` +
`collectionId` (+ `workflowVersionId` unless "current draft"), detached
`finished` rejections routed to ErrorReporter; insightsCache invalidated on
addRun/cancel); `evaluation-collections.controller.ts`
(`/workflows/:workflowId/eval-collections` GET/POST/GET:id/PATCH/DELETE/
POST:id/runs/POST:id/cancel, workflow-finder 404 authorization, read=
workflow:read, mutate=workflow:update, run-affecting=workflow:execute);
`src/evaluation/insights/eval-insights.service.ts` + `.controller.ts`
(GET cached envelope — `null` when absent or failing the strict schema —
POST generates/stores; deterministic `status:'fallback'` generator: winner =
highest avgScore with run-order labels V1…Vn, regressions = metrics ≥5
points below the winner, templated suggestedNext, all strings clamped to the
schema caps and the envelope `.strict()`-parsed before storing). server.ts
rewired off the two `evaluation.ee` imports. LLM path deliberately NOT
implemented: the only model seam lives inside the conditionally-loaded
`instance-ai` backend module, which core evaluation code must not import;
`fallback` is a first-class schema state.

**Clean-room sources:** codex contract inventory §5/8/9;
`@n8n/api-types` eval-collections + eval-insights schemas (DTOs, response
types, scoring helpers — reused, not reimplemented); the compare-view E2E
(`eval-collections-compare.spec.ts`, route + envelope pins); sibling
fair-code evaluation controllers/services/repositories (patterns);
pubsub event map. No `.ee` source read.

**Verification:** `@n8n/db` build exit 0, tests 409/409; cli tsc 0 errors in
`src/evaluation/**` + `server.ts` (pre-existing errors elsewhere only);
`eslint src/evaluation` exit 0; `grep evaluation.ee packages/cli/src` → 0
lines; internal test-runs spec 28/28; new insights unit tests 10/10.

## 2026-08-09 — E13 review fixes (codex adversarial pass)

Multi-provider review (codex read-only) of the E13 rebuild produced 11
findings; 8 fixed, 3 deferred. Fixed: queue-mode executions now serialize
full execution data (pinData/trigger/destination) exactly like offloaded
manual executions — workers can reconstruct evaluation runs; every case and
the dataset prefetch pass `triggerToStartFrom` so a canvas webhook/schedule
trigger can never displace the evaluation trigger; the prefetch execution is
cancel-trackable; setInputs/setOutputs are read from `item.evaluationData`
(first item — pinned by the node's own comment), not `item.json`; cancelled
in-flight cases are recorded cancelled, not UNKNOWN_ERROR; run completion is
a compare-and-set against `cancelRequested` so a late cancel can't be
overwritten by `completed`; `failRun` rethrows persistence failures so
`finished` observers see unsettleable runs; internal cancel 409s terminal
runs and delete 409s running runs; OpenAI judge nodes emit a plain string
model (typeVersion 1); run/case ordering gained `id` tiebreakers. Deferred
(logged, non-blocking — no surviving consumer pins them): structured
`EvaluationApiError` transport on config validation responses; SQL-side
summary aggregation instead of relation-loading cases; Vertex `projectId` /
Azure `authentication` parameters on compiled judge nodes (needs a DTO
extension); the execution-id registration window in cancellation.

**Verification after fixes:** db build exit 0 + 409/409; internal spec
28/28; insights 10/10; eslint 0; cli tsc 0 errors in src/evaluation.

## 2026-08-09 — E3a: source-control foundation (`packages/cli`)

Clean-room rebuild of the source-control module's foundation slice under the
fair-code path `packages/cli/src/modules/source-control/` (formerly
`source-control.ee/`). Files: `constants.ts` (work-folder layout constants
pinned by the environment specs' path assertions, plus git/ssh folder names
and the `features.sourceControl.sshKeys` settings key), `types/{resource-owner,
exportable-credential,exportable-data-table,exportable-folders,
exportable-workflow}.ts` (serialized shapes pinned by the export/import/status
spec fixtures), `source-control-scoped.service.ts` (team-project scoping:
global `sourceControl:push` = instance-wide; else team projects where the
user holds `project:admin` or a custom role granting project-level
`sourceControl:push`), `source-control-context.factory.ts`
(`SourceControlContextFactory.createContext(user)` returning an immutable
`SourceControlContext`), `source-control-git.service.ts` (simple-git wrapper:
init/remote/branch management, DB-stored SSH key materialized to
`${n8nFolder}/ssh/key` mode 0600 with per-instance `known_hosts` and
`StrictHostKeyChecking=accept-new`, fetch/pull/push/stage/commit/status/
diff/reset), and `source-control-helper.ts`
(`isSourceControlLicensed` via `LicenseState`,
`getTrackingInformationFromPullResult`, `getRepoType`).

**Clean-room sources:** the E3 contract inventory (derived solely from
surviving fair-code specs/consumers); the five integration specs under
`test/integration/environments/`; the public-api pull handler; the surviving
fair-code `source-control-preferences.service.ts` + types; the
`MoveSshKeysToDatabase` migration (key-pair storage shape); `@n8n/permissions`
scope/role definitions; `check-access.ts` scoping patterns; simple-git's
public API. No enterprise source or history was consulted.

**Verification:** cli tsc — 0 errors in `src/modules/source-control/**`
(remaining source-control errors are the 3 pre-existing `.ee` imports in the
not-yet-rewired public-api handler); `eslint src/modules/source-control`
exit 0; standalone smoke harness against a real local bare git remote —
helper counters, init/branch/stage/commit/push/fetch/diffLocal/hard-reset/
ff-only-pull, SSH key materialization (mode 600, known_hosts, missing-key
UserError) all green.

## 2026-08-09 — E3b: source-control export service (`packages/cli`)

Clean-room rebuild of `SourceControlExportService` at
`packages/cli/src/modules/source-control/source-control-export.service.ts`
(formerly `source-control.ee/source-control-export.service.ee.ts`), plus
use-case-named repository methods in `@n8n/db`
(`TagRepository.findAllTags`, `WorkflowTagMappingRepository.findAllMappings`
/ `findMappingsForWorkflows`,
`SharedWorkflowRepository.findWorkflowIdsOwnedByProjects`,
`FolderRepository.findManyWithHomeProject`,
`WorkflowRepository.findByIdsWithParentFolder`). The service serializes
resources into `${n8nFolder}/git/`: per-resource JSON files for workflows,
credential stubs (secrets stripped — strings blanked, non-string primitives
kept, nesting preserved, `oauthTokenData` omitted; owner serialized as
structured personal/team `ownedBy`), and data tables (schema only, columns
sorted by index), plus aggregate `tags.json` and `folders.json` whose
scoped exports merge with the existing file so out-of-scope entries are
never erased. The spec's `.ee` import paths were repointed to the fair-code
module.

**Clean-room sources:** the E3 contract inventory §3 (export contract);
`test/integration/environments/source-control-export.service.test.ts`
(651-line spec, acceptance gate); the E3a fair-code foundation
(constants, context factory, scoped service, `types/*`); existing fair-code
repositories/entities in `@n8n/db` and the `data-table` module; `Cipher`
(n8n-core, `decryptV2` read path as in `Credentials.getData`). No
enterprise source or history was consulted.

**Verification:** export spec 13/13 green (sqlite); cli
`tsc -p tsconfig.build.json` — 0 errors mentioning `source-control-export`
or `modules/source-control/` (remaining errors are pre-existing `.ee`
imports in not-yet-rebuilt slices); `eslint src/modules/source-control`
exit 0, no rule disables; `@n8n/db` build exit 0 and tests 409/409.

## 2026-08-09 — E3c: source-control import service (`packages/cli`)

Clean-room rebuild of `SourceControlImportService` at
`packages/cli/src/modules/source-control/source-control-import.service.ts`
(formerly `source-control.ee/source-control-import.service.ee.ts`), plus one
use-case-named repository method in `@n8n/db`
(`SharedCredentialsRepository.findOwnedCredentialsInProjects`). The service
covers scope-filtered discovery of remote (work-folder JSON) and local (DB)
workflows, credentials, folders, and tags/mappings — instance-wide contexts
see everything, project-scoped admins only resources owned by their
administered team projects (a serialized personal owner never matches, even
the caller's own email), everyone else nothing — and the import paths:
credentials (re-encrypted via `Cipher.encryptV2`, ownership replaced to match
the serialized owner, team projects recreated with exact source id/name,
personal/legacy-email owners falling back to the importing user's personal
project), tags (definitions upserted and never deleted; mappings reconciled
only for workflows represented in the import, with a workflow-file scan
determining representation when the tag file has no mappings), and workflows
(files missing versionId/nodes/connections skipped without error; history
recorded per `(workflowId, versionId)` with author
`import by <firstName> <lastName>`, rewritten only when content changed;
archived local workflows get `active`/`activeVersionId` cleared even when the
incoming file is unarchived). The spec's `.ee` import paths were repointed to
the fair-code module.

**Clean-room sources:** the E3 contract inventory §4 (import contract, scope
matrix); `test/integration/environments/source-control-import.service.test.ts`
(2,019-line spec, acceptance gate); the E3a/E3b fair-code foundation
(constants, context factory, scoped service, export service types,
`types/*`); existing fair-code repositories/entities in `@n8n/db` and
`WorkflowHistoryService`. No enterprise source or history was consulted.

**Verification:** import spec 47/47 green (sqlite); cli
`tsc -p tsconfig.build.json` — 0 errors mentioning `source-control-import`
(remaining source-control errors are the pre-existing `.ee` imports in the
not-yet-rewired public-api handler); `eslint src/modules/source-control`
exit 0, no rule disables; `@n8n/db` build exit 0 and tests 409/409.

## 2026-08-09 — E3d: source-control status/service/controller/module (`packages/cli`)

Clean-room rebuild of the final source-control slice:
`source-control-status.service.ts` (`SourceControlStatusService` — local↔work-folder
diff for workflows, credentials, folders, data tables, tags, plus synthesized
`project` entries for team projects owning changed resources; scoped callers
never see out-of-scope resources, and a remote resource whose local ownership
moved out of scope is reported neither as deleted nor modified),
`source-control.service.ts` (`SourceControlService` — sanity check, direction-aware
status authorization (pull requires global `sourceControl:pull`, push accepts
global or project-level `sourceControl:push` with per-candidate team-ownership
validation), pushWorkfolder (read-only branch rejects with BadRequest before
authorization; `fileNames: []` pushes all changes; per-resource exports plus
aggregate folders/tags merges and `projects/<id>.json` files; stage/commit/push
via the git wrapper), pullWorkfolder (409 + full status on unforced conflicts,
imports workflows/credentials/tags on success), connect/disconnect/branch
operations, SSH key-pair management (RSA via node:crypto + sshpk public-key
derivation, Ed25519 via sshpk; private key encrypted with the instance key in
`features.sourceControl.sshKeys`), work-folder-restricted `remote-content`
reads, and a `reload-source-control-config` pubsub handler),
`source-control.controller.ts` (REST routes under `/source-control` with the
pinned redaction tiers on GET /preferences and route scopes per the contract),
and `source-control.module.ts` (`@BackendModule({ name: 'source-control',
instanceTypes: ['main'], licenseFlag: 'feat:sourceControl' })`). Rewired the
public-api handler, `test-server.ts`, `main-only-modules.test.ts`, and the four
surviving spec files off `source-control.ee` paths (import repointing only);
removed the stale `source-control.ee` entries from the cli eslint ratchet
allowlist. Added the use-case method `SettingsRepository.deleteByKey` to
`@n8n/db`. Also added a minimal `modules/provisioning/provisioning.module.ts`
registration (`name: 'provisioning'`, `instanceTypes: ['main']`) so the module
loader and the `main-only-modules` metadata pin resolve; the full provisioning
surface remains E11.

**Clean-room sources:** the E3 contract inventory (§2 service contract, §5
routes, §6 helpers, §8 events/pubsub); the three acceptance specs
`source-control.service.test.ts` (1,608 lines),
`source-control.api.test.ts`, `source-control-access-control.test.ts`; the
E3a–E3c fair-code foundation (constants, types, context factory, scoped/git/
helper/preferences/export/import services); surviving fair-code consumers
(public-api handler, relay.event-map, pubsub types) and sibling module/controller
patterns (`modules/ldap`). No enterprise source or history was consulted.

**Verification:** service spec 26/26, api spec 20/20, access-control spec
16/16 (sqlite); regression export 13/13 + import 47/47 (60/60 combined);
`main-only-modules.test.ts` 6/6; `grep -rn "source-control.ee" packages/cli/src
packages/cli/test --include='*.ts'` → 0 matches; cli `tsc -p
tsconfig.build.json` — 0 errors mentioning source-control; `eslint
src/modules/source-control src/public-api/v1/handlers/source-control` exit 0,
no rule disables; `@n8n/db` build exit 0 and tests 409/409. The rewired
public-api spec `test/integration/public-api/source-control.test.ts` now loads
but 6/9 tests fail on a pre-existing repo-wide public-api breakage: the
log-streaming handler still imports the not-yet-rebuilt `log-streaming.ee`
module (E9), which breaks handler resolution for all public-api routes
(untouched `tags.test.ts` fails identically).

## 2026-08-09 — E3 hardening (adversarial review) (`packages/cli`)

Hardened the rebuilt source-control subsystem against the 14-finding
adversarial review, without changing any behavior the five environment specs
pin.

**Fixed (finding → change):**

- **#1 Push trusted client payloads** — `pushWorkfolder` now treats the
  request's `fileNames` as `{type,id}` *selections* only: it regenerates a
  fresh scoped status server-side, maps each selection onto it, and rejects
  (403) any selection absent from that status. All statuses, owners, and
  filesystem paths come from the server-side entries; project files are
  written at the canonical `projects/<id>.json` path with an id-charset guard.
- **#2 Symlink traversal** — added `assertNotSymlink` (lstat) and
  `assertParentWithinFolder` (realpath containment) guards on every managed
  read/write: import candidate reads, discovery reads, export writes,
  aggregate-file reads, and `remote-content` reads. Guards are tolerant of
  missing files/dirs so they are inert under the specs' fs mocks.
- **#3 Credential pull blanked secrets** — importing an *existing* credential
  now decrypts the local data and merges the incoming stub over it
  (`mergeCredentialData`): blank-string placeholders and never-exported keys
  (`oauthTokenData`) keep their local values; non-blank strings, numbers, and
  booleans are applied. Only newly created credentials store the stub as-is.
- **#4 Pull completeness** — `pullWorkfolder` now dispatches on the full
  status: imports folders (new `importFoldersFromWorkFolder`, id-preserving,
  parents-first) and data tables (new `importDataTablesFromWorkFolder`,
  id-preserving creation via `DataTableService`, name-keyed column
  reconciliation), then applies remote deletions for workflows, credentials,
  folders, and data tables through the respective services (new
  `delete*RemovedFromRemote` methods, best-effort per resource). A `created`
  tags entry (remote `tags.json` missing) is skipped instead of read.
  409/force semantics unchanged.
- **#5 Archived/active** — workflow import bases active-state clearing on the
  *resulting* archive state (incoming `isArchived: true` now clears
  `active`/`activeVersionId`) and routes deactivation of a previously active
  workflow through the injected `ActiveWorkflowManager.remove()` so runtime
  triggers stay in sync (failure is logged, not fatal).
- **#6 Operation lock** — added an in-process promise-chain mutex in
  `SourceControlService` serializing status-with-reset, push, pull, connect,
  disconnect, and reset-workfolder. Cluster-wide (multi-main) locking remains
  a documented follow-up.
- **#7 Fail-closed sync** — pull now performs its own fetch + hard reset +
  managed-path `git clean` and propagates failures (`OperationalError`)
  instead of importing stale content; connect verifies the remote (fetch must
  succeed, a configured branch must exist on a non-empty remote) before
  persisting `connected: true`; reset-workfolder and the status-side reset
  also clean untracked managed files (new `cleanManagedPaths`, scoped to
  `SOURCE_CONTROL_MANAGED_PATHS`). Status computation itself stays tolerant of
  offline remotes, as pinned.
- **#9 Owner type check** — a serialized team owner resolving to an existing
  *non-team* project by id collision now falls back to the importing user's
  personal project instead of attaching to the colliding project.
- **#11 Remote-content authz** — `getRemoteFileEntity` authorizes scoped
  callers against the remote file's parsed-and-validated serialized owner
  (team in caller's scope), with local ownership as an additional constraint
  when the workflow exists locally; caller-controlled ids are restricted to a
  safe path-segment charset.
- **#12 GIT_SSH_COMMAND** — key and known_hosts paths are single-quoted with
  embedded-quote escaping, `-o IdentitiesOnly=yes` added, and the key file is
  explicitly `chmod 0600` even when it already existed.
- **#13 Branch validation** — new `isValidGitBranchName` (rejects leading
  `-`/`.`/`/`, `..`, `.lock` suffixes, trailing `/`/`.`, empty segments,
  spaces/control chars; still allows nested `a/b`) used by the controller's
  preference parsing and, as defense in depth, by `SourceControlGitService.setBranch`.
- **#14 Preferences GET** — the manager read path only triggers lazy key-pair
  generation when the feature is licensed; unlicensed reads return the stored
  public key (if any) via the new side-effect-free `getStoredPublicKey`.

**Deferred (documented, not implemented):**

- **#8** numeric/boolean credential leaves are still exported verbatim — the
  export spec explicitly pins preserving non-string leaves, so this stands as
  a known limitation until the spec contract changes.
- **#10** ownership transfer for *existing* workflows on import remains
  non-destructive (owner is only assigned on creation) — contract open
  question.
- Cluster-wide/multi-main operation lock (in-process lock only this pass).

**Clean-room sources:** the E3 review findings list, the E3 contract
inventory, the five environment specs, and this repo's own fair-code
(`WorkflowService.delete`, `CredentialsService.delete`, `FolderService`,
`DataTableService` surfaces). No enterprise source or history was consulted.

**Verification:** environment specs 122/122 (5 files, sqlite, zero assertion
changes); `main-only-modules.test.ts` 6/6; new unit tests
`__tests__/source-control-helper.test.ts` 53/53 (branch-name validation,
path-segment ids, credential-data merge, symlink/containment guards on real
tmpdirs) and `__tests__/source-control.service.push-selection.test.ts` 4/4
(forged selection rejected, client paths/statuses replaced by server entries);
cli `tsc -p tsconfig.build.json` — 0 errors mentioning source-control;
`eslint src/modules/source-control src/public-api/v1/handlers/source-control
--quiet` exit 0, no rule disables.

## 2026-08-09 — E9: log-streaming module (`packages/cli`)

Rebuilt the purged log-streaming module fair-code at
`packages/cli/src/modules/log-streaming/` (no `.ee` path):

- `log-streaming.module.ts` — `@BackendModule({ name: 'log-streaming',
  licenseFlag: 'feat:logStreaming' })`; registers the `EventDestinations`
  entity via `entities()` (collected before license gating), initializes the
  destination service + controller on `init()`, closes destinations on
  shutdown.
- `database/entities/index.ts` — `EventDestinations` (`id` uuid PK,
  `destination` JSON via `JsonColumn`, `WithTimestamps`), mapping onto the
  pre-existing `event_destinations` table created by the surviving
  fair-code migrations in `@n8n/db` (no migration changes).
- `database/repositories/event-destination.repository.ts` —
  `EventDestinationsRepository` extending `BaseRepository` with use-case
  methods (`getAll`, `saveDestination` upsert, `deleteById`); TypeORM stays
  inside the module `database/` dir.
- `log-streaming-destination.service.ts` — owns the destination registry.
  **Open-area decisions:** a single service-owned `"message"` listener fans
  out to enabled+subscribed destinations; each successful delivery confirms
  the message under the destination's identity; zero applicable destinations
  confirm as `{ id: '0', name: 'eventBus' }` (mirrors the bus's no-listener
  behavior); all-failed leaves the message unconfirmed for the bus retry
  loop. `removeDestination(id, persist = true)`: always closes/unregisters,
  skips the DB delete when `persist === false` (the only surviving caller of
  the boolean is test teardown).
- `create-message-event-bus-destination.ts` — factory dispatching on the
  three `__type` discriminators via type predicates; unknown type throws
  `UserError`.
- `destinations/` — abstract base (segment-aware event filtering incl. `*`
  wildcard, contained delivery errors logged verbatim, audit-payload
  anonymization) plus webhook (via `OutboundHttp.requests()`; keypair/JSON
  headers+query, generic httpHeaderAuth/httpBasicAuth credential resolution
  through `CredentialsRepository` + n8n-core `Credentials`), syslog
  (`@n8n/syslog-client`; udp/tcp/tls, `tlsCa` → `tlsCA`), and sentry
  (raw envelope POST to the DSN's ingestion endpoint through `OutboundHttp`
  instead of the global Sentry SDK, keeping instance error reporting
  untouched). Circuit-breaker options are persisted/serialized but have no
  runtime behavior (nothing surviving pins one).
- `log-streaming.controller.ts` — `/eventbus/destination` GET/POST/DELETE +
  `/eventbus/testmessage`, `@Licensed('feat:logStreaming')` +
  `@GlobalScope('logStreaming:manage')`; POST validated by
  `CreateDestinationDto`; env-managed mode returns 403 for mutations
  (public API keeps its 409).

Rewires (path repointing only, assertions untouched): public-api handler,
instance-settings loader + its two tests, `test-server.ts` `eventBus` group,
the four integration specs, and `e2e.controller.ts` (missed by ripgrep-style
tools — the file trips binary detection; found via `tsc`). Removed the stale
`log-streaming.ee` eslint ratchet entry (the new service imports no TypeORM).

Also hardened `public-api/index.ts` operation-handler resolution: a handler
module that fails to import now 500s only its own routes instead of poisoning
the whole v1 router (the not-yet-rebuilt sso-oidc/sso-saml services were
blocking every public API route, including this epic's acceptance suite).

**Clean-room sources:** the E9 contract inventory (`.defork/e9-contract.md`),
the surviving fair-code specs (eventbus, log-streaming controller, syslog-tls,
loader unit+integration, public-api log-streaming, Playwright delivery spec),
the fair-code option schemas/defaults in `packages/workflow/src/message-event-bus.ts`,
`@n8n/syslog-client`, and this repo's own fair-code consumers. No enterprise
source or history was consulted.

**Verification:** integration 68/68 (eventbus 6, controller 12, syslog-tls 2,
loader roundtrip 4, public-api log-streaming 44); loader unit 20/20;
`grep -rn "log-streaming.ee" src test` → 0; cli `tsc -p tsconfig.build.json`
110 errors before and after, none mentioning log-streaming (12 missing-module
errors resolved); `eslint src/modules/log-streaming
src/public-api/v1/handlers/log-streaming --quiet` exit 0, no rule disables;
sqlite migrations suite 214 passed / 1 skipped; public-api tags.test.ts now
runs: 23/24 (1 pre-existing RBAC failure unrelated to log-streaming).
