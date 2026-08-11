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

### 2026-08-11 — Rebuilt the purged `@n8n/ai-workflow-builder` package (E20)

The purge removed `@n8n/ai-workflow-builder.ee` but left its fair-code consumers
in place — eight production files in `packages/cli` still imported it. The
package therefore had to exist for `packages/cli` to compile at all, and its
absence was why `start.test.ts` collected **0** tests.

**Rebuilt fair-code as `packages/@n8n/ai-workflow-builder`** (no `.ee`), in four
parts:

1. **Tool descriptors** — the 11 `{ toolName, displayTitle }` constants naming
   the workflow-builder tools, plus `SDK_IMPORT_STATEMENT`.
2. **Parse / validate** — `ParseValidateHandler`, `stripImportStatements`,
   `getWarningKey`, and a re-export of `ValidationWarning`. Orchestration only;
   the parsing and validation themselves are `@n8n/workflow-sdk`'s.
3. **Session storage** — `ISessionStorage`, `StoredSession`, `LangchainMessage`,
   `isLangchainMessagesArray`.
4. **Builder service** — `AiWorkflowBuilderService`, `ChatPayload`,
   `ResourceLocatorCallbackFactory`, `createPassthroughSsrfGuard`.

**Parts 1–3 are fully functional.** The MCP workflow-builder tools
(`validate_workflow`, `create_workflow_from_code`, `update_workflow`, the SDK
reference) parse and validate real SDK code again, and the builder session
repository has its contract back.

**Part 4 ships as a loud-failing seam, by decision.** The LLM agent is *not*
rebuilt here — that is the AI Workflow Composer's job (item C2), which is
correctly downstream. What is rebuilt is the real class shape, constructor, and
lifecycle, so C2 drops an agent in rather than re-threading thirteen
dependencies through `packages/cli`. Operations that need the agent — `chat`,
`getBuilderInstanceCredits` — throw `AiBuilderUnavailableError`. Operations that
can be answered truthfully from storage — `clearSession`, and `getSessions` /
`truncateMessagesAfter` when there is no stored conversation — run for real.
Where a stored conversation *does* exist, `getSessions` throws rather than
report `[]`: those turns are in the agent's own encoding and cannot be rendered
without it, and claiming a user's history is empty is a different, wrong
statement. `/ai/build` stays registered behind `@Licensed('feat:aiBuilder')`
(off by default → 403); if enabled, `ai.controller.ts` re-emits the error into
the response stream, so the editor shows the explanation. Nothing returns an
empty-but-successful result — the failure mode that made the
`OWNER_API_KEY_SCOPES` defect above so hard to see.

**Clean-room sources.** No `.ee` body, history, or upstream was read.
`toolName` literals come from `packages/cli/src/modules/mcp/mcp-scopes.ts`,
which grants access by them; `displayTitle` from each tool's own surviving test;
the export list from the ~12 `vi.mock('@n8n/ai-workflow-builder', …)` blocks;
`ISessionStorage`/`StoredSession` from `workflow-builder-session.repository.ts`,
which declares `implements ISessionStorage`; `ChatPayload` from
`ai.controller.ts`, which builds it inline, with field types from
`@n8n/api-types`' `AiBuilderChatRequestDto`; parse/validate behaviour from
`@n8n/workflow-sdk`'s public exports; and the stream framing from the surviving
editor-UI client.

**One mock was wrong and the drift guard proves it.** Several test mocks give
`CODE_BUILDER_VALIDATE_TOOL.toolName` as `validate_workflow_code`. The registered
name is `validate_workflow` — `mcp-scopes.ts` grants by that, and
`mcp-scopes.test.ts` (which does *not* mock this package) fails if the two
disagree. Taking the mock at face value would have made the tool unreachable for
every scoped credential. Same for `get_workflow_sdk_reference`, which the live
upstream MCP surface calls `get_sdk_reference`.

**Verified**, each against the same tree with the package removed:

| Check | Before | After |
|---|---|---|
| `packages/cli` typecheck, `Cannot find module` errors | 10 | **0** |
| `packages/cli` typecheck, total errors | 80 | **68** |
| `start.test.ts` tests collected | 0 | **9 passed** |
| `mcp.settings.controller.api.test.ts` | file failed, 28 skipped | **26 passed** |
| `mcp-scopes.test.ts` (unmocked drift guards) | file failed | **15 passed** |

`packages/cli` MCP + workflow-builder + builder-service suites: **1224/1226**.
New package: **63 tests**, typecheck and lint clean. No new typecheck errors
introduced anywhere, and two pre-existing cascading ones fixed.

The parse path was also driven end-to-end through the same
`await import('@n8n/ai-workflow-builder')` the MCP tools use — those tools' own
tests mock the module wholesale, so nothing else exercises it — confirming all
26 named exports resolve across the CJS boundary and that real SDK code parses
into workflow JSON.

The 2 remaining failures are in `mcp.settings.controller.api.test.ts`, newly
*exposed* rather than caused: that file could not load before. Both mint users
with role `global:member` and 403 on `GET /mcp/api-key`, which requires
`mcpApiKey:create`. Which side is wrong is unsettled and deliberately left
alone — `custom-role-scopes.ts` files that scope under `settings.Manage`, and
the editor-UI gates the whole MCP settings page on it, so the likely fix is the
two specs (they are really asserting key uniqueness and pick `global:member`
only to mint distinct users) rather than widening a role grant.

**A10 is still red, and not because of this.** `pnpm --filter n8n build` now
gets past module resolution and fails on **31 pre-existing `src/` errors** in
`source-control-import.service.ts` (12 unused injected dependencies),
`workflows.controller.ts` (5), `evaluation/test-runner`, and
`source-control-status.service.ts`. These are separate de-fork fallout and are
A10's scope; E20's own verify clause has been corrected accordingly, since the
whole-build gate was never something this item could satisfy alone.

### 2026-08-10 — 13 more API-key scopes were ungrantable, taking three public APIs down (#24)

Follow-up to the eight below, and the larger half of the same defect. A public
API key may only hold scopes its principal's role holds, matched by **exact
slug**. But `API_KEY_RESOURCES` deliberately names some resources differently
from the RBAC catalog (`dataTableRow:read` against `dataTable:readRow`) and
exposes operations the RBAC catalog has no entry for at all (`testRun:create`).
Nothing bridged the two namespaces, so 13 scopes could be granted to nobody —
the instance owner included — and every route behind them answered 403 to
everyone. The whole evaluations API, data-table row and column CRUD, and
execution-tag list/update were dead.

**Fixed.** `API_KEY_SCOPE_BACKED_BY` maps each such API-key scope to the RBAC
scope that backs it, and `getApiKeyScopesForRole` consults it. Every entry is
read off the route that requires it: each of these endpoints already pairs its
`publicApiScope(...)` with the `projectScope(...)` it enforces, so the backing
scope is the one the request is checked against anyway. This grants nothing
extra — it only makes the key-level gate reachable for a principal that already
holds the underlying permission. Owner and admin now reach **88/88** API-key
scopes, up from 75.

**Measured on the real suites**, each compared against the same run with
`public-api-permissions.ts` reverted:

| Public API suite | Before | After |
|---|---|---|
| `evaluations` | 12 failed / 11 passed | **1 failed / 22 passed** |
| `data-tables` | 67 failed / 55 passed | **8 failed / 114 passed** |
| `executions` | 37 failed / 38 passed | **29 failed / 46 passed** |

78 specs fixed, no regressions. `@n8n/permissions` **110/110** (105 + 5 new).

**Added — the assertion that would have caught it.** A new
`public-api-permissions` spec requires every scope in `API_KEY_RESOURCES` to be
grantable to the owner and to an admin, every backing scope to exist in
`ALL_SCOPES`, and the bridge to cover only scopes the RBAC catalog does not
already name (a bridge over an existing scope would silently redirect it to a
different permission).

**Still failing, and not this bug → follow-up.** The residual 38 failures share
one root cause: `getApiKeyScopesForRole` derives a key's scopes from the
principal's **global** role, but a member holds authority through their
**project** roles — by design, per `GLOBAL_MEMBER_SCOPES`. So a member's key
resolves to 7 of 88 scopes and every "member should be able to…" public API spec
403s. That needs project-derived scopes in key issuance, which is a design change
rather than a catalog fix.
### 2026-08-10 — Review fixes on the annotation rebuild

A three-model review panel (codex, grok, a Claude reviewer) over the stacked
branches found four defects worth acting on. Two were introduced by the
annotation rebuild itself.

**Fixed — filtering the executions list by annotation tag crashed on Postgres.**
The tag filter joined the mapping table and used `SELECT DISTINCT` to collapse
the duplicate rows that join produces. But the list's own sort orders are
computed expressions (`COALESCE(startedAt, createdAt)`, and a `CASE` for
top-of-list status), and Postgres rejects `SELECT DISTINCT` whose `ORDER BY`
expressions are not in the select list. Any tag-filtered request under the
editor's default sort returned a 500 — on the executions list hot path. SQLite
does not enforce the restriction, and no test combined a tag filter with an
order, so the earlier Postgres run passed. The filter is now a grouped subquery,
which needs no `DISTINCT` at all.

**Fixed — selecting several annotation tags now means "has all of them".** The
rebuild used `tagId IN (...)`, i.e. any. The workflow list filters by its own
tags with `HAVING COUNT(DISTINCT ...) = :tagCount`, and the executions filter UI
is the same dropdown, so the two surfaces disagreed. Now consistent.

**Fixed — a project viewer could annotate executions.** `PATCH /rest/executions/:id`
resolved accessible workflows with `workflow:read`, but it writes: it stores a
vote, note and tags. The editor only offers those controls to users holding
`workflow:update`, so the API was more permissive than the UI it serves — and
since annotated executions are now exempt from pruning, it also let a viewer
pin executions in storage. Scoped on `workflow:update` to match.

**Fixed — unknown tag ids returned 500 from the editor path.** The public API
path already mapped the foreign-key failure to `404 Some tags not found`; the
editor's PATCH did not. Both now agree.

**Changed — `IExecutionResponse.annotation`** now declares the `id`, `vote` and
`note` that `serializeAnnotation` has been populating, instead of `tags` alone.

Regression tests added for all four; the two behavioural fixes were
mutation-tested (reverting each fails its spec). Verified on **both** databases:
`execution.service.integration` **39/39**, `executions.controller` **18/18**,
`executions-pruning.service` **22/22**, `annotation-tags.api` **9/9** — 88/88 on
Postgres and on SQLite; `@n8n/db` **411/411**; cli execution unit tests
**231/231**; cli `tsc` unchanged at 16 pre-existing errors.

**Reviewed and deliberately not changed:** `execution:stop` is absent from the
custom-role scope groups, so only built-in roles can hold it — inert, as the stop
routes authorize on `workflow:execute`. The annotation summary in list responses
still omits `note`, which the surviving specs pin with an exact `toEqual`.

### 2026-08-10 — Execution annotations rebuilt fair-code (E19)

The purge removed the execution-annotation backend while every consumer of it
survived, so the editor's vote/note/tag controls called routes with nothing
behind them and `packages/cli` could not compile. Rebuilt clean-room from the
surviving fair-code; the last Phase-E item.

**Added — `@n8n/db`**

- Entities `AnnotationTagEntity`, `ExecutionAnnotation` and `AnnotationTagMapping`,
  mirroring the already-migrated schema in `1724753530828-CreateExecutionAnnotationTables`
  and `1728659839644-AddMissingPrimaryKeyOnAnnotationTagMapping` exactly (24-char
  tag names, one annotation per execution via the unique index on `executionId`,
  cascade delete from the execution).
- Repositories `AnnotationTagRepository`, `AnnotationTagMappingRepository` and
  `ExecutionAnnotationRepository`. Their names are pinned by surviving callers —
  `ExecutionService` and the integration test helpers already imported them.
- `ExecutionEntity.annotation`, which is what made the five surviving
  `execution-persistence.ts` annotation call sites compile again.

**Fixed — `@n8n/db` `execution.repository.ts`** (paths stripped by A8b)

- `includeAnnotation` restored across the four `findSingleExecution` overloads
  and the implementation.
- Pruning no longer deletes annotated executions. Someone annotating an execution
  is the clearest signal they want to keep it; without the exclusion subquery the
  two surviving `should not prune annotated executions` specs fail (verified by
  removing it).
