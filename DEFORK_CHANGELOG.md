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