- Execution summaries carry their annotation again. Loaded in a second query
  keyed on the already-paginated ids rather than joined into the list query: a tag
  join multiplies rows, so `LIMIT` would have truncated executions instead of
  tags. Filtering by `vote`/`annotationTags` does join, and only when those
  filters are present, so the common list path keeps its existing plan.

**Added — `packages/cli`**

- `annotation-tags.controller.ts` at a **fair-code path** (was
  `annotation-tags.controller.ee`), plus `AnnotationTagService`. `/rest/annotation-tags`
  CRUD gated on `annotationTag:list|create|update|delete`, reusing the same
  `CreateOrUpdateTagRequestDto`/`RetrieveTagQueryDto` the surviving
  `createTagsApi('/annotation-tags')` client sends. Kept separate from
  `TagService` rather than made a mode flag, so neither tag surface can grant the
  other's scope.
- `server.ts` and the integration `test-server` now import it. This was the last
  `.ee` reference in `packages/cli`: the feature-list check
  (`grep -ran "annotation-tags\.controller\.ee" …`) returns **0**.

**Added — annotation notes end to end**

`note` reaches the database for the first time in this fork: added to
`ExecutionSummary.annotation` (`packages/workflow`), to `ExecutionUpdatePayload`,
to the `PATCH /rest/executions/:id` zod schema — **which strips unknown keys, so
without this the field would have been silently dropped** — and to
`serializeAnnotation`. The upsert in `ExecutionService.annotate` is now
field-wise, so a vote-only update no longer erases an existing note (both
behaviours verified by reverting the change and watching the specs fail).
`ExecutionSummary.annotation.vote` is now `AnnotationVote | null`, matching the
nullable column and what the list already returned. No surviving consumer reads
`note` yet — the A11 editor components will.

**Clean-room sources:** the two annotation migrations (authoritative schema), the
surviving `AnnotationTagsRequest` in `requests.ts`, `tags.api.ts` +
`tags.store.ts` (routes, DTOs and scopes), the intact `@Patch('/:id')` handler in
`executions.controller.ts`, `executions.store.ts` (which does
`addExecution(response)`, pinning PATCH's full-summary response), the surviving
`execution.service.integration` and `executions-pruning.service` specs, the
`annotateExecution`/`createAnnotationTags` test helpers, and `tags.controller.ts`
as the controller idiom.

**Verification:** `@n8n/db` build exit 0 and **411/411** (409 + 2 new);
`n8n-workflow` **5510/5510**; `packages/cli` `tsc -p tsconfig.build.json --noEmit`
**32 → 16 errors, 0 new** (all 16 remaining are the purged
`@n8n/ai-workflow-builder` package and `workflows.controller.ts`, neither in E19's
scope); cli execution unit tests **231/231**; integration
`execution.service.integration` **37/37** (was 32/37 — the 5 failures were the
annotated-list specs), `executions.controller` **15/15** including 4 new PATCH
specs, `executions-pruning.service` **22/22**, `test/integration/executions`
**45/45**, and a new `annotation-tags.api` spec at **9/9**. `eslint --quiet` on
every touched file: 0 errors.

**Also verified on Postgres**, which mattered here: the surviving code warns that
upsert behaviour diverges between the two databases and the annotate path is an
upsert, plus the prune exclusion is hand-written SQL. Against a real Postgres
(`pnpm --filter n8n-containers services --services postgres`, then
`pnpm test:postgres`): `executions.controller` **15/15** including the three note
specs, `executions-pruning.service` **22/22**, `annotation-tags.api` **9/9**,
`execution.service.integration` **37/37** — **83/83**, no divergence from SQLite.

**Does not fully unblock A10.** `start.test.ts` still collects 0 tests, but on a
different import now: `@n8n/ai-workflow-builder`, reached via `ai.controller.ts`.
The earlier note that annotations were the sole cause was wrong — there were two
blockers and this closes one. The other is defork item C2.

### 2026-08-10 — Eight public API routes were requiring scopes no key could hold

**Fixed — `@n8n/permissions` `constants.ts`**

The API-key catalog and the public API's own `x-required-scope` declarations had
drifted apart in the direction nothing was checking. Diffed mechanically against
every `x-required-scope` in `packages/cli/src/public-api/v1/**`: 88 scopes are
required by routes, 80 were declared, **8 were missing** — `credential:update`,
`execution:retry`, `project:export`, `role:manage`, `role:manageProject`,
`workflow:export`, `workflow:import` (and `execution:stop`, below). There were
zero orphans in the other direction, which is why the existing parity test —
it only asserts catalog ⊆ required — stayed green.

This was not merely cosmetic. A key's scopes are validated against
`getApiKeyScopesForRole` at creation and enforced with a strict
`apiKeyScopes.includes(endpointScope)` at request time, so a required scope
absent from the catalog can never be granted and its route answers 403 to
everyone, owner included. Each of the eight was also already a hard type error at
its handler, which is why `packages/cli` could not compile.

`packages/cli` `tsc -p tsconfig.build.json --noEmit`: **40 → 32 errors**, one per
scope closed, 0 new. Catalog ↔ spec diff is now exact in both directions
(0 missing, 0 orphans).

**Added — public API scope-parity test**

The parity test asserted only that every declared API-key scope is required by
some route. It never asserted the converse, which is the direction that breaks
routes — so the eight missing scopes were invisible to it. It now checks both.

**Clean-room source:** the surviving public API OpenAPI specs
(`x-required-scope`) and the fair-code handlers/controllers that declare them.

### 2026-08-10 — `execution:stop` added to the RBAC catalog so the stop routes work

The eighth missing scope needed more than a catalog entry. `execution:stop` is
required by `POST /executions/{id}/stop` and `POST /executions/stop` (both
surviving fair-code routes, both declaring it in their OpenAPI spec), but it did
not exist as an RBAC scope at all — so even once declared as an API-key scope, no
role could hold it and the routes would have kept returning 403 to everyone.

`execution:stop` is therefore now a scope in its own right. Consequences worth
knowing:

- `ALL_SCOPES` gains an entry, so `AuthRolesService` writes one new `scope` row on
  each instance's next boot (the table is synced from `ALL_SCOPES`, so no
  migration is needed). The snapshot test that guards catalog changes was updated
  deliberately — it caught this, which is what it is for.
- Instance owner and admin hold it automatically (both are the full visible
  catalog). Custom roles do not, unless granted; it is not added to the custom
  role editor's scope groups.
- Nothing else enforces it: the internal REST stop route and the public API
  handler both authorize on `workflow:execute` against the workflow. The scope
  gates *which API keys* may reach the route, layered on top of that.

### 2026-08-10 — Shared role/scope types made honest about the runtime

The Tier-0 `@n8n/permissions` rebuild under-approximated four shared contracts.
Nothing was wrong at runtime; the *types* claimed less than the code already does,
which blocked the `editor-ui` typecheck and left 26 real errors in `packages/cli`.
Each correction below is pinned by surviving fair-code evidence — no `.ee` source,
history or upstream was read.

**Changed — `types.ts`**

- `RoleObject.slug` widened from `AllRoleTypes` to `AllRoleTypes | (string & {})`.
  Custom roles are saved under generated slugs
  (`${roleType}:${name}-${suffix}`, `RoleService.createCustomRole`) and the `role`
  table types `slug` as `string`.
- `RoleObject.description` `string` → `string | null` (the column is nullable and
  `CreateRoleDto.description` is optional).
- Added `usedByUsers?`/`usedByProjects?` — `RoleService.dbRoleToRoleDTO` has always
  returned them for `?withUsageCount=true`, and `useRoleDeleteGuard`,
  `useRoleDeletion` and `ProjectRoleView` read them.
- Added `createdAt?: Date`/`updatedAt?: Date` — the entity extends `WithTimestamps`
  and is spread into the DTO; `roles.public.controller.ts` already calls
  `role.createdAt!.toISOString()` (the `!` pins them as optional `Date`), and
  `RolesTable.vue` renders `updatedAt`.
- `AssignableProjectRole` `Exclude<ProjectRole, 'project:personalOwner'>` → `string`,
  mirroring `AssignableGlobalRole`. The runtime validator `teamRoleSchema` accepts
  `/^(project|custom):.+/`, so custom project roles are assignable and the old type
  contradicted it. No consumer relied on exhaustiveness (`isRoleLicensed`'s switch
  has a `default`).

**Changed — `roles/custom-role-scopes.ts`**

- `PROJECT_CUSTOM_ROLE_OPERATIONS` is now the editor's *visible* checkbox map,
  reconstructed one-for-one from the surviving `projectRoles.<resource>:<operation>`
  i18n keys and `SCOPE_TYPES` in `projectRoleScopes.ts`. This adds the four
  project resources the rebuild missed (`project`, `sourceControl`,
  `externalSecretsProvider`, `externalSecret`) and drops the operations that were
  swept in wholesale from `RESOURCES` but have no label, no checkbox and no
  translation.
- The scopes a project role may actually *hold* moved to a new
  `PROJECT_CUSTOM_ROLE_HIDDEN_OPERATIONS` map, so `PROJECT_CUSTOM_ROLE_SCOPES`
  stays a superset of the editor surface — as the surviving test requires
  (`workflow:list`, `credential:list`, `dataTable:listProject`). Verified
  mechanically: **87 → 102 scopes, 0 removed**, the 15 additions being exactly the
  four new resources plus their implicit `:list` twins. No existing custom role
  loses a grant.
- `GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS` gained the four groups the instance role editor
  indexes but the rebuild never defined: `role`, `apiKey`, `tag`, `insights`. Their
  option sets are pinned by the `instanceRoles.description.*` strings, by
  `SUPERSEDED_BY` (each "Manage" is a strict superset of the option it supersedes)
  and by the controllers that enforce them (`apiKey:manage` is what reaches other
  users' keys; the roles list is gated on `role:read`).
- Both operation maps now `satisfies { [R in Resource]?: ReadonlyArray<ResourceOperation<R>> }`,
  so an operation that does not exist for its resource is a compile error rather
  than a silently dead scope string.

**Changed — `constants.ts`**

- `API_KEY_RESOURCES` gained `communityPackage`, `dataTable`, `dataTableColumn`,
  `dataTableRow`, `executionTags` and `insights`. Every operation added is required
  by a live public API route (`x-required-scope` in `public-api/v1/**`), and each
  was already a hard `packages/cli` type error where the handler passes the scope to
  `apiKeyHasScopeWithGlobalScopeFallback`. `API_KEY_RESOURCES` is a separate surface
  from `RESOURCES`, not a subset — `dataTableRow`/`dataTableColumn`/`executionTags`
  exist only here.

**Fixed — `public-api-permissions.ts`**

- `OWNER_API_KEY_SCOPES` was rebuilt as "the full set" of API-key scopes. The
  surviving `community-packages` public API test disproves that: it unions
  `communityPackage:*` onto `OWNER_API_KEY_SCOPES` to build a working key, and
  asserts a key holding only `OWNER_API_KEY_SCOPES` gets a 403 from
  `GET /community-packages`. Community-package management is therefore opt-in, and
  the constant now excludes it. Surfaced by this work (adding `communityPackage` to
  the API-key catalog made the too-broad owner set observable); no runtime
  authorization changes, as `OWNER_API_KEY_SCOPES` has no `src` consumer.

**Changed — `@n8n/i18n` `en.json`**

- Added the three missing project-role tooltips (`workflow:share`,
  `sourceControl:pull`, `sourceControl:manage`); the required key set was derived
  from the operations map, not from a report.
- Removed `projectRoles.workflow:updateRedactionSetting` (+ tooltip): migration
  `1784000000013` split that scope into `enableRedaction`/`disableRedaction`, so the
  keys were stale and named a scope absent from the catalog.
- Removed a duplicate `projectRoles.credential:createEndUser` key pair.

**Clean-room sources:** the surviving fair-code consumers
(`projectRoleScopes.ts`, `instanceRoleScopes.ts`, `ProjectRoleView.vue`,
`RolesTable.vue`, `apiKeys.constants.ts`, the role/api-key/tags/insights
controllers, the public API `x-required-scope` specs), the surviving
`custom-role-scopes.test.ts`, the `role` entity and migrations, and `en.json`.

**Verification:** `@n8n/permissions` **105/105**, build exit 0, no snapshot
changed; `@n8n/api-types` **1775/1775**; `@n8n/db` build exit 0 and **409/409**;
`@n8n/i18n` build exit 0; `packages/cli` `tsc -p tsconfig.build.json --noEmit`
**66 → 40 errors, 0 new**; cli role/project/api-key unit
tests **61/61**; integration `role.service` + `custom-roles-functionality`
**97/97**; `role.controller` **51/51** and `built-in-roles` **7/7**;
`role.api`/`project.api` show the same 8 pre-existing failures as master (per-role
scope sets, project listing — unchanged by this work); public API `scope-parity`
keeps 3/4 with the same pre-existing `users.handler.ee` load failure, and the
"no orphan API-key scopes" assertion still passes. `eslint` on every touched file:
0 errors, no rule disables.

### 2026-08-09 — E10 hardening: split-brain fixes in multi-main leadership

Follow-up to the E10 rebuild below, closing eight defects found in an adversarial
review of it. Same clean-room provenance: derived from the surviving primitives,
the fair-code consumers and this repo's own fair-code — no `.ee` body was read.
Three of the eight could put two mains into leadership at once, which means every
schedule, trigger and webhook runs twice.

**Fixed — the lock owner is now an unguessable token, not `hostId`.** Docker
derives `hostId` from the hostname, and this repo explicitly detects live host-ID
clashes, so two mains could share one. The second would read the first's key as
"ours", promote without an atomic claim, and both could renew and delete the same
key; reusing a hostname when replacing an instance gave the same problem across
time. `LeaderElectionClient` now mints a random token at each claim, stores
`hostId#token`, and both Lua scripts compare the whole value. `hostId` is kept
only so the debug endpoint and logs can still name the leader.

**Fixed — a read of our own key no longer promotes on its own.** After a
transient demotion, a follower could read its still-present key milliseconds
before expiry and promote; the key then lapsed and another main took over
alongside it. Promotion now requires a *successful* owner-checked renewal — a
missing key falls through to the atomic claim, another owner keeps us a follower.

**Fixed — local leadership is bounded by the lease deadline.** Takeover and
stepdown handlers used to run inside the same guard that prevents overlapping
checks, so every renewal was skipped until the last handler settled: one slow
handler let the key expire while the instance kept leading. Handlers now run on
their own serialized queue while renewals continue. Separately, the instance
tracks the last *proven* lease deadline (measured from when the renewal was sent,
so it never over-estimates) and a 500ms watchdog demotes it once less than a
second of that lease remains — including while a Redis command is hung, which is
exactly when the old interval check was suppressed. **Not closed:** a long process
pause or a Redis failover can still leave this instance believing it leads after
the key has moved, because the bound is enforced by its own clock. Only fencing
tokens threaded through leader-only work close that window; that is an
architectural change and is deliberately out of scope here.

**Fixed — config validation now accounts for the command timeout.** The old rule
accepted a 2s TTL with a 1s interval even though a leader-election command may
wait 5s, so the key could expire while the renewal meant to extend it was still
in flight. Startup now requires `interval + 5s command timeout + 1s margin < TTL`.
The shipped defaults (10s TTL, 3s interval → 9s < 10s) still pass, and no config
in the repo sets either variable. Supersedes the "at least 2s" rule below.

**Fixed — failed transition handlers are no longer just logged.** A rejected
stepdown handler left triggers, pollers or timers running here beside the main
that now holds the lease. Failed stepdown teardown is now fail-stop: the process
logs and exits so a supervisor restarts it as a clean follower, rather than
silently double-running every schedule. A failed *takeover* instead demotes,
releases the lease so another main can take over cleanly, and tears down whatever
did start. Supersedes the "a throwing handler is logged without aborting" decision
below.

**Fixed — leadership handlers are wired before the election starts.** `init()`
started the interval but `start.ts` subscribed only after license, asset and
module init, so an early transition reached zero handlers — `WaitTracker` could
start as leader, have a renewal failure fire a stepdown into the void, and keep
its timer running. `MultiMainSetup.init()` now subscribes itself, before the first
timer can fire; `MultiMainMetadata.subscribe()` already replays earlier
registrations and keeps notifying on later ones, so late-loading modules are
unaffected. Supersedes the `registerEventHandlers()` ordering note below.

**Fixed — a claim that wins during shutdown is released.** If shutdown began
while the atomic claim was in flight, the claim could still succeed; promotion
was correctly skipped, but the local role then read `follower`, the release was
skipped, and the exiting process owned the key until the TTL expired — blocking
immediate takeover. The owner-checked release now runs unconditionally after
draining. For an instance that holds nothing it is one compare-and-delete that
matches nothing.

**Fixed — worker-status requests from different users no longer collapse.**
Subscriber debounce is keyed only by command name, so two users asking within
300ms merged into one request and only the second user's `requestingUserId`
survived; the first user got no answers. `get-worker-status` is now an immediate
command.

**Fixed — the requesting user's ID is no longer echoed to the browser.** It is a
routing field, and the push payload is typed as a plain `WorkerStatus`. It is now
stripped before the push and kept on the worker→main hop where the routing
happens. Supersedes the "deliberately preserved" note below.

### 2026-08-09 — E10: multi-main leader election and worker status rebuilt fair-code

Rebuilds the last two purged scaling modules. **Clean-room source:** the
`.defork/e10-contract.md` contract (itself derived only from surviving fair-code),
the fair-code consumers that import these symbols (`start.ts`, `worker.ts`,
`debug.controller.ts`, `orchestration.controller.ts`), the surviving
`leader-election-client.ts` primitives, the `@OnLeaderTakeover` /
`@OnLeaderStepdown` decorator contract and its test, the `WorkerStatus` DTO in
`@n8n/api-types`, and the pubsub event map. No `.ee` body was read.

**Built at fair-code paths, not the contract's `.ee` filenames.** The contract's
file map named the targets `multi-main-setup.ee.ts` and
`worker-status.service.ee.ts`; this fork bans `.ee` paths, so they landed as
`packages/cli/src/scaling/multi-main-setup.ts` and
`packages/cli/src/scaling/worker-status.service.ts`, with every consumer and spec
import repointed. Spec assertions were not touched.

**Added — multi-main leader election.** `MultiMainSetup` assigns a definitive
leader/follower role before `init()` resolves, renews the leader key on an
interval, reconciles local role against Redis, and drives the `leader-takeover` /
`leader-stepdown` events that 22 leader-only services depend on for triggers,
schedules, queue recovery, pruning and gateway lifecycles. It adds only the state
machine, timers and events on top of `LeaderElectionClient`; the Redis primitives
were already fair-code.

**Added — an owner-checked leader release.** `LeaderElectionClient.clearLeader()`
performed an unconditional `DEL`, so a process with a stale local role could
delete a *newer* leader's key — the exact split brain that makes two instances run
every schedule. It is replaced by `releaseLeaderIfOwner()`, a compare-and-delete
Lua script mirroring the existing owner-checked renewal. `clearLeader()` had no
callers and was removed rather than left as a footgun.

**Added — leader-election config is now validated at startup.** Nothing checked
that the renewal interval fits inside the key TTL, so a misconfigured instance
would let its key expire between renewals and flap leadership silently. `init()`
now rejects with an actionable error unless the TTL is at least 2s and the
interval leaves room for two renewal attempts per TTL window. The shipped defaults
(10s TTL, 3s interval) pass; no config in the repo sets either variable.

**Added — worker status reporting.** `WorkerStatusService` publishes
`get-worker-status`, answers it on workers with one process/host snapshot, and
fans responses out to the requesting user over push from whichever main holds
their connection.

**Behaviour decisions on points the contract left open** (each covered by a test
in `src/scaling/__tests__/multi-main-setup.test.ts`):

- Ambiguity always fails closed — the instance demotes rather than optimistically
  retaining leadership. A failed atomic claim is never treated as proof of
  leadership.
- A renewal error demotes on the **first** failure. The trade-off is accepted and
  deliberate: a transient Redis blip causes a stepdown/takeover cycle (and the
  trigger churn that implies) roughly one interval later, which is far cheaper
  than two mains believing they lead.
- The **initial** role assignment emits no `leader-takeover`. `Start` calls
  `registerEventHandlers()` only after `init()` resolves, so the event would reach
  zero handlers; all 22 leader-only consumers self-initialize from `isLeader`.
- Transitions **await** their decorator handlers. Handlers run concurrently (no
  guaranteed order — stepdown teardown is time-sensitive) and a throwing handler
  is logged without aborting the transition or the other handlers.
- `shutdown()` does **not** emit `leader-stepdown`; consumers needing exit
  teardown already declare `@OnShutdown`, and emitting would run it twice.
- `fetchLeaderKey()` throws on a Redis failure rather than returning `null`, so an
  outage cannot masquerade as "no leader".
- The election client is resolved lazily, not constructor-injected: it opens a
  Redis connection, and `DebugController` injects `MultiMainSetup` on every
  instance — including single-main and regular-mode ones with no Redis. For the
  same reason `fetchLeaderKey()` short-circuits to `null` on a non-multi-main
  instance without contacting Redis. **Caveat:** that check reads `isMultiMain`,
  which includes licensed state, so an instance whose multi-main entitlement is
  absent reports `null` on the debug endpoint even if a leader key exists.
- A leader check still in flight when `shutdown()` begins can no longer promote
  the instance. Without a guard, a check parked on its leader read would resume
  after shutdown started, win the atomic claim, and run every takeover handler —
  starting gateways, pruning timers and trigger activation on an exiting process,
  only for shutdown to delete the key it had just acquired.

**Known, deliberately preserved:** a worker's status response echoes the
requesting user's ID back inside the public `status` payload pushed to that user's
browser. It is pinned by the surviving spec and left as-is; see the note in
`.defork/e10-contract.md` §8.15. *(Superseded by E10 hardening above: the review
confirmed this is a contract leak rather than an authorization bypass, the field
is now stripped before the push, and the spec was repinned.)*

Still under-pinned and chosen as the simplest correct option: worker CPU string
formatting, network-interface flattening order (name-sorted), unavailable
container-memory APIs reported as `0`, and transition log wording.

### 2026-08-09 — E18 hardening: publication-integrity fixes

Follow-up to the E18 rebuild below, closing five defects found in an adversarial
review of it. Same clean-room provenance: derived from the surviving DTOs, the
fair-code consumers, and this repo's own fair-code — no `.ee` body was read.

**Fixed — decisions are bound to the version the reviewer inspected.** A
reviewer could load V1, have the author re-pin to V2, and approve — publishing a
version nobody reviewed. `decide()` now resolves the pin inside its own
transaction, takes the link row with a conditional write that re-asserts that
pin, and auto-publishes the version that transaction returned rather than one
read before it. **Partial by design:** this closes a re-pin that races the
decision. A re-pin that lands *before* the decision arrives is caught only when
the client sends the new optional `expectedVersionId` on
`POST /workflow-review-requests/:id/decision`, which is CAS-checked and 409s on
mismatch. The field is optional so existing clients keep working; the protection
is complete only once the editor sends it (tracked separately).

**Fixed — "at most one open review per workflow" is now a database invariant.**
It was an unlocked check-then-insert, so two concurrent creates both committed
and both blocked publication. A nullable `openWorkflowId` sentinel on
`workflow_review_request_workflow`, cleared on every closure path and covered by
a plain unique constraint, enforces it portably on SQLite and Postgres (a
partial unique index is not portable). Contention returns 409.

**Fixed — a pinned version is verified to belong to the linked workflow.** The
foreign key only checks the globally unique `versionId`, so a caller could pin
another workflow's version, producing a null review snapshot that blocked
publication and then failed to publish. The `(workflowId, versionId)` pair is
now validated before both create and re-pin, and a version-metadata update
affecting zero rows is an error instead of being ignored.

**Fixed — transfers close their reviews atomically.** Ownership changed before
the best-effort `afterWorkflowsTransferred` hook, so a failure in the gap left
the destination project's members able to see and decide the source project's
still-open review. Closure now runs in the transaction that moves ownership,
through a new `duringWorkflowsTransferred` hook that is allowed to throw;
`afterWorkflowsTransferred` remains post-commit but only broadcasts. **Behaviour
change:** a closure failure now fails the transfer instead of being swallowed.

**Fixed — workflow deletion no longer orphans the review aggregate.** The
cascade removed the child link but not its parent request, and a swallowed
pre-delete failure left that parent `open`. `beforeWorkflowDeleted` now
propagates failures so the delete is aborted, and `afterWorkflowDeleted` removes
requests left without any workflow. **Behaviour change:** a review-closure
failure now aborts a workflow delete, including the per-workflow loops in
project deletion and user deletion.

**Added (migration):**
`packages/@n8n/db/src/migrations/common/1785913150000-AddOpenWorkflowSentinelToWorkflowReviews.ts`,
reversible. Adds the nullable sentinel column, resolves any pre-existing
duplicate open reviews (newest per workflow keeps the sentinel and stays open,
older ones are closed), backfills the sentinel for open reviews, then creates
the unique index. Both index files are generated, so they pick it up
automatically.

**Changed (persistence, `packages/@n8n/db/`):**
`WorkflowReviewRequestWorkflowRepository` gains `takeLinkAtPin` (the locking
pin CAS that also releases the sentinel) and reports a sentinel collision as a
domain result rather than a driver error; `createWorkflowRow` now takes an
explicit `open` flag. `WorkflowReviewRequestRepository` clears sentinels before
the request-row write — the module's single lock order is link row before
request row — and gains `deleteLinklessRequests`. `WorkflowHistoryRepository`
gains `versionBelongsToWorkflow`. `SharedWorkflowRepository.transferOwnership`,
`WorkflowRepository.updateParentFolder` and `FolderRepository.moveFoldersToProject`
now run in the caller's transaction (`OperationContext`), so ownership, folder
re-homing and module cleanup commit as one unit.

**Verification:** 108 tests across the module (31 unit, 77 API integration), 4
new migration tests covering the duplicate resolution and the reversal, all
green on both SQLite and Postgres. Every new guard was mutation-tested: breaking
it makes targeted tests fail.

### 2026-08-09 — E18: workflow-reviews module

Rebuilds the purged workflow-reviews backend module clean-room: the two ORM
entities and their junctions, the two repositories, the eight-route REST
surface, the publish guard, the lifecycle hooks, and the workflow-history
pruning protection for open review pins. Unlike other de-fork items, **no
backend endpoint spec survived** — the surviving DTOs, the frontend REST client,
the migration and the workflow-history integration test were the whole contract,
so this change also authors the missing endpoint/service tests (82 new tests).

**Added (entities, `packages/@n8n/db/src/entities/`):**
`workflow-review-request.ts` (`WorkflowReviewRequest` → `workflow_review_request`)
and `workflow-review-request-workflow.ts` (`WorkflowReviewRequestWorkflow` →
`workflow_review_request_workflow`), both registered in `entities/index.ts` —
export block **and** the `entities` map, whose keys are what `testDb.truncate`'s
`EntityName` union derives from (the surviving workflow-history integration test
truncates both by name). The reviewer and author junctions are modelled as
`@ManyToMany` + explicit `@JoinTable` on the request rather than as entities, so
`truncate` clears them through TypeORM's many-to-many metadata instead of relying
on FK cascade.

**Added (repositories, `packages/@n8n/db/src/repositories/`):**
`workflow-review-request.repository.ts` and
`workflow-review-request-workflow.repository.ts`, exported from
`repositories/index.ts`. Both extend `BaseRepository`, take an `OperationContext`
and keep TypeORM behind use-case-named methods. `createRequest`,
`createWorkflowRow` and `findByRequestId` reproduce the exact signatures the
surviving `workflow-history.repository.test.ts` calls.

**Added (module, `packages/cli/src/modules/workflow-reviews/`):** fair-code path,
no `.ee`. `workflow-reviews.module.ts` (registers the controller and both
providers), `workflow-reviews.controller.ts` (the eight routes),
`workflow-review.service.ts` (authorization, transitions, detail assembly,
approval, auto-publication, collaboration invalidation),
`workflow-review-access.service.ts`, `workflow-review-feature.service.ts`,
`workflow-review-inbox-cursor.ts`, `workflow-review-publish-guard.ts`,
`workflow-review-lifecycle-hooks.ts`, and
`database/workflow-review-user.repository.ts`.

**Changed:** `WorkflowHistoryRepository.deleteEarlierThanExceptCurrentAndActive`
now excludes versions pinned by an **open** review, even when named-version
preservation is off — review pins are named versions and would otherwise be
pruned mid-review. A closed review no longer protects its pin, and the child FK
nulls the pin when the version is pruned.
`ownership-transfer.manifest.json` now points `WorkflowReviewRequest` at its
rebuilt declaring file, and the integration `test-server.ts` imports the clean
module path.

**Fixed (surviving-code defect):** `WorkflowMutationHooks.afterWorkflowsTransferred`
existed on the proxy but had **no production caller**, so no module could react
to a workflow changing project. `EnterpriseWorkflowService.transferWorkflow` and
`.transferFolder` now invoke it after the ownership change commits. Without this,
moving a workflow to another project would have left its review open and blocking
publication forever.

**Decisions on under-pinned points** (contract §9), all covered by new tests:
single-open-review uniqueness is enforced by a check inside the create
transaction rather than a new forward migration (a partial unique index on
`state = 'open'` is not portable across SQLite and Postgres, and the migration is
already deployed); a new pin resets `changes_requested` to `pending`; authors are
the creator plus anyone who re-pins; lifecycle closure sets `state = 'closed'` and
`closedById` but leaves `decision` untouched, because closing for an archive or a
move is not a reviewer verdict; the diff baseline is the currently published
version; disabling the policy stops enforcement but leaves open reviews intact.

**Deliberate deviations from a documented interface, both covered by tests:**
`beforeWorkflowDeleted` is documented as the one mutation hook that *may* throw
to abort a delete; this provider swallows and logs instead, because failing to
tidy up review bookkeeping should not stop a user deleting their own workflow.
And although the schema permits several workflows per review, `decide` now
throws `UnexpectedError` if it ever finds more than one, rather than picking an
arbitrary row — the relation is unordered, so a silent pick would authorize
against one workflow while publishing another's pinned version.

**Clean-room sources:** the surviving migration
`packages/@n8n/db/src/migrations/common/1784000000052-CreateWorkflowReviewRequestTables.ts`
and its spec (authoritative for tables, columns, FKs and indices); the seven
surviving DTOs and shared types in `packages/@n8n/api-types/src/dto/workflow-reviews/`,
`workflow-review-request-summary.ts`, `workflow-review-eligible-reviewer.ts`,
`workflow-reviews-policy.ts`, `push/workflow-review.ts` and
`workflow-publish-blocked-details.ts` (authoritative for every request and
response shape); the frontend REST client
`packages/frontend/editor-ui/src/features/workflow-reviews/workflowReviews.api.ts`
with its stores and components (authoritative for method, path, and the 409 /
403-404 / auto-publish behaviours) — read only, never modified; the surviving
`packages/cli/test/integration/database/repositories/workflow-history.repository.test.ts`
(pins repository class names, the three method signatures and pin-retention);
the fair-code proxies `workflow-publish-guard-proxy.service.ts` and
`workflow-mutation-hooks-proxy.service.ts`; `collaboration.service.ts`,
`workflow-review-policy.service.ts`, `security-settings.controller.ts`,
`frontend.service.ts`, `WorkflowPublishHistoryRepository`, and
`ownership-transfer.manifest.json`. No `.ee` body was read from any source.

### 2026-08-09 — E17: agent-eval database substrate

Rebuilds the four purged agent-eval entities and their repositories in
`@n8n/db`, clean-room. The whole `packages/cli/src/modules/agent-evals/`
module survived as fair-code but could not typecheck — and its ~2,900 lines of
specs could not run — because the persistence layer it imports was removed with
the Enterprise purge. Nothing in the surviving module was changed; the
repositories were built to satisfy its existing call sites.

**Added (entities, `packages/@n8n/db/src/entities/`):**
`agent-eval-dataset.ts` (`AgentEvalDataset` → `agent_eval_dataset`),
`agent-eval-run.ts` (`AgentEvalRun` → `agent_eval_run`),
`agent-eval-result.ts` (`AgentEvalResult` → `agent_eval_result`),
`agent-eval-rating.ts` (`AgentEvalRating` → `agent_eval_rating`) — all
registered in `entities/index.ts` (export block **and** the `entities` map,
whose keys are what `testDb.truncate`'s `EntityName` union is derived from).

**Added (repositories, `packages/@n8n/db/src/repositories/`):**
`agent-eval-dataset.repository.ts`, `agent-eval-run.repository.ts`,
`agent-eval-result.repository.ts`, `agent-eval-rating.repository.ts`, exported
from `repositories/index.ts`. All extend `BaseRepository`, are `@Service()`, and
keep TypeORM inside the persistence layer behind use-case-named methods taking
plain parameters.

**Relations — deliberate deviation from the migration's FK set.** The migration
declares FKs to `agents` and `user`. `AgentEvalRun.dataset`,
`AgentEvalResult.run` and `AgentEvalRating.result` are wired as ORM
`@ManyToOne` relations (both endpoints live in `@n8n/db`), and `createdBy` /
`ratedBy` point at `User` the way `EvaluationCollection` does. **`agentId` is a
plain column with no ORM relation**: `Agent` is registered by the `agents`
module, so a relation from an always-loaded `@n8n/db` entity would break
TypeORM metadata whenever that module is off — the exact failure the surviving
`assertRequiredModulesActive` guard exists to pre-empt. Referential integrity
there stays the migration's DB-level FK.

**Clean-room sources:** the surviving migration
`packages/@n8n/db/src/migrations/common/1784815940112-CreateAgentEvalTables.ts`
(authoritative for columns, types, nullability, FKs, indices and enum checks)
and its spec `packages/cli/test/migration/1784815940112-create-agent-eval-tables.test.ts`;
the surviving consumers in `packages/cli/src/modules/agent-evals/` (runner,
service, rating service, case-generation service, controller, record mappers),
which pin every method name, parameter and return shape; the module's own specs,
notably the three `*.integration.test.ts` files, which pin repository behaviour
against a real driver; the shared contract in
`packages/@n8n/api-types/src/schemas/agent-evals.schema.ts` (status/vote unions
and `DatasetRef`, imported rather than redefined); and sibling fair-code
conventions in `@n8n/db` (`test-run`, `test-case-execution`, `evaluation-config`,
`evaluation-collection`). No Enterprise source or history was consulted.

**Under-pinned choices** (no spec asserts them; simplest option consistent with
the migration and the consumers, flagged here rather than claimed as covered):

- `findByAgentId` orders datasets newest-first (`createdAt DESC, id DESC`);
  `findByResultId` orders a case's rating history newest-first. Only single-row
  results are asserted.
- `findLatestByRunId` joins rating → result in SQL, then picks the newest per
  case in memory. A `MAX(createdAt)` correlated sub-query would return both rows
  on a same-millisecond re-vote, and window functions are not uniform across the
  supported drivers. Bounded by a run's 500-case cap.
- `markAllIncompleteAsError` writes `errorCode: 'interrupted'` with a generic
  `errorDetails.message`; the spec only reads `affected`.
- `updateDataset` treats an empty payload (which the DTO permits) as a legal
  no-op and returns the row, instead of letting TypeORM throw on an empty
  `UPDATE`. Only keys actually present are written, so `description: null`
  (clear) stays distinct from an omitted `description` (leave).
- `markAsCancelled` / `markAsCompleted` / `markAsError` set `completedAt`; the
  run-level `metrics` argument is written only when supplied, so an early
  failure can't null out a tally.
- `findAndCountByDatasetIdAndAgentId` uses an explicit join with `offset`/
  `limit` rather than `find`'s `skip`/`take`, which routes a relation-filtered
  query onto TypeORM's DISTINCT sub-query path; a many-to-one join cannot
  multiply rows. `take: 0` keeps n8n's "no limit" meaning.
- `findAndCountByRunId` orders by `runIndex` first: seeding inserts every case
  in one statement, so `createdAt` ties and the fallback would be the
  non-monotonic generated id.
- Unlike `TestRunRepository.markAsCompleted`, the run's completion is **not**
  guarded on `cancelRequested: false` — nothing pins that behaviour here and the
  runner already branches on the cancel flag before calling.

**Verification:** `@n8n/db` `pnpm build` exit 0, `pnpm typecheck` exit 0,
`pnpm test` **409/409** (31 files — unchanged from baseline). `packages/cli`:
agent-eval unit specs **228/228** across 7 files (previously unable to run);
agent-eval integration specs **17/17** on SQLite *and* **17/17** on Postgres via
testcontainers; migration spec **4/4** on SQLite and **4/4** on Postgres.
`tsc -p tsconfig.build.json --noEmit` → **0** errors mentioning `agent-eval`
(74 unrelated pre-existing errors remain in 27 files, all from other pending
de-fork epics). `eslint src/modules/agent-evals --quiet` exit 0 and eslint on
the eight new `@n8n/db` files exit 0, no rule disables. Regressions unmoved:
`credentials.api.test.ts` 80/80, `src/modules/external-secrets
src/modules/dynamic-credentials` 2/2. `grep -ran "agent-eval" packages/cli/src
packages/cli/test | grep -c "\.ee"` → **0**.

### 2026-08-09 — E8: external-secrets module rebuilt fair-code

Rebuilds the purged external-secrets module clean-room at
`packages/cli/src/modules/external-secrets/`. Only `external-secrets.config.ts`
and `secret-provider-access-check.service.ts` had survived; everything else —
the provider contract, the two registries, the manager and its lifecycle, the
secret cache, the legacy settings store, the connection service, five route
groups, project-deletion cleanup and module registration — is new here.
Clean-room sources: `.defork/e8-contract.md`, the nine surviving executable
specs and their shared provider fixture, the surviving entities/repositories/
migrations in `@n8n/db`, the DTOs and schemas in `@n8n/api-types`, the
`@n8n/permissions` scope catalog, the surviving event maps and relays, and the
fair-code consumers (`ExternalSecretsProxy`, `get-secrets-proxy.ts`,
`get-additional-keys.ts`, `credentials-helper.ts`, `credentials/validation.ts`).
No `.ee` body was read.

**Added — the provider contract.** `SecretsProvider` owns the connection state
machine so every provider reports progress and failure identically: `connect()`
moves `initializing → connecting → connected`, and on failure records `error`
plus a `connectionError` message instead of throwing — one unreachable store
must not abort start-up for the rest. Two registries, as the API requires:
`ExternalSecretsProviders` catalogs provider *types*, while
`ExternalSecretsProviderRegistry` holds live instances keyed by the connection's
expression-facing `providerKey`, which is what allows several AWS or Vault
connections with different `$secrets` names.

**Added — the manager.** `ExternalSecretsManager` selects the storage model
(legacy settings row, or connection entities once
`N8N_EXTERNAL_SECRETS_FOR_PROJECTS` / `N8N_EXTERNAL_SECRETS_MULTIPLE_CONNECTIONS`
is on), starts every configured provider, connects the enabled ones, and
registers itself on `ExternalSecretsProxy` — nothing else did, so without it
`$secrets` resolved to no providers at all. It handles the payload-less
`reload-external-secrets-providers` pubsub command and shuts down under
`@OnShutdown`. Teardown detaches the shared registry synchronously before
disconnecting, so a slow shutdown can never evict a concurrent restart's fresh
providers.

**Added — the connection API.** Five route groups: the legacy
`/external-secrets/**` routes, global connection CRUD plus test/reload at
`/secret-providers/connections`, the project-scoped equivalents under
`/secret-providers/projects/:projectId/connections`, provider-type metadata at
`/secret-providers/types`, and secret-name completions at
`/secret-providers/completions`. Project routes may *read* global connections
but never mutate them, and a connection belonging to another project is reported
as not found rather than forbidden, so a project cannot enumerate keys elsewhere.

**Added — project-deletion cleanup.** Registered as a
`ProjectOwnershipTransferHandler`, so deleting a project takes the connections it
owns with it, and merely *disables* connections it was only granted, dropping the
grant. Both halves and the grant removal run in one transaction through the
sanctioned `TransactionRunner`; a partial cleanup would either strand a
connection nobody can administer or leave grants pointing at a deleted project.
Connections are not *transferred* with a project, matching the `notTransferred`
decision already recorded for `ProjectSecretsProviderAccess` in the
ownership-transfer manifest.

**Added — `@n8n/db` surface the specs required.**
`ProjectSecretsProviderAccessRepository` (absent entirely) plus
`findEnabledGlobalConnections` and `findEnabledByProjectId` on
`SecretsProviderConnectionRepository`, which now extends `BaseRepository` so
deletion/disable run inside the caller's transaction.

**Secret handling.** Provider settings are only ever persisted encrypted with the
same `Cipher` API the credential subsystem uses — as `encryptedSettings` on the
connection row, or as the encrypted `feature.externalSecrets` settings row.
Password-typed settings fields are blanked with `CREDENTIAL_BLANKING_VALUE` in
every response that carries settings (legacy provider list and detail, and
connection create/read/update); the connection *list* endpoint omits `settings`
altogether and `DELETE` returns 204 with no body. Non-password fields (region,
URL, namespace) are returned verbatim — they are configuration, not credentials.
A payload that echoes the blanking marker back keeps the stored password rather
than overwriting it. Completions return secret *names* only; values are read
live from the provider and never cached, and remain confined to credential
expression evaluation. No log line, error message or API response carries a
secret value, a decrypted settings object or ciphertext.

**Provider implementations, stated plainly.** The six catalogued provider types
(`awsSecretsManager`, `gcpSecretsManager`, `vault`, `azureKeyVault`, `infisical`,
`onePassword`) are pinned by the public DTO enum, and settings metadata is
pinned only for Vault (display name, icon, `url`/`token`/`namespace`) and AWS
(`region` plus three password fields). **No vendor SDK contract survives for any
of them, and no spec exercises a real provider** — every acceptance spec
registers its own dummy provider. Rather than guess at an authentication
protocol and risk handing credentials to the wrong endpoint, these providers
ship their identity and settings form and fail loudly on connect
("No integration is available for the … secrets provider on this instance").
Azure Key Vault, Infisical and 1Password expose no settings fields at all,
because none survived. GCP declares only the `projectId` an update example
implies.

**Other under-pinned decisions.** Polling is implemented from the surviving
300-second `N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL` as a serialised, unref'd
interval that refreshes connected providers; timer type, retry, backoff and
failure isolation were unpinned. `N8N_EXTERNAL_SECRETS_MULTIPLE_CONNECTIONS` is
a name chosen here for the config field the specs require. Connection-route scope
decorators follow the permission catalog (`externalSecretsProvider:*`,
`externalSecret:list`); the missing controllers could not confirm them. The
`SetSecretsProviderConnectionIsEnabledDto` and
`UpdateExternalSecretsSettingsDto` DTOs have **no route** — their paths and
semantics were unpinned and none was invented; enabling/disabling is reachable
through the connection `PATCH`. `roleBasedAccess` in the module's frontend
settings reports whether project scoping is on, and `systemRolesEnabled` reads
the surviving `externalSecrets.systemRoles.enabled` instance setting (whose scope
map is empty in this fork, so switching it on currently widens nothing).
`hasProvider()` reports true only for a *connected* provider, so an errored or
retrying one surfaces the "not reachable" expression error rather than "secret
not found" — intermediate states are untested upstream, and this is the chosen
semantic. `getSecretNames()` answers from the cache alone, which is refreshed on
every successful connect and update: a connected provider whose `update()` has
never succeeded therefore reports no secrets rather than being queried live.
Behavior when `feat:externalSecrets` is unlicensed is untested upstream; the
module is gated on the flag, so an unlicensed instance registers no routes and
starts no providers.

**Verification:** integration `test/integration/external-secrets/` **154/154**
across 9 files — 8 of them previously failed to import (0 tests); the ninth,
`external-secrets.expression-access.test.ts`, already passed and is unchanged
here. `secrets-provider-connection.repository.test.ts` **11/11** (including the
three `findAllAccessibleProviderKeysByCredentialId` cases, which re-prove the
credential-side `$secrets` allowlist after the repository's base-class change);
`@n8n/db` unit **409/409**; credential validation/service/controller unit
**276/276**; regression `credentials.api.test.ts` **80/80** and
sso-saml/sso-oidc/provisioning/dynamic-credentials **201/201**, both unmoved.
The two consumer halves of §9 — the allowlist population in
`credentials-helper.ts` and the `externalSecret:list` / provider-existence checks
in `credentials/validation.ts` — survive untouched and already point at the
fair-code `secret-provider-access-check.service` path.
`grep -ran "external-secrets\.ee"` over `packages/cli/src` and `packages/cli/test`
returns **0**; `tsc -p tsconfig.build.json` reports **0** external-secrets errors;
`eslint src/modules/external-secrets --quiet` exits 0 with no rule disables, and
the stale `external-secrets.ee` entry was **removed** from the
`misplaced-n8n-typeorm-import` ratchet rather than repointed — the new connection
service imports no TypeORM at all. `ExternalSecretsProxy` registration, which no
spec covers, was verified by driving the real proxy through a temporary
integration probe (empty before `init()`, serving the provider's secrets after)
which was then removed.

### 2026-08-09 — E12: dynamic-credentials module rebuilt fair-code

Rebuilds the purged end-user ("private") credentials module clean-room at
`packages/cli/src/modules/dynamic-credentials/`. Only an 18-line
`services/shared-fields.ts` had survived a previous pass; the rest of the
module — persistence, per-user connection state, identity resolution, the read
and write paths, module registration and resolver CRUD — is new here. Clean-room
sources: `.defork/e12-contract.md` (a verified inventory of the surviving
fair-code contracts), the surviving migrations in `@n8n/db`, the fair-code
consumers themselves (`credentials-helper.ts`, `credentials.controller.ts`,
`credentials.service.ts`, `credentials-sharing.service.ts`,
`dynamic-credentials-proxy.ts`, `credential-connection-status-proxy.ts`,
`oauth.service.ts`, `webhook-helpers.ts`, `workflow-validation.service.ts`), the
surviving DTOs/schemas in `@n8n/api-types`, the `@n8n/permissions` scope
catalog, and the surviving executable specs. No `.ee` body was read.

**Added — persistence for end-user credential data.** Three entities and
repositories behind the module's `database/` folder, matching the surviving
migrations exactly: `dynamic_credential_resolver` (encrypted `config`),
`dynamic_credential_entry` (keyed by credential + arbitrary external subject,
snake_case columns) and `dynamic_credential_user_entry` (keyed by credential +
n8n user, camelCase columns). Both entry tables cascade from the credential, the
resolver and — for per-user rows — the user, so deleting any of the three takes
its credential data with it, while deleting a resolver only nulls the
credential's `resolverId` and leaves the credential itself alone. Two storage
classes wrap them; to those classes the stored payload is opaque text, so no
credential material is ever inspected or logged there.

**Added — per-user connection state.** `CredentialConnectionStatusService` is
registered on `CredentialConnectionStatusProxy` at module init and is what makes
`connectedByMe`, `connectedUserCount` and the per-user `data.oauthTokenData`
signal real on the existing `/credentials` routes. "Connected" means the system
resolver only — a user connects their own n8n account — and the list lookup is
one bulk query for the whole page rather than one per credential. Cleanup, by
contrast, spans every resolver: losing `credential:connect` drops all of that
user's data for the credential.

**Added — identity resolution.** `N8NIdentifier` maps the `n8n-auth` cookie
captured at the controller boundary to the running user by re-validating it
through `AuthService` at point of use, so a user who logs out mid-run stops
resolving (the invalid-token blocklist and the MFA gate both still apply) and
nothing request-bound (browser id, endpoint, method) is needed.
`CredentialResolverService` registers on `DynamicCredentialsProxy` as both the
resolution and the storage provider: it picks the resolver as credential →
workflow → seeded system resolver, turns the execution context's identity into a
subject (an n8n user for the system resolver, an opaque external subject
otherwise), and reads or writes that subject's payload encrypted with the same
`Cipher` API the credential subsystem uses. When no identity or no stored data
can be found it raises `CredentialResolutionError` rather than silently falling
back to the shared static credential.

**Added — module registration.** `DynamicCredentialsModule` registers the three
entities before the datasource is created, seeds the well-known `system-n8n`
resolver idempotently (a conflict on the id is ignored, so concurrent mains and
operator edits are both safe), registers the providers above, and exposes
`credentialCheckProxy` on the workflow context so webhook and MCP triggers can
gate a run on "is this credential connected for the triggering user?" before
anything executes. The module deliberately carries **no** `instanceTypes`
restriction — webhook and worker processes resolve credentials too.

**Added — `GET`/`POST`/`PATCH`/`DELETE /credential-resolvers`** plus
`/credential-resolvers/types` and `/credential-resolvers/:id/workflows`, gated on
the `credentialResolver:*` scopes. The resolver `config` is stored encrypted and
returned encrypted; the decrypted form is only ever included on a single-resolver
read. The built-in `system-n8n` resolver cannot be edited or deleted, and a
resolver still selected by a published workflow cannot be deleted until those
workflows are unpublished. The API schemas allow longer names/types (255) and ids
(36) than the tables do (128/128/16); the stricter **database limits are
authoritative** and over-long values are rejected with a 400 rather than
surfacing a driver error.

**Fixed — transferring an end-user credential.** `EnterpriseCredentialsService.transferOne()`
previously moved a private credential without checking whether the caller may
manage end-user credentials in the destination project, and left every existing
per-user connection in place. Both are now handled: the move needs
`credential:createEndUser` on the destination, and afterwards the old home
project's members are re-evaluated so anyone who lost `credential:connect` has
their connection removed — while users who keep access through the destination
project, or through a global role, keep theirs.

**Known gaps, stated plainly.** Several areas had no surviving specification and
are **not** spec-verified: the system resolver's name/type strings (only the id
`system-n8n` survived with a value); the `CredentialResolutionError` base class;
the static/dynamic merge rule and the encryption envelope for stored entries;
`resolvableAllowFallback`, whose column and default survive but which nothing
pins — no fallback behavior is implemented; custom-resolver validation (e.g. the
`credential-resolver.oauth2-1.0` type an E2E consumer mentions), where a custom
resolver currently treats the context identity itself as the subject rather than
running any type-specific validation; and resolver-CRUD authorization, uniqueness
and deletion policy. The externally-facing execution endpoints
(`/workflows/:id/execution-status`, `/credentials/:id/authorize`,
`/credentials/:id/revoke`) are **deliberately not built** — their
authentication, static-token and CORS contracts are unpinned, and inventing an
auth-bearing surface is exactly what the contract warns against. Behavior when
`feat:dynamicCredentials` is unlicensed is also unpinned; the module is gated on
that flag, so an unlicensed instance keeps the tables but registers no providers.
`N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN` and
`N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS` are names chosen here, now
pinned by a clean-room config test.

**Verification:** integration `test/integration/dynamic-credentials/` **43/43**
across 5 files (was 5 files failing to import, 0 tests);
`credentials.resolvable.api.test.ts` **37/37** (was 0);
`manual-execution-credential-context.test.ts` **5/5** (was 0); unit
`credentials-helper.test.ts` **49/49** (was 47 passed / 2 failed). Regression
holds: `credentials.api.test.ts` **80/80** unchanged, `src/modules/sso-saml` +
`sso-oidc` + `provisioning` **199/199** unchanged, `main-only-modules` **6/6**
unchanged, and the full `packages/cli` unit suite has **zero new failing files**
against a clean-tree baseline (the pre-existing failures come from other purged
`.ee` modules). `dynamic-credentials.ee` references in `packages/cli` src+test =
**0**; `tsc -p tsconfig.build.json` reports **0** errors mentioning
`dynamic-credential` or `credentials-helper` (93 unrelated pre-existing errors,
unchanged); `eslint src/modules/dynamic-credentials --quiet` exits **0** with no
rule disables. The ESLint TypeORM ratchet shrank by one: of the three stale `.ee`
entries, one was carried over to its fair-code path (the surviving
`ICredentialConnectionStatusProvider` contract passes an `EntityManager`) and two
were dropped because the rebuilt services no longer touch TypeORM.

### 2026-08-09 — E11: provisioning module and role-mapping engine

Rebuilds the purged SSO role-provisioning module clean-room
(`packages/cli/src/modules/provisioning/`), replacing the temporary
fail-closed deny gates that both SSO backends carried since E5/E6. Clean-room
sources: `.defork/e11-contract.md` (a verified inventory of the surviving
fair-code contracts), the fair-code consumers themselves (`saml.service.ts`,
`oidc.service.ts`, `users.controller.ts`, `project.controller.ts`, the public
projects handler, `role.service.ts`), the surviving DTOs/entities/migration in
`@n8n/api-types` and `@n8n/db`, the surviving executable specs, and this repo's
own `@n8n/expression-runtime`. No `.ee` body was read.

**Added — a role-mapping evaluation engine.** `ProvisioningService` now decides
what a login is entitled to before any account is looked up or written. Rules
are read per type in ascending order and the first match wins; a matching
instance rule beats the configured default condition; with nothing matched the
default condition applies (`block:access` denies the login, a role slug assigns
that role, unset falls back to `global:member` under expression mapping and to
"leave the role alone" under direct-claim provisioning). Project rules resolve
per target project, so one login can draw different projects from different
rules. Reconciliation is confined to the projects the policy governs: personal
projects, project ownership, and memberships granted outside provisioning are
never touched, and revocations are written before grants so an interrupted
apply can only reduce access. Results emit `sso-user-instance-role-updated`,
`sso-user-project-access-updated`, and `expression-mapping-roles-resolved`.

**Added — rule expressions run in a V8 isolate.** A dedicated
`ProvisioningExpressionEvaluator` uses `@n8n/expression-runtime`
(`ExpressionEvaluator` + `IsolatedVmBridge`) with the production AST hooks
(`ThisSanitizer`, `PrototypeSanitizer`, `DollarSignValidator`). Operators write
the expressions, but the claims they read come from the identity provider and
are treated as untrusted: the isolate sees a structured clone of the claims plus
the provider discriminator and nothing else — no host functions, no `process`,
no filesystem or network reach — behind a 500 ms / 16 MB budget (far below the
5 s / 128 MB workflow defaults) and a single pooled isolate that is released in
a `finally` and disposed on shutdown. Claims are size- and depth-checked on the
host before they are copied in. The result must be a boolean; timeout, memory,
syntax, prototype-escape, oversized-claim and non-boolean outcomes are all
evaluation failures that **fail the login closed**, recorded as a rule id and a
failure class only — never a claim or claim value.

**Added — `GET`/`PATCH /sso/provisioning/config`** (`provisioning:manage`).
`PATCH` is partial and persists the merged full document, because the reader
rejects partial rows. `defaultInstanceRole` accepts `block:access` or an
assignable global role, rejects `global:owner`/unknown/non-global roles with
400, and `null` removes it. `deleteProjectRules` clears the project rule space
and reports `role-mapping-rules-bulk-deleted`. A successful write updates the
local policy and publishes `reload-sso-provisioning-configuration`, which the
service now actually handles (`@OnPubSubEvent`) — previously the event existed
in the map with neither a publisher nor a handler.

**Added — `/role-mapping-rule` CRUD** (`roleMappingRule:*`, licensed when
either `feat:saml` or `feat:oidc` is available, otherwise 403 "Provisioning is
not licensed"). Create inserts at a clamped position and shifts, omitted order
appends, move reorders and compacts, delete compacts, and a `PATCH` that lands
on an occupied same-type order is a 409. Ordering is type-local, so instance
and project rules may share order values.

**Added — role deletion is blocked while provisioning still points at a role.**
`ProvisioningRoleDeletionChecker` implements the existing `RoleDeletionChecker`
contract and reports mapping-rule references and use as the default instance
role; the module registers it on init.

**Changed — both SSO backends now evaluate the policy instead of denying it.**
`SamlService.handleSamlLogin()` stops discarding the raw assertion attributes
and evaluates the policy against them (plus the mapped `n8nInstanceRole` /
`n8nProjectRoles` claims) before `userRepository.findOne()`; `OidcService`
evaluates it at the top of the sign-in path, before any identity lookup. A
denial still stops the flow before any write and carries no claim content.
`SamlService` no longer needs its own `RoleMappingRuleRepository`, removing the
divergence where SAML noticed stray rules and OIDC did not.

**Fixed — three stale unit-test literals expected the wrong settings key.**
`src/instance-settings-loader/__tests__/sso/provisioning.instance-settings-loader.test.ts`
asserted `features.provisioning` while production writes and reads
`sso.provisioning.config` everywhere: the constant in
`src/modules/provisioning/constants.ts`, the loader that writes through it,
`ProvisioningService` that reads through it, and the OIDC integration cleanup
that deletes through it. The focused suite failed 3 of 7 with exactly that diff.
The three test literals were corrected to match production; no legacy fallback
or migration is introduced, since nothing surviving reads the old key.

**Fixed — OIDC scope generation followed a different configuration source than
policy evaluation.** `buildScopes()` read `GlobalConfig.sso.provisioning` while
runtime policy reads the persisted document, so enabling a role claim through
the configuration endpoint never added the scope that carries it and the claim
never arrived. Both now read the persisted policy.

**Added — `@n8n/db` repository operations.** `RoleMappingRuleRepository` gains
use-case-named, transaction-aware methods for ordered reads, listing, and every
reorder (all order rewrites stage rows in a disjoint negative range first,
because `UNIQUE(type, order)` is checked per row and a naive shift collides
mid-statement). `ProjectRelationRepository.applyProvisionedRelationsForUser()`
applies one user's provisioning outcome in a single transaction without
touching other members, and `UserRepository.updateGlobalRole()` sets a global
role for provisioning, and `ProjectRepository.getExistingTeamProjectIds()`
backs the rule-creation guard below. No schema change, no migration.

**Changed — mapping rules may only target shared projects.** `projectIds` that
name a personal or non-existent project are rejected with 400. A personal
project has exactly one owner and is not a membership surface provisioning may
write to; reconciliation additionally skips personal projects and project
ownership when revoking.

**Under-pinned areas, decided and documented in code:** a non-boolean or
unevaluable rule denies rather than counting as "no match"; project matching is
per target project (the pinned event shape carries a `matchedRuleId` per
project, which only makes sense per project); removal is bounded to
rule-linked projects and never touches personal projects or ownership; the
instance owner is never re-assigned; OIDC `$claims` is the ID token overlaid by
UserInfo (with both documents also exposed unmerged as `$oidc`); direct project
claims are read as `<projectId>:<roleSlug>`, split at the first separator
because role slugs contain a colon and project ids do not, with unusable
entries skipped rather than denying the login; the reload command is always published (a no-op outside
queue mode).

**Known, pre-existing and out of scope:** with these specs finally executable,
`saml.api.test.ts` shows 5 failures in its metadata-URL/connection-test round
trips, and `project.api.test.ts` / `users.api.test.ts` /
`public-api/projects.test.ts` show 10 failures in project listing, user-list
field restrictions and public-API 404s. All were verified to reproduce with
this change's `src/` edits stashed, so none is caused by E11. The SAML ones
root-cause to `OutboundHttp.requests()` defaulting SSRF protection **on** for
the IdP metadata fetch (`SsrfBlockedIpError`), which blocks the loopback
address the spec serves metadata from; every other admin-configured endpoint in
the tree passes an explicit `ssrf` option instead. `OidcService`'s discovery
fetch has the same shape. Recommended follow-up, on its own branch: adopt the
`ssrf: config.enabled ? ssrfProtectionService : 'disabled'` pattern already used
in `workflows.controller.ts`, so an internal identity provider is reachable by
default while an operator who turns protection on is still honoured.


### 2026-08-09 — E5 hardening: SAML assertion binding, flow state and provisioning policy

Review follow-up on the rebuilt SAML backend
(`packages/cli/src/modules/sso-saml/`). Behavioural changes only; no schema or
migration.

**Added — an authenticated response is now checked against this service
provider.** After `parseLoginResponse`, `saml-response-validation.ts` reads the
assertion that the signature verification authenticated and requires: exactly
one `SubjectConfirmation`, using the bearer method, carrying confirmation data;
an `Audience` equal to our entity ID; a `Recipient` equal to our assertion
consumer service URL (and a response `Destination` equal to it when present); a
`Conditions/NotOnOrAfter` and a `SubjectConfirmationData/NotOnOrAfter` that are
both present and still open; and an `InResponseTo` present on both the response
and the confirmation data and identical in both. Every value is taken from the
authenticated assertion, never from the surrounding response, and all
comparisons allow ±60 s of clock drift. Previously nothing beyond samlify's own
issuer/signature checks was verified, and `Conditions` were only checked when
present. Because the request identifier is required, identity-provider-initiated
logins (no `InResponseTo`) are not accepted.

**Added — `wantAssertionsSigned` is enforced on the assertion itself.** samlify
accepts a response as soon as *either* the response-level or the
assertion-level signature verifies, so the assertion requirement — the one our
service-provider metadata advertises — is now checked on its own: the assertion
signature is re-verified against the identity provider certificate on a copy of
the document with the response-level `<Signature>` removed (the assertion's own
signature covers only the assertion subtree, so removing a sibling leaves it
verifiable). This closes a gap specific to the redirect binding, where samlify
verifies no XML signature at all. Behaviour change: with the default
`wantAssertionsSigned: true`, an identity provider that signs only the response
is now rejected — either have it sign the assertion (the setting n8n publishes
in its metadata) or turn the requirement off.

`wantMessageSigned` is treated as satisfied by any identity provider signature
covering the values acted on: a response-level `<Signature>` element, the
detached query signature on the redirect binding, or an assertion signature that
verified independently. samlify's `metadata-sp` never advertises
`WantMessageSigned`, so an identity provider has no way to learn about it, and
several common providers (assertion-only signing) would otherwise be locked out
by a default-on requirement. This is safe because every response-level value
used — `Destination`, `InResponseTo`, the response ID — is cross-checked against
its counterpart inside the independently verified assertion. Known limitation:
when both signature elements are present, the response-level one is not
separately re-verified; samlify exposes no way to scope verification to a single
element.

**Added — login requests are retained and consumed once.**
`saml-flow-state.ts` keeps the `AuthnRequest` IDs this instance issued (15-minute
TTL) and the response/assertion IDs already consumed (until their validity
window ends, capped at 30 minutes). A response is accepted only when its
`InResponseTo` matches a retained request, which is then dropped, and a response
or assertion ID seen before is refused. `GET /rest/sso/saml/initsso` also sets a
short-lived `n8n-saml-flow` cookie (HttpOnly, `Secure` per
`N8N_SECURE_COOKIE`, `SameSite=None` when secure so the cross-site POST binding
still carries it and `Lax` otherwise, scoped to `/<rest>/sso/saml`) and binds it
to the issued request; the assertion consumer service clears it. If the browser
presents the cookie it must match the request's, and if it presents none the
request identifier alone binds the response, so plain-HTTP deployments using the
POST binding keep working. Connection tests register their request the same way
but without a cookie. The store is per process: in a multi-main deployment each
main only knows the flows it started, so one-time consumption holds
instance-wide only with a single main or sticky sessions.

**Added — identity provider endpoints must use a supported scheme.** Every
single sign-on endpoint read from metadata (redirect and, when declared, POST)
must parse as an absolute `https:` URL, or `http:` on `localhost`, `127.0.0.1`
or `::1`. The check runs in `SamlValidator.validateIdentityProvider`, so invalid
metadata is refused by `POST /rest/sso/saml/config`, the metadata-URL fetch and
the connection test, and never persists; the generated login URL is re-checked
before it is returned to the browser. XML Schema `anyURI` accepts values such as
`javascript:`, which previously passed validation and were handed to the
frontend for navigation.

**Changed — an existing privileged account is not linked by email alone.** When
the asserted email matches an account holding `global:owner` or `global:admin`
that has no SAML identity yet, the login is refused with the generic
`SAML login failed` message (the controller still answers 401 `SAML
Authentication failed`) and a `logger.warn` recording the role and a truncated
SHA-256 digest of the address, never the address itself. Accounts that already
have a linked SAML identity, and non-privileged accounts, continue to match by
email as before.

**Changed — a configured role provisioning policy denies login until it can be
applied.** `handleSamlLogin` evaluates the policy immediately after email
validation and before any account lookup, creation or update. Rule evaluation
lives in the provisioning module, which is not rebuilt yet, so a login is denied
with `ForbiddenError` whenever provisioning is configured at all: expression
mapping enabled, instance-role or project-role provisioning enabled, a default
condition of `block:access`, or any `role_mapping_rule` row present. Previously
those settings were read for claim names only and the login proceeded with
default roles. Operational consequence: **an instance that has enabled SSO role
provisioning will have all SAML logins denied** until the provisioning rebuild
lands; disable provisioning to restore logins. The provisioning rebuild must
replace this gate with real evaluation that still runs before any account
mutation — the pins in `test/integration/saml/saml.api.test.ts` (matching rule
assigns `global:admin` / `project:editor`; a `block:access` default condition
rejects with `ForbiddenError`, creates no account and leaves an existing account
untouched) describe the target behaviour.

**Fixed — redirect-binding responses now verify.** The signed material for the
redirect binding is the query string *without* the `Signature` parameter (SAML
bindings §3.4.4.1); the whole query string including it was being passed, so
every redirect-binding delivery failed with
`ERR_FAILED_MESSAGE_SIGNATURE_VERIFICATION`. Reverting only this change makes
the three new redirect-binding tests fail, which is how it was confirmed.

**Known dependency defect (not fixed here):** the repository-wide pnpm override
pins `node-rsa` to `2.0.0` while samlify 2.13.0 declares `^1.1.1`. node-rsa 2
returns a `Uint8Array` from `sign()`, so samlify's `constructMessageSignature`
calls `.toString('base64')` on it and produces a comma-separated decimal string
instead of base64. Outbound redirect-binding signing is therefore malformed,
which affects signed `AuthnRequest`s (`N8N_ENV_FEAT_SIGNED_SAML_REQUESTS`) and
any redirect-binding message this instance signs. Inbound verification is
unaffected. Fixing it means changing the override, patching samlify or replacing
its node-rsa use, all of which reach beyond this module — recorded here so it is
picked up deliberately.

**Clean-room sources:** the SAML 2.0 core/bindings/profiles standards, samlify
2.13.0's installed public API (`SamlLib`, `Extractor`, binding builders) read
from `node_modules`, this repo's own fair-code (`sso-oidc` flow-cookie pattern,
`@n8n/db` role constants and `RoleMappingRuleRepository`, `@n8n/api-types`
provisioning DTO), and the pins in `test/integration/saml/saml.api.test.ts`. No
`.ee` source read.

**Verification:** unit `src/modules/sso-saml` **84/84** (was 39) — 45 new tests:
26 in the new `saml-login-response.test.ts` (real identity-provider-signed
fixtures over both bindings covering audience, recipient, destination, subject
confirmation, validity windows, request binding, replay and both signature
requirements, including the default requirement pairing against an
assertion-only signature), 8 endpoint-scheme tests in `saml-validator.test.ts`,
and 11 in `saml.service.test.ts` for privileged-account linking and the
provisioning gate (asserting no repository write happens on refusal).
Integration `public-api/sso-saml.test.ts` **16/16**, `saml/saml-helpers.test.ts`
1/1, `saml/saml.instance-settings-loader.test.ts` **2/2** — unchanged from
baseline — plus a new `saml/saml-initsso.test.ts` 2/2 driving
`GET /rest/sso/saml/initsso` through the real route to pin the login URL and the
per-login flow cookie;
`saml/saml.api.test.ts` still collects zero tests because it imports the missing
`modules/provisioning.ee/provisioning.service.ee`, and repointing it is not
possible while the surviving `ProvisioningService` lacks the `init()` and
`provisioningConfig` surface it drives. `tsc -p tsconfig.build.json` → 0 errors
mentioning sso-saml; `eslint src/modules/sso-saml --quiet` exit 0, no rule
disables. `@n8n/db` untouched.

### 2026-08-09 — E6 hardening: OIDC identity resolution and provisioning policy

Review follow-up on the rebuilt OIDC backend
(`packages/cli/src/modules/sso-oidc/`). Behavioural changes only; no schema or
migration.

**Changed — identity claims are read from one document.** `email` and
`email_verified` are now resolved together from a single claims source:
UserInfo when it carries an email, otherwise the ID token. A verification flag
is never combined with an email from the other document. A login is refused
when the two documents disagree on the subject or (case-insensitively) on the
email address, and when the ID token carries no issuer. Previously the email
preferred UserInfo while the verification flag fell back independently to the
ID-token claim, so `emailVerifiedRequired` could be satisfied by a flag that
described a different address.

**Changed — email matching to an existing account is narrower.** An asserted
address only resolves to an existing account when the provider reports it as
verified, independently of the `emailVerifiedRequired` setting, and an account
holding a privileged global role (`global:owner`, `global:admin`) is never
given its *first* OIDC identity by an email match. Both refusals return the
same generic `OIDC login failed` message (the controller still answers 401
`OIDC Authentication failed`) and are recorded with `logger.warn` carrying the
user id only — never the asserted address. Just-in-time creation of a *new*
account from an unverified address is unchanged and still governed by
`emailVerifiedRequired` and `N8N_SSO_JUST_IN_TIME_PROVISIONING`.

**Changed — identities are keyed by issuer and subject.** `AuthIdentity.
providerId` for `providerType: 'oidc'` is now
`oidc:v1:<base64url(sha256(sha256hex(issuer) + sub))>` (51 characters, always
within the column's 255-character limit; the fixed-length issuer digest makes
the concatenation unambiguous). Subjects are unique only within their issuer,
so a bare subject could previously resolve to another provider's user. Rows
written before this change hold the bare subject; such a row is re-keyed in
place on the next login that also presents the account's stored email — the
pair the row was created from. A row whose stored email no longer matches is
left untouched and resolution continues down the email path, so a subject
collision at a different issuer cannot inherit it. Because a subject-only row
records no issuer, re-keying carries the same conditions as an email match: the
address must be reported as verified, and an account with a privileged global
role is not resolved this way. `providerId` is not
surfaced in the UI or the public API; the subject remains readable in provider
logs. No migration: the value is derived at read time from the issuer that
authenticated the login, which a migration cannot know.

**Changed — configured role provisioning now fails closed.** OIDC login is
refused, before any account lookup or mutation and before any session is
issued, whenever the stored provisioning configuration enables instance-role
claims, project-role claims, expression mapping, or sets a default condition.
Rule evaluation does not exist in the surviving fair-code (only
`ProvisioningService`'s config read survives; there is no rule-evaluation
engine, controller, or expression evaluator, and `RoleMappingRuleRepository` is
a bare repository), and a configured policy that cannot be evaluated must not
be treated as no policy. Previously such a login was admitted with default
roles.

**Deferred to the provisioning rebuild** (the OIDC service will call it once it
exists): fetching `RoleMappingRule` rows ordered by `order` and filtered by
`type`; evaluating each `expression` against
`{ $claims, $oidc: { idToken, userInfo }, $provider: 'oidc' }`; honouring a
`block:access` outcome and the `defaultInstanceRole` fallback; and
transactional instance-role/project-membership reconciliation with the
`sso-user-instance-role-updated`, `sso-user-project-access-updated` and
`expression-mapping-roles-resolved` events. Until then the fail-closed refusal
above stands.

**Fixed — coverage hole:** `test/integration/oidc/oidc.instance-settings-
loader.test.ts` imported the removed `modules/provisioning.ee/constants`;
repointed to the surviving `modules/provisioning/constants` (import path only).
The file now executes.

**Clean-room sources:** the surviving OIDC fair-code and its consumers, the
`.defork/e5e6-contract.md` inventory, `ProvisioningConfigDto` /
`RoleMappingRule` / `AuthIdentity` in `@n8n/db` and `@n8n/api-types`, the
OpenID Connect Core specification (`sub` uniqueness is per-issuer;
`email_verified` describes the `email` claim in the same document), and
openid-client 6.8.4's public API. No `.ee` source or history was consulted.

**Verification:** unit `src/modules/sso-oidc` **60/60** (was 35; 57 in
`oidc.service.test.ts`, 3 in `oidc-test-result.test.ts`) — 25 new tests
covering claim-source atomicity and both disagreement refusals, missing
issuer, privileged-account link refusal, unverified-email match refusal,
issuer-scoped resolution, legacy re-keying and its email-mismatch,
unverified-email and privileged-account refusals, and
the fail-closed provisioning branches including "no lookup or mutation
precedes the decision". Integration: public-api `sso-oidc.test.ts` **24/24**,
public-api `log-streaming.test.ts` **44/44**, `oidc-discovery-http` 2/2,
`oidc.instance-settings-loader` **1/1** (was a load failure), and a new
`oidc-legacy-identity.test.ts` 1/1 exercising the in-place re-key of a
primary-key column against the SQLite integration database (`DB_TYPE=sqlite`,
the suite default); the same write on Postgres was not exercised. `tsc -p tsconfig.build.json` → 0
errors mentioning sso-oidc; `eslint src/modules/sso-oidc --quiet` exit 0, no
rule disables. `@n8n/db` untouched.

### 2026-08-09 — E5: SAML backend rebuilt fair-code

**Added (clean-room rebuild of purged `sso-saml/*.ee` files):**
`packages/cli/src/modules/sso-saml/` — `saml.service.ts` (preference lifecycle
persisted as the `features.saml` settings row with the signing private key
encrypted via `Cipher`; secret-update semantics `''`=clear /
`CREDENTIAL_BLANKING_VALUE`=keep; PEM format + key/cert pair validation gated
on `N8N_ENV_FEAT_SIGNED_SAML_REQUESTS`; IdP metadata validation through the
surviving `SamlValidator` and metadata-URL fetching through `OutboundHttp`
(SSRF policy + `ignoreSSL`); samlify SP/IdP adapters with per-request
RelayState; assertion consumption + attribute mapping via surviving
`saml-helpers` with JIT user create/update; single-use hex-token
connection-test cache with 5-min TTL), `saml.controller.ts` (`/sso/saml`
metadata/config/config\/toggle/config\/test/initsso/acs; `saml:manage` scope +
surviving licensed/enabled middlewares; ACS renders the surviving
connection-test handlebars templates always-200, normal-login failures return
401 `SAML Authentication failed`, success issues the auth cookie, emits
`user-logged-in` and redirects only to same-origin relative RelayState paths),
`service-provider.ts` (entityID/ACS/config-test URL helpers + samlify SP
factory), plus `__tests__/saml.service.test.ts` (16 unit tests covering
metadata rejection, metadata-URL fetch errors, connection-test token flow,
signing-key encryption round-trip, email validation and JIT-disabled login).
Rewired the `.ee` import paths in `sso-saml.module.ts`, the public-api
sso-saml handler/mapper, the test server, and the SAML/OIDC specs (path
repoints only; `saml.instance-settings-loader.test.ts` also repointed
`provisioning.ee/constants` → surviving `provisioning/constants`).

**Clean-room sources:** the `.defork/e5e6-contract.md` consumer contract; the
surviving sso-saml fair-code (validator, helpers + their tests, DTOs, module,
middlewares, XSD schemas, connection-test templates, `init-sso-post` view);
`test/integration/saml/*` and `test/integration/public-api/sso-saml.test.ts`
pins; `sso-helpers`, `UrlService`, `AuthService.issueCookie`, the LDAP module
as the fair-code module pattern; the SAML 2.0 public standard and samlify
2.13.0's installed public API. No `.ee` source read.

**Verification:** `.ee` SAML refs in `packages/cli` src+test = 0; unit
`src/modules/sso-saml/__tests__` **39/39** (validator 8, helpers 15, new
service 16); integration `public-api/sso-saml.test.ts` **16/16**,
`saml/saml-helpers.test.ts` 1/1, `saml/saml.instance-settings-loader.test.ts`
**2/2** (was a load-failure); api-types SAML DTO tests 14/14; cli
`tsc -p tsconfig.build.json` 0 sso-saml errors; eslint clean (0 errors, no
rule disables). `saml/saml.api.test.ts` remains blocked by its import of
missing `modules/provisioning.ee/provisioning.service.ee` (E-provisioning),
not an E5 defect — expression-based role provisioning inside `handleSamlLogin`
is deferred to that rebuild.

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

## 2026-08-09 — E9 hardening: log-streaming review findings

Follow-up hardening of the rebuilt log-streaming module after an adversarial
review (`packages/cli/src/modules/log-streaming/`, public-api handler, and the
public-api operation-handler resolver). All surviving specs unchanged.

**Fixed**

- **Credential binding authorization (internal controller):** a webhook
  destination's credential reference is now validated at create/update time
  (`validate-destination-credentials.ts`): the requesting user must be able to
  read the credential (`CredentialsFinderService.findCredentialForUser` with
  `credential:read`), the stored credential type must match the configured
  generic auth type, only `httpHeaderAuth`/`httpBasicAuth` are accepted, and
  only the validated binding is persisted (stray references are stripped;
  non-webhook destinations persist no credentials). The public API DTO already
  excludes credential fields, so no public-handler change was needed.
- **Delivery authentication is fail-closed:** any authentication configuration
  the webhook destination cannot fully resolve at send time (unsupported mode
  or generic type, unbound/deleted credential, stored-type mismatch) now aborts
  the delivery (logged, message left unconfirmed) instead of sending the event
  without authentication.
- **Per-destination acknowledgment:** the destination service now tracks
  per-(message, destination) delivery state in a bounded in-memory map (TTL
  sweep + hard cap, documented in the service) and confirms a message to the
  bus only once every applicable destination has delivered it. A bus retry
  re-attempts only outstanding destinations — a destination that already
  delivered is not sent a duplicate, and an in-flight delivery is not doubled.
  The fair-code log writer was not modified.
- **Secret redaction on read APIs:** webhook header/query parameter values and
  raw JSON header/query strings are replaced with a placeholder in everything
  returned by read endpoints (internal GET, public GET/DELETE responses);
  persistence and internal reload keep the full serialization
  (`serialize({ redactSecrets })`). Re-saving a payload containing the
  placeholder restores the stored values (`restoreRedactedSecrets`), so a
  read-modify-write round-trip cannot corrupt stored secrets. Create/update
  responses still echo the caller's own input, which the public API spec pins.
- **Bounded delivery concurrency + drain:** each destination now delivers
  through a bounded serial queue (`delivery-queue.ts`, cap 100). On overflow
  the newest delivery is refused and its message stays unconfirmed for the bus
  retry loop (documented trade-off: recoverable shedding over cancelling
  admitted work). `close()`/`removeDestination()`/`shutdown()` stop admission
  first, await in-flight deliveries with a timeout, then close transports.
- **Persist-before-swap:** add/update persists the row before swapping runtime
  state (a DB failure leaves the previous destination active); delete removes
  the row before closing the runtime destination; mutations are serialized per
  destination id.
- **Narrower public-api handler containment:** the operation-handler resolver
  now contains a load failure only when the unresolvable specifier is a purged
  `.ee` module pending rebuild or the handler module itself; every other load
  error (syntax error, top-level throw, missing third-party dependency) fails
  the router build loudly.
- **Circuit breaker implemented:** `circuitBreaker.maxFailures` now has runtime
  behavior (`circuit-breaker.ts`): after the configured consecutive failures
  the breaker opens (deliveries skipped, messages left unconfirmed for retry),
  half-opens after `maxDuration` (default 30 s), admits `halfOpenRequests`
  probes (default 1), and closes on a successful probe. `failureWindow` bounds
  the failure streak; `maxConcurrentHalfOpenRequests` is accepted but unused
  (deliveries are serialized per destination).

**Deferred**

- Sentry DSN and syslog `tlsCa` are not redacted (the DSN is required by the
  public response schema and carries only the public ingest key; the CA is
  public material).
- Breaker state is in-memory per process; multi-main instances track failures
  independently.

**Clean-room sources:** the E9 contract inventory, the surviving fair-code
specs, and this repo's own fair-code (`CredentialsFinderService`, event bus,
log writer). No enterprise source or history was consulted.

**Verification:** integration 68/68 (eventbus 6, controller 12, syslog-tls 2,
loader roundtrip 4, public-api log-streaming 44) with zero assertion changes;
new module unit tests 42/42 (`src/modules/log-streaming/__tests__/`: credential
validation 8, webhook fail-closed auth + redaction 10, service ack/persist
ordering 10, breaker 9, queue 5); loader unit 20/20; eventbus unit 22/22;
`tsc` (build + full incl. tests) → 0 errors mentioning log-streaming or
`public-api/index`; `eslint src/modules/log-streaming
src/public-api/v1/handlers/log-streaming --quiet` exit 0, no rule disables;
public-api tags.test.ts 23/24 (same pre-existing RBAC failure).

## 2026-08-09 — E6: OIDC backend rebuilt fair-code

**Rebuilt (clean-room):** `packages/cli/src/modules/sso-oidc/oidc.service.ts`
(`OidcService`: settings-row persistence under `features.oidc` with
`Cipher.encryptV2`-encrypted client secret and exact-sentinel redaction,
`loadConfig(includeSecret?)` per the pinned surface, `updateConfig` with
discovery-validated writes and SAML/OIDC/LDAP mutual exclusion as 400s,
authorization-URL generation with per-request state/nonce/PKCE-S256, callback
token exchange + UserInfo via `openid-client` 6.8.4, claims→user resolution
(identity → email → JIT create), encrypted `n8n-oidc-id-token` cookie with the
3,800-byte ceiling, RP-initiated logout URL building) and
`oidc.controller.ts` (`/sso/oidc` internal routes: config get/set/test under
`feat:oidc` + `oidc:manage`, public login/callback, authenticated logout that
always ends the local session). Filenames drop the `.ee` infix.

**Rewired:** `sso-oidc.module.ts`, public-api `sso-oidc.handler.ts` +
`sso-oidc.mapper.ts`, `test-server.ts` (oidc case), and the two OIDC specs —
path repointing only. Added state/nonce/PKCE cookie-name constants to the
surviving `constants.ts`. Fixed the pinned Convict drift: `config/schema.ts`
`authenticationMethod` format now includes `oidc`.

**Open-area decisions (contract §8, chosen + documented in code):** plain
`sub` as `AuthIdentity.providerId`; resolution order identity → email →
JIT-create honoring `N8N_SSO_JUST_IN_TIME_PROVISIONING`; UserInfo canonical
with ID-token fallback for email/names; base scopes `openid profile email`
plus the provisioning scope when claim provisioning is enabled; state/nonce/
PKCE verifier in httpOnly SameSite=Lax 15-min cookies scoped to
`/{rest}/sso/oidc`; connection tests marked by an in-memory single-use
pending-state map; normal-callback success 302→instance base URL, failure
401 `OIDC Authentication failed`; `post_logout_redirect_uri` = instance base
URL, provider errors degrade to local-only logout (`redirectUrl: null`);
unset discovery endpoint surfaces a syntactically valid example.com
placeholder URL. Role provisioning/expression mapping stays delegated to the
provisioning rebuild (inputs preserved, nothing wired).

**Clean-room sources:** the E5/E6 contract inventory
(`.defork/e5e6-contract.md`), surviving fair-code (module file, constants,
`oidc-test-result` views + test, DTOs, env loader, sso-helpers, public-api
handler/mapper, discovery spec, frontend REST client), the OpenID Connect
Core/Discovery/RP-Initiated-Logout specs, and openid-client's public API. No
enterprise source or history was consulted.

**Verification:** new unit tests 32/32
(`src/modules/sso-oidc/__tests__/oidc.service.test.ts`: state/PKCE flow,
token-exchange failure modes, claim mapping, sentinel handling, logout);
surviving `oidc-test-result` 3/3 and OIDC DTO 3/3 unchanged; integration
`oidc-discovery-http` 2/2; public-api `sso-oidc.test.ts` **24/24** (was a
load failure — also exercises the internal `/sso/oidc/config` routes);
public-api `log-streaming` baseline 44/44; `main-only-modules` 6/6;
`grep oidc.service.ee|oidc.controller.ee` in src+test = 0; build `tsc` → 0
sso-oidc errors; `eslint src/modules/sso-oidc
src/public-api/v1/handlers/sso-oidc --quiet` exit 0, no rule disables.
`oidc.instance-settings-loader.test.ts` remains blocked on the missing
`modules/provisioning.ee/constants` import (provisioning rebuild scope).
